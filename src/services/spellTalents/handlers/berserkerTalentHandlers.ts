import { db } from "../../../db";
import { applyBuff } from "../../buffService";
import { applySpellDebuff, applySpellDot } from "../../spellHandlers/helpers";
import type { SpellTalentHandler, TalentConfig } from "../types";

const n = (config: TalentConfig, key: string, fallback = 0): number => {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
};

const rank = (context: any): Record<string, any> => {
  if (!context.spell.rank_config || typeof context.spell.rank_config !== "object") context.spell.rank_config = {};
  return context.spell.rank_config;
};

const living = (context: any): any[] => {
  const allies = (context.allies ?? []).filter((ally: any) => Number(ally.hp) > 0);
  return allies.length ? allies : [{ playerId: context.playerId, hp: context.currentPlayerHP, maxHp: context.maxPlayerHP }];
};

async function status(playerId: number, key: string, value: number, charges: number, seconds: number, source: string) {
  await db.query(
    `INSERT INTO player_status_effects(player_id,effect_key,value,charges,expires_at,source)
     VALUES(?,?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
     ON DUPLICATE KEY UPDATE value=VALUES(value),charges=VALUES(charges),expires_at=VALUES(expires_at),source=VALUES(source)`,
    [playerId, key, value, Math.max(1, charges), Math.max(1, seconds), source]
  );
}

async function shield(playerId: number, amount: number, seconds: number, source: string) {
  if (amount <= 0) return;
  await db.query(
    `INSERT INTO player_shields(player_id,max_absorb,remaining_absorb,expires_at,source)
     VALUES(?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
     ON DUPLICATE KEY UPDATE max_absorb=VALUES(max_absorb),remaining_absorb=VALUES(remaining_absorb),expires_at=VALUES(expires_at)`,
    [playerId, amount, amount, seconds, source]
  );
}

export async function getActiveBerserkerDamageMultiplier(
  playerId: number,
  currentHP: number,
  maxHP: number
): Promise<number> {
  const [[effect]]: any = await db.query(
    `SELECT value FROM player_status_effects WHERE player_id=? AND effect_key='berserker_death_wish'
       AND expires_at>NOW(3) LIMIT 1`,
    [playerId]
  );
  if (!effect) return 1;
  const missing = 1 - Math.max(0, Math.min(1, currentHP / Math.max(1, maxHP)));
  const progress = Math.min(1, missing / 0.8);
  return 1 + Math.max(0, Number(effect.value) || 0) * progress / 100;
}

export async function processBerserkerCriticalGauge(playerId: number, critical: boolean): Promise<number> {
  if (!critical) return 0;
  const [[effect]]: any = await db.query(
    `SELECT value FROM player_status_effects WHERE player_id=? AND effect_key='berserker_critical_gauge'
       AND expires_at>NOW(3) ORDER BY value DESC LIMIT 1`,
    [playerId]
  );
  return Math.max(0, Number(effect?.value) || 0);
}

export async function convertBerserkerLifestealOverhealToShield(
  playerId: number,
  overhealing: number,
  seconds = 8
): Promise<number> {
  if (overhealing <= 0) return 0;
  const [[effect]]: any = await db.query(
    `SELECT id FROM player_status_effects WHERE player_id=? AND effect_key='berserker_lifesteal_overheal_shield'
       AND expires_at>NOW(3) LIMIT 1`,
    [playerId]
  );
  if (!effect) return 0;
  const amount = Math.max(1, Math.floor(overhealing));
  await shield(playerId, amount, seconds, `berserker:blood_fed:${effect.id}`);
  return amount;
}

export const berserkerTalentHandlers: Record<string, SpellTalentHandler> = {
  berserker_relentless_strikes: {
    modifySpell(c) { c.spell.damage = Math.round(Number(c.spell.damage || 0) * (1 + n(c.talent.config, "damagePercent", 40) / 100)); }
  },
  berserker_fevered_momentum: {
    modifySpell(c) { const r = rank(c); r.casterGaugeGain = Number(r.casterGaugeGain || 0) + n(c.talent.config, "additionalGaugeGain", 8); }
  },
  berserker_cleaving_frenzy: {
    afterCast(c, result) { return result.dodged ? result : { ...result, splashDamagePercent: n(c.talent.config, "splashPercent", 50) }; }
  },
  berserker_jagged_slash: {
    async afterCast(c, result) {
      if (result.dodged || !c.enemy || Number(result.damage) <= 0 || Number(result.enemyHP) <= 0) return result;
      const total = Math.max(1, Math.floor(Number(result.damage) * n(c.talent.config, "bleedDamagePercent", 40) / 100));
      await applySpellDot(c.enemy, {
        sourcePlayerId: c.playerId, spellId: Number(c.spell.id), spellName: "Jagged Slash",
        totalDamage: total, durationSeconds: n(c.talent.config, "durationSeconds", 6),
        tickRateSeconds: n(c.talent.config, "tickRateSeconds", 2)
      });
      return { ...result, appliedStatus: true };
    }
  },
  berserker_blood_rush: {
    afterCast(c, result) { return result.crit ? { ...result, casterGaugeGain: (Number(result.casterGaugeGain) || 0) + n(c.talent.config, "criticalGaugeGain", 20) } : result; }
  },
  berserker_relentless_pace: {
    afterCast(c, result) { return result.dodged ? result : { ...result, reduceOtherCooldownsSeconds: n(c.talent.config, "cooldownReductionSeconds", 2) }; }
  },

  berserker_deep_wounds: {
    modifySpell(c) { c.spell.dot_damage = Math.round(Number(c.spell.dot_damage || 0) * (1 + n(c.talent.config, "dotDamagePercent", 50) / 100)); }
  },
  berserker_bloodletting: {
    modifySpell(c) { rank(c).rendImmediateDamagePercent = n(c.talent.config, "immediateDamagePercent", 35); }
  },
  berserker_scent_of_blood: {
    modifySpell(c) { rank(c).rendTickHealingPercent = n(c.talent.config, "tickHealingPercent", 25); }
  },
  berserker_crippling_hemorrhage: {
    async afterCast(c, result) {
      if (!c.enemy || !result.appliedStatus) return result;
      await applySpellDebuff(c.enemy, {
        sourcePlayerId: c.playerId, spellId: Number(c.spell.id), spellName: "Crippling Hemorrhage",
        stat: "damage_dealt_pct", value: n(c.talent.config, "damageReductionPercent", 15),
        durationSeconds: Number(c.spell.dot_duration || 1)
      });
      return result;
    }
  },
  berserker_spreading_wound: {
    modifySpell(c) { c.spell.target_type = String(c.talent.config.targetType || "all_enemies"); }
  },
  berserker_rupture: {
    modifySpell(c) { rank(c).rendRupturePercent = n(c.talent.config, "remainingDamagePercent", 75); }
  },

  berserker_unrestrained_fury: {
    modifySpell(c) {
      const r = rank(c);
      r.attackPercent = Number(r.attackPercent || c.spell.buff_value || 0) + n(c.talent.config, "additionalAttackPoints", 15);
      r.damageTakenPercent = Number(r.damageTakenPercent || 0) + n(c.talent.config, "additionalDamageTakenPoints", 5);
    }
  },
  berserker_crimson_resilience: {
    modifySpell(c) {
      const r = rank(c);
      r.lifestealPercent = Number(r.lifestealPercent || 0) + n(c.talent.config, "additionalLifestealPoints", 5);
      r.damageTakenPercent = Number(r.damageTakenPercent || 0) * (1 - n(c.talent.config, "penaltyReductionPercent", 50) / 100);
    }
  },
  berserker_death_wish: {
    async afterCast(c, result) {
      await status(c.playerId, "berserker_death_wish", n(c.talent.config, "maximumDamagePercent", 40), 99, Number(c.spell.buff_duration || 1), `spell:${c.spell.id}`);
      return result;
    }
  },
  berserker_furious_onslaught: {
    async afterCast(c, result) {
      await status(c.playerId, "berserker_critical_gauge", n(c.talent.config, "criticalGaugeGain", 10), 99, Number(c.spell.buff_duration || 1), `spell:${c.spell.id}`);
      return result;
    }
  },
  berserker_blood_fed: {
    modifySpell(c) { const r = rank(c); r.lifestealPercent = Number(r.lifestealPercent || 0) + n(c.talent.config, "additionalLifestealPoints", 5); },
    async afterCast(c, result) {
      await status(c.playerId, "berserker_lifesteal_overheal_shield", 1, 99, Number(c.spell.buff_duration || 1), `spell:${c.spell.id}`);
      return result;
    }
  },
  berserker_refuse_to_fall: {
    async afterCast(c, result) {
      const source = `berserker:blood_rage:${c.spell.id}`;
      await status(c.playerId, "death_prevention", 1, n(c.talent.config, "deathPreventionCharges", 1), Number(c.spell.buff_duration || 1), source);
      await status(c.playerId, "berserker_refuse_to_fall", 1, 1, Number(c.spell.buff_duration || 1), source);
      return result;
    }
  },

  berserker_crushing_force: {
    modifySpell(c) { c.spell.damage = Math.round(Number(c.spell.damage || 0) * (1 + n(c.talent.config, "damagePercent", 35) / 100)); }
  },
  berserker_predators_instinct: {
    modifySpell(c) { rank(c).woundedThresholdPercent = n(c.talent.config, "woundedThresholdPercent", 70); }
  },
  berserker_armor_crusher: {
    modifySpell(c) { rank(c).defensePenetrationPercent = n(c.talent.config, "defensePenetrationPercent", 40); }
  },
  berserker_seismic_blow: {
    afterCast(c, result) { return result.dodged ? result : { ...result, splashDamagePercent: n(c.talent.config, "splashPercent", 50) }; }
  },
  berserker_merciless: {
    modifySpell(c) { const r = rank(c); r.woundedBonusPercent = Number(r.woundedBonusPercent || 0) + n(c.talent.config, "additionalWoundedBonusPoints", 30); }
  },
  berserker_feast_on_weakness: {
    async afterCast(c, result) {
      if (!result.woundedTarget || Number(result.damage) <= 0) return result;
      const current = Math.max(0, Number(c.currentPlayerHP ?? c.player?.hpoints ?? 0));
      const maximum = Math.max(1, Number(c.maxPlayerHP ?? c.player?.maxhp ?? 1));
      const desired = Math.floor(Number(result.damage) * n(c.talent.config, "damageHealingPercent", 20) / 100);
      const finalHP = Math.min(maximum, current + desired);
      const healing = Math.max(0, finalHP - current);
      if (healing > 0) await db.query(`UPDATE players SET hpoints=? WHERE id=?`, [finalHP, c.playerId]);
      return { ...result, playerHP: finalHP, healing: (Number(result.healing) || 0) + healing };
    }
  },

  berserker_killing_rhythm: {
    modifySpell(c) {
      const r = rank(c);
      r.critChancePercent = Number(r.critChancePercent || 0) + n(c.talent.config, "additionalCritPoints", 10);
      r.atbRatePercent = Number(r.atbRatePercent || 0) + n(c.talent.config, "additionalAtbRatePoints", 15);
    }
  },
  berserker_warpath: {
    modifySpell(c) { rank(c).sharedBonusPercent = n(c.talent.config, "sharedBonusPercent", 50); }
  },
  berserker_perfect_frenzy: {
    async afterCast(c, result) {
      await applyBuff(c.playerId, "crit_damage", n(c.talent.config, "criticalDamagePercent", 40), Number(c.spell.buff_duration || 1), `talent:${c.talent.id}`);
      return result;
    }
  },
  berserker_untouchable_tempo: {
    modifySpell(c) { c.spell.buff_duration = Number(c.spell.buff_duration || 0) + n(c.talent.config, "additionalDurationSeconds", 4); },
    async afterCast(c, result) {
      await applyBuff(c.playerId, "dodge", n(c.talent.config, "dodgePercent", 15), Number(c.spell.buff_duration || 1), `talent:${c.talent.id}`);
      return result;
    }
  },
  berserker_pack_frenzy: {
    afterCast(c, result) { return { ...result, partyGaugeGain: (Number(result.partyGaugeGain) || 0) + n(c.talent.config, "partyGaugeGain", 25) }; }
  },
  berserker_shared_bloodlust: {
    async afterCast(c, result) {
      for (const ally of living(c)) await applyBuff(ally.playerId, "damage_dealt_pct", n(c.talent.config, "partyDamagePercent", 15), Number(c.spell.buff_duration || 1), `talent:${c.talent.id}`);
      return result;
    }
  },

  berserker_headsmans_precision: {
    modifySpell(c) { const r = rank(c); r.executeThresholdPercent = Number(r.executeThresholdPercent || 0) + n(c.talent.config, "additionalExecuteThresholdPoints", 10); }
  },
  berserker_blood_for_blood: {
    modifySpell(c) { c.spell.damage = Math.round(Number(c.spell.damage || 0) * (1 + n(c.talent.config, "damagePercent", 50) / 100)); },
    async beforeCast(c) {
      const current = Math.max(1, Number(c.currentPlayerHP ?? c.player?.hpoints ?? 1));
      const cost = Math.min(current - 1, Math.floor(current * n(c.talent.config, "currentHpCostPercent", 15) / 100));
      if (cost <= 0) return;
      await db.query(`UPDATE players SET hpoints=GREATEST(1,hpoints-?) WHERE id=?`, [cost, c.playerId]);
      c.castState.values.set("berserkerBloodForBloodCost", cost);
    }
  },
  berserker_executioners_edge: {
    modifySpell(c) { rank(c).executeDefensePenetrationPercent = n(c.talent.config, "executeDefensePenetrationPercent", 50); }
  },
  berserker_final_sentence: {
    modifySpell(c) { const r = rank(c); r.executeMultiplier = Number(r.executeMultiplier || 1) + n(c.talent.config, "additionalExecuteMultiplier", 0.75); }
  },
  berserker_rolling_heads: {
    afterCast(c, result) { return result.killedEnemy ? { ...result, resetSpellCooldown: Number(c.spell.id) } : result; }
  },
  berserker_crimson_reprisal: {
    async afterCast(c, result) {
      if (result.killedEnemy) return result;
      const cost = Math.max(0, Number(c.castState.values.get("berserkerBloodForBloodCost")) || 0);
      if (cost > 0 && c.talent.config.refundHealthCostOnFailure) {
        await db.query(`UPDATE players SET hpoints=LEAST(?,hpoints+?) WHERE id=?`, [Math.max(1, Number(c.maxPlayerHP || c.player?.maxhp || 1)), cost, c.playerId]);
      }
      return { ...result, reduceCurrentCooldownSeconds: n(c.talent.config, "cooldownReductionSeconds", 60), refundedHealth: cost };
    }
  }
};
