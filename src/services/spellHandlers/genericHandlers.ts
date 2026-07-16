import { db } from "../../db";
import { applyBuff } from "../buffService";
import { applyCreatureDebuff } from "../creatureBuffService";

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
// SHARED DEBUFF APPLICATION
// =====================================================

async function applySpellDebuff(
  enemyId: number,
  spell: any
): Promise<boolean> {
  const debuff = getConfiguredDebuff(spell);

  if (
    !debuff.stat ||
    debuff.duration <= 0 ||
    debuff.value === 0
  ) {
    return false;
  }

  await applyCreatureDebuff(
    enemyId,
    debuff.stat,
    debuff.value,
    debuff.duration,
    `spell:${spell.id}`
  );

  return true;
}

function appendDebuffLog(
  log: string,
  spell: any
): string {
  const debuff = getConfiguredDebuff(spell);

  if (
    !debuff.stat ||
    debuff.duration <= 0 ||
    debuff.value === 0
  ) {
    return log;
  }

  const valueText =
    debuff.value > 0
      ? `+${debuff.value}`
      : `${debuff.value}`;

  return (
    `${log} 🕸 ${debuff.stat.toUpperCase()} ` +
    `${valueText} for ${debuff.duration}s!`
  );
}

// =====================================================
// DIRECT DAMAGE
// =====================================================

export const damageHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const baseDamage = Number(spell.damage) || 0;

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
      throw new Error("Damage handler received no enemy");
    }

    const baseDamage = Number(spell.damage) || 0;

    const scaledDamage = calculateScaledSpellAmount(
      player,
      baseDamage
    );

    const damageResult = resolveDamageAgainstEnemy(
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

    const appliedStatus = await applySpellDebuff(
      enemy.id,
      spell
    );

    let log = damageResult.crit
      ? `✨ Critical! ${spell.name} hits for ${damage} damage!`
      : `✨ You cast ${spell.name} for ${damage} damage!`;

    if (appliedStatus) {
      log = appendDebuffLog(log, spell);
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
// DIRECT HEALING
// =====================================================

export const healHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const baseHeal = Number(spell.heal) || 0;

    if (baseHeal <= 0) {
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
    const baseHeal = Number(spell.heal) || 0;

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

    const log =
      actualHealing > 0
        ? `✨ You cast ${spell.name} and restore ${actualHealing} HP!`
        : `✨ You cast ${spell.name}, but you are already at full health!`;

    return {
      log,
      playerHP
    };
  }
};

// =====================================================
// DAMAGE OVER TIME
// =====================================================

export const dotHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const dotDamage = Number(spell.dot_damage) || 0;
    const duration = Number(spell.dot_duration) || 0;
    const tickRate = Number(spell.dot_tick_rate) || 0;

    if (dotDamage <= 0) {
      return `${spell.name} has invalid DOT damage`;
    }

    if (duration <= 0) {
      return `${spell.name} has invalid DOT duration`;
    }

    if (tickRate <= 0) {
      return `${spell.name} has invalid DOT tick rate`;
    }

    return null;
  },

  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error("DOT handler received no enemy");
    }

    const baseDotDamage =
      Number(spell.dot_damage) || 0;

    const dotDuration =
      Number(spell.dot_duration) || 0;

    const tickRate =
      Number(spell.dot_tick_rate) || 1;

    const scaledDotDamage = calculateScaledSpellAmount(
      player,
      baseDotDamage
    );

    const dotResult = resolveDamageAgainstEnemy(
      player,
      enemy,
      scaledDotDamage
    );

    const totalDotDamage = Math.max(
      1,
      Number(dotResult.damage) || 1
    );

    const totalTicks = Math.max(
      1,
      Math.floor(dotDuration / tickRate)
    );

    const initialTickDamage = Math.max(
      1,
      Math.floor(totalDotDamage / totalTicks)
    );

    await db.query(
      `
      INSERT INTO player_creature_dots
        (
          player_creature_id,
          damage,
          total_damage,
          total_ticks,
          ticks_applied,
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
          ?,
          0,
          ?,
          NOW(),
          DATE_ADD(NOW(), INTERVAL ? SECOND),
          ?
        )
      `,
      [
        enemy.id,
        initialTickDamage,
        totalDotDamage,
        totalTicks,
        tickRate,
        dotDuration,
        `spell:${spell.id}`
      ]
    );
    const appliedStatus = await applySpellDebuff(
      enemy.id,
      spell
    );

    let log = dotResult.crit
      ? (
          `☠ Critical! ${spell.name} afflicts the enemy ` +
          `for ${totalDotDamage} damage over ${dotDuration}s!`
        )
      : (
          `☠ ${spell.name} afflicts the enemy ` +
          `for ${totalDotDamage} damage over ${dotDuration}s!`
        );

    if (appliedStatus) {
      log = appendDebuffLog(log, spell);
    }

    return {
      log,
      enemyHP: Number(enemy.hp),
      appliedStatus,
      killedEnemy: false
    };
  }
};

// =====================================================
// DIRECT DAMAGE + DAMAGE OVER TIME
// =====================================================

export const damageDotHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const directDamage = Number(spell.damage) || 0;
    const dotDamage = Number(spell.dot_damage) || 0;
    const duration = Number(spell.dot_duration) || 0;
    const tickRate = Number(spell.dot_tick_rate) || 0;

    if (directDamage <= 0) {
      return `${spell.name} has invalid direct damage`;
    }

    if (dotDamage <= 0) {
      return `${spell.name} has invalid DOT damage`;
    }

    if (duration <= 0) {
      return `${spell.name} has invalid DOT duration`;
    }

    if (tickRate <= 0) {
      return `${spell.name} has invalid DOT tick rate`;
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
        "Damage-DOT handler received no enemy"
      );
    }

    // -------------------------
    // Direct hit
    // -------------------------

    const baseDirectDamage =
      Number(spell.damage) || 0;

    const scaledDirectDamage =
      calculateScaledSpellAmount(
        player,
        baseDirectDamage
      );

    const directResult = resolveDamageAgainstEnemy(
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

    // Do not apply a DOT to an enemy killed by the direct hit.
    if (enemyHP <= 0) {
      return {
        log: directResult.crit
          ? (
              `✨ Critical! ${spell.name} hits for ` +
              `${directDamage} damage!`
            )
          : (
              `✨ You cast ${spell.name} for ` +
              `${directDamage} damage!`
            ),
        enemyHP,
        killedEnemy: true,
        appliedStatus: false
      };
    }

    // -------------------------
    // DOT portion
    // -------------------------

    const baseDotDamage =
      Number(spell.dot_damage) || 0;

    const dotDuration =
      Number(spell.dot_duration) || 0;

    const tickRate =
      Number(spell.dot_tick_rate) || 1;

    const scaledDotDamage =
      calculateScaledSpellAmount(
        player,
        baseDotDamage
      );

    const dotResult = resolveDamageAgainstEnemy(
      player,
      {
        ...enemy,
        hp: enemyHP
      },
      scaledDotDamage
    );

    const totalDotDamage = Math.max(
      1,
      Number(dotResult.damage) || 1
    );

    const totalTicks = Math.max(
      1,
      Math.floor(dotDuration / tickRate)
    );

    const initialTickDamage = Math.max(
      1,
      Math.floor(totalDotDamage / totalTicks)
    );

    await db.query(
      `
      INSERT INTO player_creature_dots
        (
          player_creature_id,
          damage,
          total_damage,
          total_ticks,
          ticks_applied,
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
          ?,
          0,
          ?,
          NOW(),
          DATE_ADD(NOW(), INTERVAL ? SECOND),
          ?
        )
      `,
      [
        enemy.id,
        initialTickDamage,
        totalDotDamage,
        totalTicks,
        tickRate,
        dotDuration,
        `spell:${spell.id}`
      ]
    );

    const appliedStatus = await applySpellDebuff(
      enemy.id,
      spell
    );

    let log = directResult.crit
      ? (
          `✨ Critical! ${spell.name} hits for ` +
          `${directDamage} damage and afflicts the enemy ` +
          `for ${totalDotDamage} damage over ${dotDuration}s!`
        )
      : (
          `✨ You cast ${spell.name} for ` +
          `${directDamage} damage and afflict the enemy ` +
          `for ${totalDotDamage} damage over ${dotDuration}s!`
        );

    if (dotResult.crit) {
      log += " ☠ The lingering effect was critical!";
    }

    if (appliedStatus) {
      log = appendDebuffLog(log, spell);
    }

    return {
      log,
      enemyHP,
      appliedStatus,
      killedEnemy: false
    };
  }
};

// =====================================================
// PLAYER BUFF
// =====================================================

export const buffHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);

    if (!buff.stat) {
      return `${spell.name} has no buff stat`;
    }

    if (buff.value === 0) {
      return `${spell.name} has no buff value`;
    }

    if (buff.duration <= 0) {
      return `${spell.name} has invalid buff duration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    enemy
  }): Promise<SpellHandlerResult> {
    const buff = getConfiguredBuff(spell);

    await applyBuff(
      playerId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}`
    );

    let appliedStatus = false;

    let log =
      `✨ You cast ${spell.name} and gain ` +
      `${buff.stat.toUpperCase()} ` +
      `${buff.value > 0 ? "+" : ""}${buff.value} ` +
      `for ${buff.duration}s!`;

    // Supports spells that buff the player and debuff the enemy.
    if (enemy) {
      appliedStatus = await applySpellDebuff(
        enemy.id,
        spell
      );

      if (appliedStatus) {
        log = appendDebuffLog(log, spell);
      }
    }

    return {
      log,
      appliedStatus
    };
  }
};

// =====================================================
// ENEMY DEBUFF
// =====================================================

export const debuffHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const debuff = getConfiguredDebuff(spell);

    if (!debuff.stat) {
      return `${spell.name} has no debuff stat`;
    }

    if (debuff.value === 0) {
      return `${spell.name} has no debuff value`;
    }

    if (debuff.duration <= 0) {
      return `${spell.name} has invalid debuff duration`;
    }

    return null;
  },

  async execute({
    spell,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error("Debuff handler received no enemy");
    }

    const appliedStatus = await applySpellDebuff(
      enemy.id,
      spell
    );

    const debuff = getConfiguredDebuff(spell);

    const log =
      `🕸 You cast ${spell.name}! ` +
      `${debuff.stat.toUpperCase()} ` +
      `${debuff.value > 0 ? "+" : ""}${debuff.value} ` +
      `for ${debuff.duration}s!`;

    return {
      log,
      enemyHP: Number(enemy.hp),
      appliedStatus
    };
  }
};