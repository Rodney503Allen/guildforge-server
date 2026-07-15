import { db } from "../../db";
import { applyBuff } from "../buffService";
import { applyCreatureDebuff } from "../creatureDebuffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  calculateScaledSpellAmount,
  getConfiguredBuff,
  getConfiguredDebuff,
  resolveDamageAgainstEnemy
} from "./helpers";

// =====================================================
// BRAMBLE STRIKE
// Deals damage and weakens enemy damage output.
// =====================================================

export const brambleStrikeHandler:
  SpellHandlerDefinition = {
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
        "Bramble Strike handler received no enemy"
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

    const debuff =
      getConfiguredDebuff(spell);

    let appliedStatus = false;

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
          `🌿 Critical! ${spell.name} strikes for ` +
          `${damage} damage!`
        )
      : (
          `🌿 ${spell.name} strikes for ` +
          `${damage} damage!`
        );

    if (appliedStatus) {
      log +=
        ` The enemy deals ${debuff.value}% less damage ` +
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
// NATURE'S AEGIS
//
// Current:
// Shields the caster.
//
// Future:
// Applies a separate shield to every party member.
// =====================================================

export const naturesAegisHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

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
    const buff =
      getConfiguredBuff(spell);

    const shieldAmount = Math.max(
      1,
      Math.floor(
        Math.max(1, Number(maxPlayerHP)) *
        (buff.value / 100)
      )
    );

    const expiresAt = new Date(
      Date.now() + buff.duration * 1000
    );

    const source =
      `spell:${spell.id}`;

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
        `🌳 You cast ${spell.name}, gaining a ` +
        `${shieldAmount}-point natural barrier for ` +
        `${buff.duration}s!`,

      appliedStatus: true
    };
  }
};

// =====================================================
// ANCIENT PROTECTOR
// Grants major damage reduction and healing over time.
// =====================================================

export const ancientProtectorHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff =
      getConfiguredBuff(spell);

    const baseTotalHealing =
      Number(spell.heal) || 0;

    const hotDuration =
      Number(spell.dot_duration) || 0;

    const tickInterval =
      Number(spell.dot_tick_rate) || 0;

    if (buff.stat !== "damage_reduction") {
      return `${spell.name} must use damage_reduction`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid mitigation value`;
    }

    if (buff.duration <= 0) {
      return `${spell.name} has an invalid buff duration`;
    }

    if (baseTotalHealing <= 0) {
      return `${spell.name} has invalid healing configuration`;
    }

    if (hotDuration <= 0) {
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
    player
  }): Promise<SpellHandlerResult> {
    const buff =
      getConfiguredBuff(spell);

    await applyBuff(
      playerId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}:protection`
    );

    const baseTotalHealing =
      Number(spell.heal) || 0;

    const hotDuration =
      Number(spell.dot_duration) || 0;

    const tickInterval =
      Number(spell.dot_tick_rate) || 1;

    const totalTicks = Math.max(
      1,
      Math.floor(
        hotDuration / tickInterval
      )
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
      Math.floor(
        totalHealing / totalTicks
      )
    );

    const expectedHealing =
      healingPerTick * totalTicks;

    const source =
      `spell:${spell.id}:hot`;

    // Refresh Ancient Protector's HOT rather than
    // stacking duplicate copies.
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
        hotDuration,
        source,
        spell.name
    ]
    );

    return {
      log:
        `🌲 You invoke ${spell.name}, gaining ` +
        `${buff.value}% damage reduction for ` +
        `${buff.duration}s and restoring up to ` +
        `${expectedHealing} HP over ${hotDuration}s!`,

      appliedStatus: true
    };
  }
};