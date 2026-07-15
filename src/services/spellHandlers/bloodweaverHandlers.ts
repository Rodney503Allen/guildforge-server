import { db } from "../../db";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  calculateScaledSpellAmount,
  resolveDamageAgainstEnemy
} from "./helpers";

// =====================================================
// SHARED HEALING CALCULATION
// Applies normal spell scaling and healing-received buffs.
// =====================================================

function calculateBloodweaverHealing(
  player: any,
  baseHealing: number,
  coefficient = 0.5
): number {
  const scaledHealing =
    calculateScaledSpellAmount(
      player,
      baseHealing,
      coefficient
    );

  return applyHealingReceivedMultiplier(
    player,
    scaledHealing
  );
}

// =====================================================
// LIFE SIPHON
// Deals damage to the enemy and restores the caster's HP.
//
// spell.damage = base damage
// spell.heal   = base self-healing
// =====================================================

export const lifeSiphonHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const baseDamage =
      Number(spell.damage) || 0;

    const baseHealing =
      Number(spell.heal) || 0;

    if (baseDamage <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    if (baseHealing <= 0) {
      return `${spell.name} has invalid healing configuration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player,
    enemy,
    currentPlayerHP,
    maxPlayerHP
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Life Siphon handler received no enemy"
      );
    }

    // -------------------------
    // Damage
    // -------------------------

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

    // -------------------------
    // Self-healing
    // -------------------------

    const healing =
      calculateBloodweaverHealing(
        player,
        Number(spell.heal) || 0
      );

    const playerHP = Math.min(
      maxPlayerHP,
      currentPlayerHP + healing
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

    let log = damageResult.crit
      ? (
          `🩸 Critical! ${spell.name} drains the enemy ` +
          `for ${damage} damage`
        )
      : (
          `🩸 ${spell.name} drains the enemy ` +
          `for ${damage} damage`
        );

    if (actualHealing > 0) {
      log +=
        ` and restores ${actualHealing} HP!`;
    } else {
      log +=
        ", but you are already at full health!";
    }

    return {
      log,
      enemyHP,
      playerHP,
      killedEnemy: enemyHP <= 0
    };
  }
};

// =====================================================
// SCARLET RENEWAL
// Immediately heals the caster and applies healing over time.
//
// Current solo behavior:
// Applies both effects to the caster.
//
// Future party behavior:
// Applies both effects to all allied party members.
// =====================================================

export const scarletRenewalHandler: SpellHandlerDefinition = {
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

    // -------------------------
    // Immediate healing
    // -------------------------

    const immediateHealing =
      calculateBloodweaverHealing(
        player,
        baseHealing
      );

    const playerHP = Math.min(
      maxPlayerHP,
      currentPlayerHP + immediateHealing
    );

    const actualImmediateHealing = Math.max(
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

    // -------------------------
    // Healing over time
    // -------------------------

    const totalTicks = Math.max(
      1,
      Math.floor(duration / tickInterval)
    );

    /*
     * Scarlet Renewal uses spell.heal for both portions:
     * - one immediate scaled heal
     * - one equal total amount spread across the HOT
     */
    const totalHotHealing =
      calculateBloodweaverHealing(
        player,
        baseHealing
      );

    const healingPerTick = Math.max(
      1,
      Math.floor(
        totalHotHealing / totalTicks
      )
    );

    const expectedHotHealing =
      healingPerTick * totalTicks;

    const source = `spell:${spell.id}`;

    // Refresh Scarlet Renewal's own HOT.
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
      )      `,
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
        `🩸 You cast ${spell.name}, restoring ` +
        `${actualImmediateHealing} HP immediately and up to ` +
        `${expectedHotHealing} HP over ${duration}s!`,

      playerHP,
      appliedStatus: true
    };
  }
};

// =====================================================
// BLOOD TRANSFUSION
// Pays a portion of the caster's current HP, then applies
// a powerful heal.
//
// Current solo behavior:
// The caster pays the health cost and receives the heal.
//
// Future party behavior:
// The caster pays the health cost and the selected ally
// receives the healing.
// =====================================================

export const bloodTransfusionHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const baseHealing =
      Number(spell.heal) || 0;

    if (baseHealing <= 0) {
      return `${spell.name} has invalid healing configuration`;
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

    /*
     * Health cost:
     * 20% of current HP.
     *
     * The spell cannot reduce the caster below 1 HP.
     */
    const rawHealthCost = Math.floor(
      currentPlayerHP * 0.2
    );

    const healthCost = Math.min(
      rawHealthCost,
      Math.max(0, currentPlayerHP - 1)
    );

    const hpAfterCost = Math.max(
      1,
      currentPlayerHP - healthCost
    );

    const healing =
      calculateBloodweaverHealing(
        player,
        baseHealing
      );

    /*
     * Solo behavior applies the cost first, then heals.
     */
    const playerHP = Math.min(
      maxPlayerHP,
      hpAfterCost + healing
    );

    const actualHealing = Math.max(
      0,
      playerHP - hpAfterCost
    );

    await db.query(
      `
      UPDATE players
      SET hpoints = ?
      WHERE id = ?
      `,
      [playerHP, playerId]
    );

    let log =
      `🩸 You sacrifice ${healthCost} HP and cast ` +
      `${spell.name}, restoring ${actualHealing} HP!`;

    if (healthCost <= 0) {
      log =
        `🩸 You cast ${spell.name}, restoring ` +
        `${actualHealing} HP!`;
    }

    return {
      log,
      playerHP
    };
  }
};