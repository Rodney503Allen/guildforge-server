// src/services/spellHandlers/voidwalkerHandlers.ts

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
// SHARED PLAYER MAX HP NORMALIZATION
// =====================================================

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
// SHARED VOID SHIELD
//
// Creates or refreshes a max-HP-based absorb shield.
//
// player_shields belongs to the player rather than
// a particular combat instance, allowing this to work
// across normal combat, Hunts, dungeons, and raids.
// =====================================================

async function applyVoidShield(
  playerId: number,
  spell: any,
  maximumPlayerHP: number,
  shieldPercent: number
) {

  const duration =
    Math.max(
      0,
      Number(
        spell.buff_duration
      ) || 0
    );


  const safeMaxHP =
    Math.max(
      1,
      Number(
        maximumPlayerHP
      ) || 1
    );


  const safeShieldPercent =
    Math.max(
      0,
      Number(
        shieldPercent
      ) || 0
    );


  const shieldAmount =
    Math.max(
      1,
      Math.floor(
        safeMaxHP *
        (
          safeShieldPercent /
          100
        )
      )
    );


  const source =
    `spell:${spell.id}`;


  const expiresAt =
    new Date(
      Date.now() +
      duration *
      1000
    );


  /*
   * Refresh this spell's shield on this
   * specific player instead of stacking
   * repeated copies.
   */
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
//
// Selected-friendly-target absorb shield.
// =====================================================

export const nullBarrierHandler:
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

    targetPlayerId,
    targetPlayer,
    maxTargetHP
  }): Promise<SpellHandlerResult> {

    const buff =
      getConfiguredBuff(
        spell
      );


    /*
     * Hunt combat supplies the selected ally.
     *
     * Solo combat falls back to the caster.
     */
    const targetId =
      targetPlayerId ??
      playerId;


    const recipient =
      targetPlayer ??
      player;


    const maximumHP =
      getMaximumPlayerHP(
        recipient,
        maxTargetHP ??
        maxPlayerHP
      );


    const {
      shieldAmount,
      duration
    } =
      await applyVoidShield(
        targetId,
        spell,
        maximumHP,
        buff.value
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
              `🌌 You cast ${spell.name}, surrounding yourself ` +
              `with a ${shieldAmount}-point void barrier for ` +
              `${duration}s!`
            )
          : (
              `🌌 You cast ${spell.name}, surrounding your ally ` +
              `with a ${shieldAmount}-point void barrier for ` +
              `${duration}s!`
            ),

      appliedStatus:
        true,
      shieldAmount,
      shieldedTargetId: Number(targetId),
      shieldDuration: duration
    };
  }
};


// =====================================================
// SPATIAL EXCHANGE
//
// Intended final behavior:
// Redirect a percentage of damage taken by the
// selected ally to the Voidwalker.
//
// Current compatible behavior:
// Half of the configured redirect amount becomes
// damage reduction on the selected ally.
//
// Example:
// 30% redirect
//      ↓
// 15% temporary damage reduction
//
// This preserves useful party behavior until the
// Hunt damage pipeline supports true redirection.
// =====================================================

export const spatialExchangeHandler:
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
      "damage_redirect_pct"
    ) {

      return (
        `${spell.name} must use damage_redirect_pct`
      );
    }


    if (
      buff.value <= 0
    ) {

      return (
        `${spell.name} has an invalid redirect percentage`
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


    const redirectPercent = Math.max(1, Math.min(90, Math.floor(buff.value)));
    if (Number(targetId) === Number(playerId)) {
      await applyBuff(targetId,"damage_reduction",Math.max(1,Math.floor(redirectPercent*0.5)),buff.duration,`spell:${spell.id}`);
    } else {
      await db.query(`
        INSERT INTO player_status_effects(player_id,effect_key,value,charges,expires_at,source)
        VALUES(?, 'spatial_exchange', ?, 99, DATE_ADD(NOW(3),INTERVAL ? SECOND), ?)
        ON DUPLICATE KEY UPDATE value=VALUES(value),charges=VALUES(charges),expires_at=VALUES(expires_at),source=VALUES(source)
      `,[targetId,redirectPercent,buff.duration,`spatial_exchange:${playerId}`]);
    }


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
              `🌀 You cast ${spell.name}, bending incoming force ` +
              `through folded space and gaining ` +
              `${Math.max(1,Math.floor(redirectPercent*0.5))}% damage reduction for ` +
              `${buff.duration}s!`
            )
          : (
              `🌀 You cast ${spell.name}, linking yourself to your ally ` +
              `through folded space and redirecting ` +
              `${redirectPercent}% of their incoming damage to you for ` +
              `${buff.duration}s!`
            ),

      appliedStatus:
        true,
      shieldedTargetId: Number(targetId),
      shieldDuration: buff.duration,
      redirectPercent
    };
  }
};


// =====================================================
// ABYSSAL WARD
//
// Applies an absorb shield to every living ally.
//
// Each shield is calculated independently using that
// player's own maximum HP.
// =====================================================

export const abyssalWardHandler:
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
     * Hunt / future party combat supplies allies.
     *
     * Normal solo combat may not, so fall back
     * to a one-player target list containing caster.
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
                Number(
                  player?.hpoints ??
                  1
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
          `🌑 You cast ${spell.name}, but there are ` +
          `no living allies to protect.`,

        appliedStatus:
          false
      };
    }


    let totalShield =
      0;


    let shieldedPlayers =
      0;


    for (
      const ally of
      targets
    ) {

      const maximumHP =
        getMaximumPlayerHP(
          ally.stats,
          ally.maxHp
        );


      const {
        shieldAmount
      } =
        await applyVoidShield(
          ally.playerId,
          spell,
          maximumHP,
          buff.value
        );


      totalShield +=
        shieldAmount;


      shieldedPlayers++;
    }


    return {
      log:
        `🌑 You open ${spell.name}, shielding ` +
        `${shieldedPlayers} ${
          shieldedPlayers === 1
            ? "ally"
            : "allies"
        } for ${totalShield} total absorb ` +
        `for ${buff.duration}s!`,

      appliedStatus:
        true,
      shieldedTargetIds: targets.map(ally => Number(ally.playerId)),
      shieldDuration: buff.duration,
      totalShield
    };
  }
};
