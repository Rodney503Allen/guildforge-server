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

  level?: number;
  description?: string;

  hp: number;
  maxHp: number;

  sp: number;
  maxSp: number;

  stats: DerivedStats;

  gauge: number;           // 0 - 100
  ready: boolean;
  recoveryUntil: number;   // unix ms timestamp

  atbRateMult: number;        // 0.0 - 2.0

  cooldowns: Record<string, number>; // spell:12 => timestamp, item:health => timestamp
};

export type CombatSession = {
  playerId: number;
  enemyInstanceId: number;

  createdAt: number;
  updatedAt: number;

  nextPlayerAutoAttackAt: number;

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

const BASE_ATB_SECONDS = 6.0;
const MIN_ATB_SECONDS = 3.0;
const MAX_AGILITY = 500;
const AGILITY_EXPONENT = 0.6;
const PLAYER_AUTO_ATTACK_MS = 6000;

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
  session.player.atbRateMult = Number(player.atbRateMult ?? 1);

  return player;
}

async function refreshSessionEnemy(session: CombatSession) {
  const [[enemyRow]]: any = await db.query(
    `
    SELECT
      pc.id,
      pc.hp,
      pc.affix_id,

      c.name,
      c.attack,
      c.defense,
      c.agility,
      c.crit,
      c.maxhp,
      c.level,
      c.description,

      ca.name AS affix_name,
      ca.description AS affix_description,
      ca.hp_mult,
      ca.attack_mult,
      ca.defense_mult,
      ca.speed_mult
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    LEFT JOIN creature_affixes ca ON ca.id = pc.affix_id
    WHERE pc.id = ?
      AND pc.player_id = ?
    LIMIT 1
    `,
    [session.enemyInstanceId, session.playerId]
  );

  if (!enemyRow) return null;

  const debuffs = await getCreatureDebuffTotals(enemyRow.id);

  const hpMult = Number(enemyRow.hp_mult ?? 1);
  const attackMult = Number(enemyRow.attack_mult ?? 1);
  const defenseMult = Number(enemyRow.defense_mult ?? 1);
  const speedMult = Number(enemyRow.speed_mult ?? 1);

  const modifiedMaxHp = Math.floor(Number(enemyRow.maxhp ?? 1) * hpMult);

  const enemyDisplayName = enemyRow.affix_name
    ? `${enemyRow.affix_name} ${enemyRow.name}`
    : String(enemyRow.name ?? "Enemy");

  const baseDescription = String(enemyRow.description ?? "");
  const affixDescription = String(enemyRow.affix_description ?? "");

const baseEnemyAgility =
  Math.floor(
    Number(enemyRow.agility ?? 0) *
    speedMult
  ) + Number(debuffs.agility || 0);

const attackSpeedSlowPct = Math.max(
  0,
  Math.min(
    80,
    Number(debuffs.attack_speed_pct || 0)
  )
);

const enemyAtbRateMult = Math.max(
  0.2,
  1 - attackSpeedSlowPct / 100
);

const baseEnemyAttack =
  Math.floor(
    Number(enemyRow.attack ?? 0) *
    attackMult
  ) + Number(debuffs.attack || 0);

const damageDealtReductionPct = Math.max(
  0,
  Math.min(
    80,
    Number(debuffs.damage_dealt_pct || 0)
  )
);

const finalEnemyAttack = Math.max(
  0,
  Math.floor(
    baseEnemyAttack *
    (
      1 -
      damageDealtReductionPct / 100
    )
  )
);

const damageTakenPct = Math.max(
  0,
  Number(debuffs.damage_taken_pct || 0)
);

const damageTakenMult =
  1 + damageTakenPct / 100;

  const enemyStats: DerivedStats = {
    level: Number(enemyRow.level ?? 1),
    attack: finalEnemyAttack,
    defense: Math.floor(Number(enemyRow.defense ?? 0) * defenseMult) + Number(debuffs.defense || 0),
    agility: Math.max(0,baseEnemyAgility),
    vitality: Number(debuffs.vitality || 0),
    intellect: Number(debuffs.intellect || 0),
    crit: Number(enemyRow.crit ?? 0) + Number(debuffs.crit || 0),
    hpoints: Number(enemyRow.hp ?? 0),
    spoints: 0,
    maxhp: modifiedMaxHp,
    maxspoints: 0,
    spellPower: 1,
    dodgeChance: 0,
    critDamageMult: 1.5,
    damageReduction: 0,
    lifesteal: 0,
    healingReceivedMult: 1,
    atbRateMult: 1,
    damageTakenMult: damageTakenMult,
  };

session.enemy.name = enemyDisplayName;
session.enemy.hp = Number(enemyRow.hp ?? 0);
session.enemy.maxHp = modifiedMaxHp;
session.enemy.stats = enemyStats;
session.enemy.level = Number(enemyRow.level ?? 1);

session.enemy.atbRateMult = enemyAtbRateMult;

session.enemy.description = enemyRow.affix_name
  ? `${baseDescription}\n\n${affixDescription}`
  : baseDescription;

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
    const totalDamage = Number(dot.total_damage || dot.damage || 1);
    const totalTicks = Math.max(
      1,
      Number(dot.total_ticks || 1)
    );

    const ticksApplied = Number(dot.ticks_applied || 0);

    const damageBefore = Math.floor(
      (totalDamage * ticksApplied) / totalTicks
    );

    const damageAfter = Math.floor(
      (totalDamage * (ticksApplied + 1)) / totalTicks
    );

    const tickDamage = Math.max(
      0,
      damageAfter - damageBefore
    );

    enemyHP = Math.max(
      0,
      enemyHP - tickDamage
    );

    await db.query(
      `
      UPDATE player_creatures
      SET hp = ?
      WHERE id = ?
      `,
      [enemyHP, session.enemyInstanceId]
    );

    if (ticksApplied + 1 >= totalTicks) {
      await db.query(
        `
        DELETE FROM player_creature_dots
        WHERE id = ?
        `,
        [dot.id]
      );
    } else {
      await db.query(
        `
        UPDATE player_creature_dots
        SET
          ticks_applied = ticks_applied + 1,
          next_tick_at = DATE_ADD(
            next_tick_at,
            INTERVAL tick_interval SECOND
          )
        WHERE id = ?
        `,
        [dot.id]
      );
    }

    pushLog(
      session,
      `🔥 Enemy takes ${tickDamage} damage.`
    );
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

async function processPlayerHots(session: CombatSession) {
  if (session.state !== "active") return;

  const [hots]: any = await db.query(
    `
    SELECT *
    FROM player_hots
    WHERE player_id = ?
      AND next_tick_at <= NOW()
      AND expires_at > NOW()
    `,
    [session.playerId]
  );

  if (!hots?.length) {
    await db.query(
      `
      DELETE FROM player_hots
      WHERE player_id = ?
        AND expires_at <= NOW()
      `,
      [session.playerId]
    );

    return;
  }

  const player = await getFinalPlayerStats(
    session.playerId
  );

  if (!player) return;

  let playerHP = Number(player.hpoints || 0);
  const maxPlayerHP = Math.max(
    1,
    Number(player.maxhp || 1)
  );

  for (const hot of hots) {
    const healing = Math.max(
      0,
      Number(hot.healing || 0)
    );

    const previousHP = playerHP;

    playerHP = Math.min(
      maxPlayerHP,
      playerHP + healing
    );

    const actualHealing = Math.max(
      0,
      playerHP - previousHP
    );

    await db.query(
      `
      UPDATE player_hots
      SET next_tick_at =
        DATE_ADD(
          next_tick_at,
          INTERVAL tick_interval SECOND
        )
      WHERE id = ?
      `,
      [hot.id]
    );

    if (actualHealing > 0) {
    const displayName =
      String(
        hot.display_name ||
        "Healing over Time"
      );

    pushLog(
      session,
      `✨ ${displayName} restores ${actualHealing} HP.`
    );
    }
  }

  await db.query(
    `
    UPDATE players
    SET hpoints = ?
    WHERE id = ?
    `,
    [playerHP, session.playerId]
  );

  await db.query(
    `
    DELETE FROM player_hots
    WHERE player_id = ?
      AND expires_at <= NOW()
    `,
    [session.playerId]
  );

  session.player.hp = playerHP;
  session.player.maxHp = maxPlayerHP;
}

async function processPlayerAutoAttack(session: CombatSession) {
  if (session.state !== "active") return;

  const now = Date.now();
  if (now < session.nextPlayerAutoAttackAt) return;

  const player = await refreshSessionPlayer(session);
  const enemyStats = await refreshSessionEnemy(session);

  if (!player || !enemyStats) {
    session.state = "victory";
    return;
  }

  const result = resolveAttack(session.player.stats as any, enemyStats as any);

  const damage = Math.max(0, Number(result.damage || 0));
  const newEnemyHP = Math.max(0, session.enemy.hp - damage);

  await db.query(
    `UPDATE player_creatures SET hp = ? WHERE id = ?`,
    [newEnemyHP, session.enemyInstanceId]
  );

  session.enemy.hp = newEnemyHP;

  pushLog(
    session,
    result.dodged
      ? "⚔ Your auto attack missed!"
      : `⚔ You auto attack for ${damage}${result.crit ? " (CRITICAL!)" : ""}`
  );

  let lifestealHeal = 0;

  if (!result.dodged && damage > 0 && Number(session.player.stats.lifesteal || 0) > 0) {
    lifestealHeal = Math.floor(damage * Number(session.player.stats.lifesteal || 0));

    if (lifestealHeal > 0) {
      session.player.hp = Math.min(session.player.maxHp, session.player.hp + lifestealHeal);

      await db.query(
        `UPDATE players SET hpoints = ? WHERE id = ?`,
        [session.player.hp, session.playerId]
      );

      pushLog(session, `🩸 You restore ${lifestealHeal} HP.`);
    }
  }

  session.nextPlayerAutoAttackAt = now + PLAYER_AUTO_ATTACK_MS;

  if (newEnemyHP <= 0) {
    const reward = await handleCreatureKill(session.playerId, session.enemyInstanceId);

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

type ShieldAbsorbResult = {
  incomingDamage: number;
  absorbedDamage: number;
  remainingDamage: number;
  shieldBroken: boolean;
};

async function absorbDamageWithPlayerShields(
  playerId: number,
  incomingDamage: number
): Promise<ShieldAbsorbResult> {
  let remainingDamage = Math.max(
    0,
    Math.floor(incomingDamage)
  );

  let absorbedDamage = 0;
  let shieldBroken = false;

  if (remainingDamage <= 0) {
    return {
      incomingDamage: 0,
      absorbedDamage: 0,
      remainingDamage: 0,
      shieldBroken: false
    };
  }

  // Remove expired or depleted shields first.
  await db.query(
    `
    DELETE FROM player_shields
    WHERE player_id = ?
      AND (
        expires_at <= NOW(3)
        OR remaining_absorb <= 0
      )
    `,
    [playerId]
  );

  const [shields]: any = await db.query(
    `
    SELECT
      id,
      remaining_absorb,
      source
    FROM player_shields
    WHERE player_id = ?
      AND expires_at > NOW(3)
      AND remaining_absorb > 0
    ORDER BY expires_at ASC, id ASC
    `,
    [playerId]
  );

  for (const shield of shields) {
    if (remainingDamage <= 0) break;

    const availableAbsorb = Math.max(
      0,
      Number(shield.remaining_absorb) || 0
    );

    if (availableAbsorb <= 0) continue;

    const absorbedFromShield = Math.min(
      remainingDamage,
      availableAbsorb
    );

    const newRemainingAbsorb =
      availableAbsorb - absorbedFromShield;

    remainingDamage -= absorbedFromShield;
    absorbedDamage += absorbedFromShield;

    if (newRemainingAbsorb <= 0) {
      await db.query(
        `
        DELETE FROM player_shields
        WHERE id = ?
        `,
        [shield.id]
      );

      shieldBroken = true;
    } else {
      await db.query(
        `
        UPDATE player_shields
        SET remaining_absorb = ?
        WHERE id = ?
        `,
        [
          newRemainingAbsorb,
          shield.id
        ]
      );
    }
  }

  return {
    incomingDamage: Math.max(
      0,
      Math.floor(incomingDamage)
    ),

    absorbedDamage,
    remainingDamage,
    shieldBroken
  };
}



type AegisResult = {
  damage: number;
  triggered: boolean;
  preventedDeath: boolean;
  reductionPercent: number;
};

async function applyAegisOfFaith(
  playerId: number,
  currentHP: number,
  incomingDamage: number
): Promise<AegisResult> {
  const damage = Math.max(
    0,
    Math.floor(incomingDamage)
  );

  if (damage <= 0) {
    return {
      damage: 0,
      triggered: false,
      preventedDeath: false,
      reductionPercent: 0
    };
  }

  // Remove expired or empty effects.
  await db.query(
    `
    DELETE FROM player_status_effects
    WHERE player_id = ?
      AND effect_key = 'death_prevention'
      AND (
        expires_at <= NOW(3)
        OR charges <= 0
      )
    `,
    [playerId]
  );

  const [[effect]]: any = await db.query(
    `
    SELECT
      id,
      charges,
      value
    FROM player_status_effects
    WHERE player_id = ?
      AND effect_key = 'death_prevention'
      AND expires_at > NOW(3)
      AND charges > 0
    ORDER BY expires_at ASC, id ASC
    LIMIT 1
    `,
    [playerId]
  );

  if (!effect) {
    return {
      damage,
      triggered: false,
      preventedDeath: false,
      reductionPercent: 0
    };
  }

  const reductionPercent = Math.max(
    0,
    Math.min(
      100,
      Number(effect.value) || 0
    )
  );

let reducedDamage = Math.max(
  1,
  Math.ceil(
    damage *
    (1 - reductionPercent / 100)
  )
);

let preventedDeath = false;

if (reducedDamage >= currentHP) {
  reducedDamage = Math.max(
    0,
    currentHP - 1
  );

  preventedDeath = true;
}

  const remainingCharges = Math.max(
    0,
    Number(effect.charges) - 1
  );

  if (remainingCharges <= 0) {
    await db.query(
      `
      DELETE FROM player_status_effects
      WHERE id = ?
      `,
      [effect.id]
    );
  } else {
    await db.query(
      `
      UPDATE player_status_effects
      SET charges = ?
      WHERE id = ?
      `,
      [
        remainingCharges,
        effect.id
      ]
    );
  }

  return {
    damage: reducedDamage,
    triggered: true,
    preventedDeath,
    reductionPercent
  };
}

type InterceptResult = {
  damage: number;
  triggered: boolean;
  reductionPercent: number;
};

async function applyIntercept(
  playerId: number,
  incomingDamage: number
): Promise<InterceptResult> {
  const damage = Math.max(
    0,
    Math.floor(incomingDamage)
  );

  if (damage <= 0) {
    return {
      damage: 0,
      triggered: false,
      reductionPercent: 0
    };
  }

  // Remove expired or depleted Intercept effects.
  await db.query(
    `
    DELETE FROM player_status_effects
    WHERE player_id = ?
      AND effect_key = 'intercept'
      AND (
        expires_at <= NOW(3)
        OR charges <= 0
      )
    `,
    [playerId]
  );

  const [[effect]]: any = await db.query(
    `
    SELECT
      id,
      charges,
      value
    FROM player_status_effects
    WHERE player_id = ?
      AND effect_key = 'intercept'
      AND expires_at > NOW(3)
      AND charges > 0
    ORDER BY expires_at ASC, id ASC
    LIMIT 1
    `,
    [playerId]
  );

  if (!effect) {
    return {
      damage,
      triggered: false,
      reductionPercent: 0
    };
  }

  const reductionPercent = Math.max(
    0,
    Math.min(
      90,
      Number(effect.value) || 0
    )
  );

  // Round upward so a positive nonlethal hit normally
  // still deals at least one point of damage.
  const reducedDamage = Math.max(
    1,
    Math.ceil(
      damage *
      (1 - reductionPercent / 100)
    )
  );

  const remainingCharges = Math.max(
    0,
    Number(effect.charges) - 1
  );

  if (remainingCharges <= 0) {
    await db.query(
      `
      DELETE FROM player_status_effects
      WHERE id = ?
      `,
      [effect.id]
    );
  } else {
    await db.query(
      `
      UPDATE player_status_effects
      SET charges = ?
      WHERE id = ?
      `,
      [
        remainingCharges,
        effect.id
      ]
    );
  }

  return {
    damage: reducedDamage,
    triggered: true,
    reductionPercent
  };
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

const result = resolveAttack(
  enemyStats,
  player as any
);

const mitigatedDamage = Math.max(
  0,
  Math.floor(
    Number(result.damage) || 0
  )
);

let hpDamage = mitigatedDamage;
let absorbedDamage = 0;
let shieldBroken = false;

if (!result.dodged && mitigatedDamage > 0) {
  const shieldResult =
    await absorbDamageWithPlayerShields(
      session.playerId,
      mitigatedDamage
    );

  hpDamage = shieldResult.remainingDamage;
  absorbedDamage = shieldResult.absorbedDamage;
  shieldBroken = shieldResult.shieldBroken;
}

let interceptTriggered = false;
let interceptReductionPercent = 0;

if (
  !result.dodged &&
  hpDamage > 0
) {
  const interceptResult =
    await applyIntercept(
      session.playerId,
      hpDamage
    );

  hpDamage =
    interceptResult.damage;

  interceptTriggered =
    interceptResult.triggered;

  interceptReductionPercent =
    interceptResult.reductionPercent;
}

let aegisTriggered = false;
let aegisPreventedDeath = false;
let aegisReductionPercent = 0;

if (
  !result.dodged &&
  hpDamage > 0
) {
  const aegisResult =
    await applyAegisOfFaith(
      session.playerId,
      session.player.hp,
      hpDamage
    );

  hpDamage = aegisResult.damage;
  aegisTriggered = aegisResult.triggered;
  aegisPreventedDeath =
    aegisResult.preventedDeath;
  aegisReductionPercent =
    aegisResult.reductionPercent;
}

const newHP = Math.max(
  0,
  session.player.hp - hpDamage
);

session.player.hp = newHP;

await db.query(
  `
  UPDATE players
  SET hpoints = ?
  WHERE id = ?
  `,
  [newHP, session.playerId]
);

if (result.dodged) {
  pushLog(
    session,
    `💨 ${session.enemy.name} missed you!`
  );
} else {
  let attackLog =
    `💥 ${session.enemy.name} hits you`;

  if (hpDamage > 0) {
    attackLog += ` for ${hpDamage}`;
  } else if (absorbedDamage > 0) {
    attackLog += ", but your shield absorbs the attack";
  } else if (aegisTriggered) {
    attackLog += ", but Aegis of Faith negates the attack";
  } else {
    attackLog += " for no damage";
  }

  if (result.crit) {
    attackLog += " (CRITICAL!)";
  }

  pushLog(
    session,
    `${attackLog}!`
  );

  if (absorbedDamage > 0) {
    pushLog(
      session,
      `🛡️ Your shield absorbs ${absorbedDamage} damage.`
    );
  }

  if (shieldBroken) {
    pushLog(
      session,
      "💥 Your shield shatters!"
    );
  }

  if (interceptTriggered) {
  pushLog(
    session,
    `🛡️ Intercept reduces the attack by ` +
    `${interceptReductionPercent}%!`
  );
}

  if (aegisTriggered) {
  pushLog(
    session,
    `✨ Aegis of Faith reduces the attack by ` +
    `${aegisReductionPercent}%!`
  );
}

if (aegisPreventedDeath) {
  pushLog(
    session,
    "🕊️ Aegis of Faith prevents a lethal blow!"
  );
}
}
  consumeActorTurn(session.enemy, 450);

  if (newHP <= 0) {
    await db.query(`DELETE FROM player_creatures WHERE player_id = ?`, [session.playerId]);

    session.state = "defeat";
    pushLog(session, "☠ You were slain!");
  }
}



export function getATBTimeSeconds(agility: number) {
  const agi = Math.max(0, Math.min(MAX_AGILITY, Number(agility || 0)));

  const progress = Math.pow(agi / MAX_AGILITY, AGILITY_EXPONENT);

  return BASE_ATB_SECONDS -
    progress * (BASE_ATB_SECONDS - MIN_ATB_SECONDS);
}

export function getATBFillRate(agility: number) {
  return 100 / getATBTimeSeconds(agility);
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

  const baseFillRate =
    getATBFillRate(actor.stats.agility);

  const atbRateMult = Math.max(
    0.01,
    Number(actor.atbRateMult) || 1
  );

  const fillRate =
    baseFillRate * atbRateMult;
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
    c.crit,
    c.level,
    c.description,
    c.attack_speed
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
  level: Number(enemyRow.level ?? 1),
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
  lifesteal: 0,
  healingReceivedMult: 1,
  atbRateMult: 1,
  damageTakenMult: 1
};

  const session: CombatSession = {
    playerId,
    enemyInstanceId: Number(enemyRow.id),
    createdAt: now,
    updatedAt: now,
    nextPlayerAutoAttackAt: now + PLAYER_AUTO_ATTACK_MS,
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
      atbRateMult: Number(player.atbRateMult ?? 1),
      cooldowns: {}
    },

    enemy: {
      side: "enemy",
      name: String(enemyRow.name ?? "Enemy"),
      level: Number(enemyRow.level ?? 1),
      description: String(enemyRow.description ?? ""),
      hp: Number(enemyRow.hp ?? 0),
      maxHp: Number(enemyRow.maxhp ?? 1),
      sp: 0,
      maxSp: 0,
      gauge: 0,
      ready: false,
      recoveryUntil: now + Number(enemyRow.attack_speed ?? 1500),
      atbRateMult: 1,
      stats: enemyStats as any,
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

  const baseFillRate =
    getATBFillRate(actor.stats.agility);

  const atbRateMult = Math.max(
    0.01,
    Number(actor.atbRateMult) || 1
  );

  const finalFillRate =
    baseFillRate * atbRateMult;

  actor.gauge = Math.min(
    100,
    actor.gauge +
    finalFillRate * elapsedSec
  );

    if (actor.gauge >= 100) {
      actor.gauge = 100;
      actor.ready = true;
    }
  }

  session.updatedAt = now;

  await processEnemyDots(session);

  if (session.state !== "active") {
    return session;
  }

  await processPlayerHots(session);

  if (session.state !== "active") {
    return session;
  }

  await processPlayerAutoAttack(session);

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
    autoAttackMs: Math.max(0, session.nextPlayerAutoAttackAt - now),
    autoAttackTotalMs: PLAYER_AUTO_ATTACK_MS,
    cooldowns: session.player.cooldowns
  },
    enemy: {
      name: session.enemy.name,
      level: session.enemy.level,
      description: session.enemy.description,
      hp: session.enemy.hp,
      maxHp: session.enemy.maxHp,
      gauge: session.enemy.gauge,
      ready: session.enemy.ready,
      recoveryMs: Math.max(0, session.enemy.recoveryUntil - now)
    },
    log: session.log,
    rewards: session.rewards ?? null
  };
}