import { db } from "../../db";
import { applyBuff } from "../buffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  calculateScaledSpellAmount,
  getConfiguredBuff,
  resolveDamageAgainstEnemy
} from "./helpers";

// =====================================================
// COMMANDING STRIKE
// Deals damage and briefly increases the caster's attack.
//
// Future party behavior:
// Applies the attack bonus to allied party members.
// =====================================================

export const commandingStrikeHandler:
  SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const baseDamage =
      Number(spell.damage) || 0;

    const buff =
      getConfiguredBuff(spell);

    if (baseDamage <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    if (buff.stat !== "attack_pct") {
      return `${spell.name} must use attack_pct`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid attack bonus`;
    }

    if (buff.duration <= 0) {
      return `${spell.name} has an invalid buff duration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Commanding Strike handler received no enemy"
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

    const buff =
      getConfiguredBuff(spell);

    await applyBuff(
      playerId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}`
    );

    let log = damageResult.crit
      ? (
          `⚔️ Critical! ${spell.name} hits for ` +
          `${damage} damage!`
        )
      : (
          `⚔️ ${spell.name} hits for ` +
          `${damage} damage!`
        );

    log +=
      ` Your attack increases by ${buff.value}% ` +
      `for ${buff.duration}s!`;

    return {
      log,
      enemyHP,
      appliedStatus: true,
      killedEnemy: enemyHP <= 0
    };
  }
};

// =====================================================
// WAR BANNER
// Grants attack and defense.
//
// Current solo behavior:
// Buffs the caster.
//
// Future party behavior:
// Creates a persistent banner aura for nearby allies.
// =====================================================

export const warBannerHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const duration =
      Number(spell.buff_duration) || 0;

    if (duration <= 0) {
      return `${spell.name} has an invalid duration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell
  }): Promise<SpellHandlerResult> {
    const duration =
      Number(spell.buff_duration) || 12;

    const attackBonus = 15;
    const defenseBonus = 10;

    await applyBuff(
      playerId,
      "attack_pct",
      attackBonus,
      duration,
      `spell:${spell.id}:attack`
    );

    await applyBuff(
      playerId,
      "defense",
      defenseBonus,
      duration,
      `spell:${spell.id}:defense`
    );

    return {
      log:
        `🚩 You plant ${spell.name}, gaining ` +
        `${attackBonus}% Attack and ${defenseBonus} Defense ` +
        `for ${duration}s!`,

      appliedStatus: true
    };
  }
};

// =====================================================
// CALL TO VICTORY
// Grants attack, critical chance, and ATB speed.
//
// Current solo behavior:
// Buffs the caster.
//
// Future party behavior:
// Applies to every allied party member.
// =====================================================

export const callToVictoryHandler:
  SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const duration =
      Number(spell.buff_duration) || 0;

    if (duration <= 0) {
      return `${spell.name} has an invalid duration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell
  }): Promise<SpellHandlerResult> {
    const duration =
      Number(spell.buff_duration) || 10;

    const attackBonus = 20;
    const critBonus = 10;
    const atbBonus = 15;

    await applyBuff(
      playerId,
      "attack_pct",
      attackBonus,
      duration,
      `spell:${spell.id}:attack`
    );

    await applyBuff(
      playerId,
      "crit_chance",
      critBonus,
      duration,
      `spell:${spell.id}:crit`
    );

    await applyBuff(
      playerId,
      "atb_rate_pct",
      atbBonus,
      duration,
      `spell:${spell.id}:atb`
    );

    return {
      log:
        `📯 You sound ${spell.name}, gaining ` +
        `${attackBonus}% Attack, ${critBonus}% critical chance, ` +
        `and ${atbBonus}% ATB speed for ${duration}s!`,

      appliedStatus: true
    };
  }
};