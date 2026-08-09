// src/services/spellHandlers/knightHandlers.ts

import { db } from "../../db";
import { applyBuff } from "../buffService";

import {
  SpellEnemy,
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applySpellDebuff,
  calculateScaledSpellAmount,
  getConfiguredBuff,
  getConfiguredDebuff,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";


// =====================================================
// SHARED DAMAGE-REDUCTION BUFF
// =====================================================

async function applyKnightProtection(
  playerId: number,
  spell: any
) {

  const buff =
    getConfiguredBuff(
      spell
    );


  await applyBuff(
    playerId,
    buff.stat,
    buff.value,
    buff.duration,
    `spell:${spell.id}`
  );


  return buff;
}


// =====================================================
// SHIELD BASH
//
// Deals direct damage and weakens enemy damage output.
//
// Combat-mode agnostic:
// - normal combat
// - Hunt combat
// - future dungeon / raid combat
// =====================================================

export const shieldBashHandler:
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
        "Shield Bash handler received no enemy"
      );
    }


    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    const scaledDamage =
      calculateScaledSpellAmount(
        player,
        baseDamage
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


    /*
     * Universal enemy persistence.
     */
    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    const debuff =
      getConfiguredDebuff(
        spell
      );


    let appliedStatus =
      false;


    /*
     * Do not apply the weakening effect
     * if the attack missed or killed.
     */
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
              "Shield Bash"
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


    let log:
      string;


    if (
      dodged
    ) {

      log =
        `🛡️ ${spell.name} misses the enemy!`;

    } else if (
      damageResult.crit
    ) {

      log =
        `🛡️ Critical! ${spell.name} slams the enemy ` +
        `for ${damage} damage!`;

    } else {

      log =
        `🛡️ ${spell.name} slams the enemy ` +
        `for ${damage} damage!`;
    }


    if (
      appliedStatus
    ) {

      log +=
        ` Its damage is reduced by ${debuff.value}% ` +
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
// GUARD
//
// target_type = ally
//
// Applies damage reduction to the selected ally.
// Falls back to caster for solo combat.
// =====================================================

export const guardHandler:
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
        `${spell.name} has an invalid protection value`
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
    targetPlayerId
  }): Promise<SpellHandlerResult> {

    const targetId =
      targetPlayerId ??
      playerId;


    const buff =
      await applyKnightProtection(
        targetId,
        spell
      );


    const targetingSelf =
      Number(
        targetId
      ) ===
      Number(
        playerId
      );


    return {
      log:
        targetingSelf
          ? (
              `🛡️ You cast ${spell.name}, reducing incoming ` +
              `damage by ${buff.value}% for ${buff.duration}s!`
            )
          : (
              `🛡️ You cast ${spell.name} on your ally, reducing ` +
              `their incoming damage by ${buff.value}% for ` +
              `${buff.duration}s!`
            ),

      appliedStatus:
        true
    };
  }
};


// =====================================================
// INTERCEPT
//
// target_type = ally
//
// Applies the next-hit mitigation status to
// the selected ally.
// =====================================================

export const interceptHandler:
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
      "intercept"
    ) {

      return (
        `${spell.name} must use the intercept stat`
      );
    }


    if (
      buff.value <= 0
    ) {

      return (
        `${spell.name} has an invalid reduction value`
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
    targetPlayerId
  }): Promise<SpellHandlerResult> {

    const buff =
      getConfiguredBuff(
        spell
      );


    const targetId =
      targetPlayerId ??
      playerId;


    const reductionPercent =
      Math.max(
        0,
        Math.min(
          90,
          buff.value
        )
      );


    const expiresAt =
      new Date(
        Date.now() +
        buff.duration *
        1000
      );


    const source =
      `spell:${spell.id}`;


    await db.query(
      `
        INSERT INTO player_status_effects
        (
          player_id,
          effect_key,
          charges,
          value,
          expires_at,
          source
        )

        VALUES
        (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )

        ON DUPLICATE KEY UPDATE
          charges =
            VALUES(charges),

          value =
            VALUES(value),

          expires_at =
            VALUES(expires_at)
      `,
      [
        targetId,
        "intercept",
        1,
        reductionPercent,
        expiresAt,
        source
      ]
    );


    const targetingSelf =
      Number(
        targetId
      ) ===
      Number(
        playerId
      );


    return {
      log:
        targetingSelf
          ? (
              `🛡️ You prepare to intercept the next attack, ` +
              `reducing its damage by ${reductionPercent}%!`
            )
          : (
              `🛡️ You cast ${spell.name} on your ally. Their next ` +
              `damaging attack is reduced by ${reductionPercent}%!`
            ),

      appliedStatus:
        true
    };
  }
};


// =====================================================
// SHIELD WALL
//
// target_type = all_allies
//
// Applies the configured damage reduction to
// every living ally.
//
// Solo combat falls back to the caster.
// =====================================================

export const shieldWallHandler:
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
     * Hunt combat supplies the full friendly
     * party in allies[].
     *
     * Normal combat does not, so use caster.
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
              playerId
            }
          ];


    if (
      targets.length === 0
    ) {

      return {
        log:
          `🛡️ You raise ${spell.name}, but there are ` +
          `no living allies to protect.`,

        appliedStatus:
          false
      };
    }


    for (
      const ally of
      targets
    ) {

      await applyBuff(
        ally.playerId,
        buff.stat,
        buff.value,
        buff.duration,
        `spell:${spell.id}`
      );
    }


    return {
      log:
        targets.length === 1
          ? (
              `🛡️ You raise ${spell.name}, reducing incoming ` +
              `damage by ${buff.value}% for ${buff.duration}s!`
            )
          : (
              `🛡️ You raise ${spell.name}, reducing incoming ` +
              `damage for all ${targets.length} allies by ` +
              `${buff.value}% for ${buff.duration}s!`
            ),

      appliedStatus:
        true
    };
  }
};