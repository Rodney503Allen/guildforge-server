import { db } from "../../../db";
import { applyBuff } from "../../buffService";
import type { SpellTalentHandler, TalentConfig } from "../types";

const number = (config: TalentConfig, key: string, fallback = 0): number => {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
};

const rankConfig = (context: any): Record<string, any> => {
  if (!context.spell.rank_config || typeof context.spell.rank_config !== "object") {
    context.spell.rank_config = {};
  }
  return context.spell.rank_config;
};

const maximumHP = (context: any, playerId: number): number => {
  if (Number(playerId) === Number(context.playerId)) {
    return Math.max(1, Number(context.maxPlayerHP ?? context.player?.maxhp ?? 1));
  }
  const ally = (context.allies ?? []).find((entry: any) => Number(entry.playerId) === Number(playerId));
  return Math.max(1, Number(ally?.maxHp ?? ally?.stats?.maxhp ?? 1));
};

const currentHP = (context: any, playerId: number): number => {
  if (Number(playerId) === Number(context.playerId)) {
    return Math.max(0, Number(context.currentPlayerHP ?? context.player?.hpoints ?? 0));
  }
  const ally = (context.allies ?? []).find((entry: any) => Number(entry.playerId) === Number(playerId));
  return Math.max(0, Number(ally?.hp ?? ally?.stats?.hpoints ?? 0));
};

const targetId = (context: any, result?: any): number =>
  Number(result?.protectedPlayerId ?? result?.shieldedTargetId ?? context.targetPlayerId ?? context.playerId);

const livingAllies = (context: any): any[] => {
  const allies = (context.allies ?? []).filter((ally: any) => Number(ally.hp) > 0);
  return allies.length > 0
    ? allies
    : [{ playerId: context.playerId, hp: currentHP(context, context.playerId), maxHp: maximumHP(context, context.playerId) }];
};

async function status(
  playerId: number,
  effectKey: string,
  value: number,
  charges: number,
  seconds: number,
  source: string
): Promise<void> {
  await db.query(
    `INSERT INTO player_status_effects
       (player_id,effect_key,value,charges,expires_at,source)
     VALUES (?,?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
     ON DUPLICATE KEY UPDATE
       value=VALUES(value),charges=VALUES(charges),
       expires_at=VALUES(expires_at),source=VALUES(source)`,
    [playerId, effectKey, value, Math.max(1, Math.floor(charges)), Math.max(1, Math.floor(seconds)), source]
  );
}

async function shield(
  playerId: number,
  amount: number,
  seconds: number,
  source: string
): Promise<number> {
  const absorb = Math.max(1, Math.floor(amount));
  await db.query(
    `INSERT INTO player_shields
       (player_id,max_absorb,remaining_absorb,expires_at,source)
     VALUES (?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
     ON DUPLICATE KEY UPDATE
       max_absorb=VALUES(max_absorb),remaining_absorb=VALUES(remaining_absorb),
       expires_at=VALUES(expires_at)`,
    [playerId, absorb, absorb, Math.max(1, Math.floor(seconds)), source]
  );
  return absorb;
}

export const knightTalentHandlers: Record<string, SpellTalentHandler> = {
  knight_provoking_blow: {
    modifySpell(context) {
      const config = rankConfig(context);
      config.bonusThreat = Math.round(
        Number(config.bonusThreat || 0) *
        (1 + number(context.talent.config, "bonusThreatPercent", 50) / 100)
      );
    },
    afterCast(context, result) {
      return result.dodged ? result : { ...result, forceThreatTargetPlayerId: context.playerId };
    }
  },

  knight_shieldbreaker: {
    modifySpell(context) {
      context.spell.damage = Math.round(
        Number(context.spell.damage || 0) *
        (1 + number(context.talent.config, "damagePercent", 40) / 100)
      );
    }
  },

  knight_concussive_impact: {
    afterCast(context, result) {
      if (result.dodged) return result;
      return {
        ...result,
        enemyGaugeReduction:
          (Number(result.enemyGaugeReduction) || 0) +
          number(context.talent.config, "additionalGaugeReduction", 15)
      };
    }
  },

  knight_suppressive_blow: {
    modifySpell(context) {
      context.spell.debuff_value =
        Number(context.spell.debuff_value || 0) +
        number(context.talent.config, "additionalReductionPoints", 10);
      context.spell.debuff_duration =
        Number(context.spell.debuff_duration || 0) +
        number(context.talent.config, "additionalDurationSeconds", 4);
    }
  },

  knight_reverberating_bash: {
    afterCast(context, result) {
      return result.dodged
        ? result
        : { ...result, splashDamagePercent: number(context.talent.config, "splashPercent", 50) };
    }
  },

  knight_retaliatory_guard: {
    async afterCast(context, result) {
      if (result.dodged) return result;
      const amount = await shield(
        context.playerId,
        maximumHP(context, context.playerId) * number(context.talent.config, "shieldMaxHpPercent", 10) / 100,
        number(context.talent.config, "durationSeconds", 8),
        `talent:${context.talent.id}:retaliatory_guard`
      );
      return { ...result, appliedStatus: true, absorbShield: amount };
    }
  },

  knight_guardians_oath: {
    modifySpell(context) {
      context.spell.buff_value =
        Number(context.spell.buff_value || 0) +
        number(context.talent.config, "additionalReductionPoints", 5);
    }
  },

  knight_watchful_protector: {
    async afterCast(context, result) {
      const protectedId = targetId(context, result);
      const amount = await shield(
        protectedId,
        maximumHP(context, protectedId) * number(context.talent.config, "shieldMaxHpPercent", 12) / 100,
        Number(context.spell.buff_duration || 1),
        `spell:${context.spell.id}:watchful_guard`
      );
      return { ...result, appliedStatus: true, absorbShield: amount, shieldedTargetId: protectedId };
    }
  },

  knight_shared_vigil: {
    modifySpell(context) {
      rankConfig(context).casterReductionPercent =
        number(context.talent.config, "casterReductionPercent", 100);
    }
  },

  knight_enduring_oath: {
    modifySpell(context) {
      context.spell.buff_duration =
        Number(context.spell.buff_duration || 0) +
        number(context.talent.config, "additionalDurationSeconds", 6);
    }
  },

  knight_emergency_safeguard: {
    async afterCast(context, result) {
      const protectedId = targetId(context, result);
      const threshold = number(context.talent.config, "healthThresholdPercent", 40) / 100;
      if (currentHP(context, protectedId) / maximumHP(context, protectedId) >= threshold) return result;
      const amount = await shield(
        protectedId,
        maximumHP(context, protectedId) * number(context.talent.config, "shieldMaxHpPercent", 22) / 100,
        Number(context.spell.buff_duration || 1),
        `spell:${context.spell.id}:watchful_guard`
      );
      return { ...result, appliedStatus: true, absorbShield: amount, shieldedTargetId: protectedId };
    }
  },

  knight_vengeful_guardian: {
    async afterCast(context, result) {
      const protectedId = targetId(context, result);
      await status(
        protectedId,
        "knight_thorns_pct",
        number(context.talent.config, "thornsPercent", 25),
        99,
        Number(context.spell.buff_duration || 1),
        `talent:${context.talent.id}:guard`
      );
      return result;
    }
  },

  knight_reinforced_bulwark: {
    modifySpell(context) {
      const config = rankConfig(context);
      config.shieldMaxHpPercent = Number(config.shieldMaxHpPercent || 0) *
        (1 + number(context.talent.config, "shieldIncreasePercent", 40) / 100);
    }
  },

  knight_defiant_stance: {
    modifySpell(context) {
      const config = rankConfig(context);
      const multiplier = Math.max(1, Number(config.threatMultiplier || 1));
      config.threatMultiplier = multiplier + number(context.talent.config, "additionalThreatPoints", 50) / 100;
      context.spell.buff_value =
        Number(context.spell.buff_value || 0) +
        number(context.talent.config, "additionalDefense", 8);
    }
  },

  knight_layered_plating: {
    async afterCast(context, result) {
      await status(
        context.playerId,
        "knight_bulwark_reform_pct",
        number(context.talent.config, "reformPercent", 50),
        number(context.talent.config, "charges", 1),
        Number(context.spell.buff_duration || 1),
        `shield:spell:${context.spell.id}`
      );
      return result;
    }
  },

  knight_shielded_advance: {
    afterCast(context, result) {
      return {
        ...result,
        casterGaugeGain:
          (Number(result.casterGaugeGain) || 0) + number(context.talent.config, "gaugeGain", 25)
      };
    }
  },

  knight_immovable: {
    async afterCast(context, result) {
      await status(
        context.playerId,
        "action_gauge_reduction_immune",
        1,
        99,
        Number(context.spell.buff_duration || 1),
        `talent:${context.talent.id}:bulwark`
      );
      return result;
    }
  },

  knight_spiked_bulwark: {
    async afterCast(context, result) {
      await status(
        context.playerId,
        "knight_thorns_pct",
        number(context.talent.config, "thornsPercent", 25),
        99,
        Number(context.spell.buff_duration || 1),
        `talent:${context.talent.id}:bulwark`
      );
      return result;
    }
  },

  knight_heroic_interception: {
    modifySpell(context) {
      context.spell.buff_value = Math.min(
        100,
        Number(context.spell.buff_value || 0) + number(context.talent.config, "additionalRedirectPoints", 20)
      );
    }
  },

  knight_emergency_response: {
    async afterCast(context, result) {
      const protectedId = targetId(context, result);
      const amount = await shield(
        protectedId,
        maximumHP(context, protectedId) * number(context.talent.config, "shieldMaxHpPercent", 15) / 100,
        Number(context.spell.buff_duration || 1),
        `talent:${context.talent.id}:intercept`
      );
      return { ...result, appliedStatus: true, absorbShield: amount, shieldedTargetId: protectedId };
    }
  },

  knight_take_the_blow: {
    modifySpell(context) {
      const config = rankConfig(context);
      config.redirectedDamageReductionPercent =
        Number(config.redirectedDamageReductionPercent || 0) +
        number(context.talent.config, "additionalRedirectedReductionPoints", 20);
    }
  },

  knight_answer_the_attack: {
    async afterCast(context, result) {
      const protectedId = targetId(context, result);
      await status(
        protectedId,
        "knight_intercept_next_spell_damage_pct",
        number(context.talent.config, "nextSpellDamagePercent", 40),
        1,
        Number(context.spell.buff_duration || 1),
        `knight:${context.playerId}:spell:${context.spell.id}`
      );
      return result;
    }
  },

  knight_last_second_rescue: {
    async afterCast(context, result) {
      const protectedId = targetId(context, result);
      await status(
        protectedId,
        "knight_intercept_prevent_lethal",
        1,
        1,
        Number(context.spell.buff_duration || 1),
        `knight:${context.playerId}:spell:${context.spell.id}`
      );
      return result;
    }
  },

  knight_rapid_deployment: {
    afterCast(context, result) {
      return {
        ...result,
        casterGaugeGain: (Number(result.casterGaugeGain) || 0) + number(context.talent.config, "casterGaugeGain", 20),
        targetGaugeGain: (Number(result.targetGaugeGain) || 0) + number(context.talent.config, "targetGaugeGain", 20),
        targetGaugePlayerId: targetId(context, result)
      };
    }
  },

  knight_fortress_formation: {
    modifySpell(context) {
      context.spell.buff_value =
        Number(context.spell.buff_value || 0) +
        number(context.talent.config, "additionalReductionPoints", 10);
    }
  },

  knight_rally_behind_me: {
    afterCast(context, result) {
      return {
        ...result,
        partyGaugeGain:
          (Number(result.partyGaugeGain) || 0) + number(context.talent.config, "partyGaugeGain", 20)
      };
    }
  },

  knight_hold_fast: {
    modifySpell(context) {
      context.spell.buff_duration =
        Number(context.spell.buff_duration || 0) +
        number(context.talent.config, "additionalDurationSeconds", 5);
    }
  },

  knight_interlocking_shields: {
    async afterCast(context, result) {
      for (const ally of livingAllies(context)) {
        await shield(
          Number(ally.playerId),
          Math.max(1, Number(ally.maxHp || ally.stats?.maxhp || 1)) * number(context.talent.config, "shieldMaxHpPercent", 12) / 100,
          Number(context.spell.buff_duration || 1),
          `talent:${context.talent.id}:shield_wall`
        );
      }
      return { ...result, appliedStatus: true };
    }
  },

  knight_counteroffensive_wall: {
    async afterCast(context, result) {
      for (const ally of livingAllies(context)) {
        await applyBuff(
          Number(ally.playerId),
          "damage_dealt_pct",
          number(context.talent.config, "damagePercent", 18),
          Number(context.spell.buff_duration || 1),
          `talent:${context.talent.id}:shield_wall`
        );
      }
      return { ...result, appliedStatus: true };
    }
  },

  knight_punishing_formation: {
    async afterCast(context, result) {
      for (const ally of livingAllies(context)) {
        await status(
          Number(ally.playerId),
          "knight_thorns_pct",
          number(context.talent.config, "thornsPercent", 20),
          99,
          Number(context.spell.buff_duration || 1),
          `talent:${context.talent.id}:shield_wall`
        );
      }
      return result;
    }
  },

  knight_living_fortress: {
    modifySpell(context) {
      const config = rankConfig(context);
      config.shieldMaxHpPercent = Number(config.shieldMaxHpPercent || 0) *
        (1 + number(context.talent.config, "shieldIncreasePercent", 50) / 100);
    }
  },

  knight_unstoppable_juggernaut: {
    async afterCast(context, result) {
      await applyBuff(
        context.playerId,
        "damage_dealt_pct",
        number(context.talent.config, "damagePercent", 25),
        Number(context.spell.buff_duration || 1),
        `talent:${context.talent.id}:unbreakable`
      );
      return {
        ...result,
        appliedStatus: true,
        casterGaugeGain: (Number(result.casterGaugeGain) || 0) + number(context.talent.config, "gaugeGain", 50)
      };
    }
  },

  knight_indomitable: {
    modifySpell(context) {
      const config = rankConfig(context);
      config.deathPreventionCharges =
        Number(config.deathPreventionCharges || 1) +
        number(context.talent.config, "additionalDeathPreventionCharges", 1);
    }
  },

  knight_second_wind: {
    async afterCast(context, result) {
      await status(
        context.playerId,
        "knight_unbreakable_trigger_heal_pct",
        number(context.talent.config, "triggerHealingMaxHpPercent", 30),
        Math.max(1, Number(result.deathPreventionCharges) || 1),
        Number(context.spell.buff_duration || 1),
        `spell:${context.spell.id}`
      );
      return result;
    }
  },

  knight_vengeful_bastion: {
    async afterCast(context, result) {
      await status(
        context.playerId,
        "knight_thorns_pct",
        number(context.talent.config, "thornsPercent", 40),
        99,
        Number(context.spell.buff_duration || 1),
        `talent:${context.talent.id}:unbreakable`
      );
      await status(
        context.playerId,
        "knight_thorns_use_incoming",
        context.talent.config.useIncomingDamage ? 1 : 0,
        99,
        Number(context.spell.buff_duration || 1),
        `talent:${context.talent.id}:unbreakable`
      );
      return result;
    }
  },

  knight_no_surrender: {
    afterCast(context, result) {
      return {
        ...result,
        resetSpellIds: Array.isArray(context.talent.config.resetSpellIds)
          ? context.talent.config.resetSpellIds.map(Number).filter(Number.isFinite)
          : [1, 2, 3, 4],
        setGaugeTo: number(context.talent.config, "setGaugeTo", 100)
      };
    }
  }
};
