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

  async execute({
    playerId,
    spell,
    allies
  }): Promise<SpellHandlerResult> {
    const buff =
      getConfiguredBuff(spell);

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

      appliedStatus: true
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
// Grants:
// - +15% Attack
// - +10 Defense
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
      10;


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
// Immediately advances each ally's ATB gauge by 50,
// then grants critical chance and faster ATB generation.
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
      ) || 10;


    const critBonus =
      Math.max(0, Number(spell.buff_value) || 0);


    const atbBonus =
      25;


    const gaugeGain =
      50;


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
        gaugeGain
    };
  }
};