// src/services/spellTalents/handlers/rangerTalentHandlers.ts
import { applySpellDebuff, setSpellEnemyHP } from "../../spellHandlers/helpers";
import type { SpellHandlerResult } from "../../spellHandlers/types";
import type { SpellTalentHandler, TalentConfig } from "../types";

const number = (config: TalentConfig, key: string, fallback = 0): number => {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
};

function rankConfig(context: any): Record<string, any> {
  if (
    !context.spell.rank_config ||
    typeof context.spell.rank_config !== "object"
  ) {
    context.spell.rank_config = {};
  }
  return context.spell.rank_config;
}

function multiply(value: unknown, percent: number): number {
  return Math.max(1, Math.round((Number(value) || 0) * (1 + percent / 100)));
}

async function debuff(
  context: any,
  stat: string,
  value: number,
  duration: number,
) {
  if (!context.enemy || value === 0 || duration <= 0) return;
  await applySpellDebuff(context.enemy, {
    sourcePlayerId: context.playerId,
    spellId: Number(context.spell.id),
    spellName: String(context.spell.name),
    stat,
    value,
    durationSeconds: duration,
  });
}

async function addCriticalDamage(
  context: any,
  result: SpellHandlerResult,
  percent: number,
  label: string,
): Promise<SpellHandlerResult> {
  if (
    !context.enemy ||
    !result.crit ||
    result.dodged ||
    !result.damage ||
    Number(result.enemyHP) <= 0
  ) {
    return result;
  }
  const extra = Math.max(
    1,
    Math.floor((Number(result.damage) * percent) / 100),
  );
  const hp = Math.max(0, Number(result.enemyHP) - extra);
  await setSpellEnemyHP(context.enemy, hp);
  return {
    ...result,
    damage: Number(result.damage) + extra,
    enemyHP: hp,
    killedEnemy: hp <= 0,
    log: `${result.log ?? ""} 🎯 ${label} deals ${extra} additional critical damage!`,
  };
}

export const rangerTalentHandlers: Record<string, SpellTalentHandler> = {
  ranger_rapid_rhythm: {
    afterCast({ talent }, result) {
      if (result.dodged) return result;
      return {
        ...result,
        casterGaugeGain:
          (Number(result.casterGaugeGain) || 0) +
          number(talent.config, "additionalGauge", 10),
      };
    },
  },
  ranger_snapfire: {
    afterCast({ talent }, result) {
      if (!result.crit) return result;
      return {
        ...result,
        casterGaugeGain:
          (Number(result.casterGaugeGain) || 0) +
          number(talent.config, "critGaugeGain", 15),
      };
    },
  },
  ranger_relentless_pace: {
    afterCast({ talent }, result) {
      return result.dodged
        ? result
        : {
            ...result,
            reduceOtherCooldownsSeconds: number(
              talent.config,
              "cooldownReductionSeconds",
              1,
            ),
          };
    },
  },
  ranger_serrated_shot: {
    modifySpell({ spell, talent }) {
      spell.damage = multiply(
        spell.damage,
        number(talent.config, "damagePercent", 35),
      );
    },
  },
  ranger_exposing_arrow: {
    async afterCast(context, result) {
      if (!result.dodged && Number(result.enemyHP) > 0) {
        await debuff(
          context,
          "damage_taken_pct",
          number(context.talent.config, "damageTakenPercent", 8),
          number(context.talent.config, "durationSeconds", 6),
        );
      }
      return result;
    },
  },
  ranger_hamstring_shot: {
    afterCast({ talent }, result) {
      return result.dodged
        ? result
        : {
            ...result,
            enemyGaugeReduction:
              (Number(result.enemyGaugeReduction) || 0) +
              number(talent.config, "enemyGaugeReduction", 15),
          };
    },
  },

  ranger_virulent_venom: {
    modifySpell({ spell, talent }) {
      spell.dot_damage = multiply(
        spell.dot_damage,
        number(talent.config, "dotDamagePercent", 40),
      );
    },
  },
  ranger_fast_acting_toxin: {
    modifySpell(context) {
      rankConfig(context).immediateFirstTick = true;
    },
  },
  ranger_lingering_venom: {
    modifySpell({ spell, talent }) {
      const extra = number(talent.config, "additionalDurationSeconds", 6);
      const oldDuration = Math.max(1, Number(spell.dot_duration) || 1);
      const ticks = Math.max(
        1,
        Math.floor(
          oldDuration / Math.max(0.1, Number(spell.dot_tick_rate) || 1),
        ),
      );
      const perTick = (Number(spell.dot_damage) || 0) / ticks;
      spell.dot_duration = oldDuration + extra;
      const newTicks = Math.max(
        1,
        Math.floor(
          Number(spell.dot_duration) /
            Math.max(0.1, Number(spell.dot_tick_rate) || 1),
        ),
      );
      spell.dot_damage = Math.max(1, Math.round(perTick * newTicks));
      spell.debuff_duration = spell.dot_duration;
    },
  },
  ranger_debilitating_toxin: {
    async afterCast(context, result) {
      if (result.appliedStatus) {
        await debuff(
          context,
          "damage_dealt_pct",
          number(context.talent.config, "damageDealtReductionPercent", 10),
          Number(context.spell.dot_duration),
        );
      }
      return result;
    },
  },
  ranger_numbing_venom: {
    async afterCast(context, result) {
      if (result.appliedStatus) {
        await debuff(
          context,
          "attack_speed_pct",
          number(context.talent.config, "attackSpeedReductionPercent", 15),
          Number(context.spell.dot_duration),
        );
      }
      return result;
    },
  },
  ranger_hunters_toxin: {
    async afterCast(context, result) {
      if (result.appliedStatus) {
        await debuff(
          context,
          "damage_taken_pct",
          number(context.talent.config, "damageTakenPercent", 10),
          Number(context.spell.dot_duration),
        );
      }
      return result;
    },
  },

  ranger_patient_aim: {
    modifySpell(context) {
      context.spell.damage = multiply(
        context.spell.damage,
        number(context.talent.config, "damagePercent", 30),
      );
      const config = rankConfig(context);
      config.critChanceBonusPercent =
        (Number(config.critChanceBonusPercent) || 0) +
        number(context.talent.config, "critChancePoints", 10);
    },
  },
  ranger_eagle_eye: {
    modifySpell(context) {
      rankConfig(context).talentDefenseIgnorePercent = number(
        context.talent.config,
        "defenseIgnorePercent",
        35,
      );
    },
  },
  ranger_perfect_shot: {
    afterCast(context, result) {
      return addCriticalDamage(
        context,
        result,
        number(context.talent.config, "criticalDamagePercent", 50),
        "Perfect Shot",
      );
    },
  },
  ranger_opportunistic_aim: {
    modifySpell(context) {
      const config = rankConfig(context);
      config.poisonedDamageBonusPercent =
        (Number(config.poisonedDamageBonusPercent) || 0) +
        number(context.talent.config, "additionalPoisonBonusPoints", 25);
    },
  },
  ranger_toxic_precision: {
    async afterCast(context, result) {
      if (
        !result.dodged &&
        context.enemy &&
        (await context.enemy.getDebuffValue?.("poisoned"))
      ) {
        await debuff(context, "poisoned", 1, 12);
        return { ...result, refreshPoisonDuration: 12 };
      }
      return result;
    },
  },
  ranger_killing_pace: {
    async afterCast(context, result) {
      if (
        result.dodged ||
        !context.enemy ||
        !(await context.enemy.getDebuffValue?.("poisoned"))
      )
        return result;
      return {
        ...result,
        casterGaugeGain:
          (Number(result.casterGaugeGain) || 0) +
          number(context.talent.config, "gaugeGain", 20),
      };
    },
  },

  ranger_arrow_storm: {
    modifySpell({ spell, talent }) {
      spell.damage = multiply(
        spell.damage,
        number(talent.config, "damagePercent", 35),
      );
    },
  },
  ranger_suppressing_fire: {
    afterCast({ talent }, result) {
      return result.dodged
        ? result
        : {
            ...result,
            enemyGaugeReduction:
              (Number(result.enemyGaugeReduction) || 0) +
              number(talent.config, "enemyGaugeReduction", 15),
          };
    },
  },
  ranger_endless_quiver: {
    modifySpell({ spell, talent }) {
      spell.cooldown = Math.max(
        0,
        Number(spell.cooldown) -
          number(talent.config, "cooldownReductionSeconds", 3),
      );
    },
  },
  ranger_venomous_rain: {
    modifySpell(context) {
      rankConfig(context).venomousRainEffectivenessPercent = number(
        context.talent.config,
        "poisonEffectivenessPercent",
        50,
      );
    },
  },
  ranger_contagion: {
    modifySpell(context) {
      rankConfig(context).venomousRainEffectivenessPercent = number(
        context.talent.config,
        "poisonEffectivenessPercent",
        100,
      );
    },
  },
  ranger_corrosive_downpour: {
    async afterCast(context, result) {
      if (
        !result.dodged &&
        context.enemy &&
        (await context.enemy.getDebuffValue?.("poisoned"))
      ) {
        await debuff(
          context,
          "damage_taken_pct",
          number(context.talent.config, "damageTakenPercent", 12),
          number(context.talent.config, "durationSeconds", 8),
        );
      }
      return result;
    },
  },

  ranger_shatterplate: {
    modifySpell(context) {
      const config = rankConfig(context);
      config.armorBreakPercent =
        (Number(config.armorBreakPercent) || 0) +
        number(context.talent.config, "additionalArmorBreakPoints", 10);
      config.armorBreakDurationSeconds =
        (Number(config.armorBreakDurationSeconds) || 0) +
        number(context.talent.config, "additionalDurationSeconds", 4);
    },
  },
  ranger_exposed_quarry: {
    modifySpell(context) {
      const config = rankConfig(context);
      config.armorBreakPercent =
        (Number(config.armorBreakPercent) || 0) +
        number(context.talent.config, "additionalDamageTakenPercent", 10);
    },
  },
  ranger_splintered_guard: {
    afterCast({ talent }, result) {
      return !result.appliedStatus
        ? result
        : {
            ...result,
            enemyGaugeReduction:
              (Number(result.enemyGaugeReduction) || 0) +
              number(talent.config, "enemyGaugeReduction", 25),
          };
    },
  },
  ranger_skewering_shot: {
    modifySpell(context) {
      context.spell.damage = multiply(
        context.spell.damage,
        number(context.talent.config, "damagePercent", 35),
      );
      rankConfig(context).splashPercent = number(
        context.talent.config,
        "splashPercent",
        40,
      );
    },
    afterCast(context, result) {
      return {
        ...result,
        splashDamagePercent: Number(rankConfig(context).splashPercent) || 40,
      };
    },
  },
  ranger_through_and_through: {
    modifySpell(context) {
      Object.assign(rankConfig(context), {
        splashPercent: number(context.talent.config, "splashPercent", 75),
        applyArmorBreakToSplash: Boolean(
          context.talent.config.applyArmorBreakToSplash,
        ),
      });
    },
    afterCast(context, result) {
      return {
        ...result,
        splashDamagePercent: Number(rankConfig(context).splashPercent) || 75,
        applyArmorBreakToSplash: Boolean(
          rankConfig(context).applyArmorBreakToSplash,
        ),
      };
    },
  },
  ranger_tactical_reposition: {
    afterCast({ talent }, result) {
      return result.dodged
        ? result
        : {
            ...result,
            casterGaugeGain:
              (Number(result.casterGaugeGain) || 0) +
              number(talent.config, "gaugeGain", 25),
          };
    },
  },

  ranger_executioner: {
    modifySpell(context) {
      rankConfig(context).executeThresholdPercent = number(
        context.talent.config,
        "executeThresholdPercent",
        40,
      );
    },
  },
  ranger_no_escape: {
    modifySpell(context) {
      const config = rankConfig(context);
      config.executeDamageBonusPercent =
        (Number(config.executeDamageBonusPercent) || 0) +
        number(context.talent.config, "additionalExecuteDamagePercent", 100);
    },
  },
  ranger_death_sentence: {
    async afterCast(context, result) {
      const threshold =
        Number(context.spell.rank_config?.executeThresholdPercent) || 30;
      const beforeHP = Number(result.enemyHP || 0) + Number(result.damage || 0);
      const maxHP = Math.max(1, Number(context.enemy?.maxhp) || 1);
      if (
        !result.killedEnemy &&
        !result.dodged &&
        beforeHP / maxHP <= threshold / 100
      ) {
        await debuff(
          context,
          "damage_taken_pct",
          number(context.talent.config, "damageTakenPercent", 25),
          number(context.talent.config, "durationSeconds", 10),
        );
      }
      return result;
    },
  },
  ranger_one_shot_one_kill: {
    modifySpell(context) {
      context.spell.damage = multiply(
        context.spell.damage,
        number(context.talent.config, "damagePercent", 50),
      );
      const config = rankConfig(context);
      config.missingHealthDamageBonusMaxPercent =
        (Number(config.missingHealthDamageBonusMaxPercent) || 0) +
        number(context.talent.config, "additionalMissingHealthBonusPoints", 50);
    },
  },
  ranger_heartseeker: {
    modifySpell(context) {
      Object.assign(rankConfig(context), {
        defenseIgnorePercent: number(
          context.talent.config,
          "defenseIgnorePercent",
          100,
        ),
        cannotBeDodged: Boolean(context.talent.config.cannotBeDodged),
      });
    },
  },
  ranger_rain_of_death: {
    modifySpell(context) {
      context.spell.target_type = String(
        context.talent.config.targetType || "all_enemies",
      );
      rankConfig(context).secondaryDamagePercent = number(
        context.talent.config,
        "secondaryDamagePercent",
        60,
      );
    },
    afterCast(context, result) {
      return {
        ...result,
        secondaryDamagePercent:
          Number(rankConfig(context).secondaryDamagePercent) || 60,
      };
    },
  },
};

export default rangerTalentHandlers;
