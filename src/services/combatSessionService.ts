//src/services/combatSessionService.ts
import { db } from "../db";
import type { DerivedStats } from "./statEngine";
import { getFinalPlayerStats } from "./playerService";
import { resolveAttack } from "./combatEngine";
import {
  COMBAT_TIMING,
  advanceCombatActorGauge,
  appendCombatDamageEvent,
  appendCombatLog,
  calculateDistributedTickDamage,
  consumeCombatActorTurn,
  getCombatActorReadyInMs,
  getCombatATBFillRate,
  getCombatATBTimeSeconds,
  isCombatCooldownReady,
  reduceCombatSpellCooldowns,
  setCombatCooldown,
} from "./combat";
import { handleCreatureKill } from "./killService";
import {
  getCreatureDebuffTotals,
  applyCreatureDebuff,
  extendWarlordMarkDebuffs,
} from "./creatureDebuffService";
import { mitigateIncomingPlayerDamage } from "./playerDamageMitigationService";
import {
  getActiveBerserkerDamageMultiplier,
  processBerserkerCriticalGauge,
  convertBerserkerLifestealOverhealToShield
} from "./spellTalents/handlers/berserkerTalentHandlers";
import {
  processWarlordBannerGaugeTick,
  processWarlordMarkedHit,
  processWarlordClaimThePrize,
} from "./spellTalents/handlers/warlordTalentHandlers";
import { processDuePlayerHots } from "./playerHotService";
import {
  publishPlayerStatePatch,
  publishPlayerLevelUp,
} from "../playerStateEvents";

export type CombatActionType = "attack" | "spell" | "item";

function buildWarlordMarkedCreature(playerCreatureId: number) {
  return {
    id: playerCreatureId,
    sourceType: "player_creature",
    getDebuffValue: async (stat: string) => {
      const [[row]]: any = await db.query(
        `SELECT MAX(value) AS value FROM player_creature_debuffs
         WHERE player_creature_id=? AND stat=? AND expires_at>NOW(3)`,
        [playerCreatureId, String(stat).trim().toLowerCase()],
      );
      return Math.max(0, Number(row?.value) || 0);
    },
    extendWarlordMark: (maximumExtensionSeconds: number) =>
      extendWarlordMarkDebuffs(playerCreatureId, maximumExtensionSeconds),
  };
}

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

  gauge: number; // 0 - 100
  ready: boolean;
  recoveryUntil: number; // unix ms timestamp

  atbRateMult: number; // 0.0 - 2.0

  cooldowns: Record<string, number>; // spell:12 => timestamp, item:health => timestamp
};

export type CombatDamageEvent = {
  id: number;
  target: "player" | "enemy";
  amount: number;
  crit: boolean;
  kind: "attack" | "spell" | "dot" | "item";
  createdAt: number;
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

  nextDamageEventId: number;
  damageEvents: CombatDamageEvent[];

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
    huntProgress?: any;
  };
};

const combatSessions = new Map<number, CombatSession>();

const PLAYER_AUTO_ATTACK_MS = COMBAT_TIMING.playerAutoAttackMs;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function pushLog(session: CombatSession, line: string) {
  appendCombatLog(session.log, line, 50);
}

export function pushDamageEvent(
  session: CombatSession,
  event: Omit<CombatDamageEvent, "id" | "createdAt">,
) {
  appendCombatDamageEvent(
    session.damageEvents,
    () => session.nextDamageEventId++,
    event,
    30,
  );
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
    [session.enemyInstanceId, session.playerId],
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
    Math.floor(Number(enemyRow.agility ?? 0) * speedMult) +
    Number(debuffs.agility || 0);

  const attackSpeedSlowPct = Math.max(
    0,
    Math.min(80, Number(debuffs.attack_speed_pct || 0)),
  );

  const enemyAtbRateMult = Math.max(0.2, 1 - attackSpeedSlowPct / 100);

  const baseEnemyAttack =
    Math.floor(Number(enemyRow.attack ?? 0) * attackMult) +
    Number(debuffs.attack || 0);

  const damageDealtReductionPct = Math.max(
    0,
    Math.min(80, Number(debuffs.damage_dealt_pct || 0)),
  );

  const finalEnemyAttack = Math.max(
    0,
    Math.floor(baseEnemyAttack * (1 - damageDealtReductionPct / 100)),
  );

  const damageTakenPct = Math.max(0, Number(debuffs.damage_taken_pct || 0));

  const damageTakenMult = 1 + damageTakenPct / 100;

  const spellDamageTakenMult =
    1 + Math.max(0, Number(debuffs.spell_damage_taken_pct || 0)) / 100;

  const enemyStats: DerivedStats & {
    critChanceTakenPercent: number;
    criticalDamageTakenPercent: number;
  } = {
    level: Number(enemyRow.level ?? 1),
    attack: finalEnemyAttack,
    defense:
      Math.floor(Number(enemyRow.defense ?? 0) * defenseMult) +
      Number(debuffs.defense || 0),
    agility: Math.max(0, baseEnemyAgility),
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
    healingDealtMult: 1,
    atbRateMult: 1,
    damageTakenMult: damageTakenMult,
    spellDamageTakenMult,
    critChanceTakenPercent: Math.max(
      0,
      Number(debuffs.crit_chance_taken_pct || 0),
    ),
    criticalDamageTakenPercent: Math.max(
      0,
      Number(debuffs.critical_damage_taken_pct || 0),
    ),
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
    [session.enemyInstanceId],
  );

  if (!dots?.length) {
    await db.query(
      `DELETE FROM player_creature_dots WHERE player_creature_id = ? AND expires_at <= NOW()`,
      [session.enemyInstanceId],
    );
    return;
  }

  let enemyHP = session.enemy.hp;
  let reward: any = null;

  for (const dot of dots) {
    const totalDamage = Number(dot.total_damage || dot.damage || 1);
    const totalTicks = Math.max(1, Number(dot.total_ticks || 1));

    const ticksApplied = Number(dot.ticks_applied || 0);

    const tickDamage = calculateDistributedTickDamage(
      totalDamage,
      totalTicks,
      ticksApplied,
    );

    const sourceParts = Object.fromEntries(
      String(dot.source || "")
        .split("|")
        .slice(1)
        .map((part: string) => part.split(":")),
    );
    const defensePerTick = Number(sourceParts.dr) || 0;
    const maxDefenseStacks = Number(sourceParts.ds) || 0;
    const manaPercent = Number(sourceParts.mp) || 0;
    const escalationPerTick = Number(sourceParts.ep) || 0;
    const escalationCap = Number(sourceParts.ec) || 0;
    const tickHealingPercent = Number(sourceParts.th) || 0;

    if (defensePerTick > 0 && maxDefenseStacks > 0) {
      const stacks = Math.min(maxDefenseStacks, ticksApplied + 1);
      const reduction = -Math.max(
        1,
        Math.floor(
          (Number(session.enemy.stats.defense || 0) * defensePerTick * stacks) /
            100,
        ),
      );
      await applyCreatureDebuff(
        session.enemyInstanceId,
        "defense",
        reduction,
        Number(dot.tick_interval || 1) * Math.max(1, totalTicks - ticksApplied),
        `templar_brand_exposure:${dot.id}`,
      );
    }

    if (manaPercent > 0) {
      const restored = Math.max(
        1,
        Math.floor((session.player.maxSp * manaPercent) / 100),
      );
      session.player.sp = Math.min(
        session.player.maxSp,
        session.player.sp + restored,
      );
      session.player.stats.spoints = session.player.sp;
      await db.query(`UPDATE players SET spoints = ? WHERE id = ?`, [
        session.player.sp,
        session.playerId,
      ]);
    }

    const escalatedTickDamage = Math.max(
      0,
      Math.floor(
        tickDamage *
          (1 + Math.min(escalationCap, escalationPerTick * ticksApplied) / 100),
      ),
    );

    if (
      tickHealingPercent > 0 &&
      escalatedTickDamage > 0 &&
      session.player.hp > 0
    ) {
      const potentialHealing = Math.max(
        1,
        Math.floor((escalatedTickDamage * tickHealingPercent) / 100),
      );

      const previousHP = session.player.hp;

      session.player.hp = Math.min(
        session.player.maxHp,
        session.player.hp + potentialHealing,
      );

      const actualHealing = Math.max(0, session.player.hp - previousHP);

      session.player.stats.hpoints = session.player.hp;

      if (actualHealing > 0) {
        await db.query(`UPDATE players SET hpoints = ? WHERE id = ?`, [
          session.player.hp,
          session.playerId,
        ]);

        pushLog(
          session,
          `🩸 Scent of Blood restores ${actualHealing} HP.`,
        );
      }
    }

    enemyHP = Math.max(0, enemyHP - escalatedTickDamage);

    if (escalatedTickDamage > 0) {
      const markedHit = await processWarlordMarkedHit(
        buildWarlordMarkedCreature(session.enemyInstanceId),
        session.playerId,
        escalatedTickDamage,
      );
      session.player.gauge = Math.min(100, session.player.gauge + markedHit.gaugeGain);
      session.player.ready = session.player.gauge >= 100;
    }

    await db.query(
      `
      UPDATE player_creatures
      SET hp = ?
      WHERE id = ?
      `,
      [enemyHP, session.enemyInstanceId],
    );

    if (ticksApplied + 1 >= totalTicks) {
      await db.query(
        `
        DELETE FROM player_creature_dots
        WHERE id = ?
        `,
        [dot.id],
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
        [dot.id],
      );
    }

    pushDamageEvent(session, {
      target: "enemy",
      amount: escalatedTickDamage,
      crit: false,
      kind: "dot",
    });

    pushLog(session, `🔥 Enemy takes ${escalatedTickDamage} damage.`);
  }

  await db.query(
    `DELETE FROM player_creature_dots WHERE player_creature_id = ? AND expires_at <= NOW()`,
    [session.enemyInstanceId],
  );

  session.enemy.hp = enemyHP;

  if (enemyHP <= 0) {
    const claim = await processWarlordClaimThePrize(
      buildWarlordMarkedCreature(session.enemyInstanceId),
      [session.playerId],
    );
    const claimedPlayer = claim.players[0];
    if (claimedPlayer) {
      session.player.hp = claimedPlayer.hp;
      session.player.sp = claimedPlayer.sp;
      session.player.stats.hpoints = claimedPlayer.hp;
      session.player.stats.spoints = claimedPlayer.sp;
    }
    session.player.gauge = Math.min(100, session.player.gauge + claim.gaugeGain);
    session.player.ready = session.player.gauge >= 100;
    reward = await handleCreatureKill(
      session.playerId,
      session.enemyInstanceId,
    );

    session.state = "victory";
    session.rewards = {
      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp,
      chest: reward?.chest ?? null,
      quest: reward?.quest ?? null,
      huntProgress: reward?.huntProgress ?? null,
    };

    /*
     * Creature rewards can change:
     * - gold
     * - experience
     * - level
     * - stat points
     * - HP/SP caps on level-up
     *
     * Tell the global stat panel to perform one
     * authoritative reconciliation immediately.
     * This is event-driven, not polling.
     */
    publishPlayerStatePatch(session.playerId, {
      refreshDerivedStats: true,
    });

    if (reward?.levelUp) {
      publishPlayerLevelUp(session.playerId, reward.levelUp);
    }

    pushLog(session, "🏆 Enemy defeated!");
    if (reward?.expGained)
      pushLog(session, `✨ You gained ${reward.expGained} EXP!`);
    if (reward?.goldGained)
      pushLog(session, `💰 You gained ${reward.goldGained} gold!`);
    if (reward?.levelUp) pushLog(session, "⬆ LEVEL UP!");
  }
}

async function processPlayerHots(session: CombatSession) {
  if (session.state !== "active") return;
  const ticks = await processDuePlayerHots(session.playerId);
  for (const tick of ticks) {
    session.player.hp = tick.newHP;
    session.player.maxHp = tick.maxHP;
    if (tick.gaugeGain > 0) {
      session.player.gauge = Math.min(
        100,
        session.player.gauge + tick.gaugeGain,
      );
      session.player.ready = session.player.gauge >= 100;
    }
    if (tick.healing > 0)
      pushLog(session, `✨ ${tick.displayName} restores ${tick.healing} HP.`);
    if (tick.refreshed)
      pushLog(session, `🩸 ${tick.displayName} renews itself!`);
    if (tick.casterEchoHealing > 0 && tick.casterEchoPlayerId === session.playerId) {
      session.player.hp = Math.min(session.player.maxHp, session.player.hp + tick.casterEchoHealing);
      pushLog(session, `🌱 Symbiotic Growth restores ${tick.casterEchoHealing} HP.`);
    }
    publishPlayerStatePatch(session.playerId, {
      hpoints: tick.newHP,
      maxhp: tick.maxHP,
    });
  }
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

  const deathWishMultiplier = await getActiveBerserkerDamageMultiplier(
    session.playerId, session.player.hp, session.player.maxHp
  );
  const damage = Math.max(0, Math.floor(Number(result.damage || 0) * deathWishMultiplier));
  const newEnemyHP = Math.max(0, session.enemy.hp - damage);

  await db.query(`UPDATE player_creatures SET hp = ? WHERE id = ?`, [
    newEnemyHP,
    session.enemyInstanceId,
  ]);

  session.enemy.hp = newEnemyHP;

  if (!result.dodged && damage > 0) {
    const markedHit = await processWarlordMarkedHit(
      buildWarlordMarkedCreature(session.enemyInstanceId),
      session.playerId,
      damage,
    );
    session.player.gauge = Math.min(100, session.player.gauge + markedHit.gaugeGain);
    session.player.ready = session.player.gauge >= 100;
  }

  if (!result.dodged) {
    pushDamageEvent(session, {
      target: "enemy",
      amount: damage,
      crit: Boolean(result.crit),
      kind: "attack",
    });
  }

  pushLog(
    session,
    result.dodged
      ? "⚔ Your auto attack missed!"
      : `⚔ You auto attack for ${damage}${result.crit ? " (CRITICAL!)" : ""}`,
  );

  let lifestealHeal = 0;

  if (
    !result.dodged &&
    damage > 0 &&
    Number(session.player.stats.lifesteal || 0) > 0
  ) {
    const rawLifesteal = Math.floor(
      damage * Number(session.player.stats.lifesteal || 0),
    );
    lifestealHeal = Math.min(rawLifesteal, Math.max(0, session.player.maxHp - session.player.hp));
    await convertBerserkerLifestealOverhealToShield(
      session.playerId,
      Math.max(0, rawLifesteal - lifestealHeal),
    );

    if (lifestealHeal > 0) {
      session.player.hp = Math.min(
        session.player.maxHp,
        session.player.hp + lifestealHeal,
      );

      await db.query(`UPDATE players SET hpoints = ? WHERE id = ?`, [
        session.player.hp,
        session.playerId,
      ]);

      publishPlayerStatePatch(session.playerId, {
        hpoints: session.player.hp,
        maxhp: session.player.maxHp,
      });

      pushLog(session, `🩸 You restore ${lifestealHeal} HP.`);
    }
  }

  session.nextPlayerAutoAttackAt = now + PLAYER_AUTO_ATTACK_MS;

  if (newEnemyHP <= 0) {
    const claim = await processWarlordClaimThePrize(
      buildWarlordMarkedCreature(session.enemyInstanceId),
      [session.playerId],
    );
    const claimedPlayer = claim.players[0];
    if (claimedPlayer) {
      session.player.hp = claimedPlayer.hp;
      session.player.sp = claimedPlayer.sp;
      session.player.stats.hpoints = claimedPlayer.hp;
      session.player.stats.spoints = claimedPlayer.sp;
    }
    session.player.gauge = Math.min(100, session.player.gauge + claim.gaugeGain);
    session.player.ready = session.player.gauge >= 100;
    const reward = await handleCreatureKill(
      session.playerId,
      session.enemyInstanceId,
    );

    session.state = "victory";
    session.rewards = {
      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp,
      chest: reward?.chest ?? null,
      quest: reward?.quest ?? null,
      huntProgress: reward?.huntProgress ?? null,
    };

    /*
     * Creature rewards can change:
     * - gold
     * - experience
     * - level
     * - stat points
     * - HP/SP caps on level-up
     *
     * Tell the global stat panel to perform one
     * authoritative reconciliation immediately.
     * This is event-driven, not polling.
     */
    publishPlayerStatePatch(session.playerId, {
      refreshDerivedStats: true,
    });

    if (reward?.levelUp) {
      publishPlayerLevelUp(session.playerId, reward.levelUp);
    }

    pushLog(session, "🏆 Enemy defeated!");
    if (reward?.expGained)
      pushLog(session, `✨ You gained ${reward.expGained} EXP!`);
    if (reward?.goldGained)
      pushLog(session, `💰 You gained ${reward.goldGained} gold!`);
    if (reward?.levelUp) pushLog(session, "⬆ LEVEL UP!");
  }
}

type ShieldAbsorbResult = {
  incomingDamage: number;
  absorbedDamage: number;
  remainingDamage: number;
  shieldBroken: boolean;
};

type AegisResult = {
  damage: number;
  triggered: boolean;
  preventedDeath: boolean;
  reductionPercent: number;
};

type InterceptResult = {
  damage: number;
  triggered: boolean;
  reductionPercent: number;
};

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

  const mitigatedDamage = Math.max(0, Math.floor(Number(result.damage) || 0));

  const mitigation = result.dodged
    ? null
    : await mitigateIncomingPlayerDamage(
        session.playerId,
        session.player.hp,
        mitigatedDamage,
        session.player.maxHp,
      );

  const hpDamage = result.dodged
    ? 0
    : (mitigation?.finalDamage ?? mitigatedDamage);

  const absorbedDamage = mitigation?.absorbedDamage ?? 0;

  const shieldBroken = mitigation?.shieldBroken ?? false;

  const interceptTriggered = mitigation?.interceptTriggered ?? false;

  const interceptReductionPercent = mitigation?.interceptReductionPercent ?? 0;

  const aegisTriggered = mitigation?.aegisTriggered ?? false;

  const aegisPreventedDeath = mitigation?.aegisPreventedDeath ?? false;

  const aegisReductionPercent = mitigation?.aegisReductionPercent ?? 0;

  const newHP = Math.max(
    0,
    Math.min(
      session.player.maxHp,
      session.player.hp -
        hpDamage +
        (mitigation?.aegisHealing ?? 0) +
        (mitigation?.shieldBreakHealing ?? 0) +
        (mitigation?.thornsHealing ?? 0) +
        Math.floor(
          (session.player.maxHp *
            (mitigation?.shieldBreakPartyHealPercent ?? 0)) /
            100,
        ),
    ),
  );

  session.player.hp = newHP;

  if ((mitigation?.sageTriggerGaugeGain ?? 0) > 0) {
    session.player.gauge = Math.min(100, session.player.gauge + mitigation!.sageTriggerGaugeGain);
    session.player.ready = session.player.gauge >= 100;
    pushLog(session, `🌳 Undying Grove restores ${mitigation!.sageReviveHealing} HP and grants ${mitigation!.sageTriggerGaugeGain} action gauge!`);
  }

  if ((mitigation?.voidFeedbackDamage ?? 0) > 0) {
    const reflected = Math.min(
      session.enemy.hp,
      mitigation!.voidFeedbackDamage,
    );
    session.enemy.hp = Math.max(0, session.enemy.hp - reflected);
    await db.query(`UPDATE player_creatures SET hpoints=? WHERE id=?`, [
      session.enemy.hp,
      session.enemyInstanceId,
    ]);
    pushLog(
      session,
      `🌌 Void Feedback strikes ${session.enemy.name} for ${reflected} damage!`,
    );
  }

  if ((mitigation?.thornsDamage ?? 0) > 0) {
    const reflected = Math.min(session.enemy.hp, mitigation!.thornsDamage);
    session.enemy.hp = Math.max(0, session.enemy.hp - reflected);
    await db.query(`UPDATE player_creatures SET hpoints = ? WHERE id = ?`, [
      session.enemy.hp,
      session.enemyInstanceId,
    ]);
    pushLog(
      session,
      mitigation?.knightThornsTriggered
        ? `🛡️ Your defenses retaliate against ${session.enemy.name} for ${reflected} damage!`
        : `🌿 Ironbark retaliates against ${session.enemy.name} for ${reflected} damage!`,
    );
  }

  if ((mitigation?.thornsHealing ?? 0) > 0) {
    pushLog(
      session,
      `🌱 Living Bark restores ${mitigation!.thornsHealing} HP!`,
    );
  }

  if ((mitigation?.shieldBreakHealing ?? 0) > 0) {
    pushLog(
      session,
      `🌱 Nature's Aegis blooms, restoring ${mitigation!.shieldBreakHealing} HP!`,
    );
  }

  if ((mitigation?.shieldBreakPartyHealPercent ?? 0) > 0) {
    pushLog(
      session,
      `🌸 Blooming Aegis restores ${mitigation!.shieldBreakPartyHealPercent}% maximum HP!`,
    );
  }

  if (mitigation?.sentinelDeathProtectionTriggered) {
    pushLog(
      session,
      `🌲 Ancient Protector prevents a lethal blow and restores ${mitigation.sentinelReviveHealing} HP!`,
    );
  }

  if (mitigation?.shieldReformed) {
    pushLog(
      session,
      mitigation.knightShieldReformed
        ? `🛡️ Layered Plating reforms Bulwark!`
        : `🌿 Layered Canopy reforms Nature's Aegis!`,
    );
  }

  if (mitigation?.knightSecondWindTriggered) {
    pushLog(session, `🛡️ Second Wind restores ${mitigation.aegisHealing} HP!`);
  }

  if (!result.dodged && result.crit) {
    const gaugeGain = await processBerserkerCriticalGauge(session.playerId, true);
    if (gaugeGain > 0) {
      session.player.gauge = Math.min(100, session.player.gauge + gaugeGain);
      session.player.ready = session.player.gauge >= 100;
      pushLog(session, `🔥 Furious Onslaught grants ${gaugeGain} action gauge!`);
    }
  }
  if (mitigation?.berserkerRefuseToFallTriggered) {
    pushLog(session, `🩸 Refuse to Fall prevents a lethal blow, but Blood Rage ends!`);
  }

  if (mitigation?.shieldBreakReductionApplied) {
    pushLog(session, `🌳 Barkskin Aftermath hardens your defenses!`);
  }

  if (mitigation?.shieldBreakHotApplied) {
    pushLog(session, `🌱 Seeds of Renewal begins restoring your health!`);
  }

  await db.query(
    `
  UPDATE players
  SET hpoints = ?
  WHERE id = ?
  `,
    [newHP, session.playerId],
  );

  publishPlayerStatePatch(session.playerId, {
    hpoints: newHP,
    maxhp: session.player.maxHp,
  });

  if (
    mitigation?.linkedShieldBuffRemoved ||
    mitigation?.aegisFollowupReductionPercent
  ) {
    await refreshSessionPlayer(session);
  }

  if (result.dodged) {
    pushLog(session, `💨 ${session.enemy.name} missed you!`);
  } else {
    let attackLog = `💥 ${session.enemy.name} hits you`;

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

    if (!result.dodged && hpDamage > 0) {
      pushDamageEvent(session, {
        target: "player",
        amount: hpDamage,
        crit: Boolean(result.crit),
        kind: "attack",
      });
    }

    pushLog(session, `${attackLog}!`);

    if (absorbedDamage > 0) {
      pushLog(session, `🛡️ Your shield absorbs ${absorbedDamage} damage.`);
    }

    if (shieldBroken) {
      pushLog(session, "💥 Your shield shatters!");
    }

    if (interceptTriggered) {
      pushLog(
        session,
        `🛡️ Intercept reduces the attack by ` +
          `${interceptReductionPercent}%!`,
      );
    }

    if (aegisTriggered && aegisReductionPercent > 0) {
      pushLog(
        session,
        `✨ Aegis of Faith reduces the attack by ` +
          `${aegisReductionPercent}%!`,
      );
    }

    if (aegisPreventedDeath) {
      pushLog(session, "🕊️ Aegis of Faith prevents a lethal blow!");
      if ((mitigation?.aegisHealing ?? 0) > 0) {
        pushLog(
          session,
          `💚 Undying Faith restores ${mitigation?.aegisHealing} health!`,
        );
      }
    }
    if (mitigation?.bloodweaverDeathProtectionTriggered) {
      pushLog(
        session,
        `🩸 Life Beyond Death restores you to ${mitigation.bloodweaverReviveHealing} health!`,
      );
    }
  }
  consumeActorTurn(session.enemy, 450);

  if (newHP <= 0) {
    await db.query(`DELETE FROM player_creatures WHERE player_id = ?`, [
      session.playerId,
    ]);

    session.state = "defeat";
    pushLog(session, "☠ You were slain!");
  }
}

export function getATBTimeSeconds(agility: number) {
  return getCombatATBTimeSeconds(agility);
}

export function getATBFillRate(agility: number) {
  return getCombatATBFillRate(agility);
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

  return Math.ceil(getCombatActorReadyInMs(actor, now));
}

export async function createCombatSession(
  playerId: number,
): Promise<CombatSession | null> {
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
    [playerId],
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
    healingDealtMult: 1,
    atbRateMult: 1,
    damageTakenMult: 1,
  };

  const session: CombatSession = {
    playerId,
    enemyInstanceId: Number(enemyRow.id),
    createdAt: now,
    updatedAt: now,
    nextDamageEventId: 1,
    damageEvents: [],
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
      cooldowns: {},
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
      cooldowns: {},
    },

    log: [`⚠ ${enemyRow.name ?? "Enemy"} engages you!`],
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
    advanceCombatActorGauge(actor, session.updatedAt, now);
  }

  session.updatedAt = now;

  const bannerGauge = await processWarlordBannerGaugeTick(session.playerId);
  if (bannerGauge > 0 && session.player.hp > 0) {
    session.player.gauge = Math.min(100, session.player.gauge + bannerGauge);
    session.player.ready = session.player.gauge >= 100;
  }

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

export function consumeActorTurn(actor: CombatActor, recoveryMs: number) {
  consumeCombatActorTurn(actor, recoveryMs);
}

export function isCooldownReady(actor: CombatActor, key: string) {
  return isCombatCooldownReady(actor, key);
}

export function setCooldown(actor: CombatActor, key: string, seconds: number) {
  setCombatCooldown(actor, key, seconds);
}

/**
 * Reduce every active spell cooldown except the spell that produced the
 * reduction. Item cooldowns are intentionally untouched.
 */
export function reduceOtherSpellCooldowns(
  actor: CombatActor,
  exceptSpellId: number,
  seconds: number,
) {
  reduceCombatSpellCooldowns(actor, seconds, [exceptSpellId]);
}

/**
 * Refresh an existing normal-combat DOT back to its full duration and tick
 * count. Returns true only when a matching effect existed.
 */
export async function refreshPlayerCreatureDot(
  playerCreatureId: number,
  spellId: number,
  durationSeconds: number,
): Promise<boolean> {
  const duration = Math.max(0.1, Number(durationSeconds) || 0);

  const [result]: any = await db.query(
    `
      UPDATE player_creature_dots
      SET
        ticks_applied = 0,
        next_tick_at = DATE_ADD(NOW(3), INTERVAL tick_interval SECOND),
        expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND)
      WHERE player_creature_id = ?
        AND source LIKE ?
        AND expires_at > NOW(3)
    `,
    [duration, playerCreatureId, `spell:${spellId}|%`],
  );

  return Number(result?.affectedRows || 0) > 0;
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
      readyInMs: getActorReadyInMs(session.player),
      autoAttackMs: Math.max(0, session.nextPlayerAutoAttackAt - now),
      autoAttackTotalMs: PLAYER_AUTO_ATTACK_MS,
      cooldowns: session.player.cooldowns,
    },
    enemy: {
      name: session.enemy.name,
      level: session.enemy.level,
      description: session.enemy.description,
      hp: session.enemy.hp,
      maxHp: session.enemy.maxHp,
      gauge: session.enemy.gauge,
      ready: session.enemy.ready,
      recoveryMs: Math.max(0, session.enemy.recoveryUntil - now),
      readyInMs: getActorReadyInMs(session.enemy),
    },
    damageEvents: session.damageEvents,
    log: session.log,
    rewards: session.rewards ?? null,
  };
}
