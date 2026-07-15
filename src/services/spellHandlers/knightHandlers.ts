import { db } from "../../db";
import { applyBuff } from "../buffService";
import { applyCreatureDebuff } from "../creatureDebuffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  calculateScaledSpellAmount,
  getConfiguredBuff,
  getConfiguredDebuff,
  resolveDamageAgainstEnemy
} from "./helpers";

// =====================================================
// SHARED DAMAGE-REDUCTION BUFF
// Used by Guard and Shield Wall.
// =====================================================

async function applyKnightProtection(
  playerId: number,
  spell: any
) {
  const buff = getConfiguredBuff(spell);

  await applyBuff(
    playerId,
    buff.stat,
    buff.value,
    buff.duration,
    `spell:${spell.id}`
  );

  return buff;
}

// =====================================================
// SHIELD BASH
// Deals direct damage and weakens enemy damage output.
// =====================================================

export const shieldBashHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const baseDamage =
      Number(spell.damage) || 0;

    const debuff =
      getConfiguredDebuff(spell);

    if (baseDamage <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    if (debuff.stat !== "damage_dealt_pct") {
      return `${spell.name} must use damage_dealt_pct`;
    }

    if (debuff.value <= 0) {
      return `${spell.name} has an invalid weakening value`;
    }

    if (debuff.duration <= 0) {
      return `${spell.name} has an invalid weakening duration`;
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
        "Shield Bash handler received no enemy"
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

    const debuff =
      getConfiguredDebuff(spell);

    let appliedStatus = false;

    // Do not apply the weakening effect to a dead enemy.
    if (enemyHP > 0) {
      await applyCreatureDebuff(
        enemy.id,
        debuff.stat,
        debuff.value,
        debuff.duration,
        `spell:${spell.id}`
      );

      appliedStatus = true;
    }

    let log = damageResult.crit
      ? (
          `🛡️ Critical! ${spell.name} slams the enemy ` +
          `for ${damage} damage!`
        )
      : (
          `🛡️ ${spell.name} slams the enemy ` +
          `for ${damage} damage!`
        );

    if (appliedStatus) {
      log +=
        ` Its damage is reduced by ${debuff.value}% ` +
        `for ${debuff.duration}s!`;
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
// GUARD
//
// Current solo behavior:
// Applies damage reduction to the caster.
//
// Future party behavior:
// Applies damage reduction to the selected ally.
// =====================================================

export const guardHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    if (buff.stat !== "damage_reduction") {
      return `${spell.name} must use damage_reduction`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid protection value`;
    }

    if (buff.duration <= 0) {
      return `${spell.name} has an invalid duration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell
  }): Promise<SpellHandlerResult> {
    const buff =
      await applyKnightProtection(
        playerId,
        spell
      );

    return {
      log:
        `🛡️ You cast ${spell.name}, reducing incoming ` +
        `damage by ${buff.value}% for ${buff.duration}s!`,

      appliedStatus: true
    };
  }
};

// =====================================================
// INTERCEPT
//
// Current solo behavior:
// Reduces the next damaging hit against the caster.
//
// Future party behavior:
// Protects a selected ally and redirects or intercepts
// their next incoming attack.
// =====================================================

export const interceptHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    if (buff.stat !== "intercept") {
      return `${spell.name} must use the intercept stat`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid reduction value`;
    }

    if (buff.duration <= 0) {
      return `${spell.name} has an invalid duration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell
  }): Promise<SpellHandlerResult> {
    const buff =
      getConfiguredBuff(spell);

    const reductionPercent = Math.max(
      0,
      Math.min(90, buff.value)
    );

    const expiresAt = new Date(
      Date.now() + buff.duration * 1000
    );

    const source =
      `spell:${spell.id}`;

    await db.query(
      `
      INSERT INTO player_status_effects
        (
          player_id,
          effect_key,
          charges,
          value,
          expires_at,
          source
        )
      VALUES
        (?, ?, ?, ?, ?, ?)

      ON DUPLICATE KEY UPDATE
        charges = VALUES(charges),
        value = VALUES(value),
        expires_at = VALUES(expires_at)
      `,
      [
        playerId,
        "intercept",
        1,
        reductionPercent,
        expiresAt,
        source
      ]
    );

    return {
      log:
        `🛡️ You prepare to ${spell.name.toLowerCase()} ` +
        `the next attack, reducing its damage by ` +
        `${reductionPercent}%!`,

      appliedStatus: true
    };
  }
};

// =====================================================
// SHIELD WALL
//
// Current solo behavior:
// Applies damage reduction to the caster.
//
// Future party behavior:
// Applies the same protection to every party member.
// =====================================================

export const shieldWallHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    if (buff.stat !== "damage_reduction") {
      return `${spell.name} must use damage_reduction`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid mitigation value`;
    }

    if (buff.duration <= 0) {
      return `${spell.name} has an invalid duration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell
  }): Promise<SpellHandlerResult> {
    const buff =
      await applyKnightProtection(
        playerId,
        spell
      );

    return {
      log:
        `🛡️ You raise ${spell.name}, reducing incoming ` +
        `damage by ${buff.value}% for ${buff.duration}s!`,

      appliedStatus: true
    };
  }
};