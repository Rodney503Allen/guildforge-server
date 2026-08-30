// src/services/spellHandlers/warlordHandlers.ts

import { applyBuff } from "../buffService";
import { db } from "../../db";
import { publishPlayerStatePatch } from "../../playerStateEvents";

import {
  SpellEnemy,
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  calculateScaledSpellAmount,
  getConfiguredBuff,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";


// =====================================================
// RANK CONFIGURATION
// =====================================================

function rankNumber(
  spell: any,
  key: string,
  fallback = 0
): number {
  const value = Number(
    spell?.rank_config?.[key]
  );

  return Number.isFinite(value)
    ? value
    : fallback;
}

async function applyWarlordStatus(
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
     ON DUPLICATE KEY UPDATE value=VALUES(value),charges=VALUES(charges),
       expires_at=VALUES(expires_at),source=VALUES(source)`,
    [playerId, effectKey, value, Math.max(1, Math.floor(charges)), Math.max(1, Math.floor(seconds)), source]
  );
}

async function applyWarlordShield(
  playerId: number,
  amount: number,
  seconds: number,
  source: string
): Promise<void> {
  const absorb = Math.max(1, Math.floor(amount));
  await db.query(
    `INSERT INTO player_shields
       (player_id,max_absorb,remaining_absorb,expires_at,source)
     VALUES (?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
     ON DUPLICATE KEY UPDATE max_absorb=VALUES(max_absorb),
       remaining_absorb=VALUES(remaining_absorb),expires_at=VALUES(expires_at)`,
    [playerId, absorb, absorb, Math.max(1, Math.floor(seconds)), source]
  );
}

async function applyWarlordDeathProtection(
  playerId: number,
  charges: number,
  survivalHpPercent: number,
  seconds: number,
  source: string
): Promise<void> {
  await applyWarlordStatus(playerId, "death_prevention", 1, charges, seconds, source);
  await applyWarlordStatus(playerId, "warlord_death_trigger_heal_pct", survivalHpPercent, charges, seconds, source);
}

async function cleanseOneHarmfulBuff(playerId: number): Promise<void> {
  const [[effect]]: any = await db.query(
    `SELECT id FROM player_buffs WHERE player_id=? AND value<0
       AND expires_at>NOW(3) ORDER BY expires_at ASC,id ASC LIMIT 1`,
    [playerId]
  );
  if (effect) await db.query(`DELETE FROM player_buffs WHERE id=?`, [effect.id]);
}

async function applyWarlordHot(
  playerId: number,
  healing: number,
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
    [playerId, Math.max(1, Math.floor(healing)), tickRate, tickRate, duration, source, displayName]
  );
}


// =====================================================
// SHARED PARTY BUFF TARGETS
// =====================================================

function getLivingAllies(
  playerId: number,
  allies?: any[],
  fallback?: {
    hp?: number;
    maxHp?: number;
    stats?: any;
  }
) {

  if (
    allies &&
    allies.length > 0
  ) {

    return allies.filter(
      ally =>
        Number(
          ally.hp
        ) > 0
    );
  }


  /*
   * Normal solo combat does not supply
   * a party list, so fall back to caster.
   */
  return [
    {
      playerId,
      hp: Number(fallback?.hp ?? 1),
      maxHp: Number(fallback?.maxHp ?? 1),
      stats: fallback?.stats
    }
  ];
}

// =====================================================
// HOLD THE LINE
//
// target_type = all_allies
//
// Reduces damage taken by every living ally.
// In solo combat, it applies to the caster.
// =====================================================

export const holdTheLineHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    if (buff.stat !== "damage_reduction") {
      return (
        `${spell.name} must use damage_reduction`
      );
    }

    if (buff.value <= 0) {
      return (
        `${spell.name} has an invalid damage reduction value`
      );
    }

    if (buff.duration <= 0) {
      return (
        `${spell.name} has an invalid buff duration`
      );
    }

    return null;
  },

  async execute(context): Promise<SpellHandlerResult> {

    const {
      playerId,
      spell,
      allies
    } = context;
    const buff =
      getConfiguredBuff(spell);

    /*
     * The original SQL key used "Percent", but Hold the Line
     * has no damage or healing event to multiply. Treat its
     * configured value as direct bonus threat so the command
     * can immediately pull enemy attention toward the Warlord.
     */
    const bonusThreat =
      Math.max(
        0,
        rankNumber(
          spell,
          "bonusThreat",
          rankNumber(spell, "bonusThreatPercent", 0)
        )
      );

    const targets =
      getLivingAllies(
        playerId,
        allies
      );

    if (targets.length === 0) {
      return {
        log:
          `🛡️ You order your allies to hold the line, ` +
          `but no living allies can answer.`,

        appliedStatus: false
      };
    }

    for (const ally of targets) {
      const allyPlayerId =
        Number(ally.playerId);

      if (
        !Number.isInteger(allyPlayerId) ||
        allyPlayerId <= 0
      ) {
        continue;
      }

      await applyBuff(
        allyPlayerId,
        buff.stat,
        buff.value,
        buff.duration,
        `spell:${spell.id}`
      );

      const rank = spell.rank_config ?? {};
      const maximumHP = Math.max(1, Number(ally.maxHp ?? ally.stats?.maxhp ?? 1));

      if (Number(rank.holdShieldMaxHpPercent) > 0) {
        await applyWarlordShield(
          allyPlayerId,
          maximumHP * Number(rank.holdShieldMaxHpPercent) / 100,
          buff.duration,
          `warlord:hold:${spell.id}:shield`
        );
      }

      if (Number(rank.holdThornsPercent) > 0) {
        await applyWarlordStatus(
          allyPlayerId,
          "warlord_thorns_pct",
          Number(rank.holdThornsPercent),
          99,
          buff.duration,
          `warlord:hold:${spell.id}:thorns`
        );
      }
    }

    return {
      log:
        targets.length > 1
          ? (
              `🛡️ You order your company to hold the line, ` +
              `reducing damage taken by ${buff.value}% for ` +
              `${buff.duration}s!`
            )
          : (
              `🛡️ You hold your ground, reducing damage taken ` +
              `by ${buff.value}% for ` +
              `${buff.duration}s!`
            ),

      appliedStatus: true,
      threatGenerated:
        bonusThreat * Math.max(1, rankNumber(spell, "holdBonusThreatMultiplier", 1))
    };
  }
};

// =====================================================
// RALLYING CRY
//
// Restores a percentage of maximum HP and increases
// healing received for every living ally.
// =====================================================

export const rallyingCryHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    const healPercent =
      Number(spell.heal) || 0;

    if (healPercent <= 0) {
      return (
        `${spell.name} has an invalid maximum-HP heal percentage`
      );
    }

    if (buff.stat !== "healing_received_pct") {
      return (
        `${spell.name} must use healing_received_pct`
      );
    }

    if (buff.value <= 0) {
      return (
        `${spell.name} has an invalid healing received bonus`
      );
    }

    if (buff.duration <= 0) {
      return (
        `${spell.name} has an invalid buff duration`
      );
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player,
    allies,
    currentPlayerHP,
    maxPlayerHP
  }): Promise<SpellHandlerResult> {
    const buff =
      getConfiguredBuff(spell);

    const targets =
      getLivingAllies(
        playerId,
        allies,
        {
          hp: currentPlayerHP,
          maxHp: maxPlayerHP,
          stats: player
        }
      );

    const validTargets =
      targets.filter(ally => {
        const allyPlayerId =
          Number(ally.playerId);

        return (
          Number.isInteger(allyPlayerId) &&
          allyPlayerId > 0
        );
      });

    if (validTargets.length === 0) {
      return {
        log:
          `📣 You sound ${spell.name}, but no ` +
          `living allies can answer.`,

        appliedStatus: false
      };
    }

    const healPercent =
      Math.max(0, Number(spell.heal) || 0);

    let casterHP: number | undefined;
    let totalHealing = 0;

    for (const ally of validTargets) {
      const allyPlayerId =
        Number(ally.playerId);

      const maxHp =
        Math.max(1, Number(ally.maxHp) || 1);

      const currentHp =
        Math.max(0, Number(ally.hp) || 0);

      const healingReceivedMult =
        Math.max(
          0,
          Number(ally.stats?.healingReceivedMult) || 1
        );

      const requestedHealing =
        Math.max(
          1,
          Math.floor(
            maxHp *
            (healPercent / 100) *
            healingReceivedMult
          )
        );

      const newHp =
        Math.min(maxHp, currentHp + requestedHealing);

      const actualHealing =
        Math.max(0, newHp - currentHp);

      const overhealing =
        Math.max(0, requestedHealing - actualHealing);

      await db.query(
        `UPDATE players SET hpoints = ? WHERE id = ?`,
        [newHp, allyPlayerId]
      );

      publishPlayerStatePatch(
        allyPlayerId,
        {
          hpoints: newHp,
          maxhp: maxHp
        }
      );

      await applyBuff(
        allyPlayerId,
        buff.stat,
        buff.value,
        buff.duration,
        `spell:${spell.id}`
      );

      const rank = spell.rank_config ?? {};
      const shieldCap = Math.floor(
        maxHp * Math.max(0, Number(rank.rallyOverhealShieldPercent) || 0) / 100
      );

      if (overhealing > 0 && shieldCap > 0) {
        await applyWarlordShield(
          allyPlayerId,
          Math.min(overhealing, shieldCap),
          Math.max(1, Number(rank.rallyShieldDuration) || buff.duration),
          `warlord:rally:${spell.id}:shield`
        );
      }

      if (Number(rank.rallyHealingDealtPercent) > 0) {
        await applyBuff(
          allyPlayerId,
          "healing_dealt_pct",
          Number(rank.rallyHealingDealtPercent),
          buff.duration,
          `warlord:rally:${spell.id}:healing`
        );
      }

      if (Number(rank.rallyCleanseCount) > 0) {
        await cleanseOneHarmfulBuff(allyPlayerId);
      }

      if (Number(rank.rallyDeathCharges) > 0) {
        await applyWarlordDeathProtection(
          allyPlayerId,
          Number(rank.rallyDeathCharges),
          Number(rank.rallySurvivalHpPercent) || 10,
          Number(rank.rallyDeathDuration) || 8,
          `warlord:rally:${spell.id}:death`
        );
      }

      totalHealing += actualHealing;

      if (allyPlayerId === playerId) {
        casterHP = newHp;
      }
    }

    return {
      log:
        validTargets.length > 1
          ? (
              `📣 You sound ${spell.name}, restoring your ` +
              `company's health and increasing healing received by ` +
              `${buff.value}% for ` +
              `${buff.duration}s!`
            )
          : (
              `📣 You sound ${spell.name}, restoring ${totalHealing} ` +
              `health and increasing healing received by ${buff.value}% for ` +
              `${buff.duration}s!`
            ),

      appliedStatus: true,
      healing: totalHealing,
      ...(casterHP !== undefined
        ? { playerHP: casterHP }
        : {})
    };
  }
};

// =====================================================
// COMMANDING STRIKE
//
// Deals damage to the enemy.
//
// Also grants the configured attack buff
// to the allied party.
//
// Normal solo combat:
//   caster receives the buff.
//
// Hunt combat:
//   every living party member receives it.
// =====================================================

export const commandingStrikeHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    const buff =
      getConfiguredBuff(
        spell
      );


    if (
      baseDamage <= 0
    ) {

      return (
        `${spell.name} has invalid damage configuration`
      );
    }


    if (
      buff.stat !==
      "attack_pct"
    ) {

      return (
        `${spell.name} must use attack_pct`
      );
    }


    if (
      buff.value <= 0
    ) {

      return (
        `${spell.name} has an invalid attack bonus`
      );
    }


    if (
      buff.duration <= 0
    ) {

      return (
        `${spell.name} has an invalid buff duration`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    enemy,
    allies
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {

      throw new Error(
        "Commanding Strike handler received no enemy"
      );
    }


    // =================================================
    // DAMAGE
    // =================================================

    const scaledDamage =
      calculateScaledSpellAmount(
        player,
        Number(
          spell.damage
        ) || 0
      );


    const damageResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDamage
      );


    const dodged =
      Boolean(
        damageResult.dodged
      );


    const damage =
      dodged
        ? 0
        : Math.max(
            1,
            Number(
              damageResult.damage
            ) || 1
          );


    const enemyHP =
      Math.max(
        0,
        Number(
          enemy.hp
        ) -
        damage
      );


    /*
     * Universal enemy persistence.
     */
    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    // =================================================
    // PARTY ATTACK BUFF
    // =================================================

    const buff =
      getConfiguredBuff(
        spell
      );


    const targets =
      getLivingAllies(
        playerId,
        allies
      );


    for (
      const ally of
      targets
    ) {

      await applyBuff(
        ally.playerId,
        buff.stat,
        buff.value,
        buff.duration,
        `spell:${spell.id}`
      );
    }


    // =================================================
    // LOG
    // =================================================

    let log:
      string;


    if (
      dodged
    ) {

      log =
        `⚔️ ${spell.name} misses the enemy!`;

    } else if (
      damageResult.crit
    ) {

      log =
        `⚔️ Critical! ${spell.name} hits for ` +
        `${damage} damage!`;

    } else {

      log =
        `⚔️ ${spell.name} hits for ` +
        `${damage} damage!`;
    }


    if (
      targets.length > 1
    ) {

      log +=
        ` Your company gains ${buff.value}% Attack ` +
        `for ${buff.duration}s!`;

    } else {

      log +=
        ` Your attack increases by ${buff.value}% ` +
        `for ${buff.duration}s!`;
    }


    return {
      log,

      damage,

      enemyHP,

      appliedStatus:
        true,

      killedEnemy:
        enemyHP <= 0,

      crit:
        Boolean(
          damageResult.crit
        ),

      dodged
    };
  }
};


// =====================================================
// WAR BANNER
//
// target_type = all_allies
//
// Grants rank-configured Attack and damage reduction.
//
// Applies to every living ally.
// =====================================================

export const warBannerHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    false,


  validate(spell) {

    const duration =
      Number(
        spell.buff_duration
      ) || 0;


    if (
      duration <= 0
    ) {

      return (
        `${spell.name} has an invalid duration`
      );
    }


    if (
      rankNumber(
        spell,
        "damageReductionPercent",
        10
      ) <= 0
    ) {

      return (
        `${spell.name} has invalid damage reduction configuration`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    allies
  }): Promise<SpellHandlerResult> {

    const duration =
      Number(
        spell.buff_duration
      ) || 12;


    const attackBonus =
      Math.max(0, Number(spell.buff_value) || 0);


    const damageReductionBonus =
      Math.max(
        0,
        rankNumber(
          spell,
          "damageReductionPercent",
          10
        )
      );


    const targets =
      getLivingAllies(
        playerId,
        allies
      );


    if (
      targets.length === 0
    ) {

      return {
        log:
          `🚩 You plant ${spell.name}, but there are ` +
          `no living allies to rally.`,

        appliedStatus:
          false
      };
    }


    for (
      const ally of
      targets
    ) {

      await applyBuff(
        ally.playerId,
        "attack_pct",
        attackBonus,
        duration,
        `spell:${spell.id}:attack`
      );


      await applyBuff(
        ally.playerId,
        "damage_reduction",
        damageReductionBonus,
        duration,
        `spell:${spell.id}:damage_reduction`
      );

      const rank = spell.rank_config ?? {};
      const allyMaxHp = Math.max(1, Number(ally.maxHp ?? ally.stats?.maxhp ?? 1));

      if (Number(rank.bannerDamageDealtPercent) > 0) {
        await applyBuff(ally.playerId, "damage_dealt_pct", Number(rank.bannerDamageDealtPercent), duration, `warlord:banner:${spell.id}:damage`);
      }

      if (Number(rank.bannerShieldMaxHpPercent) > 0) {
        await applyWarlordShield(ally.playerId, allyMaxHp * Number(rank.bannerShieldMaxHpPercent) / 100, duration, `warlord:banner:${spell.id}:shield`);
      }

      if (Number(rank.bannerCritChancePercent) > 0) {
        await applyBuff(ally.playerId, "crit_chance", Number(rank.bannerCritChancePercent), duration, `warlord:banner:${spell.id}:crit`);
      }

      if (Number(rank.bannerCritDamagePercent) > 0) {
        await applyBuff(ally.playerId, "crit_damage_pct", Number(rank.bannerCritDamagePercent), duration, `warlord:banner:${spell.id}:crit_damage`);
      }

      if (Number(rank.bannerGaugePerTick) > 0) {
        await applyWarlordStatus(
          ally.playerId,
          "warlord_banner_gauge_tick",
          Number(rank.bannerGaugePerTick),
          99,
          duration,
          `warlord:banner:${spell.id}:${Number(rank.bannerTickRate) || 5}`
        );
      }

      if (Number(rank.bannerHealMaxHpPercent) > 0) {
        const tickRate = Math.max(1, Number(rank.bannerTickRate) || 5);
        await applyWarlordHot(
          ally.playerId,
          allyMaxHp * Number(rank.bannerHealMaxHpPercent) / 100,
          tickRate,
          duration,
          `warlord:banner:${spell.id}:recovery`,
          "Regimental Recovery"
        );
      }

      if (Number(rank.bannerDeathCharges) > 0) {
        await applyWarlordDeathProtection(
          ally.playerId,
          Number(rank.bannerDeathCharges),
          0,
          duration,
          `warlord:banner:${spell.id}:death`
        );
      }
    }


    return {
      log:
        targets.length > 1
          ? (
              `🚩 You plant ${spell.name}, granting your company ` +
              `${attackBonus}% Attack and ${damageReductionBonus}% damage reduction ` +
              `for ${duration}s!`
            )
          : (
              `🚩 You plant ${spell.name}, gaining ` +
              `${attackBonus}% Attack and ${damageReductionBonus}% damage reduction ` +
              `for ${duration}s!`
            ),

      appliedStatus:
        true
    };
  }
};


// =====================================================
// CALL TO VICTORY
//
// target_type = all_allies
//
// Immediately advances each ally's ATB gauge,
// then grants critical chance and faster ATB generation.
// Gauge and ATB values scale through spell-rank config.
//
// Applies to every living ally.
// =====================================================

export const callToVictoryHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    false,


  validate(spell) {

    const duration =
      Number(
        spell.buff_duration
      ) || 0;


    if (
      duration <= 0
    ) {

      return (
        `${spell.name} has an invalid duration`
      );
    }


    if (
      rankNumber(spell, "partyGaugeGain", 50) <= 0
    ) {

      return (
        `${spell.name} has invalid party gauge configuration`
      );
    }


    if (
      rankNumber(spell, "atbRatePercent", 25) <= 0
    ) {

      return (
        `${spell.name} has invalid ATB speed configuration`
      );
    }


    return null;
  },


  async execute(context): Promise<SpellHandlerResult> {

    const {
      playerId,
      spell,
      allies
    } = context;

    const duration =
      Number(
        spell.buff_duration
      ) || 10;


    const critBonus =
      Math.max(0, Number(spell.buff_value) || 0);


    const atbBonus =
      Math.max(
        0,
        rankNumber(
          spell,
          "atbRatePercent",
          25
        )
      );


    const gaugeGain =
      Math.max(
        0,
        rankNumber(
          spell,
          "partyGaugeGain",
          50
        )
      );


    const targets =
      getLivingAllies(
        playerId,
        allies
      );

    const allTargets: any[] =
      Array.isArray((context as any).alliesIncludingDefeated) &&
      (context as any).alliesIncludingDefeated.length > 0
        ? (context as any).alliesIncludingDefeated
        : targets;


    if (
      targets.length === 0
    ) {

      return {
        log:
          `📯 You sound ${spell.name}, but there are ` +
          `no living allies to rally.`,

        appliedStatus:
          false
      };
    }


    for (
      const ally of
      targets
    ) {

      await applyBuff(
        ally.playerId,
        "crit_chance",
        critBonus,
        duration,
        `spell:${spell.id}:crit`
      );


      await applyBuff(
        ally.playerId,
        "atb_rate_pct",
        atbBonus,
        duration,
        `spell:${spell.id}:atb`
      );

      const rank = spell.rank_config ?? {};

      if (Number(rank.victoryDamageDealtPercent) > 0) {
        await applyBuff(ally.playerId, "damage_dealt_pct", Number(rank.victoryDamageDealtPercent), duration, `warlord:victory:${spell.id}:damage`);
      }

      if (rank.victoryNextSpellFree || Number(rank.victoryNextSpellDamagePercent) > 0) {
        const source = `warlord:victory:${spell.id}:next_spell`;
        const orderDuration = Math.max(1, Number(rank.victoryNextSpellDuration) || 15);
        if (rank.victoryNextSpellFree) {
          await applyWarlordStatus(ally.playerId, "warlord_next_spell_free", 1, 1, orderDuration, source);
        }
        if (Number(rank.victoryNextSpellDamagePercent) > 0) {
          await applyWarlordStatus(ally.playerId, "warlord_next_spell_damage_pct", Number(rank.victoryNextSpellDamagePercent), 1, orderDuration, source);
        }
      }

      if (Number(rank.victoryDeathCharges) > 0) {
        await applyWarlordDeathProtection(
          ally.playerId,
          Number(rank.victoryDeathCharges),
          Number(rank.victorySurvivalHpPercent) || 20,
          Number(rank.victoryDeathDuration) || 15,
          `warlord:victory:${spell.id}:death`
        );
      }
    }

    const rank = spell.rank_config ?? {};
    const gaugeOverrides: Record<number, number> = {};

    if (Number(rank.victoryHealMaxHpPercent) > 0) {
      for (const ally of allTargets) {
        const allyId = Number(ally.playerId);
        const maximumHP = Math.max(1, Number(ally.maxHp ?? ally.stats?.maxhp ?? 1));
        const currentHP = Math.max(0, Number(ally.hp ?? ally.stats?.hpoints ?? 0));
        const defeated = currentHP <= 0;
        const hpPercent = defeated
          ? Math.max(0, Number(rank.victoryReviveHpPercent) || 0)
          : Math.max(0, Number(rank.victoryHealMaxHpPercent) || 0);

        if (hpPercent <= 0) continue;

        const newHP = defeated
          ? Math.max(1, Math.floor(maximumHP * hpPercent / 100))
          : Math.min(maximumHP, currentHP + Math.max(1, Math.floor(maximumHP * hpPercent / 100)));

        let newMana = Math.max(0, Number(ally.sp ?? ally.stats?.spoints ?? 0));
        if (defeated && Number(rank.victoryReviveManaPercent) > 0) {
          const maximumMana = Math.max(0, Number(ally.maxSp ?? ally.stats?.maxspoints ?? 0));
          newMana = Math.floor(maximumMana * Number(rank.victoryReviveManaPercent) / 100);
        }

        await db.query(`UPDATE players SET hpoints=?,spoints=? WHERE id=?`, [newHP, newMana, allyId]);
        publishPlayerStatePatch(allyId, { hpoints: newHP, maxhp: maximumHP, spoints: newMana });
        ally.hp = newHP;
        ally.sp = newMana;

        if (defeated && Number(rank.victoryReviveGauge) > 0) {
          gaugeOverrides[allyId] = Number(rank.victoryReviveGauge);
        }
      }
    }


    return {
      log:
        targets.length > 1
          ? (
              `📯 You sound ${spell.name}, granting your company ` +
              `${gaugeGain} ATB, ${critBonus}% critical chance, ` +
              `and ${atbBonus}% ATB speed for ${duration}s!`
            )
          : (
              `📯 You sound ${spell.name}, gaining ` +
              `${gaugeGain} ATB, ${critBonus}% critical chance, ` +
              `and ${atbBonus}% ATB speed for ${duration}s!`
            ),

      appliedStatus:
        true,

      partyGaugeGain:
        gaugeGain,

      playerGaugeOverrides:
        gaugeOverrides
    };
  }
};
