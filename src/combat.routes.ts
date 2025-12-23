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
    FROM player_creature_debuffs d
    WHERE d.player_creature_id = pc.id
      AND d.stat IN ('dot', 'hot')
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
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ stop: true });

    // Find current enemy instance (if any)
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

    // If not in combat anymore, stop polling
    if (!enemy) {
      return res.json({ stop: true });
    }

    // If enemy is dead, stop polling (UI can reload/close modal)
if (Number(enemy.enemyHP) <= 0) {
  // 🔥 Finalize combat HERE
  const reward = await handleCreatureKill(pid, enemy.playerCreatureId);

  return res.json({
    stop: true,
    enemyDead: true,
    enemyHP: 0,
    enemyMaxHP: Number(enemy.enemyMaxHP),
    exp: reward?.expGained,
    gold: reward?.goldGained,
    levelUp: reward?.levelUp
  });
}



    // Otherwise return current HP snapshot
    return res.json({
      stop: false,
      enemyDead: false,
      enemyHP: Number(enemy.enemyHP),
      enemyMaxHP: Number(enemy.enemyMaxHP)
    });
  } catch (err) {
    console.error("🔥 /combat/poll ERROR:", err);
    return res.status(500).json({ stop: true });
  }
});


/* ===========================
   COMBAT SPELLS
=========================== */
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
        icon,
        scost,
        type,
        svalue,
        buff_stat,
        buff_value,
        cooldown
      FROM spells
      WHERE sclass = ?
        AND level <= ?
        AND is_combat = 1
    `,
      [player.pclass, player.level]
    );

    res.json(Array.isArray(spells) ? spells : []);
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
  const newHP = Math.max(0, enemyRow.hp - result.damage);

  await db.query(
    "UPDATE player_creatures SET hp = ? WHERE id = ?",
    [newHP, enemyRow.id]
  );

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
