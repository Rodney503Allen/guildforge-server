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
// DIVINE INTERVENTION
// Large direct heal + temporary damage reduction
// =====================================================

export const divineInterventionHandler: SpellHandlerDefinition = {
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

    // Use the same scaling formula as generic direct healing.
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

    let log: string;

    if (actualHealing > 0) {
      log =
        `✨ You cast ${spell.name}, restoring ` +
        `${actualHealing} HP and gaining ` +
        `${buff.value}% damage reduction for ` +
        `${buff.duration}s!`;
    } else {
      log =
        `✨ You cast ${spell.name}. You are already at full health, ` +
        `but gain ${buff.value}% damage reduction for ` +
        `${buff.duration}s!`;
    }

    return {
      log,
      playerHP,
      appliedStatus: true
    };
  }
};


// =====================================================
// RENEW
// Applies healing over time to the player.
// spell.heal represents the base total healing.
// =====================================================

export const renewHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const baseTotalHealing =
      Number(spell.heal) || 0;

    const duration =
      Number(spell.dot_duration) || 0;

    const tickInterval =
      Number(spell.dot_tick_rate) || 0;

    if (baseTotalHealing <= 0) {
      return `${spell.name} has invalid total healing configuration`;
    }

    if (duration <= 0) {
      return `${spell.name} has invalid HOT duration`;
    }

    if (tickInterval <= 0) {
      return `${spell.name} has invalid HOT tick interval`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player
  }): Promise<SpellHandlerResult> {
    const baseTotalHealing =
      Number(spell.heal) || 0;

    const duration =
      Number(spell.dot_duration) || 0;

    const tickInterval =
      Number(spell.dot_tick_rate) || 1;

    const totalTicks = Math.max(
      1,
      Math.floor(duration / tickInterval)
    );

    const baseScaledHealing =
      calculateScaledSpellAmount(
        player,
        baseTotalHealing
      );

    const totalHealing =
      applyHealingReceivedMultiplier(
        player,
        baseScaledHealing
      );

    const healingPerTick = Math.max(
      1,
      Math.floor(totalHealing / totalTicks)
    );

    const expectedHealing =
      healingPerTick * totalTicks;

    const source = `spell:${spell.id}`;

    // Renew refreshes instead of stacking with itself.
    await db.query(
      `
      DELETE FROM player_hots
      WHERE player_id = ?
        AND source = ?
      `,
      [playerId, source]
    );

    await db.query(
      `
      INSERT INTO player_hots
        (
          player_id,
          healing,
          tick_interval,
          next_tick_at,
          expires_at,
          source,
          display_name
        )
      VALUES
        (
          ?,
          ?,
          ?,
          DATE_ADD(NOW(3), INTERVAL ? SECOND),
          DATE_ADD(NOW(3), INTERVAL ? SECOND),
          ?,
          ?
        )
      `,
      [
        playerId,
        healingPerTick,
        tickInterval,
        tickInterval,
        duration,
        source,
        spell.name
      ]
    );

    return {
      log:
        `✨ You cast ${spell.name}, restoring up to ` +
        `${expectedHealing} HP over ${duration}s!`,
      appliedStatus: true
    };
  }
};

// =====================================================
// PURIFY
// Removes harmful timed stat effects from the player.
// =====================================================

export const purifyHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate() {
    return null;
  },

  async execute({
    playerId,
    spell
  }): Promise<SpellHandlerResult> {
    const [result]: any = await db.query(
      `
      DELETE FROM player_buffs
      WHERE player_id = ?
        AND value < 0
      `,
      [playerId]
    );

    const cleansedCount =
      Number(result.affectedRows) || 0;

    const log =
      cleansedCount > 0
        ? (
            `✨ You cast ${spell.name} and cleanse ` +
            `${cleansedCount} harmful ` +
            `${cleansedCount === 1 ? "effect" : "effects"}!`
          )
        : (
            `✨ You cast ${spell.name}, but there are ` +
            `no harmful effects to cleanse.`
          );

    return {
      log,
      appliedStatus: cleansedCount > 0
    };
  }
};