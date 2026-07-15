import { db } from "../../db";

import {
  applyCreatureDebuff
} from "../creatureDebuffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  calculateScaledSpellAmount,
  resolveDamageAgainstEnemy
} from "./helpers";

// =====================================================
// FROST LANCE
// Deals direct damage and slows enemy ATB speed.
// =====================================================

export const frostLanceHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const baseDamage =
      Number(spell.damage) || 0;

    const debuffStat = String(
      spell.debuff_stat || ""
    )
      .trim()
      .toLowerCase();

    const debuffValue =
      Number(spell.debuff_value) || 0;

    const debuffDuration =
      Number(spell.debuff_duration) || 0;

    if (baseDamage <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    if (
      debuffStat !== "attack_speed_pct"
    ) {
      return `${spell.name} must use attack_speed_pct`;
    }

    if (debuffValue <= 0) {
      return `${spell.name} has an invalid slow percentage`;
    }

    if (debuffDuration <= 0) {
      return `${spell.name} has an invalid slow duration`;
    }

    return null;
  },

  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Frost Lance handler received no enemy"
      );
    }

    const baseDamage =
      Number(spell.damage) || 0;

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

    const damage = Math.max(
      1,
      Number(damageResult.damage) || 1
    );

    const enemyHP = Math.max(
      0,
      Number(enemy.hp) - damage
    );

    await db.query(
      `
      UPDATE player_creatures
      SET hp = ?
      WHERE id = ?
      `,
      [enemyHP, enemy.id]
    );

    let appliedStatus = false;

    if (enemyHP > 0) {
      await applyCreatureDebuff(
        enemy.id,
        "attack_speed_pct",
        Number(spell.debuff_value) || 15,
        Number(spell.debuff_duration) || 8,
        `spell:${spell.id}`
      );

      appliedStatus = true;
    }

    const slowPercent =
      Number(spell.debuff_value) || 15;

    const slowDuration =
      Number(spell.debuff_duration) || 8;

    let log = damageResult.crit
      ? (
          `❄️ Critical! ${spell.name} pierces the enemy ` +
          `for ${damage} damage!`
        )
      : (
          `❄️ You cast ${spell.name} for ` +
          `${damage} damage!`
        );

    if (appliedStatus) {
      log +=
        ` The enemy is slowed by ${slowPercent}% ` +
        `for ${slowDuration}s!`;
    }

    return {
      log,
      enemyHP,
      appliedStatus,
      killedEnemy: enemyHP <= 0
    };
  }
};

// =====================================================
// CHAIN LIGHTNING
// Strikes the current enemy.
// Future: bounce to additional enemies with reduced damage.
// =====================================================

export const chainLightningHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const baseDamage =
      Number(spell.damage) || 0;

    if (baseDamage <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    return null;
  },

  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Chain Lightning handler received no enemy"
      );
    }

    const baseDamage =
      Number(spell.damage) || 0;

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

    const damage = Math.max(
      1,
      Number(damageResult.damage) || 1
    );

    const enemyHP = Math.max(
      0,
      Number(enemy.hp) - damage
    );

    await db.query(
      `
      UPDATE player_creatures
      SET hp = ?
      WHERE id = ?
      `,
      [enemyHP, enemy.id]
    );

    const log = damageResult.crit
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
      killedEnemy: enemyHP <= 0
    };
  }
};

// =====================================================
// INFERNO
// Deals immediate damage and applies a burn over time.
// Future: apply to all active enemies.
// =====================================================

export const infernoHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const directDamage =
      Number(spell.damage) || 0;

    const dotDamage =
      Number(spell.dot_damage) || 0;

    const dotDuration =
      Number(spell.dot_duration) || 0;

    const tickInterval =
      Number(spell.dot_tick_rate) || 0;

    if (directDamage <= 0) {
      return `${spell.name} has invalid direct damage`;
    }

    if (dotDamage <= 0) {
      return `${spell.name} has invalid burn damage`;
    }

    if (dotDuration <= 0) {
      return `${spell.name} has invalid burn duration`;
    }

    if (tickInterval <= 0) {
      return `${spell.name} has invalid burn tick interval`;
    }

    return null;
  },

  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Inferno handler received no enemy"
      );
    }

    // -------------------------
    // Direct hit
    // -------------------------

    const scaledDirectDamage =
      calculateScaledSpellAmount(
        player,
        Number(spell.damage) || 0
      );

    const directResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDirectDamage
      );

    const directDamage = Math.max(
      1,
      Number(directResult.damage) || 1
    );

    const enemyHP = Math.max(
      0,
      Number(enemy.hp) - directDamage
    );

    await db.query(
      `
      UPDATE player_creatures
      SET hp = ?
      WHERE id = ?
      `,
      [enemyHP, enemy.id]
    );

    // Do not apply the burn if the direct hit kills.
    if (enemyHP <= 0) {
      return {
        log: directResult.crit
          ? (
              `🔥 Critical! ${spell.name} erupts for ` +
              `${directDamage} damage!`
            )
          : (
              `🔥 ${spell.name} erupts for ` +
              `${directDamage} damage!`
            ),

        enemyHP,
        killedEnemy: true
      };
    }

    // -------------------------
    // Burn
    // -------------------------

    const dotDuration =
      Number(spell.dot_duration) || 0;

    const tickInterval =
      Number(spell.dot_tick_rate) || 1;

    const totalTicks = Math.max(
      1,
      Math.floor(
        dotDuration / tickInterval
      )
    );

    // Inferno's dot_damage represents base damage per tick.
    // DOT ticks use a smaller stat coefficient than direct spells.
    const scaledDamagePerTick =
    calculateScaledSpellAmount(
        player,
        Number(spell.dot_damage) || 0,
        0.15
    );

    const dotResult =
    resolveDamageAgainstEnemy(
        player,
        {
        ...enemy,
        hp: enemyHP
        },
        scaledDamagePerTick
    );

    const damagePerTick = Math.max(
    1,
    Number(dotResult.damage) || 1
    );

    const totalDotDamage =
    damagePerTick * totalTicks;

    const source = `spell:${spell.id}`;

    // Inferno refreshes its own burn instead of stacking
    // repeated copies from the same spell.
    await db.query(
      `
      DELETE FROM player_creature_dots
      WHERE player_creature_id = ?
        AND source = ?
      `,
      [enemy.id, source]
    );

    await db.query(
      `
      INSERT INTO player_creature_dots
        (
          player_creature_id,
          damage,
          tick_interval,
          next_tick_at,
          expires_at,
          source
        )
      VALUES
        (
          ?,
          ?,
          ?,
          DATE_ADD(NOW(3), INTERVAL ? SECOND),
          DATE_ADD(NOW(3), INTERVAL ? SECOND),
          ?
        )
      `,
      [
        enemy.id,
        damagePerTick,
        tickInterval,
        tickInterval,
        dotDuration,
        source
      ]
    );

    let log = directResult.crit
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

    if (dotResult.crit) {
      log += " The burn was critically empowered!";
    }

    return {
      log,
      enemyHP,
      appliedStatus: true,
      killedEnemy: false
    };
  }
};

// =====================================================
// CATACLYSM
// Deals massive elemental damage.
// Future: apply to all active enemies.
// =====================================================

export const cataclysmHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const baseDamage =
      Number(spell.damage) || 0;

    if (baseDamage <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    return null;
  },

  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Cataclysm handler received no enemy"
      );
    }

    const scaledDamage =
      calculateScaledSpellAmount(
        player,
        Number(spell.damage) || 0
      );

    const damageResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDamage
      );

    const damage = Math.max(
      1,
      Number(damageResult.damage) || 1
    );

    const enemyHP = Math.max(
      0,
      Number(enemy.hp) - damage
    );

    await db.query(
      `
      UPDATE player_creatures
      SET hp = ?
      WHERE id = ?
      `,
      [enemyHP, enemy.id]
    );

    const log = damageResult.crit
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
      killedEnemy: enemyHP <= 0
    };
  }
};