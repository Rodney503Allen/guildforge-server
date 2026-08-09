// src/services/spellHandlers/rangerHandlers.ts

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
// SHARED RANGER DAMAGE
//
// Combat-mode agnostic.
//
// Normal combat:
//   SpellEnemy.setHP -> player_creatures
//
// Hunt combat:
//   SpellEnemy.setHP -> hunt_encounters/session
//
// Future dungeon / raid:
//   Their own SpellEnemy adapters handle persistence.
// =====================================================

async function dealRangerDamage(
  spell: any,
  player: any,
  enemy: SpellEnemy,
  options?: {
    damageMultiplier?: number;
    defenseIgnorePct?: number;
    forceCrit?: boolean;
  }
) {

  const damageMultiplier =
    Math.max(
      0,
      Number(
        options?.damageMultiplier
      ) || 1
    );


  const defenseIgnorePct =
    Math.max(
      0,
      Math.min(
        100,
        Number(
          options?.defenseIgnorePct
        ) || 0
      )
    );


  // =================================================
  // BASE DAMAGE
  // =================================================

  const scaledDamage =
    calculateScaledSpellAmount(
      player,
      Number(
        spell.damage
      ) || 0
    );


  const modifiedDamage =
    Math.max(
      1,
      Math.floor(
        scaledDamage *
        damageMultiplier
      )
    );


  // =================================================
  // TEMPORARY DEFENSE MODIFICATION
  // =================================================

  /*
   * resolveDamageAgainstEnemy may use enemy.stats
   * when available.
   *
   * Therefore Piercing Arrow needs to modify both:
   *
   * enemy.defense
   * enemy.stats.defense
   *
   * on a temporary copy of the enemy.
   */
  const currentDefense =
    Math.max(
      0,
      Number(
        enemy.stats?.defense ??
        enemy.defense ??
        0
      ) || 0
    );


  const modifiedDefense =
    Math.max(
      0,
      Math.floor(
        currentDefense *
        (
          1 -
          defenseIgnorePct /
          100
        )
      )
    );


  const modifiedEnemy:
    SpellEnemy = {

    ...enemy,

    defense:
      modifiedDefense,

    stats:
      enemy.stats
        ? {
            ...enemy.stats,

            defense:
              modifiedDefense
          }
        : enemy.stats
  };


  // =================================================
  // DAMAGE RESOLUTION
  // =================================================

  let damageResult =
    resolveDamageAgainstEnemy(
      player,
      modifiedEnemy,
      modifiedDamage
    );


  // =================================================
  // FORCED CRITICAL
  // =================================================

  /*
   * Deadeye guarantees a critical during execute.
   *
   * If the normal damage roll was not already a crit,
   * apply the player's normal critical multiplier.
   */
  if (
    options?.forceCrit &&
    !damageResult.crit &&
    !damageResult.dodged
  ) {

    const critMultiplier =
      Math.max(
        1,
        Number(
          player?.critDamageMult ??
          1.5
        ) || 1.5
      );


    damageResult = {
      ...damageResult,

      damage:
        Math.max(
          1,
          Math.floor(
            Number(
              damageResult.damage ??
              1
            ) *
            critMultiplier
          )
        ),

      crit:
        true
    };
  }


  // =================================================
  // FINAL DAMAGE
  // =================================================

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
   * IMPORTANT:
   *
   * Never directly UPDATE player_creatures here.
   *
   * The SpellEnemy adapter decides which combat
   * system owns this enemy's HP.
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
        damageResult.crit
      ),

    dodged
  };
}


// =====================================================
// VOLLEY
//
// target_type = all_enemies
//
// Current single-enemy combat behavior:
// Hits the current active enemy.
//
// Hunt combat:
// Hits the Hunt quarry.
//
// Future dungeon / raid:
// Once those encounters expose multiple SpellEnemy
// targets, the combat layer can fan this spell out
// across all enemies.
// =====================================================

export const volleyHandler:
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
        "Volley handler received no enemy"
      );
    }


    const result =
      await dealRangerDamage(
        spell,
        player,
        enemy
      );


    let log:
      string;


    if (
      result.dodged
    ) {

      log =
        `🏹 ${spell.name} rains down, but the enemy evades the volley!`;

    } else if (
      result.critical
    ) {

      log =
        `🏹 Critical! ${spell.name} rains down for ` +
        `${result.damage} damage!`;

    } else {

      log =
        `🏹 ${spell.name} rains down for ` +
        `${result.damage} damage!`;
    }


    return {
      log,

      enemyHP:
        result.enemyHP,

      killedEnemy:
        result.enemyHP <=
        0,

      crit:
        result.critical,

      dodged:
        result.dodged
    };
  }
};


// =====================================================
// PIERCING ARROW
//
// Ignores 40% of the target's Defense for this hit.
// =====================================================

export const piercingArrowHandler:
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
        "Piercing Arrow handler received no enemy"
      );
    }


    const defenseIgnorePct =
      40;


    const result =
      await dealRangerDamage(
        spell,
        player,
        enemy,
        {
          defenseIgnorePct
        }
      );


    let log:
      string;


    if (
      result.dodged
    ) {

      log =
        `🏹 ${spell.name} misses the enemy!`;

    } else if (
      result.critical
    ) {

      log =
        `🏹 Critical! ${spell.name} pierces the enemy ` +
        `for ${result.damage} damage!`;

    } else {

      log =
        `🏹 ${spell.name} pierces the enemy ` +
        `for ${result.damage} damage!`;
    }


    if (
      !result.dodged
    ) {

      log +=
        ` The arrow ignores ${defenseIgnorePct}% of its Defense!`;
    }


    return {
      log,

      enemyHP:
        result.enemyHP,

      killedEnemy:
        result.enemyHP <=
        0,

      crit:
        result.critical,

      dodged:
        result.dodged
    };
  }
};


// =====================================================
// DEADEYE
//
// Normal:
// Deals heavy ranged damage.
//
// Execute:
// At or below 25% enemy HP:
//
// - +75% damage
// - guaranteed critical strike
// =====================================================

export const deadeyeHandler:
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
        "Deadeye handler received no enemy"
      );
    }


    // =================================================
    // TARGET HEALTH
    // =================================================

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
      0.25;


    // =================================================
    // DAMAGE
    // =================================================

    const result =
      await dealRangerDamage(
        spell,
        player,
        enemy,
        {
          damageMultiplier:
            executeActive
              ? 1.75
              : 1,

          forceCrit:
            executeActive
        }
      );


    // =================================================
    // LOG
    // =================================================

    let log:
      string;


    if (
      result.dodged
    ) {

      log =
        `🎯 ${spell.name} misses the enemy!`;

    } else if (
      result.critical
    ) {

      log =
        `🎯 Critical! ${spell.name} strikes for ` +
        `${result.damage} damage!`;

    } else {

      log =
        `🎯 ${spell.name} strikes for ` +
        `${result.damage} damage!`;
    }


    if (
      executeActive &&
      !result.dodged
    ) {

      log +=
        ` The wounded target triggers Deadeye's lethal precision!`;
    }


    return {
      log,

      enemyHP:
        result.enemyHP,

      killedEnemy:
        result.enemyHP <=
        0,

      crit:
        result.critical,

      dodged:
        result.dodged
    };
  }
};