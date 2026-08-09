// src/services/spellHandlers/berserkerHandlers.ts

import { applyBuff } from "../buffService";

import {
  SpellEnemy,
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  calculateScaledSpellAmount,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";


// =====================================================
// SHARED BERSERKER DAMAGE
//
// Combat-mode agnostic.
//
// Normal combat:
//   enemy.setHP -> player_creatures
//
// Hunt:
//   enemy.setHP -> hunt encounter state
//
// Future dungeon / raid:
//   adapter controls persistence
// =====================================================

async function dealBerserkerDamage(
  spell: any,
  player: any,
  enemy: SpellEnemy,
  multiplier = 1
) {

  const baseDamage =
    Number(
      spell.damage
    ) || 0;


  const scaledDamage =
    calculateScaledSpellAmount(
      player,
      baseDamage
    );


  const modifiedDamage =
    Math.max(
      1,
      Math.floor(
        scaledDamage *
        multiplier
      )
    );


  const result =
    resolveDamageAgainstEnemy(
      player,
      enemy,
      modifiedDamage
    );


  const dodged =
    Boolean(
      result.dodged
    );


  const damage =
    dodged
      ? 0
      : Math.max(
          1,
          Number(
            result.damage
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
   * IMPORTANT:
   *
   * Never directly update player_creatures here.
   *
   * SpellEnemy determines where this enemy's
   * HP actually lives.
   */
  await setSpellEnemyHP(
    enemy,
    enemyHP
  );


  return {
    damage,

    enemyHP,

    critical:
      Boolean(
        result.crit
      ),

    dodged
  };
}


// =====================================================
// SAVAGE BLOW
//
// Deals 50% bonus damage when the enemy
// is at or below 50% HP.
// =====================================================

export const savageBlowHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    if (
      (
        Number(
          spell.damage
        ) || 0
      ) <= 0
    ) {

      return (
        `${spell.name} has invalid damage configuration`
      );
    }


    return null;
  },


  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {

      throw new Error(
        "Savage Blow handler received no enemy"
      );
    }


    const currentHP =
      Math.max(
        0,
        Number(
          enemy.hp
        ) || 0
      );


    const maxHP =
      Math.max(
        1,
        Number(
          enemy.maxhp
        ) || 1
      );


    const healthPercent =
      Math.max(
        0,
        Math.min(
          1,
          currentHP /
          maxHP
        )
      );


    const wounded =
      healthPercent <=
      0.5;


    const damageMultiplier =
      wounded
        ? 1.5
        : 1;


    const result =
      await dealBerserkerDamage(
        spell,
        player,
        enemy,
        damageMultiplier
      );


    let log:
      string;


    if (
      result.dodged
    ) {

      log =
        `🪓 ${spell.name} misses the enemy!`;

    } else if (
      result.critical
    ) {

      log =
        `🪓 Critical! ${spell.name} crushes the enemy ` +
        `for ${result.damage} damage!`;

    } else {

      log =
        `🪓 ${spell.name} deals ` +
        `${result.damage} damage!`;
    }


    if (
      wounded &&
      !result.dodged
    ) {

      log +=
        " The wounded enemy takes 50% bonus damage!";
    }


    return {
      log,

      enemyHP:
        result.enemyHP,

      killedEnemy:
        result.enemyHP <= 0,

      crit:
        result.critical,

      dodged:
        result.dodged
    };
  }
};


// =====================================================
// BATTLE FRENZY
//
// Self buff:
// - +10% critical chance
// - +20% ATB generation
// =====================================================

export const battleFrenzyHandler:
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
    spell
  }): Promise<SpellHandlerResult> {

    const duration =
      Number(
        spell.buff_duration
      ) || 8;


    const critBonus =
      10;


    const atbRateBonus =
      20;


    await applyBuff(
      playerId,
      "crit_chance",
      critBonus,
      duration,
      `spell:${spell.id}:crit`
    );


    await applyBuff(
      playerId,
      "atb_rate_pct",
      atbRateBonus,
      duration,
      `spell:${spell.id}:atb`
    );


    return {
      log:
        `🔥 You enter ${spell.name}, gaining ` +
        `${critBonus}% critical chance and ` +
        `${atbRateBonus}% ATB speed for ` +
        `${duration}s!`,

      appliedStatus:
        true
    };
  }
};


// =====================================================
// BLOOD RAGE
//
// Self buff:
// - +25% Attack
// - -10% damage reduction
//
// Negative damage reduction effectively means
// increased incoming damage.
// =====================================================

export const bloodRageHandler:
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
    spell
  }): Promise<SpellHandlerResult> {

    const duration =
      Number(
        spell.buff_duration
      ) || 10;


    const attackBonus =
      25;


    const damageReductionPenalty =
      -10;


    await applyBuff(
      playerId,
      "attack_pct",
      attackBonus,
      duration,
      `spell:${spell.id}:attack`
    );


    await applyBuff(
      playerId,
      "damage_reduction",
      damageReductionPenalty,
      duration,
      `spell:${spell.id}:reckless`
    );


    return {
      log:
        `🩸 You enter ${spell.name}, gaining ` +
        `${attackBonus}% Attack but taking ` +
        `10% more damage for ${duration}s!`,

      appliedStatus:
        true
    };
  }
};


// =====================================================
// DECAPITATE
//
// Execute:
//
// Enemy > 20% HP:
//   normal damage
//
// Enemy <= 20% HP:
//   2x damage
// =====================================================

export const decapitateHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    if (
      (
        Number(
          spell.damage
        ) || 0
      ) <= 0
    ) {

      return (
        `${spell.name} has invalid damage configuration`
      );
    }


    return null;
  },


  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {

      throw new Error(
        "Decapitate handler received no enemy"
      );
    }


    const currentHP =
      Math.max(
        0,
        Number(
          enemy.hp
        ) || 0
      );


    const maxHP =
      Math.max(
        1,
        Number(
          enemy.maxhp
        ) || 1
      );


    const healthPercent =
      Math.max(
        0,
        Math.min(
          1,
          currentHP /
          maxHP
        )
      );


    const executeActive =
      healthPercent <=
      0.2;


    const damageMultiplier =
      executeActive
        ? 2
        : 1;


    const result =
      await dealBerserkerDamage(
        spell,
        player,
        enemy,
        damageMultiplier
      );


    let log:
      string;


    if (
      result.dodged
    ) {

      log =
        `💀 ${spell.name} misses the enemy!`;

    } else if (
      result.critical
    ) {

      log =
        `💀 Critical! ${spell.name} strikes for ` +
        `${result.damage} damage!`;

    } else {

      log =
        `💀 ${spell.name} strikes for ` +
        `${result.damage} damage!`;
    }


    if (
      executeActive &&
      !result.dodged
    ) {

      log +=
        " 💀 Execute damage activated!";
    }


    return {
      log,

      enemyHP:
        result.enemyHP,

      killedEnemy:
        result.enemyHP <= 0,

      crit:
        result.critical,

      dodged:
        result.dodged
    };
  }
};