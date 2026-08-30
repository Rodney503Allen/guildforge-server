// src/services/spellHandlers/sageHandlers.ts

import { db } from "../../db";
import { applyBuff } from "../buffService";

import {
  SpellFriendlyTarget,
  SpellHandlerContext,
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  calculateScaledHealingAmount,
  getConfiguredBuff
} from "./helpers";

function rankNumber(spell: any, key: string, fallback = 0): number {
  const value = Number(spell?.rank_config?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function singleTarget(context: SpellHandlerContext): SpellFriendlyTarget {
  const targetId = Number(context.targetPlayerId ?? context.playerId);
  const targetingSelf = targetId === Number(context.playerId);
  const target = context.targetPlayer ?? context.player;

  return {
    playerId: targetId,
    name: target?.name,
    stats: target,
    hp: Math.max(
      0,
      Number(
        targetingSelf
          ? context.currentPlayerHP ?? context.player?.hpoints ?? 0
          : context.currentTargetHP ?? target?.hpoints ?? 0
      ) || 0
    ),
    maxHp: Math.max(
      1,
      Number(
        targetingSelf
          ? context.maxPlayerHP ?? context.player?.maxhp ?? 1
          : context.maxTargetHP ?? target?.maxhp ?? 1
      ) || 1
    ),
    sp: Math.max(0, Number(target?.spoints) || 0),
    maxSp: Math.max(0, Number(target?.maxspoints) || 0)
  };
}

function livingTargets(context: SpellHandlerContext): SpellFriendlyTarget[] {
  const allies = (context.allies ?? []).filter(ally => Number(ally.hp) > 0);
  return allies.length > 0 ? allies : [singleTarget(context)];
}

async function healTarget(
  target: SpellFriendlyTarget,
  caster: any,
  baseHealing: number
) {
  const scaled = calculateScaledHealingAmount(caster, baseHealing);
  const potential = applyHealingReceivedMultiplier(target.stats, scaled);
  const currentHP = Math.max(0, Number(target.hp) || 0);
  const maxHP = Math.max(1, Number(target.maxHp) || 1);
  const finalHP = Math.min(maxHP, currentHP + potential);
  const actual = Math.max(0, finalHP - currentHP);

  await db.query(
    `UPDATE players SET hpoints = ? WHERE id = ?`,
    [finalHP, target.playerId]
  );

  target.hp = finalHP;
  if (target.stats) target.stats.hpoints = finalHP;

  return {
    actual,
    potential,
    overhealing: Math.max(0, potential - actual),
    finalHP
  };
}

async function applyHot(
  target: SpellFriendlyTarget,
  caster: any,
  spell: any,
  totalHealing: number,
  sourceSuffix = ""
) {
  const duration = Math.max(0.1, Number(spell.dot_duration) || 1);
  const tickInterval = Math.max(0.1, Number(spell.dot_tick_rate) || 1);
  const totalTicks = Math.max(1, Math.floor(duration / tickInterval));
  const scaledTotal = calculateScaledHealingAmount(caster, totalHealing);
  const recipientTotal = applyHealingReceivedMultiplier(target.stats, scaledTotal);
  const healingPerTick = Math.max(1, Math.floor(recipientTotal / totalTicks));
  const source = `spell:${spell.id}${sourceSuffix}`;

  await db.query(
    `DELETE FROM player_hots WHERE player_id = ? AND source = ?`,
    [target.playerId, source]
  );

  await db.query(
    `
      INSERT INTO player_hots
        (player_id, healing, tick_interval, next_tick_at, expires_at, source, display_name)
      VALUES
        (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND),
         DATE_ADD(NOW(3), INTERVAL ? SECOND), ?, ?)
    `,
    [
      target.playerId,
      healingPerTick,
      tickInterval,
      tickInterval,
      duration,
      source,
      spell.name
    ]
  );

  return healingPerTick * totalTicks;
}

async function bloomPlayerHots(
  playerId: number,
  bloomTicks: number,
  extensionSeconds: number
) {
  const [rows]: any = await db.query(
    `
      SELECT ph.healing, p.hpoints, p.maxhp
      FROM player_hots ph
      JOIN players p ON p.id = ph.player_id
      WHERE ph.player_id = ?
        AND ph.expires_at > NOW(3)
    `,
    [playerId]
  );

  const currentHP = Math.max(0, Number(rows?.[0]?.hpoints) || 0);
  const maxHP = Math.max(1, Number(rows?.[0]?.maxhp) || 1);
  const rawBloom = (rows ?? []).reduce(
    (sum: number, row: any) => sum + Math.max(0, Number(row.healing) || 0),
    0
  ) * Math.max(0, bloomTicks);
  const finalHP = Math.min(maxHP, currentHP + rawBloom);
  const actualHealing = Math.max(0, finalHP - currentHP);

  if (actualHealing > 0) {
    await db.query(`UPDATE players SET hpoints = ? WHERE id = ?`, [finalHP, playerId]);
  }

  if (extensionSeconds > 0) {
    await db.query(
      `
        UPDATE player_hots
        SET expires_at = DATE_ADD(expires_at, INTERVAL ? SECOND)
        WHERE player_id = ?
          AND expires_at > NOW(3)
      `,
      [extensionSeconds, playerId]
    );
  }

  return {
    actualHealing,
    activeHots: (rows ?? []).length,
    finalHP
  };
}

async function acceleratePlayerHots(playerId: number, percent: number) {
  const multiplier = Math.max(0.1, 1 - Math.max(0, percent) / 100);
  const [rows]: any = await db.query(
    `
      SELECT id, tick_interval
      FROM player_hots
      WHERE player_id = ?
        AND expires_at > NOW(3)
    `,
    [playerId]
  );

  for (const row of rows ?? []) {
    const newInterval = Math.max(0.1, Number(row.tick_interval || 1) * multiplier);
    await db.query(
      `
        UPDATE player_hots
        SET tick_interval = ?,
            next_tick_at = LEAST(
              next_tick_at,
              DATE_ADD(NOW(3), INTERVAL ? SECOND)
            )
        WHERE id = ?
      `,
      [newInterval, newInterval, row.id]
    );
  }

  return (rows ?? []).length;
}

export const naturesTouchHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    return (Number(spell.heal) || 0) > 0
      ? null
      : `${spell.name} has invalid healing configuration`;
  },

  async execute(context): Promise<SpellHandlerResult> {
    const target = singleTarget(context);
    const healing = await healTarget(target, context.player, Number(context.spell.heal));
    const gauge = Math.max(0, rankNumber(context.spell, "casterGaugeGain", 8));

    return {
      log: `🌿 ${context.spell.name} restores ${healing.actual} HP and grants ${gauge} action gauge!`,
      healing: healing.actual,
      potentialHealing: healing.potential,
      overhealing: healing.overhealing,
      healedTargetId: target.playerId,
      healedTargetMaxHP: target.maxHp,
      healedTargetHPAfter: healing.finalHP,
      casterGaugeGain: gauge
    };
  }
};

export const rejuvenationHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    if ((Number(spell.heal) || 0) <= 0) return `${spell.name} has invalid healing`;
    if ((Number(spell.dot_duration) || 0) <= 0) return `${spell.name} has invalid duration`;
    if ((Number(spell.dot_tick_rate) || 0) <= 0) return `${spell.name} has invalid tick rate`;
    return null;
  },

  async execute(context): Promise<SpellHandlerResult> {
    const target = singleTarget(context);
    const expectedHealing = await applyHot(
      target,
      context.player,
      context.spell,
      Number(context.spell.heal)
    );

    return {
      log: `🌱 ${context.spell.name} will restore up to ${expectedHealing} HP over ${context.spell.dot_duration}s!`,
      healing: 0,
      expectedHotHealing: expectedHealing,
      hotHealingPerTick: Math.max(
        1,
        Math.floor(
          expectedHealing /
          Math.max(
            1,
            Math.floor(
              Number(context.spell.dot_duration) /
              Number(context.spell.dot_tick_rate)
            )
          )
        )
      ),
      hotDuration: Number(context.spell.dot_duration),
      healedTargetId: target.playerId,
      healedTargetMaxHP: target.maxHp,
      appliedStatus: true
    };
  }
};

export const herbalRemedyHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);
    if (buff.stat !== "cleanse_physical") return `${spell.name} must use cleanse_physical`;
    if ((Number(spell.heal) || 0) <= 0) return `${spell.name} has invalid healing`;
    return null;
  },

  async execute(context): Promise<SpellHandlerResult> {
    const allTargets = String(context.spell.target_type).toLowerCase() === "all_allies";
    const targets = allTargets ? livingTargets(context) : [singleTarget(context)];
    const primaryId = Number(context.targetPlayerId ?? context.playerId);
    const secondaryPercent = Math.max(0, rankNumber(context.spell, "secondaryHealingPercent", 60));
    const cleanseAll = Boolean(context.spell.rank_config?.cleanseAllRemovable);
    let cleansedCount = 0;
    let totalHealing = 0;
    let totalPotential = 0;
    let totalOverhealing = 0;
    const cleansedTargetIds: number[] = [];
    const targetGaugeGains: Array<{ playerId: number; amount: number }> = [];

    for (const target of targets) {
      let targetCleansed = 0;

    const [buffResult]: any = await db.query(
      `
        DELETE FROM player_buffs
        WHERE player_id = ?
          AND value < 0
          AND ( ? = 1 OR
            source LIKE 'poison:%' OR source LIKE 'bleed:%'
            OR source LIKE 'disease:%' OR source LIKE 'physical:%'
          )
      `,
      [target.playerId, cleanseAll ? 1 : 0]
    );
    targetCleansed += Number(buffResult.affectedRows) || 0;

    const [statusResult]: any = await db.query(
      `
        DELETE FROM player_status_effects
        WHERE player_id = ?
          AND effect_key IN (
            'poison', 'bleed', 'disease', 'physical_debuff',
            'curse', 'magic_debuff', 'silence', 'stun', 'root', 'slow'
          )
          AND (? = 1 OR effect_key IN ('poison', 'bleed', 'disease', 'physical_debuff'))
      `,
      [target.playerId, cleanseAll ? 1 : 0]
    );
    targetCleansed += Number(statusResult.affectedRows) || 0;

    const baseHeal = Number(context.spell.heal) * (
      allTargets && target.playerId !== primaryId ? secondaryPercent / 100 : 1
    );
    const healing = await healTarget(target, context.player, baseHeal);
    const gauge = targetCleansed > 0
      ? Math.max(0, rankNumber(context.spell, "successfulCleanseTargetGaugeGain", 10))
      : 0;

    cleansedCount += targetCleansed;
    totalHealing += healing.actual;
    totalPotential += healing.potential;
    totalOverhealing += healing.overhealing;
    if (targetCleansed > 0) cleansedTargetIds.push(target.playerId);
    if (gauge > 0) targetGaugeGains.push({ playerId: target.playerId, amount: gauge });
    }

    return {
      log: cleansedCount > 0
        ? `🌿 ${context.spell.name} restores ${totalHealing} HP and cleanses ${cleansedCount} ailment${cleansedCount === 1 ? "" : "s"}.`
        : `🌿 ${context.spell.name} restores ${totalHealing} HP, but finds no removable ailments.`,
      healing: totalHealing,
      potentialHealing: totalPotential,
      overhealing: totalOverhealing,
      healedTargetId: primaryId,
      targetGaugeGain: targetGaugeGains.find(gain => gain.playerId === primaryId)?.amount ?? 0,
      targetGaugePlayerId: primaryId,
      targetGaugeGains,
      cleansedCount,
      cleansedTargetIds,
      healedPlayerIds: targets.map(target => target.playerId),
      appliedStatus: cleansedCount > 0
    };
  }
};

export const tranquilityHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    return (Number(spell.heal) || 0) > 0
      ? null
      : `${spell.name} has invalid healing configuration`;
  },

  async execute(context): Promise<SpellHandlerResult> {
    const targets = livingTargets(context);
    let totalHealing = 0;

    for (const target of targets) {
      totalHealing += (await healTarget(target, context.player, Number(context.spell.heal))).actual;
    }

    return {
      log: `🌊 ${context.spell.name} restores ${totalHealing} total HP across ${targets.length} living ${targets.length === 1 ? "ally" : "allies"}!`,
      healing: totalHealing,
      healedPlayerIds: targets.map(target => target.playerId)
    };
  }
};

export const flourishHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);
    if (buff.stat !== "healing_received_pct") return `${spell.name} must use healing_received_pct`;
    if (buff.value <= 0 || buff.duration <= 0) return `${spell.name} has invalid buff configuration`;
    return null;
  },

  async execute(context): Promise<SpellHandlerResult> {
    const targets = livingTargets(context);
    const buff = getConfiguredBuff(context.spell);
    const bloomTicks = Math.max(0, rankNumber(context.spell, "hotBloomTicks", 1));
    const extension = Math.max(0, rankNumber(context.spell, "hotDurationExtensionSeconds", 4));
    let totalBloomHealing = 0;
    let bloomedHots = 0;
    const bloomHealingByTarget: Record<number, number> = {};
    const activeHotsByTarget: Record<number, number> = {};
    const chainRequired = Math.max(0, rankNumber(context.spell, "chainBloomRequiredHots", 0));
    const chainTicks = Math.max(0, rankNumber(context.spell, "chainBloomAdditionalTicks", 0));
    const sharedRenewalPercent = Math.max(0, rankNumber(context.spell, "sharedRenewalPercent", 0));

    let rejuvenation: any = null;
    if (sharedRenewalPercent > 0) {
      const [[row]]: any = await db.query(
        `SELECT s.id, s.name,
                COALESCE(sr.heal, s.heal) AS heal,
                COALESCE(sr.dot_duration, s.dot_duration) AS dot_duration,
                COALESCE(sr.dot_tick_rate, s.dot_tick_rate) AS dot_tick_rate
         FROM spells s
         LEFT JOIN player_spells ps ON ps.player_id = ? AND ps.spell_id = s.id
         LEFT JOIN spell_ranks sr ON sr.spell_id = s.id
           AND sr.spell_rank = COALESCE(ps.skill_level, 1)
         WHERE s.id = 68 LIMIT 1`,
        [context.playerId]
      );
      rejuvenation = row ?? null;
    }

    for (const target of targets) {
      const bloom = await bloomPlayerHots(target.playerId, bloomTicks, extension);
      let targetBloomHealing = bloom.actualHealing;
      if (chainTicks > 0 && bloom.activeHots >= chainRequired) {
        const chain = await bloomPlayerHots(target.playerId, chainTicks, 0);
        targetBloomHealing += chain.actualHealing;
        bloom.finalHP = chain.finalHP;
      }
      totalBloomHealing += targetBloomHealing;
      bloomedHots += bloom.activeHots;
      bloomHealingByTarget[target.playerId] = targetBloomHealing;
      activeHotsByTarget[target.playerId] = bloom.activeHots;
      target.hp = bloom.finalHP || target.hp;

      await applyBuff(
        target.playerId,
        buff.stat,
        buff.value,
        buff.duration,
        `spell:${context.spell.id}`
      );

      if (rejuvenation) {
        const [[existing]]: any = await db.query(
          `SELECT id FROM player_hots WHERE player_id = ? AND source = 'spell:68' AND expires_at > NOW(3) LIMIT 1`,
          [target.playerId]
        );
        if (!existing) {
          await applyHot(
            target,
            context.player,
            rejuvenation,
            Number(rejuvenation.heal) * sharedRenewalPercent / 100
          );
        }
      }
    }

    return {
      log: `🌸 ${context.spell.name} blooms ${bloomedHots} active regeneration effect${bloomedHots === 1 ? "" : "s"} for ${totalBloomHealing} immediate healing, extends them by ${extension}s, and grants ${buff.value}% increased healing received!`,
      healing: totalBloomHealing,
      appliedStatus: true,
      bloomHealingByTarget,
      activeHotsByTarget,
      healedPlayerIds: targets.map(target => target.playerId)
    };
  }
};

export const harmonyOfTheWildHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    if ((Number(spell.heal) || 0) <= 0) return `${spell.name} has invalid immediate healing`;
    if ((Number(spell.dot_duration) || 0) <= 0) return `${spell.name} has invalid HOT duration`;
    if ((Number(spell.dot_tick_rate) || 0) <= 0) return `${spell.name} has invalid HOT interval`;
    if (rankNumber(spell, "hotTotalHealing", 0) <= 0) return `${spell.name} has invalid HOT healing`;
    return null;
  },

  async execute(context): Promise<SpellHandlerResult> {
    const targets = livingTargets(context);
    const bloomTicks = Math.max(0, rankNumber(context.spell, "hotBloomTicks", 1));
    const acceleration = Math.max(0, rankNumber(context.spell, "hotAccelerationPercent", 25));
    const hotTotal = Math.max(1, rankNumber(context.spell, "hotTotalHealing", 80));
    const partyGaugeGain = Math.max(0, rankNumber(context.spell, "partyGaugeGain", 20));
    let immediateHealing = 0;
    let bloomHealing = 0;
    let expectedHotHealing = 0;
    let acceleratedHots = 0;

    for (const target of targets) {
      const bloom = await bloomPlayerHots(target.playerId, bloomTicks, 0);
      bloomHealing += bloom.actualHealing;
      target.hp = bloom.finalHP || target.hp;

      acceleratedHots += await acceleratePlayerHots(target.playerId, acceleration);

      const direct = await healTarget(target, context.player, Number(context.spell.heal));
      immediateHealing += direct.actual;

      expectedHotHealing += await applyHot(
        target,
        context.player,
        context.spell,
        hotTotal,
        ":harmony"
      );
    }

    return {
      log: `🌿 ${context.spell.name} restores ${immediateHealing + bloomHealing} immediate HP, grants up to ${expectedHotHealing} regeneration, accelerates ${acceleratedHots} active HoT${acceleratedHots === 1 ? "" : "s"}, and advances the party by ${partyGaugeGain} action gauge!`,
      healing: immediateHealing + bloomHealing,
      expectedHotHealing,
      partyGaugeGain,
      appliedStatus: true,
      healedPlayerIds: targets.map(target => target.playerId)
    };
  }
};
