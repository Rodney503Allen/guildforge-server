//src/services/combatSessionService.ts
import { db } from "../db";
import type { DerivedStats } from "./statEngine";
import { getFinalPlayerStats } from "./playerService";
import { resolveAttack } from "./combatEngine";
import { handleCreatureKill } from "./killService";
import { getCreatureDebuffTotals } from "./creatureDebuffService";

export type CombatActionType = "attack" | "spell" | "item";

export type CombatActor = {
  side: "player" | "enemy";
  name: string;

  hp: number;
  maxHp: number;

  sp: number;
  maxSp: number;

  stats: DerivedStats;

  gauge: number;           // 0 - 100
  ready: boolean;
  recoveryUntil: number;   // unix ms timestamp

  cooldowns: Record<string, number>; // spell:12 => timestamp, item:health => timestamp
};

export type CombatSession = {
  playerId: number;
  enemyInstanceId: number;

  createdAt: number;
  updatedAt: number;

  state: "active" | "victory" | "defeat" | "fled";

  player: CombatActor;
  enemy: CombatActor;

  log: string[];

  rewards?: {
    exp?: number;
    gold?: number;
    levelUp?: {
        newLevel: number;
        exp: number;
        hpGain: number;
        spGain: number;
        statPoints: number;
    } | null;
    chest?: any;
    quest?: any;
    };
};

const combatSessions = new Map<number, CombatSession>();

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function pushLog(session: CombatSession, line: string) {
  session.log.push(line);
  if (session.log.length > 50) {
    session.log = session.log.slice(-50);
  }
}

async function refreshSessionPlayer(session: CombatSession) {
  const player = await getFinalPlayerStats(session.playerId);
  if (!player) return null;

  session.player.stats = player;
  session.player.name = player.name ?? "Player";
  session.player.hp = Number(player.hpoints ?? 0);
  session.player.maxHp = Number(player.maxhp ?? 1);
  session.player.sp = Number(player.spoints ?? 0);
  session.player.maxSp = Number(player.maxspoints ?? 0);

  return player;
}

async function refreshSessionEnemy(session: CombatSession) {
  const [[enemyRow]]: any = await db.query(
    `
    SELECT
      pc.id,
      pc.hp,
      c.name,
      c.attack,
      c.defense,
      c.agility,
      c.crit,
      c.maxhp
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.id = ?
      AND pc.player_id = ?
    LIMIT 1
    `,
    [session.enemyInstanceId, session.playerId]
  );

  if (!enemyRow) return null;

  const debuffs = await getCreatureDebuffTotals(enemyRow.id);

  const enemyStats: DerivedStats = {
    level: 1,
    attack: Number(enemyRow.attack ?? 0) + Number(debuffs.attack || 0),
    defense: Number(enemyRow.defense ?? 0) + Number(debuffs.defense || 0),
    agility: Number(enemyRow.agility ?? 0) + Number(debuffs.agility || 0),
    vitality: Number(debuffs.vitality || 0),
    intellect: Number(debuffs.intellect || 0),
    crit: Number(enemyRow.crit ?? 0) + Number(debuffs.crit || 0),
    hpoints: Number(enemyRow.hp ?? 0),
    spoints: 0,
    maxhp: Number(enemyRow.maxhp ?? 1),
    maxspoints: 0,
    spellPower: 1,
    dodgeChance: 0,
    critDamageMult: 1.5,
    damageReduction: 0,
    lifesteal: 0
  };

  session.enemy.name = String(enemyRow.name ?? "Enemy");
  session.enemy.hp = Number(enemyRow.hp ?? 0);
  session.enemy.maxHp = Number(enemyRow.maxhp ?? 1);
  session.enemy.stats = enemyStats;

  return enemyStats;
}
async function processEnemyDots(session: CombatSession) {
  if (session.state !== "active") return;

  const [dots]: any = await db.query(
    `
    SELECT *
    FROM player_creature_dots
    WHERE player_creature_id = ?
      AND next_tick_at <= NOW()
      AND expires_at > NOW()
    `,
    [session.enemyInstanceId]
  );

  if (!dots?.length) {
    await db.query(
      `DELETE FROM player_creature_dots WHERE player_creature_id = ? AND expires_at <= NOW()`,
      [session.enemyInstanceId]
    );
    return;
  }

  let enemyHP = session.enemy.hp;
  let reward: any = null;

  for (const dot of dots) {
    enemyHP = Math.max(0, enemyHP - Number(dot.damage || 0));

    await db.query(
      `UPDATE player_creatures SET hp = ? WHERE id = ?`,
      [enemyHP, session.enemyInstanceId]
    );

    await db.query(
      `
      UPDATE player_creature_dots
      SET next_tick_at = DATE_ADD(next_tick_at, INTERVAL tick_interval SECOND)
      WHERE id = ?
      `,
      [dot.id]
    );

    pushLog(session, `🔥 Enemy takes ${dot.damage} damage.`);
  }

  await db.query(
    `DELETE FROM player_creature_dots WHERE player_creature_id = ? AND expires_at <= NOW()`,
    [session.enemyInstanceId]
  );

  session.enemy.hp = enemyHP;

  if (enemyHP <= 0) {
    reward = await handleCreatureKill(session.playerId, session.enemyInstanceId);

    session.state = "victory";
    session.rewards = {
      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp,
      chest: reward?.chest ?? null,
      quest: reward?.quest ?? null
    };

    pushLog(session, "🏆 Enemy defeated!");
    if (reward?.expGained) pushLog(session, `✨ You gained ${reward.expGained} EXP!`);
    if (reward?.goldGained) pushLog(session, `💰 You gained ${reward.goldGained} gold!`);
    if (reward?.levelUp) pushLog(session, "⬆ LEVEL UP!");
  }
}

async function processEnemyAction(session: CombatSession) {
  if (session.state !== "active") return;
  if (!session.enemy.ready) return;

  const player = await refreshSessionPlayer(session);
  const enemyStats = await refreshSessionEnemy(session);

  if (!player || !enemyStats) {
    session.state = "victory";
    return;
  }

  const result = resolveAttack(enemyStats, player as any);
  const dmg = Math.max(0, Math.floor(Number(result.damage) || 0));
  const newHP = Math.max(0, session.player.hp - dmg);

  session.player.hp = newHP;

  await db.query(
    `UPDATE players SET hpoints = ? WHERE id = ?`,
    [newHP, session.playerId]
  );

  pushLog(
    session,
    result.dodged
      ? `💨 ${session.enemy.name} missed you!`
      : `💥 ${session.enemy.name} hits you for ${dmg}${result.crit ? " (CRITICAL!)" : ""}`
  );

  consumeActorTurn(session.enemy, 450);

  if (newHP <= 0) {
    await db.query(`DELETE FROM player_creatures WHERE player_id = ?`, [session.playerId]);

    session.state = "defeat";
    pushLog(session, "☠ You were slain!");
  }
}






export function getATBFillRate(agility: number) {
  return 14 + Math.sqrt(Math.max(0, agility)) * 2.4;
}

export function getCombatSession(playerId: number) {
  return combatSessions.get(playerId) ?? null;
}

export function destroyCombatSession(playerId: number) {
  combatSessions.delete(playerId);
}

export function getActorReadyInMs(actor: CombatActor) {
  const now = Date.now();

  if (actor.ready) return 0;

  if (now < actor.recoveryUntil) {
    return actor.recoveryUntil - now;
  }

  const fillRate = getATBFillRate(actor.stats.agility);
  const remainingGauge = Math.max(0, 100 - actor.gauge);

  return Math.ceil((remainingGauge / Math.max(fillRate, 0.001)) * 1000);
}

export async function createCombatSession(playerId: number): Promise<CombatSession | null> {
  const player = await getFinalPlayerStats(playerId);
  if (!player) return null;

const [[enemyRow]]: any = await db.query(
  `
  SELECT
    pc.id,
    pc.hp,
    c.name,
    c.maxhp,
    c.attack,
    c.defense,
    c.agility,
    c.crit
  FROM player_creatures pc
  JOIN creatures c ON c.id = pc.creature_id
  WHERE pc.player_id = ?
  LIMIT 1
  `,
  [playerId]
);

  if (!enemyRow) return null;

  const now = Date.now();

const enemyStats: DerivedStats = {
  level: 1,
  attack: Number(enemyRow.attack ?? 0),
  defense: Number(enemyRow.defense ?? 0),
  agility: Number(enemyRow.agility ?? 0),
  vitality: 0,
  intellect: 0,
  crit: Math.max(0, Math.min(0.4, Number(enemyRow.crit ?? 0) * 0.005)),
  hpoints: Number(enemyRow.hp ?? 1),
  spoints: 0,
  maxhp: Number(enemyRow.maxhp ?? 1),
  maxspoints: 0,
  spellPower: 1,
  dodgeChance: clamp(Number(enemyRow.agility ?? 0) * 0.002, 0, 0.35),
  critDamageMult: 1.5,
  damageReduction: 0,
  lifesteal: 0
};

  const session: CombatSession = {
    playerId,
    enemyInstanceId: Number(enemyRow.id),
    createdAt: now,
    updatedAt: now,
    state: "active",

    player: {
      side: "player",
      name: player.name ?? "Player",
      hp: Number(player.hpoints),
      maxHp: Number(player.maxhp),
      sp: Number(player.spoints),
      maxSp: Number(player.maxspoints),
      stats: player,
      gauge: 0,
      ready: false,
      recoveryUntil: 0,
      cooldowns: {}
    },

    enemy: {
      side: "enemy",
      name: String(enemyRow.name ?? "Enemy"),
      hp: Number(enemyRow.hp),
      maxHp: Number(enemyRow.maxhp),
      sp: 0,
      maxSp: 0,
      stats: enemyStats,
      gauge: 0,
      ready: false,
      recoveryUntil: 0,
      cooldowns: {}
    },

    log: [`⚠ ${enemyRow.name ?? "Enemy"} engages you!`]
  };

  combatSessions.set(playerId, session);
  return session;
}

export function ensureCombatSession(playerId: number) {
  return combatSessions.get(playerId) ?? null;
}

export async function advanceCombatSession(session: CombatSession) {
  if (session.state !== "active") return session;

  const enemyExists = await refreshSessionEnemy(session);
  const playerExists = await refreshSessionPlayer(session);

  if (!playerExists) {
    session.state = "defeat";
    return session;
  }

  if (!enemyExists) {
    session.state = "victory";
    return session;
  }

  const now = Date.now();
  const elapsedMs = Math.max(0, now - session.updatedAt);
  const elapsedSec = elapsedMs / 1000;

  for (const actor of [session.player, session.enemy]) {
    if (now < actor.recoveryUntil) continue;
    if (actor.ready) continue;

    const fillRate = getATBFillRate(actor.stats.agility);
    actor.gauge = Math.min(100, actor.gauge + fillRate * elapsedSec);

    if (actor.gauge >= 100) {
      actor.gauge = 100;
      actor.ready = true;
    }
  }

  session.updatedAt = now;

  await processEnemyDots(session);

  if (session.state !== "active") return session;

  await processEnemyAction(session);

  return session;
}

export function consumeActorTurn(
  actor: CombatActor,
  recoveryMs: number
) {
  const now = Date.now();
  actor.gauge = 0;
  actor.ready = false;
  actor.recoveryUntil = now + recoveryMs;
}

export function isCooldownReady(actor: CombatActor, key: string) {
  const now = Date.now();
  return now >= (actor.cooldowns[key] || 0);
}

export function setCooldown(actor: CombatActor, key: string, seconds: number) {
  actor.cooldowns[key] = Date.now() + seconds * 1000;
}

export function buildCombatSnapshot(session: CombatSession) {
  const now = Date.now();

  return {
    state: session.state,
    player: {
      name: session.player.name,
      hp: session.player.hp,
      maxHp: session.player.maxHp,
      sp: session.player.sp,
      maxSp: session.player.maxSp,
      gauge: session.player.gauge,
      ready: session.player.ready,
      recoveryMs: Math.max(0, session.player.recoveryUntil - now),
      cooldowns: session.player.cooldowns
    },
    enemy: {
      name: session.enemy.name,
      hp: session.enemy.hp,
      maxHp: session.enemy.maxHp,
      gauge: session.enemy.gauge,
      ready: session.enemy.ready,
      recoveryMs: Math.max(0, session.enemy.recoveryUntil - now)
    },
    log: session.log.slice(-12),
    rewards: session.rewards ?? null
  };
}