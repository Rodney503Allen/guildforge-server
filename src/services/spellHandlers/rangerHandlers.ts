import { db } from "../../db";

import {
  SpellEnemy,
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  calculateScaledSpellAmount,
  resolveDamageAgainstEnemy
} from "./helpers";

// =====================================================
// SHARED RANGER DAMAGE
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
    Number(options?.damageMultiplier) || 1;

  const defenseIgnorePct = Math.max(
    0,
    Math.min(
      100,
      Number(options?.defenseIgnorePct) || 0
    )
  );

  const scaledDamage =
    calculateScaledSpellAmount(
      player,
      Number(spell.damage) || 0
    );

  const modifiedDamage = Math.max(
    1,
    Math.floor(
      scaledDamage * damageMultiplier
    )
  );

  const modifiedEnemy = {
    ...enemy,

    defense: Math.max(
      0,
      Math.floor(
        Number(enemy.defense || 0) *
        (1 - defenseIgnorePct / 100)
      )
    )
  };

  let damageResult =
    resolveDamageAgainstEnemy(
      player,
      modifiedEnemy,
      modifiedDamage
    );

  /*
   * Deadeye's execute forces a critical result.
   * Recalculate from the noncritical result using the
   * player's normal critical multiplier.
   */
  if (
    options?.forceCrit &&
    !damageResult.crit
  ) {
    damageResult = {
      ...damageResult,

      damage: Math.max(
        1,
        Math.floor(
          Number(damageResult.damage || 1) *
          Number(player.critDamageMult || 1.5)
        )
      ),

      crit: true
    };
  }

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

  return {
    damage,
    enemyHP,
    critical: Boolean(damageResult.crit)
  };
}

// =====================================================
// VOLLEY
// Current: strikes the active enemy.
// Future: strikes every enemy in the encounter.
// =====================================================

export const volleyHandler:
  SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    if ((Number(spell.damage) || 0) <= 0) {
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
        "Volley handler received no enemy"
      );
    }

    const result =
      await dealRangerDamage(
        spell,
        player,
        enemy
      );

    const log = result.critical
      ? (
          `🏹 Critical! ${spell.name} rains down for ` +
          `${result.damage} damage!`
        )
      : (
          `🏹 ${spell.name} rains down for ` +
          `${result.damage} damage!`
        );

    return {
      log,
      enemyHP: result.enemyHP,
      killedEnemy: result.enemyHP <= 0
    };
  }
};

// =====================================================
// PIERCING ARROW
// Ignores 40% of the target's Defense for this hit.
// =====================================================

export const piercingArrowHandler:
  SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    if ((Number(spell.damage) || 0) <= 0) {
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
        "Piercing Arrow handler received no enemy"
      );
    }

    const defenseIgnorePct = 40;

    const result =
      await dealRangerDamage(
        spell,
        player,
        enemy,
        {
          defenseIgnorePct
        }
      );
      
    let log = result.critical
      ? (
          `🏹 Critical! ${spell.name} pierces the enemy ` +
          `for ${result.damage} damage!`
        )
      : (
          `🏹 ${spell.name} pierces the enemy ` +
          `for ${result.damage} damage!`
        );

    log +=
      ` The arrow ignores ${defenseIgnorePct}% of its Defense!`;

    return {
      log,
      enemyHP: result.enemyHP,
      killedEnemy: result.enemyHP <= 0
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
// - deals 75% bonus damage
// - guarantees a critical strike
// =====================================================

export const deadeyeHandler:
  SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    if ((Number(spell.damage) || 0) <= 0) {
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
        "Deadeye handler received no enemy"
      );
    }

    const currentHP = Math.max(
      0,
      Number(enemy.hp) || 0
    );

    const maxHP = Math.max(
      1,
      Number(enemy.maxhp) || 1
    );

    const healthPercent = Math.max(
      0,
      Math.min(
        1,
        currentHP / maxHP
      )
    );

    const executeActive =
      healthPercent <= 0.25;

    const result =
      await dealRangerDamage(
        spell,
        player,
        enemy,
        {
          damageMultiplier:
            executeActive ? 1.75 : 1,

          forceCrit:
            executeActive
        }
      );

    let log = result.critical
      ? (
          `🎯 Critical! ${spell.name} strikes for ` +
          `${result.damage} damage!`
        )
      : (
          `🎯 ${spell.name} strikes for ` +
          `${result.damage} damage!`
        );

    if (executeActive) {
      log +=
        " The wounded target triggers Deadeye's lethal precision!";
    }

    return {
      log,
      enemyHP: result.enemyHP,
      killedEnemy: result.enemyHP <= 0
    };
  }
};