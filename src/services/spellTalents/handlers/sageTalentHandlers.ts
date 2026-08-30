// src/services/spellTalents/handlers/sageTalentHandlers.ts

import { db } from "../../../db";
import { applyBuff } from "../../buffService";
import { calculateScaledSpellAmount } from "../../spellHandlers/helpers";
import type { SpellHandlerResult } from "../../spellHandlers/types";
import type { SpellTalentHandler, TalentConfig } from "../types";

const n = (config: TalentConfig, key: string, fallback = 0): number => {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
};

const targetId = (context: any, result?: any) =>
  Number(result?.healedTargetId ?? context.targetPlayerId ?? context.playerId);

const targetMaxHp = (context: any, result?: any) =>
  Math.max(1, Number(
    result?.healedTargetMaxHP ?? context.maxTargetHP ?? context.maxPlayerHP ??
    context.targetPlayer?.maxhp ?? context.player?.maxhp ?? 1
  ));

const living = (context: any) => {
  const allies = (context.allies ?? []).filter((ally: any) => Number(ally.hp) > 0);
  return allies.length > 0
    ? allies
    : [{ playerId: context.playerId, hp: context.currentPlayerHP, maxHp: context.maxPlayerHP }];
};

function config(context: any): Record<string, any> {
  if (!context.spell.rank_config || typeof context.spell.rank_config !== "object") {
    context.spell.rank_config = {};
  }
  return context.spell.rank_config;
}

function multiplyHeal(context: any, percent: number) {
  context.spell.heal = Math.max(
    1,
    Math.round((Number(context.spell.heal) || 0) * (1 + percent / 100))
  );
}

function append(result: SpellHandlerResult, message: string): SpellHandlerResult {
  return { ...result, log: `${result.log ?? ""} ${message}`.trim() };
}

async function healPlayer(playerId: number, amount: number) {
  const [[player]]: any = await db.query(
    `SELECT hpoints, maxhp FROM players WHERE id = ? LIMIT 1`,
    [playerId]
  );
  if (!player) return 0;
  const before = Math.max(0, Number(player.hpoints) || 0);
  const maxHp = Math.max(1, Number(player.maxhp) || 1);
  const after = Math.min(maxHp, before + Math.max(0, Math.floor(amount)));
  await db.query(`UPDATE players SET hpoints = ? WHERE id = ?`, [after, playerId]);
  return Math.max(0, after - before);
}

async function shield(playerId: number, amount: number, duration: number, source: string) {
  const absorb = Math.max(0, Math.floor(amount));
  if (absorb <= 0) return;
  await db.query(
    `
      INSERT INTO player_shields
        (player_id, max_absorb, remaining_absorb, expires_at, source)
      VALUES
        (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND), ?)
      ON DUPLICATE KEY UPDATE
        max_absorb = VALUES(max_absorb),
        remaining_absorb = VALUES(remaining_absorb),
        expires_at = VALUES(expires_at)
    `,
    [playerId, absorb, absorb, duration, source]
  );
}

async function status(
  playerId: number,
  effectKey: string,
  value: number,
  charges: number,
  duration: number,
  source: string
) {
  await db.query(
    `
      INSERT INTO player_status_effects
        (player_id, effect_key, value, charges, expires_at, source)
      VALUES
        (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND), ?)
      ON DUPLICATE KEY UPDATE
        value = VALUES(value), charges = VALUES(charges),
        expires_at = VALUES(expires_at), source = VALUES(source)
    `,
    [playerId, effectKey, value, charges, duration, source]
  );
}

async function applySimpleHot(
  playerId: number,
  totalHealing: number,
  duration: number,
  tickRate: number,
  source: string,
  displayName: string,
  immediate = false
) {
  const ticks = Math.max(1, Math.floor(duration / tickRate));
  const perTick = Math.max(1, Math.floor(totalHealing / ticks));
  await db.query(`DELETE FROM player_hots WHERE player_id = ? AND source = ?`, [playerId, source]);
  await db.query(
    `
      INSERT INTO player_hots
        (player_id, healing, tick_interval, next_tick_at, expires_at, source, display_name)
      VALUES
        (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND),
         DATE_ADD(NOW(3), INTERVAL ? SECOND), ?, ?)
    `,
    [playerId, perTick, tickRate, immediate ? 0 : tickRate, duration, source, displayName]
  );
  return perTick;
}

export const sageTalentHandlers: Record<string, SpellTalentHandler> = {
  sage_gentle_current: {
    modifySpell(context) { multiplyHeal(context, n(context.talent.config, "healingPercent", 35)); }
  },
  sage_overflowing_nature: {
    async afterCast(context, result) {
      const overhealing = Math.max(0, Number(result.overhealing) || 0);
      const total = Math.floor(overhealing * n(context.talent.config, "overhealToHotPercent", 60) / 100);
      if (total <= 0) return result;
      await applySimpleHot(
        targetId(context, result), total,
        n(context.talent.config, "durationSeconds", 6),
        n(context.talent.config, "tickRateSeconds", 2),
        `talent:${context.talent.id}`, "Overflowing Nature"
      );
      return append(result, `🌱 ${total} overhealing becomes regeneration.`);
    }
  },
  sage_twin_leaves: {
    async afterCast(context, result) {
      const primary = targetId(context, result);
      const other = living(context)
        .filter((ally: any) => Number(ally.playerId) !== primary)
        .sort((a: any, b: any) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      if (!other) return result;
      const amount = Math.floor((Number(result.healing) || 0) * n(context.talent.config, "secondaryHealingPercent", 40) / 100);
      const healed = await healPlayer(Number(other.playerId), amount);
      return append({ ...result, healing: (Number(result.healing) || 0) + healed }, `🍃 Twin Leaves restores ${healed} HP to another ally.`);
    }
  },
  sage_verdant_momentum: {
    afterCast(context, result) {
      return {
        ...result,
        casterGaugeGain: (Number(result.casterGaugeGain) || 0) + n(context.talent.config, "additionalGauge", 10)
      };
    }
  },
  sage_shared_momentum: {
    afterCast(context, result) {
      return {
        ...result,
        targetGaugeGain: (Number(result.targetGaugeGain) || 0) + n(context.talent.config, "targetGaugeGain", 15),
        targetGaugePlayerId: targetId(context, result)
      };
    }
  },
  sage_natures_echo: {
    async afterCast(context, result) {
      if (Math.random() >= n(context.talent.config, "chancePercent", 35) / 100) return result;
      const amount = Math.floor((Number(result.potentialHealing ?? result.healing) || 0) * n(context.talent.config, "repeatHealingPercent", 50) / 100);
      const healed = await healPlayer(targetId(context, result), amount);
      return append({ ...result, healing: (Number(result.healing) || 0) + healed }, `🌿 Nature's Echo restores ${healed} additional HP.`);
    }
  },

  sage_deep_roots: {
    modifySpell(context) { multiplyHeal(context, n(context.talent.config, "healingPercent", 40)); }
  },
  sage_everlasting_growth: {
    modifySpell(context) {
      const extra = n(context.talent.config, "additionalDurationSeconds", 6);
      const oldDuration = Math.max(1, Number(context.spell.dot_duration) || 1);
      context.spell.dot_duration = oldDuration + extra;
      context.spell.heal = Math.max(1, Math.round(Number(context.spell.heal) * Number(context.spell.dot_duration) / oldDuration));
    }
  },
  sage_symbiotic_growth: {
    async afterCast(context, result) {
      await status(
        targetId(context, result), "sage_hot_caster_echo", context.playerId,
        n(context.talent.config, "casterHealingPercent", 25),
        Number(context.spell.dot_duration), `hot:spell:${context.spell.id}`
      );
      return result;
    }
  },
  sage_living_cycle: {
    async afterCast(context, result) {
      const tick = Math.max(0, Number(result.hotHealingPerTick) || 0);
      const healed = tick > 0 ? await healPlayer(targetId(context, result), tick) : 0;
      return healed > 0
        ? append({ ...result, healing: (Number(result.healing) || 0) + healed }, `🌱 Living Cycle immediately restores ${healed} HP.`)
        : result;
    }
  },
  sage_regrowth: {
    async beforeCast(context) {
      const hp = Number(context.currentTargetHP ?? context.currentPlayerHP ?? 0);
      const maxHp = targetMaxHp(context);
      if (hp / maxHp < n(context.talent.config, "healthThresholdPercent", 50) / 100) {
        config(context).regrowthHealing = Math.floor(Number(context.spell.heal) * n(context.talent.config, "immediateHealingPercent", 25) / 100);
      }
    },
    async afterCast(context, result) {
      const amount = Math.max(0, Number(config(context).regrowthHealing) || 0);
      const healed = amount > 0 ? await healPlayer(targetId(context, result), amount) : 0;
      return healed > 0
        ? append({ ...result, healing: (Number(result.healing) || 0) + healed }, `🌱 Regrowth restores ${healed} immediate HP.`)
        : result;
    }
  },
  sage_invigorating_growth: {
    async afterCast(context, result) {
      await status(
        targetId(context, result), "hot_gauge_per_tick",
        n(context.talent.config, "targetGaugePerTick", 3), 99,
        Number(context.spell.dot_duration), `hot:spell:${context.spell.id}`
      );
      return result;
    }
  },

  sage_potent_remedy: {
    modifySpell(context) { multiplyHeal(context, n(context.talent.config, "healingPercent", 40)); }
  },
  sage_antidotal_barrier: {
    async afterCast(context, result) {
      if ((Number(result.cleansedCount) || 0) <= 0) return result;
      const amount = Math.floor(targetMaxHp(context, result) * n(context.talent.config, "shieldMaxHpPercent", 10) / 100);
      await shield(targetId(context, result), amount, n(context.talent.config, "durationSeconds", 8), `talent:${context.talent.id}`);
      return append({ ...result, absorbShield: amount }, `🛡 Antidotal Barrier absorbs ${amount} damage.`);
    }
  },
  sage_prepared_poultice: {
    afterCast(context, result) {
      if ((Number(result.cleansedCount) || 0) > 0) return result;
      return {
        ...result,
        manaRestored: (Number(result.manaRestored) || 0) + Math.floor(context.castState.manaCost * n(context.talent.config, "manaRefundPercent", 50) / 100),
        reduceCurrentCooldownSeconds: n(context.talent.config, "cooldownReductionSeconds", 5)
      };
    }
  },
  sage_purging_herbs: {
    modifySpell(context) { config(context).cleanseAllRemovable = true; }
  },
  sage_cleansing_wave: {
    modifySpell(context) {
      context.spell.target_type = String(context.talent.config.targetType || "all_allies");
      config(context).secondaryHealingPercent = n(context.talent.config, "secondaryHealingPercent", 60);
    }
  },
  sage_renewed_vigor: {
    async afterCast(context, result) {
      const ids = (result.cleansedTargetIds ?? []) as number[];
      for (const id of ids) {
        await applyBuff(id, "damage_dealt_pct", n(context.talent.config, "damagePercent", 12), n(context.talent.config, "durationSeconds", 10), `talent:${context.talent.id}`);
      }
      return result;
    }
  },

  sage_deep_calm: {
    modifySpell(context) { multiplyHeal(context, n(context.talent.config, "healingPercent", 35)); }
  },
  sage_emergency_serenity: {
    async afterCast(context, result) {
      let extra = 0;
      const threshold = n(context.talent.config, "healthThresholdPercent", 40) / 100;
      for (const ally of living(context)) {
        if (Number(ally.hp) / Math.max(1, Number(ally.maxHp)) < threshold) {
          extra += await healPlayer(ally.playerId, Math.floor(Number(context.spell.heal) * n(context.talent.config, "additionalHealingPercent", 50) / 100));
        }
      }
      return extra > 0 ? append({ ...result, healing: (Number(result.healing) || 0) + extra }, `🌊 Emergency Serenity restores ${extra} additional HP.`) : result;
    }
  },
  sage_still_waters: {
    modifySpell(context) {
      context.spell.mana_cost = Math.max(0, Math.floor(Number(context.spell.mana_cost) * (1 - n(context.talent.config, "manaReductionPercent", 25) / 100)));
      context.spell.cooldown = Math.max(0, Number(context.spell.cooldown) - n(context.talent.config, "cooldownReductionSeconds", 4));
    }
  },
  sage_soothing_tide: {
    async afterCast(context, result) {
      const ids = (result.healedPlayerIds ?? []) as number[];
      const total = Math.floor(Number(context.spell.heal) * n(context.talent.config, "hotHealingPercent", 30) / 100);
      for (const id of ids) {
        await applySimpleHot(id, total, n(context.talent.config, "durationSeconds", 6), n(context.talent.config, "tickRateSeconds", 2), `talent:${context.talent.id}`, "Soothing Tide");
      }
      return { ...result, appliedStatus: true };
    }
  },
  sage_rising_tide: {
    async afterCast(context, result) {
      const ids = (result.healedPlayerIds ?? []) as number[];
      const total = Math.floor(Number(context.spell.heal) * n(context.talent.config, "hotHealingPercent", 60) / 100);
      for (const id of ids) {
        const tick = await applySimpleHot(id, total, 6, 2, `talent:${context.getTalent("sage_soothing_tide")?.id ?? context.talent.id}`, "Rising Tide", true);
        await healPlayer(id, tick);
      }
      return result;
    }
  },
  sage_shelter_in_current: {
    async afterCast(context, result) {
      for (const id of (result.healedPlayerIds ?? []) as number[]) {
        await applyBuff(id, "damage_reduction", n(context.talent.config, "damageReductionPercent", 12), n(context.talent.config, "durationSeconds", 8), `talent:${context.talent.id}`);
      }
      return { ...result, appliedStatus: true };
    }
  },

  sage_abundant_bloom: {
    modifySpell(context) { config(context).hotBloomTicks = n(context.talent.config, "bloomTicks", 2); }
  },
  sage_overgrowth: {
    async afterCast(context, result) {
      const byTarget = result.bloomHealingByTarget ?? {};
      for (const [id, healing] of Object.entries(byTarget)) {
        await shield(Number(id), Math.floor(Number(healing) * n(context.talent.config, "bloomShieldPercent", 40) / 100), n(context.talent.config, "durationSeconds", 8), `talent:${context.talent.id}:${id}`);
      }
      return result;
    }
  },
  sage_chain_bloom: {
    modifySpell(context) {
      Object.assign(config(context), {
        chainBloomRequiredHots: n(context.talent.config, "requiredActiveHots", 2),
        chainBloomAdditionalTicks: n(context.talent.config, "additionalBloomTicks", 1)
      });
    }
  },
  sage_verdant_communion: {
    modifySpell(context) {
      context.spell.buff_value = Number(context.spell.buff_value) + n(context.talent.config, "additionalHealingReceivedPoints", 10);
      config(context).hotDurationExtensionSeconds = Number(config(context).hotDurationExtensionSeconds || 0) + n(context.talent.config, "additionalExtensionSeconds", 4);
    }
  },
  sage_perpetual_spring: {
    modifySpell(context) { context.spell.cooldown = Math.max(0, Number(context.spell.cooldown) - n(context.talent.config, "cooldownReductionSeconds", 8)); }
  },
  sage_shared_renewal: {
    modifySpell(context) { config(context).sharedRenewalPercent = n(context.talent.config, "rejuvenationEffectivenessPercent", 50); }
  },

  sage_world_in_bloom: {
    modifySpell(context) {
      const percent = n(context.talent.config, "healingPercent", 50);
      multiplyHeal(context, percent);
      config(context).hotTotalHealing = Math.max(1, Math.round(Number(config(context).hotTotalHealing) * (1 + percent / 100)));
    }
  },
  sage_genesis: {
    modifySpell(context) { config(context).hotBloomTicks = n(context.talent.config, "bloomTicks", 3); }
  },
  sage_wild_ascendance: {
    async afterCast(context, result) {
      for (const ally of living(context)) {
        await applyBuff(ally.playerId, "damage_dealt_pct", n(context.talent.config, "damagePercent", 20), n(context.talent.config, "durationSeconds", 12), `talent:${context.talent.id}:damage`);
        await applyBuff(ally.playerId, "healing_dealt_pct", n(context.talent.config, "healingPercent", 20), n(context.talent.config, "durationSeconds", 12), `talent:${context.talent.id}:healing`);
      }
      return { ...result, appliedStatus: true };
    }
  },
  sage_cycle_unbroken: {
    async afterCast(context, result) {
      for (const ally of living(context)) {
        await status(ally.playerId, "death_prevention", 1, n(context.talent.config, "charges", 1), n(context.talent.config, "durationSeconds", 12), `talent:${context.talent.id}`);
      }
      return { ...result, appliedStatus: true };
    }
  },
  sage_undying_grove: {
    async afterCast(context, result) {
      for (const ally of living(context)) {
        await status(ally.playerId, "sage_death_trigger_heal_pct", n(context.talent.config, "triggerHealingMaxHpPercent", 25), 1, 12, `talent:${context.getTalent("sage_cycle_unbroken")?.id ?? context.talent.id}`);
        await status(ally.playerId, "sage_death_trigger_gauge", n(context.talent.config, "triggerGaugeGain", 25), 1, 12, `talent:${context.getTalent("sage_cycle_unbroken")?.id ?? context.talent.id}`);
      }
      return result;
    }
  },
  sage_rebirth: {
    async afterCast(context, result) {
      const defeated = (context.allies ?? []).find((ally: any) => Number(ally.hp) <= 0);
      if (defeated) {
        const hp = Math.max(1, Math.floor(Number(defeated.maxHp) * n(context.talent.config, "reviveHealthPercent", 40) / 100));
        await db.query(`UPDATE players SET hpoints = ? WHERE id = ?`, [hp, defeated.playerId]);
        defeated.hp = hp;
        return append({ ...result, revivedPlayerId: defeated.playerId, revivedHP: hp }, `🌳 Rebirth returns ${defeated.name ?? "an ally"} to life with ${hp} HP!`);
      }
      for (const ally of living(context)) {
        const amount = Math.floor(Number(ally.maxHp) * n(context.talent.config, "fallbackShieldMaxHpPercent", 20) / 100);
        await shield(ally.playerId, amount, n(context.talent.config, "shieldDurationSeconds", 12), `talent:${context.talent.id}:${ally.playerId}`);
      }
      return append(result, "🌳 Rebirth finds no fallen ally and shields the living party instead.");
    }
  }
};

export default sageTalentHandlers;
