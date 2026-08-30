import { db } from "../../../db";
import { applyBuff } from "../../buffService";
import { applySpellDebuff } from "../../spellHandlers/helpers";
import type { SpellHandlerResult } from "../../spellHandlers/types";
import type { SpellTalentHandler, TalentConfig } from "../types";

const n = (config: TalentConfig, key: string, fallback = 0) => {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
};

const cfg = (context: any): Record<string, any> => {
  if (!context.spell.rank_config || typeof context.spell.rank_config !== "object") {
    context.spell.rank_config = {};
  }
  return context.spell.rank_config;
};

const targetId = (context: any, result?: any) =>
  Number(result?.buffedTargetId ?? result?.shieldedTargetId ?? context.targetPlayerId ?? context.playerId);

const living = (context: any) => {
  const allies = (context.allies ?? []).filter((ally: any) => Number(ally.hp) > 0);
  return allies.length > 0
    ? allies
    : [{
        playerId: context.playerId,
        hp: context.currentPlayerHP ?? context.player?.hpoints ?? 1,
        maxHp: context.maxPlayerHP ?? context.player?.maxhp ?? 1,
        stats: context.player
      }];
};

async function status(
  playerId: number,
  effectKey: string,
  value: number,
  charges: number,
  seconds: number,
  source: string
) {
  await db.query(
    `INSERT INTO player_status_effects
      (player_id,effect_key,value,charges,expires_at,source)
     VALUES (?,?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
     ON DUPLICATE KEY UPDATE
       value=VALUES(value),charges=VALUES(charges),
       expires_at=VALUES(expires_at),source=VALUES(source)`,
    [playerId, effectKey, value, charges, seconds, source]
  );
}

async function shield(playerId: number, amount: number, seconds: number, source: string) {
  if (amount <= 0) return;
  await db.query(
    `INSERT INTO player_shields
      (player_id,max_absorb,remaining_absorb,expires_at,source)
     VALUES (?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
     ON DUPLICATE KEY UPDATE
       max_absorb=VALUES(max_absorb),remaining_absorb=VALUES(remaining_absorb),
       expires_at=VALUES(expires_at)`,
    [playerId, amount, amount, seconds, source]
  );
}

async function hot(
  playerId: number,
  healingPerTick: number,
  tickRate: number,
  duration: number,
  source: string,
  displayName: string
) {
  await db.query(`DELETE FROM player_hots WHERE player_id=? AND source=?`, [playerId, source]);
  await db.query(
    `INSERT INTO player_hots
      (player_id,healing,tick_interval,next_tick_at,expires_at,source,display_name)
     VALUES (?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),DATE_ADD(NOW(3),INTERVAL ? SECOND),?,?)`,
    [playerId, Math.max(1, healingPerTick), tickRate, tickRate, duration, source, displayName]
  );
}

async function enemyDebuff(context: any, stat: string, value: number, seconds: number) {
  if (!context.enemy) return;
  await applySpellDebuff(context.enemy, {
    sourcePlayerId: context.playerId,
    spellId: Number(context.spell.id),
    spellName: String(context.spell.name),
    stat,
    value,
    durationSeconds: seconds
  });
}

export const sentinelTalentHandlers: Record<string, SpellTalentHandler> = {
  sentinel_thorned_challenge: {
    modifySpell(context) {
      const rank = cfg(context);
      rank.bonusThreat = Math.round(
        Number(rank.bonusThreat || 0) *
        (1 + n(context.talent.config, "bonusThreatPercent", 50) / 100)
      );
    },
    afterCast(context, result) {
      return result.dodged
        ? result
        : { ...result, forceThreatTargetPlayerId: context.playerId };
    }
  },

  sentinel_savage_growth: {
    modifySpell(context) {
      context.spell.damage = Math.round(
        Number(context.spell.damage || 0) *
        (1 + n(context.talent.config, "damagePercent", 40) / 100)
      );
    }
  },

  sentinel_grasping_challenge: {
    afterCast(context, result) {
      if (result.dodged) return result;
      return {
        ...result,
        enemyGaugeReduction:
          (Number(result.enemyGaugeReduction) || 0) +
          n(context.talent.config, "enemyGaugeReduction", 15)
      };
    }
  },

  sentinel_bramble_guard: {
    async afterCast(context, result) {
      if (result.dodged) return result;
      const maximumHP = Math.max(1, Number(context.maxPlayerHP ?? context.player?.maxhp ?? 1));
      const amount = Math.floor(maximumHP * n(context.talent.config, "shieldMaxHpPercent", 10) / 100);
      await shield(context.playerId, amount, n(context.talent.config, "durationSeconds", 8), `talent:${context.talent.id}`);
      return { ...result, appliedStatus: true, brambleGuardShield: amount };
    }
  },

  sentinel_splintering_thorns: {
    async afterCast(context, result) {
      if (!result.dodged && Number(result.enemyHP) > 0) {
        await enemyDebuff(
          context,
          "defense_pct",
          n(context.talent.config, "defenseReductionPercent", 15),
          n(context.talent.config, "durationSeconds", 8)
        );
      }
      return result;
    }
  },

  sentinel_relentless_growth: {
    afterCast(context, result) {
      return result.crit
        ? { ...result, resetSpellCooldown: Number(context.spell.id) }
        : result;
    }
  },

  sentinel_guardians_bark: {
    async afterCast(context, result) {
      const percent = n(context.talent.config, "casterDefensePercent", 60);
      const defense = Math.max(1, Math.floor(Number(context.spell.buff_value || 0) * percent / 100));
      await applyBuff(context.playerId, "defense", defense, Number(context.spell.buff_duration), `talent:${context.talent.id}`);
      return { ...result, appliedStatus: true };
    }
  },

  sentinel_vengeful_bark: {
    modifySpell(context) {
      const rank = cfg(context);
      rank.thornsDamagePercent = Math.round(
        Number(rank.thornsDamagePercent || 0) *
        (1 + n(context.talent.config, "thornsIncreasePercent", 75) / 100)
      );
    }
  },

  sentinel_barkbound_bond: {
    async afterCast(context, result) {
      const protectedPlayerId = targetId(context, result);
      if (protectedPlayerId !== context.playerId) {
        await status(
          protectedPlayerId,
          "sentinel_ancient_intercept",
          n(context.talent.config, "redirectPercent", 15),
          99,
          Number(context.spell.buff_duration),
          `ancient_protector:${context.playerId}`
        );
      }
      return result;
    }
  },

  sentinel_deep_roots: {
    modifySpell(context) {
      context.spell.buff_value = Math.round(
        Number(context.spell.buff_value || 0) *
        (1 + n(context.talent.config, "defensePercent", 25) / 100)
      );
      context.spell.buff_duration =
        Number(context.spell.buff_duration || 0) +
        n(context.talent.config, "durationSeconds", 4);
    }
  },

  sentinel_barbed_retribution: {
    async afterCast(context, result) {
      await status(
        targetId(context, result),
        "sentinel_thorns_splash_pct",
        n(context.talent.config, "splashPercent", 50),
        99,
        Number(context.spell.buff_duration),
        `spell:${context.spell.id}:ironbark`
      );
      return result;
    }
  },

  sentinel_living_bark: {
    async afterCast(context, result) {
      await status(
        targetId(context, result),
        "sentinel_thorns_heal_pct",
        n(context.talent.config, "healMaxHpPercent", 2),
        99,
        Number(context.spell.buff_duration),
        `spell:${context.spell.id}:ironbark`
      );
      await status(
        targetId(context, result),
        "sentinel_thorns_heal_icd_seconds",
        n(context.talent.config, "internalCooldownSeconds", 2),
        99,
        Number(context.spell.buff_duration),
        `spell:${context.spell.id}:ironbark`
      );
      return result;
    }
  },

  sentinel_crushing_roots: {
    modifySpell(context) {
      const rank = cfg(context);
      rank.enemyGaugeReduction =
        Number(rank.enemyGaugeReduction || 0) +
        n(context.talent.config, "additionalGaugeReduction", 20);
    }
  },

  sentinel_spreading_roots: {
    modifySpell(context) {
      context.spell.target_type = String(context.talent.config.targetType || "all_enemies");
    }
  },

  sentinel_uprooted_momentum: {
    afterCast(context, result) {
      const removed = Math.max(0, Number(result.enemyGaugeReduction) || 0);
      return {
        ...result,
        casterGaugeGain:
          (Number(result.casterGaugeGain) || 0) +
          Math.floor(removed * n(context.talent.config, "gaugeReturnPercent", 50) / 100)
      };
    }
  },

  sentinel_withering_grip: {
    async afterCast(context, result) {
      if (result.appliedStatus) {
        await enemyDebuff(
          context,
          "damage_dealt_pct",
          n(context.talent.config, "damageReductionPercent", 15),
          Number(context.spell.debuff_duration)
        );
      }
      return result;
    }
  },

  sentinel_tangled_battlefield: {
    modifySpell(context) {
      context.spell.debuff_duration =
        Number(context.spell.debuff_duration || 0) +
        n(context.talent.config, "durationSeconds", 5);
    }
  },

  sentinel_rooted_prey: {
    async afterCast(context, result) {
      if (result.appliedStatus) {
        await enemyDebuff(
          context,
          "damage_taken_pct",
          n(context.talent.config, "damageTakenPercent", 12),
          Number(context.spell.debuff_duration)
        );
      }
      return result;
    }
  },

  sentinel_restorative_grove: {
    async afterCast(context, result) {
      const tickRate = n(context.talent.config, "tickRateSeconds", 4);
      const duration = Number(context.spell.buff_duration);
      for (const ally of living(context)) {
        const healing = Math.max(1, Math.floor(Number(ally.maxHp) * n(context.talent.config, "healMaxHpPercent", 3) / 100));
        await hot(ally.playerId, healing, tickRate, duration, `talent:${context.talent.id}`, "Restorative Grove");
      }
      return { ...result, appliedStatus: true };
    }
  },

  sentinel_thorned_grove: {
    async afterCast(context, result) {
      for (const ally of living(context)) {
        await status(ally.playerId, "sentinel_thorns_pct", n(context.talent.config, "thornsPercent", 20), 99, Number(context.spell.buff_duration), `talent:${context.talent.id}`);
      }
      return result;
    }
  },

  sentinel_rejuvenating_soil: {
    async afterCast(context, result) {
      const multiplier = 1 + n(context.talent.config, "hotIncreasePercent", 30) / 100;
      for (const ally of living(context)) {
        await db.query(
          `UPDATE player_hots SET healing=GREATEST(1,FLOOR(healing*?)) WHERE player_id=? AND expires_at>NOW(3)`,
          [multiplier, ally.playerId]
        );
      }
      return result;
    }
  },

  sentinel_shelter_of_ancients: {
    async afterCast(context, result) {
      const threshold = n(context.talent.config, "healthThresholdPercent", 35) / 100;
      const extra = Math.floor(Number(context.spell.buff_value || 0) * n(context.talent.config, "reductionIncreasePercent", 50) / 100);
      for (const ally of living(context)) {
        if (Number(ally.hp) / Math.max(1, Number(ally.maxHp)) < threshold) {
          await applyBuff(ally.playerId, "damage_reduction", extra, Number(context.spell.buff_duration), `talent:${context.talent.id}`);
        }
      }
      return result;
    }
  },

  sentinel_briar_circle: {
    async afterCast(context, result) {
      for (const ally of living(context)) {
        await status(ally.playerId, "sentinel_thorns_pct", n(context.talent.config, "thornsPercent", 35), 99, Number(context.spell.buff_duration), `talent:${context.talent.id}`);
        await status(ally.playerId, "sentinel_thorns_use_incoming", 1, 99, Number(context.spell.buff_duration), `talent:${context.talent.id}`);
      }
      return result;
    }
  },

  sentinel_verdant_rally: {
    afterCast(context, result) {
      return {
        ...result,
        partyGaugeGain:
          (Number(result.partyGaugeGain) || 0) +
          n(context.talent.config, "partyGaugeGain", 20)
      };
    }
  },

  sentinel_overgrown_aegis: {
    modifySpell(context) {
      context.spell.buff_value = Math.round(
        Number(context.spell.buff_value || 0) *
        (1 + n(context.talent.config, "shieldIncreasePercent", 35) / 100)
      );
    }
  },

  sentinel_rejuvenating_aegis: {
    modifySpell(context) {
      const rank = cfg(context);
      rank.shieldBreakHealMaxHpPercent =
        Number(rank.shieldBreakHealMaxHpPercent || 0) *
        (1 + n(context.talent.config, "breakHealingIncreasePercent", 75) / 100);
    }
  },

  sentinel_layered_canopy: {
    async afterCast(context, result) {
      for (const ally of living(context)) {
        await status(ally.playerId, "natures_aegis_reform_pct", n(context.talent.config, "reformPercent", 35), n(context.talent.config, "charges", 1), Number(context.spell.buff_duration), `shield:spell:${context.spell.id}`);
      }
      return result;
    }
  },

  sentinel_barkskin_aftermath: {
    async afterCast(context, result) {
      const packed = n(context.talent.config, "damageReductionPercent", 20) * 1000 + n(context.talent.config, "durationSeconds", 6);
      for (const ally of living(context)) {
        await status(ally.playerId, "natures_aegis_break_reduction", packed, 1, Number(context.spell.buff_duration), `shield:spell:${context.spell.id}`);
      }
      return result;
    }
  },

  sentinel_blooming_aegis: {
    async afterCast(context, result) {
      for (const ally of living(context)) {
        await status(ally.playerId, "natures_aegis_party_heal_pct", n(context.talent.config, "partyHealMaxHpPercent", 4), 1, Number(context.spell.buff_duration), `shield:spell:${context.spell.id}`);
      }
      return result;
    }
  },

  sentinel_seeds_of_renewal: {
    async afterCast(context, result) {
      const packed = n(context.talent.config, "hotMaxHpPercent", 8) * 1000000 + n(context.talent.config, "durationSeconds", 6) * 1000 + n(context.talent.config, "tickRateSeconds", 2);
      for (const ally of living(context)) {
        await status(ally.playerId, "natures_aegis_break_hot", packed, 1, Number(context.spell.buff_duration), `shield:spell:${context.spell.id}`);
      }
      return result;
    }
  },

  sentinel_worldtree_colossus: {
    modifySpell(context) {
      context.spell.buff_value = Number(context.spell.buff_value || 0) + n(context.talent.config, "damageReductionPoints", 10);
      const rank = cfg(context);
      rank.allyInterceptPercent = Number(rank.allyInterceptPercent || 0) + n(context.talent.config, "interceptPoints", 10);
    }
  },

  sentinel_heart_of_the_forest: {
    modifySpell(context) {
      context.spell.heal = Math.round(Number(context.spell.heal || 0) * (1 + n(context.talent.config, "healingIncreasePercent", 50) / 100));
    },
    async afterCast(context, result) {
      await status(context.playerId, "hot_gauge_per_tick", n(context.talent.config, "gaugePerTick", 5), 99, Number(context.spell.dot_duration) + 2, `hot:spell:${context.spell.id}:hot`);
      return result;
    }
  },

  sentinel_unyielding_roots: {
    modifySpell(context) {
      const rank = cfg(context);
      rank.deathPreventionCharges = Number(rank.deathPreventionCharges || 1) + n(context.talent.config, "additionalCharges", 1);
    }
  },

  sentinel_bearer_of_burdens: {
    modifySpell(context) {
      const rank = cfg(context);
      rank.allyInterceptPercent = n(context.talent.config, "interceptPercent", 50);
      rank.redirectedDamageReductionPercent = n(context.talent.config, "redirectedDamageReductionPercent", 25);
    }
  },

  sentinel_awakening_grove: {
    async afterCast(context, result) {
      await status(context.playerId, "sentinel_hot_party_echo_pct", n(context.talent.config, "partyHealingPercent", 50), 99, Number(context.spell.dot_duration) + 2, `hot:spell:${context.spell.id}:hot`);
      return result;
    }
  },

  sentinel_ancient_wrath: {
    async afterCast(context, result) {
      const duration = Number(context.spell.buff_duration);
      await applyBuff(context.playerId, "damage_dealt_pct", n(context.talent.config, "damagePercent", 30), duration, `talent:${context.talent.id}:damage`);
      await status(context.playerId, "sentinel_thorns_pct", n(context.talent.config, "thornsPercent", 30), 99, duration, `talent:${context.talent.id}:thorns`);
      return { ...result, appliedStatus: true };
    }
  }
};
