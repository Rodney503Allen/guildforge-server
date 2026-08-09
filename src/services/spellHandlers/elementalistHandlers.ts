// src/services/spellHandlers/elementalistHandlers.ts

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applySpellDebuff,
  applySpellDot,
  calculateScaledSpellAmount,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";


// =====================================================
// FROST LANCE
// Deals direct damage and slows enemy ATB speed.
// =====================================================

export const frostLanceHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    const debuffStat =
      String(
        spell.debuff_stat ||
        ""
      )
        .trim()
        .toLowerCase();


    const debuffValue =
      Number(
        spell.debuff_value
      ) || 0;


    const debuffDuration =
      Number(
        spell.debuff_duration
      ) || 0;


    if (
      baseDamage <= 0
    ) {
      return (
        `${spell.name} has invalid damage configuration`
      );
    }


    if (
      debuffStat !==
      "attack_speed_pct"
    ) {
      return (
        `${spell.name} must use attack_speed_pct`
      );
    }


    if (
      debuffValue <= 0
    ) {
      return (
        `${spell.name} has an invalid slow percentage`
      );
    }


    if (
      debuffDuration <= 0
    ) {
      return (
        `${spell.name} has an invalid slow duration`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {
      throw new Error(
        "Frost Lance handler received no enemy"
      );
    }


    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    const scaledDamage =
      calculateScaledSpellAmount(
        player,
        baseDamage
      );


    const damageResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDamage
      );


    const damage =
      damageResult.dodged
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
     *
     * Normal combat:
     * player_creatures
     *
     * Hunt:
     * Hunt encounter session
     */
    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    let appliedStatus =
      false;


    /*
     * Do not apply the slow if:
     * - the attack missed
     * - the enemy died
     */
    if (
      enemyHP > 0 &&
      !damageResult.dodged
    ) {

      await applySpellDebuff(
        enemy,
        {
          sourcePlayerId:
            playerId,

          spellId:
            Number(
              spell.id
            ),

          spellName:
            String(
              spell.name ||
              "Frost Lance"
            ),

          stat:
            "attack_speed_pct",

          value:
            Number(
              spell.debuff_value
            ) || 15,

          durationSeconds:
            Number(
              spell.debuff_duration
            ) || 8
        }
      );


      appliedStatus =
        true;
    }


    const slowPercent =
      Number(
        spell.debuff_value
      ) || 15;


    const slowDuration =
      Number(
        spell.debuff_duration
      ) || 8;


    let log:
      string;


    if (
      damageResult.dodged
    ) {

      log =
        `❄️ ${spell.name} misses the enemy!`;

    } else if (
      damageResult.crit
    ) {

      log =
        `❄️ Critical! ${spell.name} pierces the enemy ` +
        `for ${damage} damage!`;

    } else {

      log =
        `❄️ You cast ${spell.name} for ` +
        `${damage} damage!`;
    }


    if (
      appliedStatus
    ) {

      log +=
        ` The enemy is slowed by ${slowPercent}% ` +
        `for ${slowDuration}s!`;
    }


    return {
      log,

      enemyHP,

      appliedStatus,

      killedEnemy:
        enemyHP <= 0,

      crit:
        Boolean(
          damageResult.crit
        ),

      dodged:
        Boolean(
          damageResult.dodged
        )
    };
  }
};


// =====================================================
// CHAIN LIGHTNING
//
// Current behavior:
// Strikes the current enemy.
//
// Hunt combat currently contains one Hunt target,
// so this naturally hits that target.
//
// Future dungeon/raid behavior:
// Bounce to multiple active enemies.
// =====================================================

export const chainLightningHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    if (
      baseDamage <= 0
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
        "Chain Lightning handler received no enemy"
      );
    }


    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    const scaledDamage =
      calculateScaledSpellAmount(
        player,
        baseDamage
      );


    const damageResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDamage
      );


    const damage =
      damageResult.dodged
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


    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    const log =
      damageResult.dodged
        ? (
            `⚡ ${spell.name} misses the enemy!`
          )
        : damageResult.crit
          ? (
              `⚡ Critical! ${spell.name} strikes the enemy ` +
              `for ${damage} damage!`
            )
          : (
              `⚡ ${spell.name} strikes the enemy ` +
              `for ${damage} damage!`
            );


    return {
      log,

      enemyHP,

      killedEnemy:
        enemyHP <= 0,

      crit:
        Boolean(
          damageResult.crit
        ),

      dodged:
        Boolean(
          damageResult.dodged
        )
    };
  }
};


// =====================================================
// INFERNO
//
// Deals immediate damage and applies a burn.
//
// Current Hunt behavior:
// Applies to the Hunt target.
//
// Future dungeon/raid behavior:
// Apply to all active enemies.
// =====================================================

export const infernoHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    const directDamage =
      Number(
        spell.damage
      ) || 0;


    const dotDamage =
      Number(
        spell.dot_damage
      ) || 0;


    const dotDuration =
      Number(
        spell.dot_duration
      ) || 0;


    const tickInterval =
      Number(
        spell.dot_tick_rate
      ) || 0;


    if (
      directDamage <= 0
    ) {
      return (
        `${spell.name} has invalid direct damage`
      );
    }


    if (
      dotDamage <= 0
    ) {
      return (
        `${spell.name} has invalid burn damage`
      );
    }


    if (
      dotDuration <= 0
    ) {
      return (
        `${spell.name} has invalid burn duration`
      );
    }


    if (
      tickInterval <= 0
    ) {
      return (
        `${spell.name} has invalid burn tick interval`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {
      throw new Error(
        "Inferno handler received no enemy"
      );
    }


    // =================================================
    // DIRECT HIT
    // =================================================

    const scaledDirectDamage =
      calculateScaledSpellAmount(
        player,
        Number(
          spell.damage
        ) || 0
      );


    const directResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDirectDamage
      );


    const directDamage =
      directResult.dodged
        ? 0
        : Math.max(
            1,
            Number(
              directResult.damage
            ) || 1
          );


    const enemyHP =
      Math.max(
        0,
        Number(
          enemy.hp
        ) -
        directDamage
      );


    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    /*
     * If the direct spell misses, do not
     * attach the burn.
     */
    if (
      directResult.dodged
    ) {

      return {
        log:
          `🔥 ${spell.name} misses the enemy!`,

        enemyHP,

        killedEnemy:
          false,

        appliedStatus:
          false,

        crit:
          false,

        dodged:
          true
      };
    }


    /*
     * Do not burn something already killed
     * by the initial eruption.
     */
    if (
      enemyHP <= 0
    ) {

      return {
        log:
          directResult.crit
            ? (
                `🔥 Critical! ${spell.name} erupts for ` +
                `${directDamage} damage!`
              )
            : (
                `🔥 ${spell.name} erupts for ` +
                `${directDamage} damage!`
              ),

        enemyHP,

        killedEnemy:
          true,

        appliedStatus:
          false,

        crit:
          Boolean(
            directResult.crit
          ),

        dodged:
          false
      };
    }


    // =================================================
    // BURN
    // =================================================

    const dotDuration =
      Number(
        spell.dot_duration
      ) || 0;


    const tickInterval =
      Number(
        spell.dot_tick_rate
      ) || 1;


    const totalTicks =
      Math.max(
        1,
        Math.floor(
          dotDuration /
          tickInterval
        )
      );


    /*
     * Inferno's dot_damage represents
     * base damage per tick.
     *
     * Preserve the existing smaller
     * DOT scaling coefficient.
     */
    const scaledDamagePerTick =
      calculateScaledSpellAmount(
        player,
        Number(
          spell.dot_damage
        ) || 0,
        0.15
      );


    const dotResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDamagePerTick
      );


    const damagePerTick =
      Math.max(
        1,
        Number(
          dotResult.damage
        ) || 1
      );


    const totalDotDamage =
      damagePerTick *
      totalTicks;


    /*
     * Universal DOT application.
     *
     * Normal combat:
     * player_creature_dots
     *
     * Hunt:
     * session.dots
     */
    await applySpellDot(
      enemy,
      {
        sourcePlayerId:
          playerId,

        spellId:
          Number(
            spell.id
          ),

        spellName:
          String(
            spell.name ||
            "Inferno"
          ),

        totalDamage:
          totalDotDamage,

        durationSeconds:
          dotDuration,

        tickRateSeconds:
          tickInterval
      }
    );


    let log =
      directResult.crit
        ? (
            `🔥 Critical! ${spell.name} erupts for ` +
            `${directDamage} damage and burns the enemy for ` +
            `${totalDotDamage} damage over ${dotDuration}s!`
          )
        : (
            `🔥 ${spell.name} erupts for ` +
            `${directDamage} damage and burns the enemy for ` +
            `${totalDotDamage} damage over ${dotDuration}s!`
          );


    if (
      dotResult.crit
    ) {

      log +=
        " The burn was critically empowered!";
    }


    return {
      log,

      enemyHP,

      appliedStatus:
        true,

      killedEnemy:
        false,

      crit:
        Boolean(
          directResult.crit
        ),

      dodged:
        false
    };
  }
};


// =====================================================
// CATACLYSM
//
// Massive elemental damage.
//
// Current Hunt behavior:
// Hits the Hunt target.
//
// Future dungeon/raid behavior:
// Apply to all active enemies.
// =====================================================

export const cataclysmHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    if (
      baseDamage <= 0
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
        "Cataclysm handler received no enemy"
      );
    }


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


    const damage =
      damageResult.dodged
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


    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    const log =
      damageResult.dodged
        ? (
            `🌩️ ${spell.name} misses the enemy!`
          )
        : damageResult.crit
          ? (
              `🌩️ Critical! ${spell.name} tears through the enemy ` +
              `for ${damage} damage!`
            )
          : (
              `🌩️ ${spell.name} tears through the enemy ` +
              `for ${damage} damage!`
            );


    return {
      log,

      enemyHP,

      killedEnemy:
        enemyHP <= 0,

      crit:
        Boolean(
          damageResult.crit
        ),

      dodged:
        Boolean(
          damageResult.dodged
        )
    };
  }
};