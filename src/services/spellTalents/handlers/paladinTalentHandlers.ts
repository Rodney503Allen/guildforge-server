import type {
  SpellHandlerResult
} from "../../spellHandlers/types";

import { applyBuff } from "../../buffService";
import { db } from "../../../db";
import {
  applyHealingReceivedMultiplier,
  calculateScaledSpellAmount
} from "../../spellHandlers/helpers";

import type {
  SpellTalentHandler,
  TalentConfig
} from "../types";


type RallyingStrikeConfig = TalentConfig & {
  gaugeGain?: number;
};

function requirePositiveConfigNumber(
  config: TalentConfig,
  key: string,
  errorCode: string
): number {
  const value = Number(config[key]);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(errorCode);
  }

  return value;
}


function getGaugeGain(
  config: RallyingStrikeConfig
): number {
  const gaugeGain =
    Number(
      config.gaugeGain
    );


  if (
    !Number.isFinite(
      gaugeGain
    ) ||
    gaugeGain <= 0
  ) {
    throw new Error(
      "PALADIN_RALLYING_STRIKE_INVALID_GAUGE_GAIN"
    );
  }


  return Math.min(
    100,
    gaugeGain
  );
}


/**
 * Rallying Strike
 *
 * After Sacred Strike resolves, advance the action gauge of the
 * caster's combat group.
 *
 * World Combat has one player actor, so only the caster advances.
 * Hunt Combat applies partyGaugeGain to every living participant.
 * Future party combat modes can honor the same handler result.
 */
export const rallyingStrikeTalentHandler:
SpellTalentHandler = {
  afterCast(
    { talent },
    result
  ): SpellHandlerResult {
    const gaugeGain =
      getGaugeGain(
        talent.config as RallyingStrikeConfig
      );


    return {
      ...result,

      partyGaugeGain:
        Math.min(
          100,
          Math.max(
            0,
            Number(
              result.partyGaugeGain
            ) || 0
          ) +
          gaugeGain
        )
    };
  }
};

/** Add flat threat to Sacred Strike after its base handler resolves. */
export const righteousChallengeTalentHandler:
SpellTalentHandler = {
  afterCast({ talent }, result): SpellHandlerResult {
    const bonusThreat = requirePositiveConfigNumber(
      talent.config,
      "bonusThreat",
      "PALADIN_RIGHTEOUS_CHALLENGE_INVALID_BONUS_THREAT"
    );

    return {
      ...result,
      threatGenerated:
        Math.max(0, Number(result.threatGenerated) || 0) + bonusThreat
    };
  }
};

/** Grant the caster short personal mitigation after Sacred Strike. */
export const steadfastJudgmentTalentHandler:
SpellTalentHandler = {
  async afterCast(
    { playerId, spell, talent },
    result
  ): Promise<SpellHandlerResult> {
    const damageReductionPercent = requirePositiveConfigNumber(
      talent.config,
      "damageReductionPercent",
      "PALADIN_STEADFAST_JUDGMENT_INVALID_REDUCTION"
    );
    const durationSeconds = requirePositiveConfigNumber(
      talent.config,
      "durationSeconds",
      "PALADIN_STEADFAST_JUDGMENT_INVALID_DURATION"
    );

    await applyBuff(
      playerId,
      "damage_reduction",
      damageReductionPercent,
      durationSeconds,
      `talent:${talent.id}:spell:${spell.id}`
    );

    return {
      ...result,
      appliedStatus: true
    };
  }
};

/** Double flat bonus threat and amplify the damage-derived portion. */
export const overwhelmingPresenceTalentHandler:
SpellTalentHandler = {
  afterCast({ talent }, result): SpellHandlerResult {
    const bonusThreatMultiplier = requirePositiveConfigNumber(
      talent.config,
      "bonusThreatMultiplier",
      "PALADIN_OVERWHELMING_PRESENCE_INVALID_BONUS_MULTIPLIER"
    );
    const damageThreatMultiplier = requirePositiveConfigNumber(
      talent.config,
      "damageThreatMultiplier",
      "PALADIN_OVERWHELMING_PRESENCE_INVALID_DAMAGE_MULTIPLIER"
    );

    return {
      ...result,
      threatGenerated:
        Math.max(0, Number(result.threatGenerated) || 0) *
        bonusThreatMultiplier,
      threatMultiplier:
        Math.max(0, Number(result.threatMultiplier) || 1) *
        damageThreatMultiplier
    };
  }
};

/** Sacred Strike critical hits weaken the enemy's outgoing damage. */
export const blindingRadianceTalentHandler:
SpellTalentHandler = {
  async afterCast(
    { playerId, spell, enemy, talent },
    result
  ): Promise<SpellHandlerResult> {
    if (!result.crit || !enemy?.applyDebuff) {
      return result;
    }

    const damageReductionPercent = requirePositiveConfigNumber(
      talent.config,
      "damageReductionPercent",
      "PALADIN_BLINDING_RADIANCE_INVALID_REDUCTION"
    );
    const durationSeconds = requirePositiveConfigNumber(
      talent.config,
      "durationSeconds",
      "PALADIN_BLINDING_RADIANCE_INVALID_DURATION"
    );

    await enemy.applyDebuff({
      sourcePlayerId: playerId,
      spellId: Number(spell.id),
      spellName: String(spell.name),
      stat: "damage_dealt_pct",
      value: -damageReductionPercent,
      durationSeconds
    });

    return {
      ...result,
      appliedStatus: true
    };
  }
};

function configNumber(config: TalentConfig, key: string, fallback = 0): number {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
}

function livingAllies(context: any) {
  return context.allies?.filter((ally: any) => Number(ally.hp) > 0) ?? [{
    playerId: context.playerId,
    hp: Number(context.currentPlayerHP ?? context.player?.hpoints ?? 0),
    maxHp: Number(context.maxPlayerHP ?? context.player?.maxhp ?? 1),
    sp: Number(context.currentPlayerSP ?? context.player?.spoints ?? 0),
    maxSp: Number(context.maxPlayerSP ?? context.player?.maxspoints ?? 0)
  }];
}

function friendlyTargetId(context: any, result: SpellHandlerResult): number {
  const id = Number(
    result.shieldTargetId ??
    result.healedTargetId ??
    context.targetPlayerId ??
    context.playerId
  );
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("PALADIN_TALENT_INVALID_FRIENDLY_TARGET");
  }
  return id;
}

function positiveDuration(value: unknown, fallback: unknown): number {
  const duration = Number(value) || Number(fallback) || 1;
  return Math.max(1, duration);
}

async function upsertShield(playerId: number, amount: number, duration: number, source: string) {
  const expiresAt = new Date(Date.now() + duration * 1000);
  await db.query(`
    INSERT INTO player_shields
      (player_id, max_absorb, remaining_absorb, expires_at, source)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      max_absorb = VALUES(max_absorb),
      remaining_absorb = VALUES(remaining_absorb),
      expires_at = VALUES(expires_at)
  `, [playerId, amount, amount, expiresAt, source]);
}

async function upsertStatus(
  playerId: number,
  effectKey: string,
  charges: number,
  value: number,
  duration: number,
  source: string
) {
  const expiresAt = new Date(Date.now() + duration * 1000);
  await db.query(`
    INSERT INTO player_status_effects
      (player_id, effect_key, charges, value, expires_at, source)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      charges = VALUES(charges), value = VALUES(value), expires_at = VALUES(expires_at)
  `, [playerId, effectKey, charges, value, expiresAt, source]);
}

export const guardianBondTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const { playerId, spell, talent } = context;
    const targetId = friendlyTargetId(context, result);
    const duration = positiveDuration(result.shieldDuration, spell.buff_duration);
    const targetingSelf = result.targetingSelf ?? targetId === Number(playerId);
    if (targetingSelf) {
      await applyBuff(playerId, "damage_reduction", configNumber(talent.config, "selfReductionPercent", 10), duration, `talent:${talent.id}`);
    } else {
      const targetMaxHp = Number(context.maxTargetHP ?? context.maxPlayerHP ?? 1) || 1;
      const originalShield = Number(result.shieldAmount) || Math.max(1, Math.floor(targetMaxHp * (Number(spell.buff_value) || 0) / 100));
      const amount = Math.max(1, Math.floor(originalShield * configNumber(talent.config, "sharedShieldPercent", 50) / 100));
      await upsertShield(playerId, amount, duration, `talent:${talent.id}:bond`);
    }
    return { ...result, appliedStatus: true };
  }
};

export const radiantBarrierTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const { spell, talent } = context;
    const targetId = friendlyTargetId(context, result);
    const duration = positiveDuration(result.shieldDuration, spell.buff_duration);
    await applyBuff(targetId, "damage_dealt_pct", configNumber(talent.config, "damagePercent", 10), duration, `shield:spell:${spell.id}`);
    return { ...result, appliedStatus: true };
  }
};

export const sharedSanctuaryTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const { playerId, talent, spell } = context;
    const targetId = friendlyTargetId(context, result);
    const duration = positiveDuration(result.shieldDuration, spell.buff_duration);
    const value = configNumber(talent.config, "healingReceivedPercent", 15);
    await Promise.all(Array.from(new Set([playerId, targetId])).map(id =>
      applyBuff(id, "healing_received_pct", value, duration, `talent:${talent.id}:shield`)
    ));
    return { ...result, appliedStatus: true };
  }
};

export const defendersCallingTalentHandler: SpellTalentHandler = {
  afterCast({ talent }, result) {
    return {
      ...result,
      threatGenerated: (Number(result.threatGenerated) || 0) + configNumber(talent.config, "bonusThreat", 50),
      casterGaugeGain: (Number(result.casterGaugeGain) || 0) + configNumber(talent.config, "gaugeGain", 10)
    };
  }
};

export const inspiringConsecrationTalentHandler: SpellTalentHandler = {
  afterCast({ talent }, result) {
    return { ...result, partyGaugeGain: (Number(result.partyGaugeGain) || 0) + configNumber(talent.config, "gaugeGain", 10) };
  }
};

export const sacredChallengeTalentHandler: SpellTalentHandler = {
  async afterCast({ playerId, spell, talent }, result) {
    await applyBuff(playerId, "threat_generation_pct", configNumber(talent.config, "threatPercent", 50), Number(spell.buff_duration), `spell:${spell.id}:challenge`);
    return { ...result, appliedStatus: true };
  }
};

export const crusadersZealTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    await Promise.all(livingAllies(context).map((a: any) =>
      applyBuff(a.playerId, "crit_damage", configNumber(context.talent.config, "critDamagePercent", 20), Number(context.spell.buff_duration), `talent:${context.talent.id}:zeal`)
    ));
    return { ...result, appliedStatus: true };
  }
};

export const invigoratingLightTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const percent = configNumber(context.talent.config, "manaPercent", 10);
    let restored = 0;
    await Promise.all(livingAllies(context).map(async (ally: any) => {
      const amount = Math.max(0, Math.floor(Number(ally.maxSp) * percent / 100));
      const actual = Math.max(0, Math.min(Number(ally.maxSp), Number(ally.sp) + amount) - Number(ally.sp));
      restored += actual;
      if (actual > 0) await db.query(`UPDATE players SET spoints = LEAST(?, spoints + ?) WHERE id = ?`, [ally.maxSp, actual, ally.playerId]);
    }));
    return { ...result, manaRestored: restored };
  }
};

export const savingGraceTalentHandler: SpellTalentHandler = {
  beforeCast(context) {
    const hp = Number(context.currentTargetHP ?? context.currentPlayerHP ?? 0);
    const maxHp = Math.max(1, Number(context.maxTargetHP ?? context.maxPlayerHP ?? 1));
    if (hp / maxHp < configNumber(context.talent.config, "healthThresholdPercent", 35) / 100) {
      context.spell.heal = Math.round(Number(context.spell.heal) * (1 + configNumber(context.talent.config, "healingPercent", 35) / 100));
    }
  }
};

export const overflowingGraceTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const { spell, talent } = context;
    const recipient = context.targetPlayer ?? context.player;
    const maximumHP = Math.max(
      1,
      Number(
        result.healedTargetMaxHP ??
        context.maxTargetHP ??
        context.maxPlayerHP ??
        recipient?.maxhp ??
        recipient?.maxHp
      ) || 1
    );

    const reportedOverhealing = Number(result.overhealing);
    const potentialHealing = applyHealingReceivedMultiplier(
      recipient,
      calculateScaledSpellAmount(context.player, Number(spell.heal) || 0)
    );
    const overhealing = Number.isFinite(reportedOverhealing)
      ? Math.max(0, reportedOverhealing)
      : Math.max(0, potentialHealing - (Number(result.healing) || 0));

    const cap = Math.floor(
      maximumHP * configNumber(talent.config, "maxHpCapPercent", 15) / 100
    );
    const amount = Math.min(cap, overhealing);
    if (amount > 0) await upsertShield(friendlyTargetId(context, result), amount, positiveDuration(result.protectionDuration, spell.buff_duration), `talent:${talent.id}:overflow`);
    return { ...result, overflowShield: amount, appliedStatus: result.appliedStatus || amount > 0 };
  }
};

export const sharedGraceTalentHandler: SpellTalentHandler = {
  async afterCast({ playerId, spell, talent }, result) {
    if (!result.targetingSelf) {
      await applyBuff(playerId, "damage_reduction", Number(result.protectionValue), Number(result.protectionDuration), `talent:${talent.id}:self`);
    }
    return { ...result, appliedStatus: true };
  }
};

export const rallyBeneathShieldTalentHandler: SpellTalentHandler = {
  afterCast({ talent }, result) {
    return { ...result, partyGaugeGain: (Number(result.partyGaugeGain) || 0) + configNumber(talent.config, "gaugeGain", 15) };
  }
};

export const layeredBulwarkTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const duration = Number(context.spell.buff_duration);
    const percent = configNumber(context.talent.config, "shieldMaxHpPercent", 10);
    await Promise.all(livingAllies(context).map((ally: any) => upsertShield(ally.playerId, Math.max(1, Math.floor(ally.maxHp * percent / 100)), duration, `talent:${context.talent.id}:bulwark`)));
    return { ...result, appliedStatus: true };
  }
};

export const lastBastionTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const threshold = configNumber(context.talent.config, "healthThresholdPercent", 50) / 100;
    const bonus = configNumber(context.talent.config, "additionalReductionPercent", 10);
    await Promise.all(livingAllies(context).filter((a: any) => a.hp / Math.max(1, a.maxHp) < threshold).map((a: any) =>
      applyBuff(a.playerId, "damage_reduction", bonus, Number(context.spell.buff_duration), `talent:${context.talent.id}:bastion`)
    ));
    return { ...result, appliedStatus: true };
  }
};

export const marchingBulwarkTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    await Promise.all(livingAllies(context).map((a: any) => applyBuff(a.playerId, "damage_dealt_pct", configNumber(context.talent.config, "damagePercent", 10), Number(context.spell.buff_duration), `talent:${context.talent.id}:march`)));
    return { ...result, appliedStatus: true };
  }
};

export const undyingFaithTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const charges = Math.max(1, Math.floor(Number(context.spell.buff_value) || 1));
    await Promise.all(livingAllies(context).map((a: any) => upsertStatus(a.playerId, "aegis_trigger_heal_pct", charges, configNumber(context.talent.config, "maxHpHealPercent", 30), Number(context.spell.buff_duration), `talent:${context.talent.id}`)));
    return { ...result, appliedStatus: true };
  }
};

export const divineAscendanceTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const percent = configNumber(context.talent.config, "resourcePercent", 20);
    await Promise.all(livingAllies(context).map(async (a: any) => {
      const hp = Math.floor(a.maxHp * percent / 100);
      const sp = Math.floor(a.maxSp * percent / 100);
      await db.query(`UPDATE players SET hpoints = LEAST(?, hpoints + ?), spoints = LEAST(?, spoints + ?) WHERE id = ?`, [a.maxHp, hp, a.maxSp, sp, a.playerId]);
    }));
    return { ...result, appliedStatus: true };
  }
};

export const unbrokenSpiritTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    const packedValue = configNumber(context.talent.config, "reductionPercent", 25) * 1000 + configNumber(context.talent.config, "durationSeconds", 8);
    const charges = Math.max(1, Math.floor(Number(context.spell.buff_value) || 1));
    await Promise.all(livingAllies(context).map((a: any) => upsertStatus(a.playerId, "aegis_trigger_reduction", charges, packedValue, Number(context.spell.buff_duration), `talent:${context.talent.id}`)));
    return { ...result, appliedStatus: true };
  }
};

export const avengingFaithTalentHandler: SpellTalentHandler = {
  async afterCast(context, result) {
    await Promise.all(livingAllies(context).map((a: any) => applyBuff(a.playerId, "damage_dealt_pct", configNumber(context.talent.config, "damagePercent", 25), Number(context.spell.buff_duration), `talent:${context.talent.id}:avenging`)));
    return { ...result, appliedStatus: true };
  }
};
