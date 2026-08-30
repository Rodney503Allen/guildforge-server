// src/services/spellHandlers/paladinHandlers.ts

import { db } from "../../db";
import { applyBuff } from "../buffService";

import type {
  SpellFriendlyTarget,
  SpellHandlerContext,
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  calculateScaledHealingAmount,
  getConfiguredBuff,
  resolveDirectSpellDamage
} from "./helpers";

function getCurrentPlayerHP(
  player: any,
  currentPlayerHP?: number
): number {
  return Math.max(
    0,
    Number(currentPlayerHP ?? player?.hpoints ?? player?.hp ?? 0) || 0
  );
}

function getMaximumPlayerHP(
  player: any,
  maxPlayerHP?: number
): number {
  return Math.max(
    1,
    Number(maxPlayerHP ?? player?.maxhp ?? player?.maxHp ?? 1) || 1
  );
}

function getRankConfig(spell: any): Record<string, any> {
  const config = spell?.rank_config;
  return config && typeof config === "object" ? config : {};
}

function getConfigNumber(
  spell: any,
  key: string,
  fallback = 0
): number {
  const value = Number(getRankConfig(spell)[key]);
  return Number.isFinite(value) ? value : fallback;
}

function getLivingAllies(
  context: SpellHandlerContext
): SpellFriendlyTarget[] {
  if (context.allies?.length) {
    return context.allies.filter(ally => ally.hp > 0);
  }

  return [{
    playerId: context.playerId,
    name: context.player?.name,
    stats: context.player,
    hp: getCurrentPlayerHP(context.player, context.currentPlayerHP),
    maxHp: getMaximumPlayerHP(context.player, context.maxPlayerHP),
    sp: Math.max(0, Number(context.currentPlayerSP) || 0),
    maxSp: Math.max(0, Number(context.maxPlayerSP) || 0)
  }];
}

async function applyBuffToLivingAllies(
  context: SpellHandlerContext,
  stat: string,
  value: number,
  duration: number,
  source: string
) {
  const allies = getLivingAllies(context);

  await Promise.all(
    allies.map(ally =>
      applyBuff(ally.playerId, stat, value, duration, source)
    )
  );

  return allies;
}

// =====================================================
// SACRED STRIKE
// Direct holy damage plus rank-configured bonus threat.
// =====================================================

export const sacredStrikeHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    return Number(spell.damage) > 0
      ? null
      : `${spell.name} has invalid damage configuration`;
  },

  async execute({
    playerId,
    player,
    enemy,
    spell
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(`${spell.name} requires an enemy`);
    }

    const result = resolveDirectSpellDamage(
      player,
      enemy,
      Number(spell.damage) || 0
    );

    const enemyHP = Math.max(0, enemy.hp - result.damage);
    await enemy.setHP?.(enemyHP);

    const bonusThreat = Math.max(
      0,
      getConfigNumber(spell, "bonusThreat")
    );

    return {
      log: result.dodged
        ? `⚔ ${spell.name} misses!`
        : `⚔ ${spell.name} strikes for ${result.damage} holy damage${
            result.crit ? " (CRITICAL!)" : ""
          }!`,
      damage: result.damage,
      enemyHP,
      killedEnemy: enemyHP <= 0,
      crit: result.crit,
      dodged: result.dodged,
      threatGenerated: bonusThreat,
      sourcePlayerId: playerId
    };
  }
};

// =====================================================
// SACRED SHIELD
// Single-target max-HP absorb plus bonus caster threat.
// =====================================================

export const sacredShieldHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);

    if (buff.stat !== "shield_maxhp_pct") {
      return `${spell.name} must use shield_maxhp_pct`;
    }

    if (buff.value <= 0 || buff.duration <= 0) {
      return `${spell.name} has invalid shield configuration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player,
    maxPlayerHP,
    targetPlayerId,
    targetPlayer,
    maxTargetHP
  }): Promise<SpellHandlerResult> {
    const buff = getConfiguredBuff(spell);
    const targetId = targetPlayerId ?? playerId;
    const recipient = targetPlayer ?? player;
    const maximumHP = getMaximumPlayerHP(
      recipient,
      maxTargetHP ?? maxPlayerHP
    );
    const shieldAmount = Math.max(
      1,
      Math.floor(maximumHP * (buff.value / 100))
    );
    const source = `spell:${spell.id}`;
    const expiresAt = new Date(Date.now() + buff.duration * 1000);

    await db.query(
      `
        INSERT INTO player_shields
          (player_id, max_absorb, remaining_absorb, expires_at, source)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          max_absorb = VALUES(max_absorb),
          remaining_absorb = VALUES(remaining_absorb),
          expires_at = VALUES(expires_at)
      `,
      [targetId, shieldAmount, shieldAmount, expiresAt, source]
    );

    return {
      log: Number(targetId) === Number(playerId)
        ? `🛡️ ${spell.name} grants you a ${shieldAmount}-point shield for ${buff.duration}s!`
        : `🛡️ ${spell.name} grants your ally a ${shieldAmount}-point shield for ${buff.duration}s!`,
      appliedStatus: true,
      threatGenerated: Math.max(
        0,
        getConfigNumber(spell, "bonusThreat")
      )
    };
  }
};

// =====================================================
// CONSECRATION
// Party-wide outgoing damage increase.
// =====================================================

export const consecrationHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);

    if (buff.stat !== "damage_dealt_pct") {
      return `${spell.name} must use damage_dealt_pct`;
    }

    if (buff.value <= 0 || buff.duration <= 0) {
      return `${spell.name} has invalid party damage configuration`;
    }

    return null;
  },

  async execute(context): Promise<SpellHandlerResult> {
    const buff = getConfiguredBuff(context.spell);
    const allies = await applyBuffToLivingAllies(
      context,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${context.spell.id}`
    );

    return {
      log:
        `✨ ${context.spell.name} empowers ${allies.length} ` +
        `${allies.length === 1 ? "ally" : "allies"}, increasing damage dealt ` +
        `by ${buff.value}% for ${buff.duration}s!`,
      appliedStatus: true
    };
  }
};

// =====================================================
// GUARDIAN'S GRACE
// Ally heal and protection; reduced protection for caster.
// =====================================================

export const guardiansGraceHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);

    if (Number(spell.heal) <= 0) {
      return `${spell.name} has invalid healing configuration`;
    }

    if (buff.stat !== "damage_reduction") {
      return `${spell.name} must use damage_reduction`;
    }

    if (buff.value <= 0 || buff.duration <= 0) {
      return `${spell.name} has invalid protection configuration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player,
    currentPlayerHP,
    maxPlayerHP,
    targetPlayerId,
    targetPlayer,
    currentTargetHP,
    maxTargetHP
  }): Promise<SpellHandlerResult> {
    const buff = getConfiguredBuff(spell);
    const targetId = targetPlayerId ?? playerId;
    const recipient = targetPlayer ?? player;
    const currentHP = getCurrentPlayerHP(
      recipient,
      currentTargetHP ?? currentPlayerHP
    );
    const maximumHP = getMaximumPlayerHP(
      recipient,
      maxTargetHP ?? maxPlayerHP
    );
    const scaledHealing = applyHealingReceivedMultiplier(
      recipient,
      calculateScaledHealingAmount(player, Number(spell.heal) || 0)
    );
    const finalHP = Math.min(maximumHP, currentHP + scaledHealing);
    const actualHealing = Math.max(0, finalHP - currentHP);
    const targetingSelf = Number(targetId) === Number(playerId);

    await db.query(
      `UPDATE players SET hpoints = ? WHERE id = ?`,
      [finalHP, targetId]
    );

    await applyBuff(
      targetId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}:target`
    );

    if (!targetingSelf) {
      const selfReduction = Math.max(
        0,
        getConfigNumber(spell, "selfReductionPercent")
      );

      if (selfReduction > 0) {
        await applyBuff(
          playerId,
          buff.stat,
          selfReduction,
          buff.duration,
          `spell:${spell.id}:self`
        );
      }
    }

    return {
      log: targetingSelf
        ? `✨ ${spell.name} restores ${actualHealing} HP and grants ${buff.value}% damage reduction for ${buff.duration}s!`
        : `✨ ${spell.name} restores ${actualHealing} HP to your ally and protects you both for ${buff.duration}s!`,
      healing: actualHealing,
      appliedStatus: true
    };
  }
};

// =====================================================
// DIVINE BULWARK
// Major party-wide damage reduction cooldown.
// =====================================================

export const divineBulwarkHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);

    if (buff.stat !== "damage_reduction") {
      return `${spell.name} must use damage_reduction`;
    }

    if (buff.value <= 0 || buff.duration <= 0) {
      return `${spell.name} has invalid party protection configuration`;
    }

    return null;
  },

  async execute(context): Promise<SpellHandlerResult> {
    const buff = getConfiguredBuff(context.spell);
    const allies = await applyBuffToLivingAllies(
      context,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${context.spell.id}`
    );

    return {
      log:
        `🛡️ ${context.spell.name} protects ${allies.length} ` +
        `${allies.length === 1 ? "ally" : "allies"}, reducing damage taken ` +
        `by ${buff.value}% for ${buff.duration}s!`,
      appliedStatus: true
    };
  }
};

// =====================================================
// AEGIS OF FAITH
// Ultimate: party mitigation plus one death prevention.
// =====================================================

export const aegisOfFaithHandler: SpellHandlerDefinition = {
  requiresEnemy: false,

  validate(spell) {
    const buff = getConfiguredBuff(spell);

    if (buff.stat !== "death_prevention") {
      return `${spell.name} must use death_prevention`;
    }

    if (buff.value <= 0 || buff.duration <= 0) {
      return `${spell.name} has invalid ultimate configuration`;
    }

    return null;
  },

  async execute(context): Promise<SpellHandlerResult> {
    const { spell } = context;
    const buff = getConfiguredBuff(spell);
    const allies = getLivingAllies(context);
    const charges = Math.max(1, Math.floor(buff.value));
    const damageReductionPercent = Math.max(
      0,
      getConfigNumber(spell, "damageReductionPercent", 40)
    );
    const expiresAt = new Date(Date.now() + buff.duration * 1000);

    await Promise.all(
      allies.map(async ally => {
        await applyBuff(
          ally.playerId,
          "damage_reduction",
          damageReductionPercent,
          buff.duration,
          `spell:${spell.id}:aegis`
        );

        await db.query(
          `
            INSERT INTO player_status_effects
              (player_id, effect_key, charges, value, expires_at, source)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              charges = VALUES(charges),
              value = VALUES(value),
              expires_at = VALUES(expires_at)
          `,
          [
            ally.playerId,
            "death_prevention",
            charges,
            damageReductionPercent,
            expiresAt,
            `spell:${spell.id}`
          ]
        );
      })
    );

    return {
      log:
        `🌟 ${spell.name} shields the party for ${buff.duration}s: ` +
        `${damageReductionPercent}% damage reduction and one prevented lethal blow each!`,
      appliedStatus: true
    };
  }
};
