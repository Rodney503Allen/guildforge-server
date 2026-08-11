// src/services/spellHandlers/warlordHandlers.ts

import { applyBuff } from "../buffService";

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
  allies?: any[]
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
      playerId
    }
  ];
}

// =====================================================
// HOLD THE LINE
//
// target_type = all_allies
//
// Grants the configured flat Defense bonus to every
// living ally. In solo combat, it applies to the caster.
// =====================================================

export const holdTheLineHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    if (buff.stat !== "defense") {
      return (
        `${spell.name} must use the defense buff stat`
      );
    }

    if (buff.value <= 0) {
      return (
        `${spell.name} has an invalid Defense bonus`
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
              `granting ${buff.value} Defense for ` +
              `${buff.duration}s!`
            )
          : (
              `🛡️ You hold your ground, gaining ` +
              `${buff.value} Defense for ` +
              `${buff.duration}s!`
            ),

      appliedStatus: true
    };
  }
};

// =====================================================
// RALLYING CRY
//
// Grants the configured Attack percentage bonus to
// every living ally. In solo combat, targets the caster.
// =====================================================

export const rallyingCryHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    if (buff.stat !== "attack_pct") {
      return (
        `${spell.name} must use attack_pct`
      );
    }

    if (buff.value <= 0) {
      return (
        `${spell.name} has an invalid Attack bonus`
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

    for (const ally of validTargets) {
      await applyBuff(
        Number(ally.playerId),
        buff.stat,
        buff.value,
        buff.duration,
        `spell:${spell.id}`
      );
    }

    return {
      log:
        validTargets.length > 1
          ? (
              `📣 You sound ${spell.name}, granting your ` +
              `company ${buff.value}% Attack for ` +
              `${buff.duration}s!`
            )
          : (
              `📣 You sound ${spell.name}, gaining ` +
              `${buff.value}% Attack for ` +
              `${buff.duration}s!`
            ),

      appliedStatus: true
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
      15;


    const defenseBonus =
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
        "defense",
        defenseBonus,
        duration,
        `spell:${spell.id}:defense`
      );
    }


    return {
      log:
        targets.length > 1
          ? (
              `🚩 You plant ${spell.name}, granting your company ` +
              `${attackBonus}% Attack and ${defenseBonus} Defense ` +
              `for ${duration}s!`
            )
          : (
              `🚩 You plant ${spell.name}, gaining ` +
              `${attackBonus}% Attack and ${defenseBonus} Defense ` +
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
// Grants:
// - +20% Attack
// - +10% critical chance
// - +15% ATB speed
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


    const attackBonus =
      20;


    const critBonus =
      10;


    const atbBonus =
      15;


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
        "attack_pct",
        attackBonus,
        duration,
        `spell:${spell.id}:attack`
      );


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
              `${attackBonus}% Attack, ${critBonus}% critical chance, ` +
              `and ${atbBonus}% ATB speed for ${duration}s!`
            )
          : (
              `📯 You sound ${spell.name}, gaining ` +
              `${attackBonus}% Attack, ${critBonus}% critical chance, ` +
              `and ${atbBonus}% ATB speed for ${duration}s!`
            ),

      appliedStatus:
        true
    };
  }
};