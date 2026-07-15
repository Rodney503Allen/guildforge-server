import { db } from "../../db";
import { applyBuff } from "../buffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  calculateScaledSpellAmount,
  getConfiguredBuff
} from "./helpers";

// =====================================================
// GUARDIAN'S GRACE
// Direct heal + temporary damage reduction
// =====================================================

export const guardiansGraceHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const baseHeal = Number(spell.heal) || 0;
    const buff = getConfiguredBuff(spell);

    if (baseHeal <= 0) {
      return `${spell.name} has invalid healing configuration`;
    }

    if (!buff.stat) {
      return `${spell.name} has no protection stat configured`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid protection value`;
    }

    if (buff.duration <= 0) {
      return `${spell.name} has an invalid protection duration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player,
    currentPlayerHP,
    maxPlayerHP
  }): Promise<SpellHandlerResult> {
    const baseHeal = Number(spell.heal) || 0;
    const buff = getConfiguredBuff(spell);

    const baseScaledHealing =
      calculateScaledSpellAmount(
        player,
        baseHeal
      );

    const scaledHealing =
      applyHealingReceivedMultiplier(
        player,
        baseScaledHealing
      );

    const playerHP = Math.min(
      maxPlayerHP,
      currentPlayerHP + scaledHealing
    );

    const actualHealing = Math.max(
      0,
      playerHP - currentPlayerHP
    );

    await db.query(
      `
      UPDATE players
      SET hpoints = ?
      WHERE id = ?
      `,
      [playerHP, playerId]
    );

    await applyBuff(
      playerId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}`
    );

    const log =
      actualHealing > 0
        ? (
            `✨ You cast ${spell.name}, restoring ` +
            `${actualHealing} HP and gaining ` +
            `${buff.value}% damage reduction for ` +
            `${buff.duration}s!`
          )
        : (
            `✨ You cast ${spell.name}. You are already at full health, ` +
            `but gain ${buff.value}% damage reduction for ` +
            `${buff.duration}s!`
          );

    return {
      log,
      playerHP,
      appliedStatus: true
    };
  }
};

// =====================================================
// SACRED SHIELD
// Grants an absorb shield based on max HP.
// =====================================================

export const sacredShieldHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);

    if (buff.stat !== "shield_maxhp_pct") {
      return `${spell.name} must use shield_maxhp_pct`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid shield percentage`;
    }

    if (buff.duration <= 0) {
      return `${spell.name} has an invalid shield duration`;
    }

    return null;
  },

async execute({
  playerId,
  spell,
  maxPlayerHP
}): Promise<SpellHandlerResult> {
  const buff = getConfiguredBuff(spell);

  const shieldAmount = Math.max(
    1,
    Math.floor(
      Number(maxPlayerHP || 1) *
      (buff.value / 100)
    )
  );

  const source = `spell:${spell.id}`;

  const expiresAt = new Date(
    Date.now() + buff.duration * 1000
  );

  await db.query(
    `
    INSERT INTO player_shields
      (
        player_id,
        max_absorb,
        remaining_absorb,
        expires_at,
        source
      )
    VALUES
      (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      max_absorb = VALUES(max_absorb),
      remaining_absorb = VALUES(remaining_absorb),
      expires_at = VALUES(expires_at)
    `,
    [
      playerId,
      shieldAmount,
      shieldAmount,
      expiresAt,
      source
    ]
  );

  return {
    log:
      `🛡️ You cast ${spell.name}, gaining a ` +
      `${shieldAmount}-point shield for ` +
      `${buff.duration}s!`,

    appliedStatus: true
  };
 }
};

// =====================================================
// AEGIS OF FAITH
// Reduces the next damaging hit and prevents lethal damage.
// =====================================================

export const aegisOfFaithHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);

    if (buff.stat !== "death_prevention") {
      return `${spell.name} must use death_prevention`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid charge count`;
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
    const buff = getConfiguredBuff(spell);

    const charges = Math.max(
      1,
      Math.floor(buff.value)
    );

    const damageReductionPercent = 50;
    const source = `spell:${spell.id}`;

    const expiresAt = new Date(
      Date.now() + buff.duration * 1000
    );

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
        "death_prevention",
        charges,
        damageReductionPercent,
        expiresAt,
        source
      ]
    );

    return {
      log:
        `🛡️ You cast ${spell.name}. The next damaging attack ` +
        `is reduced by ${damageReductionPercent}% and cannot kill you ` +
        `for ${buff.duration}s!`,

      appliedStatus: true
    };
  }
};