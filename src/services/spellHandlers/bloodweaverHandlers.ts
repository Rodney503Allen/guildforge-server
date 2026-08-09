// src/services/spellHandlers/bloodweaverHandlers.ts

import { db } from "../../db";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  calculateScaledSpellAmount,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";


// =====================================================
// SHARED HEALING CALCULATION
//
// Spell scaling belongs to the caster.
//
// Healing-received modifiers belong to the recipient.
// =====================================================

function calculateBloodweaverHealing(
  caster: any,
  recipient: any,
  baseHealing: number,
  coefficient = 0.5
): number {

  const scaledHealing =
    calculateScaledSpellAmount(
      caster,
      baseHealing,
      coefficient
    );

  return applyHealingReceivedMultiplier(
    recipient,
    scaledHealing
  );
}


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
// LIFE SIPHON
//
// Deals damage to the enemy and restores the caster.
//
// spell.damage = base damage
// spell.heal   = base self-healing
//
// This remains a self-heal even during party combat.
// =====================================================

export const lifeSiphonHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    const baseHealing =
      Number(
        spell.heal
      ) || 0;


    if (
      baseDamage <= 0
    ) {

      return (
        `${spell.name} has invalid damage configuration`
      );
    }


    if (
      baseHealing <= 0
    ) {

      return (
        `${spell.name} has invalid healing configuration`
      );
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

    if (
      !enemy
    ) {

      throw new Error(
        "Life Siphon handler received no enemy"
      );
    }


    // =================================================
    // CASTER HP
    // =================================================

    const currentHP =
      getCurrentPlayerHP(
        player,
        currentPlayerHP
      );


    const maximumHP =
      getMaximumPlayerHP(
        player,
        maxPlayerHP
      );


    // =================================================
    // DAMAGE
    // =================================================

    const scaledDamage =
      calculateScaledSpellAmount(
        player,
        Number(
          spell.damage
        ) || 0
      );


    const damageResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDamage
      );


    const damage =
      damageResult.dodged
        ? 0
        : Math.max(
            1,
            Number(
              damageResult.damage
            ) || 1
          );


    const enemyHP =
      Math.max(
        0,
        Number(
          enemy.hp
        ) -
        damage
      );


    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    // =================================================
    // SELF HEAL
    // =================================================

    const healing =
      calculateBloodweaverHealing(
        player,
        player,
        Number(
          spell.heal
        ) || 0
      );


    const playerHP =
      Math.min(
        maximumHP,
        currentHP +
        healing
      );


    const actualHealing =
      Math.max(
        0,
        playerHP -
        currentHP
      );


    await db.query(
      `
        UPDATE players

        SET hpoints = ?

        WHERE id = ?
      `,
      [
        playerHP,
        playerId
      ]
    );


    // =================================================
    // LOG
    // =================================================

    let log:
      string;


    if (
      damageResult.dodged
    ) {

      log =
        `🩸 ${spell.name} fails to drain the enemy`;

    } else if (
      damageResult.crit
    ) {

      log =
        `🩸 Critical! ${spell.name} drains the enemy ` +
        `for ${damage} damage`;

    } else {

      log =
        `🩸 ${spell.name} drains the enemy ` +
        `for ${damage} damage`;
    }


    if (
      actualHealing > 0
    ) {

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

      healing:
        actualHealing,

      killedEnemy:
        enemyHP <= 0,

      crit:
        Boolean(
          damageResult.crit
        ),

      dodged:
        Boolean(
          damageResult.dodged
        )
    };
  }
};


// =====================================================
// SCARLET RENEWAL
//
// Party-wide immediate heal + healing over time.
//
// target_type = all_allies
//
// Every living party member:
// - receives an immediate heal
// - receives Scarlet Renewal HoT
//
// Each recipient's healing_received modifiers are used.
// Caster stats determine the spell's base scaling.
// =====================================================

export const scarletRenewalHandler:
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
        `${spell.name} has invalid HOT duration`
      );
    }


    if (
      tickInterval <= 0
    ) {

      return (
        `${spell.name} has invalid HOT tick interval`
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
      Number(
        spell.dot_tick_rate
      ) || 1;


    // =================================================
    // TARGETS
    // =================================================

    /*
     * Hunt combat supplies every party member.
     *
     * Normal solo combat may not supply allies,
     * so fall back to the caster.
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
              playerId,

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
          `🩸 You cast ${spell.name}, but there are ` +
          `no living allies to restore.`,

        healing:
          0,

        appliedStatus:
          false
      };
    }


    // =================================================
    // HOT CONFIGURATION
    // =================================================

    const totalTicks =
      Math.max(
        1,
        Math.floor(
          duration /
          tickInterval
        )
      );


    const source =
      `spell:${spell.id}`;


    let totalImmediateHealing =
      0;


    let totalExpectedHotHealing =
      0;


    let healedPlayers =
      0;


    // =================================================
    // APPLY TO EACH PARTY MEMBER
    // =================================================

    for (
      const ally of
      targets
    ) {

      const recipient =
        ally.stats ??
        ally;


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


      // -----------------------------------------------
      // IMMEDIATE HEAL
      // -----------------------------------------------

      const immediateHealing =
        calculateBloodweaverHealing(
          player,
          recipient,
          baseHealing
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
          ally.playerId
        ]
      );


      /*
       * Keep Hunt's context object synchronized.
       */
      ally.hp =
        finalHP;


      if (
        ally.stats
      ) {

        ally.stats.hpoints =
          finalHP;
      }


      // -----------------------------------------------
      // HOT
      // -----------------------------------------------

      /*
       * Scarlet Renewal uses the heal value twice:
       *
       * 1. immediate heal
       * 2. equal total amount distributed over HoT
       */
      const totalHotHealing =
        calculateBloodweaverHealing(
          player,
          recipient,
          baseHealing
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


      /*
       * Refresh Scarlet Renewal for this
       * recipient rather than stacking it.
       */
      await db.query(
        `
          DELETE FROM player_hots

          WHERE player_id = ?
            AND source = ?
        `,
        [
          ally.playerId,
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
          ally.playerId,

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


      healedPlayers++;
    }


    // =================================================
    // LOG
    // =================================================

    return {
      log:
        `🩸 You cast ${spell.name}, restoring ` +
        `${totalImmediateHealing} immediate HP across ` +
        `${healedPlayers} ${
          healedPlayers === 1
            ? "ally"
            : "allies"
        } and applying up to ` +
        `${totalExpectedHotHealing} additional healing ` +
        `over ${duration}s!`,

      healing:
        totalImmediateHealing,

      appliedStatus:
        true
    };
  }
};


// =====================================================
// BLOOD TRANSFUSION
//
// target_type = ally
//
// Caster:
// - sacrifices 20% of CURRENT HP
// - cannot be reduced below 1 HP
//
// Selected ally:
// - receives the powerful heal
//
// If the caster selects themselves:
// - health cost is paid first
// - healing is then applied afterward
// =====================================================

export const bloodTransfusionHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    false,


  validate(spell) {

    const baseHealing =
      Number(
        spell.heal
      ) || 0;


    if (
      baseHealing <= 0
    ) {

      return (
        `${spell.name} has invalid healing configuration`
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

    targetPlayerId,
    targetPlayer,
    currentTargetHP,
    maxTargetHP
  }): Promise<SpellHandlerResult> {

    const baseHealing =
      Number(
        spell.heal
      ) || 0;


    // =================================================
    // CASTER
    // =================================================

    const casterCurrentHP =
      getCurrentPlayerHP(
        player,
        currentPlayerHP
      );


    const casterMaximumHP =
      getMaximumPlayerHP(
        player,
        maxPlayerHP
      );


    // =================================================
    // TARGET
    // =================================================

    const targetId =
      targetPlayerId ??
      playerId;


    const recipient =
      targetPlayer ??
      player;


    const targetingSelf =
      Number(
        targetId
      ) ===
      Number(
        playerId
      );


    /*
     * If self-targeting, the target starts
     * from the caster's post-sacrifice HP.
     *
     * Otherwise use the ally's current HP.
     */
    const targetCurrentHP =
      getCurrentPlayerHP(
        recipient,

        targetingSelf
          ? casterCurrentHP
          : currentTargetHP
      );


    const targetMaximumHP =
      getMaximumPlayerHP(
        recipient,

        targetingSelf
          ? casterMaximumHP
          : maxTargetHP
      );


    // =================================================
    // CASTER HEALTH COST
    // =================================================

    /*
     * Sacrifice 20% of current HP.
     *
     * Blood Transfusion can never kill
     * its caster.
     */
    const rawHealthCost =
      Math.floor(
        casterCurrentHP *
        0.2
      );


    const healthCost =
      Math.min(
        rawHealthCost,

        Math.max(
          0,
          casterCurrentHP -
          1
        )
      );


    const casterHPAfterCost =
      Math.max(
        1,
        casterCurrentHP -
        healthCost
      );


    // =================================================
    // CALCULATE HEAL
    // =================================================

    /*
     * Caster determines spell scaling.
     *
     * Recipient determines healing-received
     * modifiers.
     */
    const healing =
      calculateBloodweaverHealing(
        player,
        recipient,
        baseHealing
      );


    // =================================================
    // SELF TARGET
    // =================================================

    if (
      targetingSelf
    ) {

      /*
       * Pay the blood cost first,
       * then apply the healing.
       */
      const finalCasterHP =
        Math.min(
          casterMaximumHP,
          casterHPAfterCost +
          healing
        );


      const actualHealing =
        Math.max(
          0,
          finalCasterHP -
          casterHPAfterCost
        );


      await db.query(
        `
          UPDATE players

          SET hpoints = ?

          WHERE id = ?
        `,
        [
          finalCasterHP,
          playerId
        ]
      );


      return {
        log:
          healthCost > 0
            ? (
                `🩸 You sacrifice ${healthCost} HP and cast ` +
                `${spell.name}, restoring ${actualHealing} HP!`
              )
            : (
                `🩸 You cast ${spell.name}, restoring ` +
                `${actualHealing} HP!`
              ),

        playerHP:
          finalCasterHP,

        healing:
          actualHealing
      };
    }


    // =================================================
    // ALLY TARGET
    // =================================================

    /*
     * First persist the caster's sacrifice.
     */
    await db.query(
      `
        UPDATE players

        SET hpoints = ?

        WHERE id = ?
      `,
      [
        casterHPAfterCost,
        playerId
      ]
    );


    /*
     * Then heal the selected ally.
     */
    const finalTargetHP =
      Math.min(
        targetMaximumHP,
        targetCurrentHP +
        healing
      );


    const actualHealing =
      Math.max(
        0,
        finalTargetHP -
        targetCurrentHP
      );


    await db.query(
      `
        UPDATE players

        SET hpoints = ?

        WHERE id = ?
      `,
      [
        finalTargetHP,
        targetId
      ]
    );


    return {
      log:
        `🩸 You sacrifice ${healthCost} HP and cast ` +
        `${spell.name}, restoring ${actualHealing} HP ` +
        `to your ally!`,

      /*
       * This represents the CASTER's new HP.
       *
       * Hunt combat can safely synchronize it
       * without confusing ally HP with caster HP.
       */
      playerHP:
        casterHPAfterCost,

      healing:
        actualHealing
    };
  }
};