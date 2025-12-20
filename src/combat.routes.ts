// src/combat.routes.ts
import { Router } from "express";
import { db } from "./db";
import { resolveAttack } from "./services/combatEngine";
import { getFinalPlayerStats } from "./services/playerService";
import { handleCreatureKill } from "./services/killService";

const router = Router();
const playerAttackCooldowns = new Map<number, number>();
const enemyAttackCooldowns = new Map<number, number>();

/* ===========================
   GET COMBAT STATE
=========================== */
router.get("/combat/state", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.json({ inCombat: false });

  const [[row]]: any = await db.query(`
    SELECT pc.id, c.name, pc.hp
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.player_id = ?
  `, [pid]);

  if (!row) return res.json({ inCombat: false });

  res.json({
    inCombat: true,
    enemy: {
      id: row.id,
      name: row.name,
      hp: row.hp
    }
  });
});

router.get("/combat/spells", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.json([]);

    const [[player]]: any = await db.query(
      "SELECT pclass, level FROM players WHERE id = ?",
      [pid]
    );

    if (!player) return res.json([]);

    const [spells]: any = await db.query(`
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
    `, [player.pclass, player.level]);

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

  // Load player base stats
const attacker = await getFinalPlayerStats(pid);
if (!attacker) return res.status(404).json({ error: "Player not found" });

    const agility = Number(attacker.agility || 0);

    const BASE_ATTACK_DELAY = 1200;
    const MIN_ATTACK_DELAY = 400;

    const delay =
      Math.max(
        MIN_ATTACK_DELAY,
        BASE_ATTACK_DELAY - agility * 10
      );

    playerAttackCooldowns.set(pid, now + delay);

  // Load enemy
  const [[enemyRow]]: any = await db.query(`
    SELECT pc.id, pc.hp, c.attack, c.defense
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.player_id = ?
  `, [pid]);

  if (!enemyRow) {
    return res.json({ error: "No enemy" });
  }

  // Minimal enemy stats (can expand later)
  const defender = {
    attack: enemyRow.attack,
    defense: enemyRow.defense,
    agility: 0,
    vitality: 0,
    intellect: 0,
    crit: 0,
    hpoints: enemyRow.hp,
    spoints: 0,
    maxhp: enemyRow.hp,
    maxspoints: 0,
    level: 1,
    dodgeChance: 0,
    spellPower: 1
  };

  // Resolve attack
  const result = resolveAttack(attacker, defender);

  const newHP = Math.max(0, enemyRow.hp - result.damage);

  await db.query(
    "UPDATE player_creatures SET hp = ? WHERE id = ?",
    [newHP, enemyRow.id]
  );

  // Enemy defeated

let reward = null;

if (newHP <= 0) {
  reward = await handleCreatureKill(pid, enemyRow.id);
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
   CAST SPELL
=========================== */


/* ===========================
   ENEMY AUTO ATTACK
=========================== */
router.post("/combat/enemy-attack", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ stop: true });

    // Load player
    const player = await getFinalPlayerStats(pid);
    if (!player) return res.json({ stop: true });

    // Load enemy
    const [[enemy]]: any = await db.query(`
      SELECT pc.id, pc.hp, c.attack, c.defense, c.agility, c.crit
      FROM player_creatures pc
      JOIN creatures c ON c.id = pc.creature_id
      WHERE pc.player_id = ?
    `, [pid]);

    if (!enemy) {
      return res.json({ stop: true });
    }

    // Compute player stats
const playerStats = {
  level: player.level,

  attack: player.attack,
  defense: player.defense,
  agility: player.agility,
  vitality: player.vitality,
  intellect: player.intellect,
  crit: player.crit,

  hpoints: player.hpoints,
  spoints: player.spoints,
  maxhp: player.maxhp,
  maxspoints: player.maxspoints,

  dodgeChance: player.dodgeChance ?? 0,
  spellPower: player.spellPower ?? 1
};



    // Build enemy stats (FULLY SAFE)
const enemyBase = {
  level: 1,

  attack: Number(enemy.attack ?? 1),
  defense: Number(enemy.defense ?? 0),
  agility: Number(enemy.agility ?? 0),
  vitality: 0,
  intellect: 0,
  crit: Number(enemy.crit ?? 0),

  hpoints: Number(enemy.hp),
  spoints: 0,
  maxhp: Number(enemy.hp),
  maxspoints: 0,

  // ✅ add these
  dodgeChance: 0,
  spellPower: 1
};

const enemyStats = enemyBase;

const now = Date.now();
const nextAllowed = enemyAttackCooldowns.get(enemy.id) || 0;

if (now < nextAllowed) {
  return res.json({ stop: false });
}

const BASE_DELAY = 1800;
const delay = Math.max(600, BASE_DELAY - (enemy.agility ?? 0) * 15);
enemyAttackCooldowns.set(enemy.id, now + delay);



    // Resolve attack (enemy → player)
const result = resolveAttack(enemyStats as any, playerStats as any);

// ✅ clamp damage so HP can never increase from an "attack"
const dmg = Math.max(0, Math.floor(Number(result.damage) || 0));
const newHP = Math.max(0, Number(player.hpoints) - dmg);


    await db.query(
      "UPDATE players SET hpoints = ? WHERE id = ?",
      [newHP, pid]
    );

    res.json({
      damage: result.damage,
      crit: result.crit,
      dodged: result.dodged,
      playerHP: newHP,
      dead: newHP <= 0,
      stop: newHP <= 0
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
