// src/services/spellHandlers/sageHandlers.ts

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
// SHARED PLAYER HP NORMALIZATION
// =====================================================

function getCurrentPlayerHP(
  player: any,
  currentPlayerHP?: number
): number {

  return Math.max(
    0,
    Number(
      currentPlayerHP ??
      player?.hpoints ??
      player?.hp ??
      0
    ) || 0
  );
}


function getMaximumPlayerHP(
  player: any,
  maxPlayerHP?: number
): number {

  return Math.max(
    1,
    Number(
      maxPlayerHP ??
      player?.maxhp ??
      player?.maxHp ??
      1
    ) || 1
  );
}


// =====================================================
// HERBAL REMEDY
//
// target_type = ally
//
// Removes physical harmful effects from the selected
// ally.
//
// Falls back to caster in normal solo combat.
// =====================================================

export const herbalRemedyHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    false,


  validate(spell) {

    const buff =
      getConfiguredBuff(
        spell
      );


    if (
      buff.stat !==
      "cleanse_physical"
    ) {

      return (
        `${spell.name} must use cleanse_physical`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    targetPlayerId
  }): Promise<SpellHandlerResult> {

    const cleanseTargetId =
      targetPlayerId ??
      playerId;


    let cleansedCount =
      0;


    // =================================================
    // NEGATIVE PHYSICAL BUFFS
    // =================================================

    const [buffResult]: any =
      await db.query(
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
        [
          cleanseTargetId
        ]
      );


    cleansedCount +=
      Number(
        buffResult.affectedRows
      ) || 0;


    // =================================================
    // PHYSICAL STATUS EFFECTS
    // =================================================

    const [statusResult]: any =
      await db.query(
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
        [
          cleanseTargetId
        ]
      );


    cleansedCount +=
      Number(
        statusResult.affectedRows
      ) || 0;


    // =================================================
    // RESULT
    // =================================================

    const targetingSelf =
      Number(
        cleanseTargetId
      ) ===
      Number(
        playerId
      );


    let log:
      string;


    if (
      cleansedCount > 0
    ) {

      log =
        targetingSelf
          ? (
              `🌿 You cast ${spell.name} and cleanse ` +
              `${cleansedCount} physical ` +
              `${
                cleansedCount === 1
                  ? "ailment"
                  : "ailments"
              }!`
            )
          : (
              `🌿 You cast ${spell.name} and cleanse ` +
              `${cleansedCount} physical ` +
              `${
                cleansedCount === 1
                  ? "ailment"
                  : "ailments"
              } from your ally!`
            );

    } else {

      log =
        targetingSelf
          ? (
              `🌿 You cast ${spell.name}, but you have ` +
              `no physical ailments to cleanse.`
            )
          : (
              `🌿 You cast ${spell.name}, but your ally has ` +
              `no physical ailments to cleanse.`
            );
    }


    return {
      log,

      appliedStatus:
        cleansedCount > 0
    };
  }
};


// =====================================================
// FLOURISH
//
// target_type = all_allies
//
// Grants increased healing received to every living
// ally and strengthens each ally's active HoTs.
// =====================================================

export const flourishHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    false,


  validate(spell) {

    const buff =
      getConfiguredBuff(
        spell
      );


    if (
      buff.stat !==
      "healing_received_pct"
    ) {

      return (
        `${spell.name} must use healing_received_pct`
      );
    }


    if (
      buff.value <= 0
    ) {

      return (
        `${spell.name} has an invalid healing bonus`
      );
    }


    if (
      buff.duration <= 0
    ) {

      return (
        `${spell.name} has an invalid duration`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    allies
  }): Promise<SpellHandlerResult> {

    const buff =
      getConfiguredBuff(
        spell
      );


    /*
     * Hunt combat supplies allies[].
     *
     * Normal combat falls back to the caster.
     */
    const targetIds =
      allies &&
      allies.length > 0
        ? allies
            .filter(
              ally =>
                Number(
                  ally.hp
                ) > 0
            )
            .map(
              ally =>
                Number(
                  ally.playerId
                )
            )
        : [
            Number(
              playerId
            )
          ];


    if (
      targetIds.length === 0
    ) {

      return {
        log:
          `🌸 You cast ${spell.name}, but there are ` +
          `no living allies to affect.`,

        appliedStatus:
          false
      };
    }


    let strengthenedHots =
      0;


    // =================================================
    // APPLY BUFF + STRENGTHEN HOTS
    // =================================================

    for (
      const targetId of
      targetIds
    ) {

      await applyBuff(
        targetId,
        buff.stat,
        buff.value,
        buff.duration,
        `spell:${spell.id}`
      );


      /*
       * Existing HoTs were calculated before Flourish
       * was applied, so strengthen their remaining
       * ticks directly.
       */
      const [hotResult]: any =
        await db.query(
          `
            UPDATE player_hots

            SET healing =
              GREATEST(
                1,
                FLOOR(
                  healing * ?
                )
              )

            WHERE player_id = ?
              AND expires_at > NOW(3)
          `,
          [
            1 +
              buff.value /
              100,

            targetId
          ]
        );


      strengthenedHots +=
        Number(
          hotResult.affectedRows
        ) || 0;
    }


    // =================================================
    // LOG
    // =================================================

    let log =
      targetIds.length > 1
        ? (
            `🌸 You cast ${spell.name}, increasing healing received ` +
            `by ${buff.value}% for your party for ${buff.duration}s!`
          )
        : (
            `🌸 You cast ${spell.name}, increasing healing received ` +
            `by ${buff.value}% for ${buff.duration}s!`
          );


    if (
      strengthenedHots > 0
    ) {

      log +=
        ` ${strengthenedHots} active ` +
        `${
          strengthenedHots === 1
            ? "regeneration effect blooms"
            : "regeneration effects bloom"
        }!`;
    }


    return {
      log,

      appliedStatus:
        true
    };
  }
};


// =====================================================
// HARMONY OF THE WILD
//
// target_type = all_allies
//
// Every living ally receives:
//
// - an immediate heal
// - a healing-over-time effect
//
// Spell scaling comes from the caster.
// Healing-received modifiers come from each recipient.
// =====================================================

export const harmonyOfTheWildHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    false,


  validate(spell) {

    const baseHealing =
      Number(
        spell.heal
      ) || 0;


    const duration =
      Number(
        spell.dot_duration
      ) || 0;


    const tickInterval =
      Number(
        spell.dot_tick_rate
      ) || 0;


    if (
      baseHealing <= 0
    ) {

      return (
        `${spell.name} has invalid healing configuration`
      );
    }


    if (
      duration <= 0
    ) {

      return (
        `${spell.name} has an invalid HOT duration`
      );
    }


    if (
      tickInterval <= 0
    ) {

      return (
        `${spell.name} has an invalid HOT interval`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    currentPlayerHP,
    maxPlayerHP,
    allies
  }): Promise<SpellHandlerResult> {

    const baseHealing =
      Number(
        spell.heal
      ) || 0;


    const duration =
      Number(
        spell.dot_duration
      ) || 0;


    const tickInterval =
      Math.max(
        0.1,
        Number(
          spell.dot_tick_rate
        ) || 1
      );


    const totalTicks =
      Math.max(
        1,
        Math.floor(
          duration /
          tickInterval
        )
      );


    /*
     * Caster controls base spell scaling.
     */
    const baseScaledHealing =
      calculateScaledSpellAmount(
        player,
        baseHealing
      );


    /*
     * Hunt combat supplies allies[].
     *
     * Normal solo combat falls back to caster.
     */
    const targets =
      allies &&
      allies.length > 0
        ? allies.filter(
            ally =>
              Number(
                ally.hp
              ) > 0
          )
        : [
            {
              playerId:
                Number(
                  playerId
                ),

              hp:
                getCurrentPlayerHP(
                  player,
                  currentPlayerHP
                ),

              maxHp:
                getMaximumPlayerHP(
                  player,
                  maxPlayerHP
                ),

              stats:
                player
            }
          ];


    if (
      targets.length === 0
    ) {

      return {
        log:
          `🌿 You cast ${spell.name}, but there are ` +
          `no living allies to heal.`,

        healing:
          0,

        appliedStatus:
          false
      };
    }


    let totalImmediateHealing =
      0;


    let totalExpectedHotHealing =
      0;


    let affectedPlayers =
      0;


    // =================================================
    // APPLY TO EACH ALLY
    // =================================================

    for (
      const ally of
      targets
    ) {

      const targetId =
        Number(
          ally.playerId
        );


      const currentHP =
        Math.max(
          0,
          Number(
            ally.hp
          ) || 0
        );


      const maximumHP =
        Math.max(
          1,
          Number(
            ally.maxHp
          ) || 1
        );


      const recipientStats =
        (ally as any).stats ??
        player;


      // ===============================================
      // IMMEDIATE HEAL
      // ===============================================

      const immediateHealing =
        applyHealingReceivedMultiplier(
          recipientStats,
          baseScaledHealing
        );


      const finalHP =
        Math.min(
          maximumHP,
          currentHP +
          immediateHealing
        );


      const actualImmediateHealing =
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


      ally.hp =
        finalHP;


      // ===============================================
      // HOT
      // ===============================================

      const totalHotHealing =
        applyHealingReceivedMultiplier(
          recipientStats,
          baseScaledHealing
        );


      const healingPerTick =
        Math.max(
          1,
          Math.floor(
            totalHotHealing /
            totalTicks
          )
        );


      const expectedHotHealing =
        healingPerTick *
        totalTicks;


      const source =
        `spell:${spell.id}`;


      /*
       * Refresh this spell's HoT for this
       * particular target instead of stacking.
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
            DATE_ADD(
              NOW(3),
              INTERVAL ? SECOND
            ),
            DATE_ADD(
              NOW(3),
              INTERVAL ? SECOND
            ),
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


      totalImmediateHealing +=
        actualImmediateHealing;


      totalExpectedHotHealing +=
        expectedHotHealing;


      affectedPlayers++;
    }


    // =================================================
    // RESULT
    // =================================================

    const log =
      affectedPlayers > 1
        ? (
            `🌿 You cast ${spell.name}, restoring ` +
            `${totalImmediateHealing} total HP immediately across ` +
            `the party and up to ${totalExpectedHotHealing} ` +
            `additional HP over ${duration}s!`
          )
        : (
            `🌿 You cast ${spell.name}, restoring ` +
            `${totalImmediateHealing} HP immediately and up to ` +
            `${totalExpectedHotHealing} HP over ${duration}s!`
          );


    return {
      log,

      healing:
        totalImmediateHealing,

      appliedStatus:
        true
    };
  }
};