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
// HERBAL REMEDY
//
// Removes physical harmful effects.
//
// Current supported physical effects:
// - negative stat buffs marked with physical sources
// - physical player status effects
//
// This can be expanded when player poison, bleed, and
// disease tables are standardized.
// =====================================================

export const herbalRemedyHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    if (buff.stat !== "cleanse_physical") {
      return `${spell.name} must use cleanse_physical`;
    }

    return null;
  },

  async execute({
    playerId,
    spell
  }): Promise<SpellHandlerResult> {
    let cleansedCount = 0;

    /*
     * Remove negative buffs explicitly categorized by
     * their source as poison, bleed, disease, or physical.
     */
    const [buffResult]: any = await db.query(
      `
      DELETE FROM player_buffs
      WHERE player_id = ?
        AND value < 0
        AND (
          source LIKE 'poison:%'
          OR source LIKE 'bleed:%'
          OR source LIKE 'disease:%'
          OR source LIKE 'physical:%'
        )
      `,
      [playerId]
    );

    cleansedCount +=
      Number(buffResult.affectedRows) || 0;

    /*
     * Remove physical status effects if they are stored
     * in player_status_effects.
     */
    const [statusResult]: any = await db.query(
      `
      DELETE FROM player_status_effects
      WHERE player_id = ?
        AND effect_key IN (
          'poison',
          'bleed',
          'disease',
          'physical_debuff'
        )
      `,
      [playerId]
    );

    cleansedCount +=
      Number(statusResult.affectedRows) || 0;

    return {
      log:
        cleansedCount > 0
          ? (
              `🌿 You cast ${spell.name} and cleanse ` +
              `${cleansedCount} physical ` +
              `${cleansedCount === 1 ? "ailment" : "ailments"}!`
            )
          : (
              `🌿 You cast ${spell.name}, but there are ` +
              `no physical ailments to cleanse.`
            ),

      appliedStatus: cleansedCount > 0
    };
  }
};

// =====================================================
// FLOURISH
//
// Grants increased healing received and strengthens
// all active healing-over-time effects.
//
// Current solo behavior:
// Applies to the caster and the caster's active HoTs.
//
// Future:
// Applies to every allied party member.
// =====================================================

export const flourishHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    if (
      buff.stat !==
      "healing_received_pct"
    ) {
      return `${spell.name} must use healing_received_pct`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid healing bonus`;
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

    await applyBuff(
      playerId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}`
    );

    /*
     * Strengthen currently active HoTs by 20%.
     *
     * This modifies their remaining ticks. HoTs cast after
     * Flourish will already benefit from healingReceivedMult.
     */
    const [hotResult]: any = await db.query(
      `
      UPDATE player_hots
      SET healing = GREATEST(
        1,
        FLOOR(healing * ?)
      )
      WHERE player_id = ?
        AND expires_at > NOW(3)
      `,
      [
        1 + buff.value / 100,
        playerId
      ]
    );

    const strengthenedHots =
      Number(hotResult.affectedRows) || 0;

    let log =
      `🌸 You cast ${spell.name}, increasing healing received ` +
      `by ${buff.value}% for ${buff.duration}s!`;

    if (strengthenedHots > 0) {
      log +=
        ` ${strengthenedHots} active ` +
        `${strengthenedHots === 1 ? "regeneration effect blooms" : "regeneration effects bloom"}!`;
    }

    return {
      log,
      appliedStatus: true
    };
  }
};

// =====================================================
// HARMONY OF THE WILD
//
// Immediate healing followed by regeneration.
//
// Current solo behavior:
// Applies to the caster.
//
// Future:
// Applies both portions to all party members.
// =====================================================

export const harmonyOfTheWildHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const baseHealing =
      Number(spell.heal) || 0;

    const duration =
      Number(spell.dot_duration) || 0;

    const tickInterval =
      Number(spell.dot_tick_rate) || 0;

    if (baseHealing <= 0) {
      return `${spell.name} has invalid healing configuration`;
    }

    if (duration <= 0) {
      return `${spell.name} has an invalid HOT duration`;
    }

    if (tickInterval <= 0) {
      return `${spell.name} has an invalid HOT interval`;
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
    const baseHealing =
      Number(spell.heal) || 0;

    const duration =
      Number(spell.dot_duration) || 0;

    const tickInterval =
      Number(spell.dot_tick_rate) || 1;

    // Immediate healing.
    const baseScaledHealing =
      calculateScaledSpellAmount(
        player,
        baseHealing
      );

    const immediateHealing =
      applyHealingReceivedMultiplier(
        player,
        baseScaledHealing
      );

    const playerHP = Math.min(
      maxPlayerHP,
      currentPlayerHP + immediateHealing
    );

    const actualImmediateHealing =
      Math.max(
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

    // Regeneration portion.
    const totalTicks = Math.max(
      1,
      Math.floor(
        duration / tickInterval
      )
    );

    /*
     * Like Scarlet Renewal, the spell's heal value powers
     * both the initial heal and an equal total HoT.
     */
    const totalHotHealing =
      applyHealingReceivedMultiplier(
        player,
        calculateScaledSpellAmount(
          player,
          baseHealing
        )
      );

    const healingPerTick = Math.max(
      1,
      Math.floor(
        totalHotHealing / totalTicks
      )
    );

    const expectedHotHealing =
      healingPerTick * totalTicks;

    const source =
      `spell:${spell.id}`;

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
        `🌿 You cast ${spell.name}, restoring ` +
        `${actualImmediateHealing} HP immediately and up to ` +
        `${expectedHotHealing} HP over ${duration}s!`,

      playerHP,
      appliedStatus: true
    };
  }
};