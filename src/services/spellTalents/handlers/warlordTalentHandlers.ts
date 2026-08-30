import { db } from "../../../db";
import { applyBuff } from "../../buffService";
import { applySpellDebuff } from "../../spellHandlers/helpers";
import type { SpellTalentHandler, TalentConfig } from "../types";

const n = (config: TalentConfig, key: string, fallback = 0): number => {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
};

const cfg = (context: any): Record<string, any> => {
  if (!context.spell.rank_config || typeof context.spell.rank_config !== "object") {
    context.spell.rank_config = {};
  }
  return context.spell.rank_config;
};

const living = (context: any): any[] => {
  const allies = (context.allies ?? []).filter((ally: any) => Number(ally.hp) > 0);
  return allies.length > 0 ? allies : [{
    playerId: context.playerId,
    hp: Number(context.currentPlayerHP ?? context.player?.hpoints ?? 1),
    maxHp: Number(context.maxPlayerHP ?? context.player?.maxhp ?? 1),
    sp: Number(context.currentPlayerSP ?? context.player?.spoints ?? 0),
    maxSp: Number(context.maxPlayerSP ?? context.player?.maxspoints ?? 0),
    stats: context.player
  }];
};

const allParty = (context: any): any[] => {
  const supplied = (context as any).alliesIncludingDefeated;
  return Array.isArray(supplied) && supplied.length > 0 ? supplied : living(context);
};

const maxHp = (ally: any): number =>
  Math.max(1, Number(ally.maxHp ?? ally.stats?.maxhp ?? 1));

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

async function deathProtection(
  playerId: number,
  charges: number,
  survivalHpPercent: number,
  seconds: number,
  source: string
): Promise<void> {
  await status(playerId, "death_prevention", 1, charges, seconds, source);
  await status(
    playerId,
    "warlord_death_trigger_heal_pct",
    Math.max(0, survivalHpPercent),
    charges,
    seconds,
    source
  );
}

async function enemyDebuff(
  context: any,
  stat: string,
  value: number,
  seconds: number
): Promise<void> {
  if (!context.enemy || value === 0 || seconds <= 0) return;
  await applySpellDebuff(context.enemy, {
    sourcePlayerId: context.playerId,
    spellId: Number(context.spell.id),
    spellName: String(context.spell.name || "Warlord Order"),
    stat,
    value,
    durationSeconds: seconds
  });
}

async function cleanseOne(playerId: number): Promise<void> {
  const [[harmful]]: any = await db.query(
    `SELECT id FROM player_buffs
     WHERE player_id=? AND value<0 AND expires_at>NOW(3)
     ORDER BY expires_at ASC,id ASC LIMIT 1`,
    [playerId]
  );
  if (harmful) await db.query(`DELETE FROM player_buffs WHERE id=?`, [harmful.id]);
}

async function hot(
  playerId: number,
  healingPerTick: number,
  tickRate: number,
  duration: number,
  source: string,
  displayName: string
): Promise<void> {
  await db.query(`DELETE FROM player_hots WHERE player_id=? AND source=?`, [playerId, source]);
  await db.query(
    `INSERT INTO player_hots
       (player_id,healing,tick_interval,next_tick_at,expires_at,source,display_name)
     VALUES (?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),DATE_ADD(NOW(3),INTERVAL ? SECOND),?,?)`,
    [playerId, Math.max(1, Math.floor(healingPerTick)), tickRate, tickRate, duration, source, displayName]
  );
}

export type WarlordNextSpellOrder = {
  damagePercent: number;
  free: boolean;
  sources: string[];
};

export async function getWarlordNextSpellOrder(playerId: number): Promise<WarlordNextSpellOrder> {
  const [rows]: any = await db.query(
    `SELECT effect_key,value,source FROM player_status_effects
     WHERE player_id=?
       AND effect_key IN ('warlord_next_spell_damage_pct','warlord_next_spell_free')
       AND expires_at>NOW(3) AND charges>0`,
    [playerId]
  );
  return {
    damagePercent: Math.max(0, ...rows.filter((row: any) => row.effect_key === "warlord_next_spell_damage_pct").map((row: any) => Number(row.value) || 0)),
    free: rows.some((row: any) => row.effect_key === "warlord_next_spell_free"),
    sources: Array.from(new Set(rows.map((row: any) => String(row.source)))) as string[]
  };
}

export async function consumeWarlordNextSpellOrder(
  playerId: number,
  order: WarlordNextSpellOrder
): Promise<void> {
  if (order.sources.length === 0) return;
  await db.query(
    `DELETE FROM player_status_effects
     WHERE player_id=?
       AND effect_key IN ('warlord_next_spell_damage_pct','warlord_next_spell_free')
       AND source IN (?)`,
    [playerId, order.sources]
  );
}

export async function processWarlordBannerGaugeTick(playerId: number): Promise<number> {
  const [[effect]]: any = await db.query(
    `SELECT id,value,source FROM player_status_effects
     WHERE player_id=? AND effect_key='warlord_banner_gauge_tick'
       AND expires_at>NOW(3) ORDER BY value DESC LIMIT 1`,
    [playerId]
  );

  if (!effect) return 0;

  const source = String(effect.source || "");
  const tickRate = Math.max(1, Number(source.split(":").pop()) || 5);
  const lockSource = `tick:${source}`;
  const [[lock]]: any = await db.query(
    `SELECT id FROM player_status_effects
     WHERE player_id=? AND effect_key='warlord_banner_gauge_lock'
       AND source=? AND expires_at>NOW(3) LIMIT 1`,
    [playerId, lockSource]
  );

  if (lock) return 0;

  await status(playerId, "warlord_banner_gauge_lock", 1, 1, tickRate, lockSource);
  return Math.max(0, Number(effect.value) || 0);
}

export type WarlordMarkedEnemy = {
  id?: number | string;
  sourceType?: string;
  getDebuffValue?: (stat: string) => Promise<number>;
  extendWarlordMark?: (maximumExtensionSeconds: number) => Promise<number>;
};

export type WarlordClaimResult = {
  gaugeGain: number;
  players: Array<{ playerId: number; hp: number; sp: number }>;
};

/** Process effects which trigger whenever any player damages Mark for Death. */
export async function processWarlordMarkedHit(
  enemy: WarlordMarkedEnemy | null | undefined,
  attackerPlayerId: number,
  damage: number,
): Promise<{ gaugeGain: number; extendedSeconds: number }> {
  if (!enemy?.getDebuffValue || damage <= 0) {
    return { gaugeGain: 0, extendedSeconds: 0 };
  }

  const [bountyGauge, bountyIcd, maximumExtension] = await Promise.all([
    enemy.getDebuffValue("warlord_bounty_gauge"),
    enemy.getDebuffValue("warlord_bounty_icd"),
    enemy.getDebuffValue("warlord_mark_extension"),
  ]);

  let gaugeGain = 0;
  if (bountyGauge > 0) {
    const targetKey = `${String(enemy.sourceType || "enemy")}:${String(enemy.id || 0)}`;
    const [[lock]]: any = await db.query(
      `SELECT id FROM player_status_effects
       WHERE player_id=? AND effect_key='warlord_bounty_hit_lock'
         AND source=? AND expires_at>NOW(3) LIMIT 1`,
      [attackerPlayerId, targetKey],
    );

    if (!lock) {
      gaugeGain = Math.max(0, Number(bountyGauge) || 0);
      await status(
        attackerPlayerId,
        "warlord_bounty_hit_lock",
        1,
        1,
        Math.max(1, Number(bountyIcd) || 2),
        targetKey,
      );
    }
  }

  const extendedSeconds = maximumExtension > 0 && enemy.extendWarlordMark
    ? await enemy.extendWarlordMark(maximumExtension)
    : 0;

  return { gaugeGain, extendedSeconds };
}

/** Apply Claim the Prize before the marked enemy and its debuffs are deleted. */
export async function processWarlordClaimThePrize(
  enemy: WarlordMarkedEnemy | null | undefined,
  playerIds: Iterable<number>,
): Promise<WarlordClaimResult> {
  if (!enemy?.getDebuffValue) return { gaugeGain: 0, players: [] };

  const [hpPercent, manaPercent, gaugeGain] = await Promise.all([
    enemy.getDebuffValue("warlord_claim_hp_pct"),
    enemy.getDebuffValue("warlord_claim_mana_pct"),
    enemy.getDebuffValue("warlord_claim_gauge"),
  ]);

  if (hpPercent <= 0 && manaPercent <= 0 && gaugeGain <= 0) {
    return { gaugeGain: 0, players: [] };
  }

  const uniqueIds = Array.from(new Set(Array.from(playerIds, Number)))
    .filter((id) => Number.isFinite(id) && id > 0);
  const players: WarlordClaimResult["players"] = [];

  for (const playerId of uniqueIds) {
    await db.query(
      `UPDATE players SET
         hpoints=GREATEST(hpoints,LEAST(maxhp,hpoints+FLOOR(maxhp*?/100))),
         spoints=GREATEST(spoints,LEAST(maxspoints,spoints+FLOOR(maxspoints*?/100)))
       WHERE id=? AND hpoints>0`,
      [Math.max(0, hpPercent), Math.max(0, manaPercent), playerId],
    );
    const [[row]]: any = await db.query(
      `SELECT hpoints,spoints FROM players WHERE id=? LIMIT 1`,
      [playerId],
    );
    if (row) players.push({
      playerId,
      hp: Number(row.hpoints) || 0,
      sp: Number(row.spoints) || 0,
    });
  }

  return { gaugeGain: Math.max(0, Number(gaugeGain) || 0), players };
}

export const warlordTalentHandlers: Record<string, SpellTalentHandler> = {
  warlord_coordinated_assault: {
    afterCast(context, result) {
      return { ...result, partyGaugeGain: (Number(result.partyGaugeGain) || 0) + n(context.talent.config, "partyGaugeGain", 12) };
    }
  },
  warlord_expose_the_flank: {
    async afterCast(context, result) {
      if (!result.dodged) await enemyDebuff(context, "damage_taken_pct", n(context.talent.config, "damageTakenPercent", 10), n(context.talent.config, "durationSeconds", 6));
      return result;
    }
  },
  warlord_press_the_attack: {
    afterCast(context, result) {
      return { ...result, partyGaugeGain: (Number(result.partyGaugeGain) || 0) + n(context.talent.config, "additionalGaugeGain", 8) };
    }
  },
  warlord_opening_volley: {
    async afterCast(context, result) {
      for (const ally of living(context)) {
        await status(Number(ally.playerId), "warlord_next_spell_damage_pct", n(context.talent.config, "damagePercent", 25), n(context.talent.config, "charges", 1), n(context.talent.config, "durationSeconds", 10), `warlord:opening_volley:${context.playerId}`);
      }
      return result;
    }
  },
  warlord_shatter_formation: {
    async afterCast(context, result) {
      if (!result.dodged && context.enemy) {
        const defense = Math.max(1, Number(context.enemy.stats?.defense ?? context.enemy.defense ?? 1));
        const reduction = -Math.max(1, Math.floor(defense * n(context.talent.config, "defenseReductionPercent", 15) / 100));
        await enemyDebuff(context, "defense", reduction, n(context.talent.config, "durationSeconds", 6));
      }
      return result;
    }
  },
  warlord_relentless_orders: {
    afterCast(context, result) {
      return result.crit ? { ...result, reduceOtherCooldownsSeconds: (Number(result.reduceOtherCooldownsSeconds) || 0) + n(context.talent.config, "cooldownReductionSeconds", 3) } : result;
    }
  },

  warlord_inspiring_rally: {
    afterCast(context, result) {
      return { ...result, partyGaugeGain: (Number(result.partyGaugeGain) || 0) + n(context.talent.config, "partyGaugeGain", 15) };
    }
  },
  warlord_bolstering_cry: { modifySpell(context) { cfg(context).rallyOverhealShieldPercent = n(context.talent.config, "shieldMaxHpPercent", 12); cfg(context).rallyShieldDuration = n(context.talent.config, "durationSeconds", 10); } },
  warlord_renewed_purpose: {
    afterCast(context, result) {
      const threshold = n(context.talent.config, "healthThresholdPercent", 50);
      const gain = n(context.talent.config, "additionalGaugeGain", 20);
      const bonuses = Object.fromEntries(living(context).filter(ally => Number(ally.hp) / maxHp(ally) * 100 < threshold).map(ally => [Number(ally.playerId), gain]));
      return { ...result, playerGaugeBonuses: bonuses } as any;
    }
  },
  warlord_resounding_cry: { modifySpell(context) { cfg(context).rallyHealingDealtPercent = n(context.talent.config, "healingDealtPercent", 15); } },
  warlord_unbroken_morale: { modifySpell(context) { cfg(context).rallyCleanseCount = n(context.talent.config, "cleanseCount", 1); } },
  warlord_refuse_defeat: { modifySpell(context) { const rank = cfg(context); rank.rallyDeathCharges = n(context.talent.config, "charges", 1); rank.rallySurvivalHpPercent = n(context.talent.config, "survivalHpPercent", 10); rank.rallyDeathDuration = n(context.talent.config, "durationSeconds", 8); } },

  warlord_phalanx_formation: { modifySpell(context) { cfg(context).holdShieldMaxHpPercent = n(context.talent.config, "shieldMaxHpPercent", 10); } },
  warlord_commanding_presence: {
    modifySpell(context) { cfg(context).holdBonusThreatMultiplier = 1 + n(context.talent.config, "bonusThreatPercent", 100) / 100; },
    afterCast(context, result) { return { ...result, forceThreatTargetPlayerId: context.playerId }; }
  },
  warlord_shielded_advance: { afterCast(context, result) { return { ...result, partyGaugeGain: (Number(result.partyGaugeGain) || 0) + n(context.talent.config, "partyGaugeGain", 15) }; } },
  warlord_retaliating_formation: { modifySpell(context) { cfg(context).holdThornsPercent = n(context.talent.config, "thornsPercent", 20); } },
  warlord_stand_your_ground: { afterCast(context, result) { return { ...result, enemyGaugeReduction: (Number(result.enemyGaugeReduction) || 0) + n(context.talent.config, "enemyGaugeReduction", 25) }; } },
  warlord_challenge_the_horde: { afterCast(context, result) { return { ...result, forceThreatTargetPlayerId: context.playerId, tauntAllEnemies: true } as any; } },

  warlord_exploit_weakness: { async afterCast(context, result) { await enemyDebuff(context, "crit_chance_taken_pct", n(context.talent.config, "critChanceTakenPercent", 15), Number(context.spell.debuff_duration || 1)); return result; } },
  warlord_bounty_of_war: { async afterCast(context, result) { await enemyDebuff(context, "warlord_bounty_gauge", n(context.talent.config, "gaugeGain", 5), Number(context.spell.debuff_duration || 1)); await enemyDebuff(context, "warlord_bounty_icd", n(context.talent.config, "internalCooldownSeconds", 2), Number(context.spell.debuff_duration || 1)); return result; } },
  warlord_mortal_opening: { async afterCast(context, result) { await enemyDebuff(context, "critical_damage_taken_pct", n(context.talent.config, "criticalDamagePercent", 25), Number(context.spell.debuff_duration || 1)); return result; } },
  warlord_armor_break: { async afterCast(context, result) { if (context.enemy) { const defense = Math.max(1, Number(context.enemy.stats?.defense ?? context.enemy.defense ?? 1)); await enemyDebuff(context, "defense", -Math.max(1, Math.floor(defense * n(context.talent.config, "defenseReductionPercent", 20) / 100)), Number(context.spell.debuff_duration || 1)); } return result; } },
  warlord_sustained_pursuit: { async afterCast(context, result) { await enemyDebuff(context, "warlord_mark_extension", n(context.talent.config, "maximumExtensionSeconds", 5), Number(context.spell.debuff_duration || 1)); return result; } },
  warlord_claim_the_prize: { async afterCast(context, result) { const duration = Number(context.spell.debuff_duration || 1); await enemyDebuff(context, "warlord_claim_hp_pct", n(context.talent.config, "restoreHpPercent", 10), duration); await enemyDebuff(context, "warlord_claim_mana_pct", n(context.talent.config, "restoreManaPercent", 10), duration); await enemyDebuff(context, "warlord_claim_gauge", n(context.talent.config, "partyGaugeGain", 25), duration); return result; } },

  warlord_banner_of_conquest: { modifySpell(context) { cfg(context).bannerDamageDealtPercent = n(context.talent.config, "damageDealtPercent", 10); } },
  warlord_banner_of_resolve: { modifySpell(context) { cfg(context).bannerShieldMaxHpPercent = n(context.talent.config, "shieldMaxHpPercent", 15); } },
  warlord_standard_of_precision: { modifySpell(context) { const rank = cfg(context); rank.bannerCritChancePercent = n(context.talent.config, "critChancePercent", 15); rank.bannerCritDamagePercent = n(context.talent.config, "criticalDamagePercent", 20); } },
  warlord_march_to_victory: { modifySpell(context) { const rank = cfg(context); rank.bannerGaugePerTick = n(context.talent.config, "gaugeGain", 10); rank.bannerTickRate = n(context.talent.config, "tickRateSeconds", 5); } },
  warlord_regimental_recovery: { modifySpell(context) { const rank = cfg(context); rank.bannerHealMaxHpPercent = n(context.talent.config, "healMaxHpPercent", 3); rank.bannerTickRate = n(context.talent.config, "tickRateSeconds", 5); } },
  warlord_unyielding_standard: { modifySpell(context) { const rank = cfg(context); rank.bannerDeathCharges = n(context.talent.config, "charges", 1); rank.bannerSurvivalHp = n(context.talent.config, "survivalHp", 1); } },

  warlord_decisive_assault: { modifySpell(context) { cfg(context).victoryDamageDealtPercent = n(context.talent.config, "damageDealtPercent", 30); } },
  warlord_no_one_left_behind: { modifySpell(context) { const rank = cfg(context); rank.victoryHealMaxHpPercent = n(context.talent.config, "healMaxHpPercent", 30); rank.victoryReviveHpPercent = n(context.talent.config, "reviveHpPercent", 35); } },
  warlord_total_war: { afterCast(context, result) { return { ...result, reducePartyCooldownsSeconds: n(context.talent.config, "cooldownReductionSeconds", 30), excludeUltimateCooldown: Boolean(context.talent.config.excludeUltimate) } as any; } },
  warlord_unstoppable_advance: { modifySpell(context) { const rank = cfg(context); rank.victoryNextSpellFree = n(context.talent.config, "manaCostReductionPercent", 100) >= 100; rank.victoryNextSpellDamagePercent = n(context.talent.config, "damagePercent", 50); rank.victoryNextSpellDuration = n(context.talent.config, "durationSeconds", 15); } },
  warlord_rally_the_fallen: { modifySpell(context) { const rank = cfg(context); rank.victoryReviveHpPercent = n(context.talent.config, "reviveHpPercent", 60); rank.victoryReviveManaPercent = n(context.talent.config, "reviveManaPercent", 40); rank.victoryReviveGauge = n(context.talent.config, "reviveGauge", 100); } },
  warlord_victory_or_death: { modifySpell(context) { const rank = cfg(context); rank.victoryDeathCharges = n(context.talent.config, "charges", 1); rank.victorySurvivalHpPercent = n(context.talent.config, "survivalHpPercent", 20); rank.victoryDeathDuration = n(context.talent.config, "durationSeconds", 15); } }
};

export const warlordTalentRuntime = {
  status,
  shield,
  deathProtection,
  cleanseOne,
  hot,
  living,
  allParty,
  maxHp
};
