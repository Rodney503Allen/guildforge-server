import { db } from "../../db";
import { applyBuff } from "../buffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  calculateScaledHealingAmount,
  getConfiguredBuff
} from "./helpers";

// =====================================================
// DIVINE INTERVENTION
// Large direct heal + temporary damage reduction
// =====================================================

export const divineInterventionHandler:
SpellHandlerDefinition = {

  requiresEnemy: false,

  validate(spell) {
    const baseHeal =
      Number(spell.heal) || 0;

    const buff =
      getConfiguredBuff(spell);

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
    maxPlayerHP,

    targetPlayerId,
    targetPlayer,
    currentTargetHP,
    maxTargetHP
  }): Promise<SpellHandlerResult> {

    const baseHeal =
      Number(spell.heal) || 0;

    const buff =
      getConfiguredBuff(spell);

    const targetId =
      targetPlayerId ??
      playerId;

    const recipient =
      targetPlayer ??
      player;

    const currentHP =
      Math.max(
        0,
        Number(
          currentTargetHP ??
          currentPlayerHP ??
          recipient?.hpoints ??
          0
        ) || 0
      );

    const maximumHP =
      Math.max(
        1,
        Number(
          maxTargetHP ??
          maxPlayerHP ??
          recipient?.maxhp ??
          1
        ) || 1
      );

    /*
     * Healing power comes from caster.
     */
    const baseScaledHealing =
      calculateScaledHealingAmount(
        player,
        baseHeal
      );

    /*
     * Healing-received modifiers belong
     * to recipient.
     */
    const scaledHealing =
      applyHealingReceivedMultiplier(
        recipient,
        baseScaledHealing
      );

    const finalHP =
      Math.min(
        maximumHP,
        currentHP +
        scaledHealing
      );

    const actualHealing =
      Math.max(
        0,
        finalHP -
        currentHP
      );

    await db.query(
      `
        UPDATE players
        SET hpoints = ?
        WHERE id = ?
      `,
      [
        finalHP,
        targetId
      ]
    );

    await applyBuff(
      targetId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}`
    );

    const rankConfig = (spell.rank_config && typeof spell.rank_config === "object")
      ? spell.rank_config as Record<string, any>
      : {};
    const revivePercent = Math.max(1, Number(rankConfig.interventionRevivePercent) || 35);
    const charges = Math.max(1, Math.floor(Number(rankConfig.interventionCharges) || 1));
    const protectionDuration = buff.duration + Math.max(0, Number(rankConfig.interventionDurationBonus) || 0);
    const expiresAt = new Date(Date.now() + protectionDuration * 1000);
    await db.query(`
      INSERT INTO player_status_effects
        (player_id,effect_key,charges,value,expires_at,source)
      VALUES (?, 'priest_death_protection', ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE charges=VALUES(charges),value=VALUES(value),expires_at=VALUES(expires_at)
    `, [targetId, charges, revivePercent, expiresAt, `spell:${spell.id}`]);

    if (Number(rankConfig.interventionTriggerDamagePercent) > 0) {
      await db.query(`
        INSERT INTO player_status_effects
          (player_id,effect_key,charges,value,expires_at,source)
        VALUES (?, 'priest_vengeful_resurrection', ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE charges=VALUES(charges),value=VALUES(value),expires_at=VALUES(expires_at)
      `, [targetId, charges, Number(rankConfig.interventionTriggerDamagePercent), expiresAt, `spell:${spell.id}`]);
    }

    const targetingSelf =
      Number(targetId) ===
      Number(playerId);

    const log =
      actualHealing > 0
        ? targetingSelf
          ? (
              `✨ You cast ${spell.name}, restoring ` +
              `${actualHealing} HP and gaining ` +
              `${buff.value}% damage reduction for ` +
              `${buff.duration}s!`
            )
          : (
              `✨ You cast ${spell.name}, restoring ` +
              `${actualHealing} HP to your ally and granting ` +
              `${buff.value}% damage reduction for ` +
              `${buff.duration}s!`
            )
        : targetingSelf
          ? (
              `✨ You cast ${spell.name}. You are already at full health, ` +
              `but gain ${buff.value}% damage reduction for ` +
              `${buff.duration}s!`
            )
          : (
              `✨ You cast ${spell.name}. Your ally is already at full health, ` +
              `but gains ${buff.value}% damage reduction for ` +
              `${buff.duration}s!`
            );

    return {
      log,
      healing: actualHealing,
      potentialHealing: scaledHealing,
      overhealing: Math.max(0, scaledHealing - actualHealing),
      healedTargetId: Number(targetId),
      healedTargetMaxHP: maximumHP,
      healedTargetHPBefore: currentHP,
      healedTargetHPAfter: finalHP,
      appliedStatus: true
    };
  }
};


// =====================================================
// RENEW
// Applies healing over time to a friendly target.
// spell.heal represents the base total healing.
// =====================================================

export const renewHandler:
SpellHandlerDefinition = {

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
    player,

    targetPlayerId,
    targetPlayer
  }): Promise<SpellHandlerResult> {

    const baseTotalHealing =
      Number(spell.heal) || 0;

    const duration =
      Number(spell.dot_duration) || 0;

    const tickInterval =
      Number(spell.dot_tick_rate) || 1;

    const targetId =
      targetPlayerId ??
      playerId;

    const recipient =
      targetPlayer ??
      player;

    const totalTicks =
      Math.max(
        1,
        Math.floor(
          duration /
          tickInterval
        )
      );

    /*
     * Healing power comes from caster.
     */
    const baseScaledHealing =
      calculateScaledHealingAmount(
        player,
        baseTotalHealing
      );

    /*
     * Healing-received modifier belongs
     * to the target.
     */
    const totalHealing =
      applyHealingReceivedMultiplier(
        recipient,
        baseScaledHealing
      );

    const healingPerTick =
      Math.max(
        1,
        Math.floor(
          totalHealing /
          totalTicks
        )
      );

    const expectedHealing =
      healingPerTick *
      totalTicks;

    const source =
      `spell:${spell.id}`;

    /*
     * Same spell refreshes on the same target.
     */
    await db.query(
      `
        DELETE FROM player_hots
        WHERE player_id = ?
          AND source = ?
      `,
      [
        targetId,
        source
      ]
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
        targetId,
        healingPerTick,
        tickInterval,
        tickInterval,
        duration,
        source,
        spell.name
      ]
    );

    const targetingSelf =
      Number(targetId) ===
      Number(playerId);

    return {
      log:
        targetingSelf
          ? (
              `✨ You cast ${spell.name}, restoring up to ` +
              `${expectedHealing} HP over ${duration}s!`
            )
          : (
              `✨ You cast ${spell.name} on your ally, restoring up to ` +
              `${expectedHealing} HP over ${duration}s!`
            ),

      appliedStatus: true,
      healedTargetId: Number(targetId),
      renewHealingPerTick: healingPerTick,
      renewTickInterval: tickInterval,
      renewDuration: duration
    };
  }
};
// =====================================================
// PURIFY
// Removes harmful timed stat effects from a friendly target.
// =====================================================

export const purifyHandler:
SpellHandlerDefinition = {

  requiresEnemy: false,

  validate() {
    return null;
  },

  async execute({
    playerId,
    spell,
    targetPlayerId,
    allies
  }): Promise<SpellHandlerResult> {

    const targetId =
      targetPlayerId ??
      playerId;

    const targets = String(spell.target_type).toLowerCase() === "all_allies"
      ? (allies ?? []).filter(ally => Number(ally.hp) > 0).map(ally => Number(ally.playerId))
      : [Number(targetId)];
    if (!targets.includes(Number(targetId)) && String(spell.target_type).toLowerCase() === "all_allies") targets.push(Number(targetId));

    let cleansedCount = 0;
    const cleansedTargetIds: number[] = [];
    for (const cleanseTargetId of targets) {
      const [result]: any = await db.query(
        `
          DELETE FROM player_buffs
          WHERE player_id = ?
            AND value < 0
        `,
        [cleanseTargetId]
      );
      const removed = Number(result.affectedRows) || 0;
      cleansedCount += removed;
      if (removed > 0) cleansedTargetIds.push(cleanseTargetId);
    }

    const targetingSelf =
      Number(targetId) ===
      Number(playerId);

    const log =
      cleansedCount > 0
        ? targetingSelf
          ? (
              `✨ You cast ${spell.name} and cleanse ` +
              `${cleansedCount} harmful ` +
              `${cleansedCount === 1 ? "effect" : "effects"}!`
            )
          : (
              `✨ You cast ${spell.name} and cleanse ` +
              `${cleansedCount} harmful ` +
              `${cleansedCount === 1 ? "effect" : "effects"} ` +
              `from your ally!`
            )
        : targetingSelf
          ? (
              `✨ You cast ${spell.name}, but there are ` +
              `no harmful effects to cleanse.`
            )
          : (
              `✨ You cast ${spell.name}, but your ally has ` +
              `no harmful effects to cleanse.`
            );

    return {
      log,
      cleansedCount,
      cleansedTargetIds,
      healedTargetId: Number(targetId),
      appliedStatus:
        cleansedCount > 0
    };
  }
};
