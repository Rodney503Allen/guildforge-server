import { db } from "../../db";
import { applyBuff } from "../buffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  getConfiguredBuff
} from "./helpers";

// =====================================================
// SHARED VOID SHIELD
// Creates or refreshes a max-HP-based absorb shield.
// =====================================================

async function applyVoidShield(
  playerId: number,
  spell: any,
  maxPlayerHP: number,
  shieldPercent: number
) {
  const duration =
    Number(spell.buff_duration) || 0;

  const shieldAmount = Math.max(
    1,
    Math.floor(
      Math.max(1, Number(maxPlayerHP)) *
      (shieldPercent / 100)
    )
  );

  const source = `spell:${spell.id}`;

  const expiresAt = new Date(
    Date.now() + duration * 1000
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
    shieldAmount,
    duration
  };
}

// =====================================================
// NULL BARRIER
// Personal absorb shield based on maximum HP.
// =====================================================

export const nullBarrierHandler: SpellHandlerDefinition = {
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

    const {
      shieldAmount,
      duration
    } = await applyVoidShield(
      playerId,
      spell,
      maxPlayerHP,
      buff.value
    );

    return {
      log:
        `🌌 You cast ${spell.name}, surrounding yourself ` +
        `with a ${shieldAmount}-point void barrier for ` +
        `${duration}s!`,

      appliedStatus: true
    };
  }
};

// =====================================================
// SPATIAL EXCHANGE
//
// Current solo behavior:
// Grants temporary damage reduction.
//
// Future party behavior:
// Redirects part of an ally's incoming damage to the
// Voidwalker.
// =====================================================

export const spatialExchangeHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);

    if (buff.stat !== "damage_redirect_pct") {
      return `${spell.name} must use damage_redirect_pct`;
    }

    if (buff.value <= 0) {
      return `${spell.name} has an invalid redirect percentage`;
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

    /*
     * Solo conversion:
     * Half of the configured redirect percentage becomes
     * personal damage reduction.
     *
     * Current spell value:
     * 30% redirect -> 15% solo damage reduction.
     */
    const soloDamageReduction = Math.max(
      1,
      Math.floor(buff.value * 0.5)
    );

    await applyBuff(
      playerId,
      "damage_reduction",
      soloDamageReduction,
      buff.duration,
      `spell:${spell.id}`
    );

    return {
      log:
        `🌀 You cast ${spell.name}, bending incoming force ` +
        `through folded space and gaining ` +
        `${soloDamageReduction}% damage reduction for ` +
        `${buff.duration}s!`,

      appliedStatus: true
    };
  }
};

// =====================================================
// ABYSSAL WARD
// Current: shields the caster.
// Future: applies a shield to every allied party member.
// =====================================================

export const abyssalWardHandler: SpellHandlerDefinition = {
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

    const {
      shieldAmount,
      duration
    } = await applyVoidShield(
      playerId,
      spell,
      maxPlayerHP,
      buff.value
    );

    return {
      log:
        `🌑 You open an abyssal ward, gaining a ` +
        `${shieldAmount}-point shield for ${duration}s!`,

      appliedStatus: true
    };
  }
};
