// src/combat.routes.ts
import { Router } from "express";
import { db } from "./db";
import { resolveAttack } from "./services/combatEngine";
import { getFinalPlayerStats } from "./services/playerService";
import { handleCreatureKill } from "./services/killService";
import { getCreatureDebuffTotals } from "./services/creatureDebuffService";

const router = Router();
const playerAttackCooldowns = new Map<number, number>();
const enemyAttackCooldowns = new Map<number, number>();

/* ===========================
   GET COMBAT STATE
=========================== */
router.get("/combat/state", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.json({ inCombat: false });

  const [[row]]: any = await db.query(
    `
SELECT
  pc.id,
  c.name,
  pc.hp,
  c.maxhp,
  EXISTS (
  SELECT 1
  FROM player_creature_dots d
  WHERE d.player_creature_id = pc.id
    AND d.expires_at > NOW()
) AS hasStatus
FROM player_creatures pc
JOIN creatures c ON c.id = pc.creature_id
WHERE pc.player_id = ?

  `,
    [pid]
  );

  if (!row) {
    return res.json({ inCombat: false });
  }

res.json({
  inCombat: true,
  enemy: {
    id: row.id,
    name: row.name,
    hp: row.hp,
    maxHP: row.maxhp,
    hasStatus: !!row.hasStatus
  }
});

});

/* ===========================
   POLL COMBAT STATUS (HP SYNC)
   Used by client while DOT/HOT active
=========================== */
router.get("/combat/poll", async (req, res) => {
  console.log("🧪 /combat/poll HIT");

  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.json({ stop: true });

    const [[enemy]]: any = await db.query(
      `
      SELECT
        pc.id AS playerCreatureId,
        pc.hp AS enemyHP,
        c.maxhp AS enemyMaxHP
      FROM player_creatures pc
      JOIN creatures c ON c.id = pc.creature_id
      WHERE pc.player_id = ?
      LIMIT 1
      `,
      [pid]
    );

    if (!enemy) return res.json({ stop: true });

    let enemyHP = Number(enemy.enemyHP);
    const combatLog: string[] = [];
    let reward = null;

    // 🔥 DOT TICKS
    const [dots]: any = await db.query(
      `
      SELECT *
      FROM player_creature_dots
      WHERE player_creature_id = ?
        AND next_tick_at <= NOW()
        AND expires_at > NOW()
      `,
      [enemy.playerCreatureId]
    );

    for (const dot of dots) {
      enemyHP = Math.max(0, enemyHP - Number(dot.damage));

      await db.query(
        "UPDATE player_creatures SET hp = ? WHERE id = ?",
        [enemyHP, enemy.playerCreatureId]
      );

      await db.query(
        `
        UPDATE player_creature_dots
        SET next_tick_at = DATE_ADD(next_tick_at, INTERVAL tick_interval SECOND)
        WHERE id = ?
        `,
        [dot.id]
      );

      combatLog.push(`🔥 Enemy takes ${dot.damage} damage.`);
    }

    await db.query(
      "DELETE FROM player_creature_dots WHERE expires_at <= NOW()"
    );

    // ☠ Death check AFTER DOTs
    if (enemyHP <= 0 && enemy.enemyHP > 0) {
      reward = await handleCreatureKill(pid, enemy.playerCreatureId);
    }

    res.json({
      stop: false,
      enemyDead: enemyHP <= 0,
      enemyHP,
      enemyMaxHP: Number(enemy.enemyMaxHP),
      log: combatLog,
      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp
    });

  } catch (err) {
    console.error("🔥 /combat/poll ERROR:", err);
    res.status(500).json({ stop: true });
  }
});



/* ===========================
   COMBAT SPELLS
=========================== */
// GET combat spells for current player
router.get("/combat/spells", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.json([]);

    const [[player]]: any = await db.query(
      "SELECT pclass, level FROM players WHERE id = ?",
      [pid]
    );

    if (!player) return res.json([]);

    const [spells]: any = await db.query(
      `
      SELECT
        id,
        name,
        description,
        icon,
        type,
        scost,
        cooldown,

        -- direct effects
        damage,
        heal,

        -- DOT system
        dot_damage,
        dot_duration,
        dot_tick_rate,

        -- buffs
        buff_stat,
        buff_value,
        buff_duration,

        -- debuffs (NON-DOT ONLY)
        debuff_stat,
        debuff_value,
        debuff_duration
      FROM spells
      WHERE sclass = ?
        AND level <= ?
        AND is_combat = 1
      ORDER BY level ASC
      `,
      [player.pclass, player.level]
    );

    res.json(spells ?? []);
  } catch (err) {
    console.error("🔥 /combat/spells ERROR:", err);
    res.status(500).json([]);
  }
});


/* ===========================
   PLAYER ATTACK
=========================== */
router.post("/combat/attack", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const now = Date.now();
  const nextAllowed = playerAttackCooldowns.get(pid) || 0;

  if (now < nextAllowed) {
    return res.json({
      error: "cooldown",
      remaining: Math.ceil((nextAllowed - now) / 1000)
    });
  }

  const attacker = await getFinalPlayerStats(pid);
  if (!attacker) {
    return res.status(404).json({ error: "Player not found" });
  }

  const agility = Number(attacker.agility || 0);
  const delay = Math.max(400, 1200 - agility * 10);
  playerAttackCooldowns.set(pid, now + delay);

  const [[enemyRow]]: any = await db.query(
    `
    SELECT
      pc.id,
      pc.hp,
      c.attack,
      c.defense,
      c.maxhp
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.player_id = ?
  `,
    [pid]
  );

  if (!enemyRow) {
    return res.json({ error: "No enemy" });
  }

  const debuffs = await getCreatureDebuffTotals(enemyRow.id);

  const defender = {
    attack: Number(enemyRow.attack) + (debuffs["attack"] || 0),
    defense: Number(enemyRow.defense) + (debuffs["defense"] || 0),
    agility: debuffs["agility"] || 0,
    vitality: debuffs["vitality"] || 0,
    intellect: debuffs["intellect"] || 0,
    crit: debuffs["crit"] || 0,
    hpoints: enemyRow.hp,
    spoints: 0,
    maxhp: enemyRow.maxhp,
    maxspoints: 0,
    level: 1,
    dodgeChance: 0,
    spellPower: 1
  };

  const result = resolveAttack(attacker, defender);
  await db.query(
  "UPDATE player_creatures SET hp = GREATEST(0, hp - ?) WHERE id = ?",
  [result.damage, enemyRow.id]
);

const [[updated]]: any = await db.query(
  "SELECT hp FROM player_creatures WHERE id = ?",
  [enemyRow.id]
);

const newHP = updated.hp;

  let reward = null;
  if (newHP <= 0) {
    reward = await handleCreatureKill(pid, enemyRow.id);
    playerAttackCooldowns.delete(pid);
    enemyAttackCooldowns.delete(enemyRow.id);
  }

  res.json({
    damage: result.damage,
    crit: result.crit,
    dodged: result.dodged,
    enemyHP: newHP,
    dead: newHP <= 0,
    exp: reward?.expGained,
    gold: reward?.goldGained,
    levelUp: reward?.levelUp
  });
});

/* ===========================
   ENEMY AUTO ATTACK
=========================== */
router.post("/combat/enemy-attack", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ stop: true });

    const player = await getFinalPlayerStats(pid);
    if (!player) return res.json({ stop: true });

    const [[enemy]]: any = await db.query(
      `
      SELECT
        pc.id,
        pc.hp,
        c.attack,
        c.defense,
        c.agility,
        c.crit
      FROM player_creatures pc
      JOIN creatures c ON c.id = pc.creature_id
      WHERE pc.player_id = ?
    `,
      [pid]
    );
    if (!enemy) {
      return res.json({ stop: true });
    }


    const debuffs = await getCreatureDebuffTotals(enemy.id);

    const enemyStats = {
      level: 1,
      attack: Number(enemy.attack ?? 1) + (debuffs.attack || 0),
      defense: Number(enemy.defense ?? 0) + (debuffs.defense || 0),
      agility: Number(enemy.agility ?? 0) + (debuffs.agility || 0),
      vitality: debuffs.vitality || 0,
      intellect: debuffs.intellect || 0,
      crit: Number(enemy.crit ?? 0) + (debuffs.crit || 0),
      hpoints: Number(enemy.hp),
      spoints: 0,
      maxhp: Number(enemy.hp),
      maxspoints: 0,
      dodgeChance: 0,
      spellPower: 1
    };

    const now = Date.now();
    const nextAllowed = enemyAttackCooldowns.get(enemy.id) || 0;

    if (now < nextAllowed) {
      return res.json({ skipped: true });
    }

    const delay = Math.max(600, 1800 - (enemy.agility ?? 0) * 15);
    enemyAttackCooldowns.set(enemy.id, now + delay);

    const result = resolveAttack(enemyStats as any, player as any);
    const dmg = Math.max(0, Math.floor(Number(result.damage) || 0));
    const newHP = Math.max(0, Number(player.hpoints) - dmg);

    await db.query(
      "UPDATE players SET hpoints = ? WHERE id = ?",
      [newHP, pid]
    );

    res.json({
      type: "enemy-attack",
      playerDead: newHP <= 0,
      enemyDead: false,
      damage: dmg,
      crit: result.crit,
      dodged: result.dodged,
      playerHP: newHP,
      playerMaxHP: player.maxhp
    });

  } catch (err) {
    console.error("🔥 ENEMY ATTACK ERROR:", err);
    res.status(500).json({ stop: true });
  }
});

/* ===========================
   FLEE COMBAT
=========================== */
router.post("/combat/flee", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ success: false });

  await db.query(
    "DELETE FROM player_creatures WHERE player_id = ?",
    [pid]
  );

  playerAttackCooldowns.delete(pid);
  enemyAttackCooldowns.clear();

  res.json({ success: true });
});

export default router;
