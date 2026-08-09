// src/services/spellHandlers/sentinelHandlers.ts

import { db } from "../../db";
import { applyBuff } from "../buffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  applySpellDebuff,
  calculateScaledSpellAmount,
  getConfiguredBuff,
  getConfiguredDebuff,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";


// =====================================================
// BRAMBLE STRIKE
//
// Deals damage and weakens enemy damage output.
//
// Universal enemy support:
// - normal combat
// - Hunt combat
// - dungeon / raid later
// =====================================================

export const brambleStrikeHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    const debuff =
      getConfiguredDebuff(
        spell
      );


    if (
      baseDamage <= 0
    ) {

      return (
        `${spell.name} has invalid damage configuration`
      );
    }


    if (
      debuff.stat !==
      "damage_dealt_pct"
    ) {

      return (
        `${spell.name} must use damage_dealt_pct`
      );
    }


    if (
      debuff.value <= 0
    ) {

      return (
        `${spell.name} has an invalid weakening value`
      );
    }


    if (
      debuff.duration <= 0
    ) {

      return (
        `${spell.name} has an invalid weakening duration`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {

      throw new Error(
        "Bramble Strike handler received no enemy"
      );
    }


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


    const dodged =
      Boolean(
        damageResult.dodged
      );


    const damage =
      dodged
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
    // DEBUFF
    // =================================================

    const debuff =
      getConfiguredDebuff(
        spell
      );


    let appliedStatus =
      false;


    if (
      !dodged &&
      enemyHP > 0
    ) {

      await applySpellDebuff(
        enemy,
        {
          sourcePlayerId:
            playerId,

          spellId:
            Number(
              spell.id
            ),

          spellName:
            String(
              spell.name ||
              "Bramble Strike"
            ),

          stat:
            debuff.stat,

          value:
            debuff.value,

          durationSeconds:
            debuff.duration
        }
      );


      appliedStatus =
        true;
    }


    // =================================================
    // LOG
    // =================================================

    let log:
      string;


    if (
      dodged
    ) {

      log =
        `🌿 ${spell.name} misses the enemy!`;

    } else if (
      damageResult.crit
    ) {

      log =
        `🌿 Critical! ${spell.name} strikes for ` +
        `${damage} damage!`;

    } else {

      log =
        `🌿 ${spell.name} strikes for ` +
        `${damage} damage!`;
    }


    if (
      appliedStatus
    ) {

      log +=
        ` The enemy deals ${debuff.value}% less damage ` +
        `for ${debuff.duration}s!`;
    }


    return {
      log,

      enemyHP,

      appliedStatus,

      killedEnemy:
        enemyHP <= 0,

      crit:
        Boolean(
          damageResult.crit
        ),

      dodged
    };
  }
};


// =====================================================
// NATURE'S AEGIS
//
// target_type = all_allies
//
// Applies a separate max-HP based shield to every
// living allied player.
//
// Solo combat falls back to the caster.
// =====================================================

export const naturesAegisHandler:
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
      "shield_maxhp_pct"
    ) {

      return (
        `${spell.name} must use shield_maxhp_pct`
      );
    }


    if (
      buff.value <= 0
    ) {

      return (
        `${spell.name} has an invalid shield percentage`
      );
    }


    if (
      buff.duration <= 0
    ) {

      return (
        `${spell.name} has an invalid shield duration`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    maxPlayerHP,
    allies
  }): Promise<SpellHandlerResult> {

    const buff =
      getConfiguredBuff(
        spell
      );


    /*
     * Hunt combat supplies allies[].
     *
     * Normal combat does not, so create
     * a single caster fallback.
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

              maxHp:
                Math.max(
                  1,
                  Number(
                    maxPlayerHP ??
                    player?.maxhp ??
                    1
                  )
                )
            }
          ];


    if (
      targets.length === 0
    ) {

      return {
        log:
          `🌳 You cast ${spell.name}, but there are ` +
          `no living allies to shield.`,

        appliedStatus:
          false
      };
    }


    const expiresAt =
      new Date(
        Date.now() +
        buff.duration *
        1000
      );


    const source =
      `spell:${spell.id}`;


    let totalShield =
      0;


    for (
      const ally of
      targets
    ) {

      const maximumHP =
        Math.max(
          1,
          Number(
            ally.maxHp ?? 1
          )
        );


      const shieldAmount =
        Math.max(
          1,
          Math.floor(
            maximumHP *
            (
              buff.value /
              100
            )
          )
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
          (
            ?,
            ?,
            ?,
            ?,
            ?
          )

          ON DUPLICATE KEY UPDATE
            max_absorb =
              VALUES(max_absorb),

            remaining_absorb =
              VALUES(remaining_absorb),

            expires_at =
              VALUES(expires_at)
        `,
        [
          ally.playerId,
          shieldAmount,
          shieldAmount,
          expiresAt,
          source
        ]
      );


      totalShield +=
        shieldAmount;
    }


    return {
      log:
        targets.length > 1
          ? (
              `🌳 You cast ${spell.name}, surrounding your company ` +
              `with natural barriers worth ${buff.value}% of each ` +
              `ally's maximum HP for ${buff.duration}s!`
            )
          : (
              `🌳 You cast ${spell.name}, gaining a ` +
              `${totalShield}-point natural barrier for ` +
              `${buff.duration}s!`
            ),

      appliedStatus:
        true
    };
  }
};


// =====================================================
// ANCIENT PROTECTOR
//
// target_type = self
//
// Grants:
// - damage reduction
// - healing over time
//
// This is intentionally self-only.
// =====================================================

export const ancientProtectorHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    false,


  validate(spell) {

    const buff =
      getConfiguredBuff(
        spell
      );


    const baseTotalHealing =
      Number(
        spell.heal
      ) || 0;


    const hotDuration =
      Number(
        spell.dot_duration
      ) || 0;


    const tickInterval =
      Number(
        spell.dot_tick_rate
      ) || 0;


    if (
      buff.stat !==
      "damage_reduction"
    ) {

      return (
        `${spell.name} must use damage_reduction`
      );
    }


    if (
      buff.value <= 0
    ) {

      return (
        `${spell.name} has an invalid mitigation value`
      );
    }


    if (
      buff.duration <= 0
    ) {

      return (
        `${spell.name} has an invalid buff duration`
      );
    }


    if (
      baseTotalHealing <= 0
    ) {

      return (
        `${spell.name} has invalid healing configuration`
      );
    }


    if (
      hotDuration <= 0
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
    player
  }): Promise<SpellHandlerResult> {

    const buff =
      getConfiguredBuff(
        spell
      );


    // =================================================
    // DAMAGE REDUCTION
    // =================================================

    await applyBuff(
      playerId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}:protection`
    );


    // =================================================
    // HOT CONFIGURATION
    // =================================================

    const baseTotalHealing =
      Number(
        spell.heal
      ) || 0;


    const hotDuration =
      Number(
        spell.dot_duration
      ) || 0;


    const tickInterval =
      Number(
        spell.dot_tick_rate
      ) || 1;


    const totalTicks =
      Math.max(
        1,
        Math.floor(
          hotDuration /
          tickInterval
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
      `spell:${spell.id}:hot`;


    /*
     * Refresh Ancient Protector's HOT
     * rather than stacking duplicate copies.
     */
    await db.query(
      `
        DELETE FROM player_hots

        WHERE player_id = ?
          AND source = ?
      `,
      [
        playerId,
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

      appliedStatus:
        true
    };
  }
};