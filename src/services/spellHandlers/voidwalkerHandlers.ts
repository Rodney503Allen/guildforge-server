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

const VOIDWALKER_THREAT_GENERATION_PERCENT = 100;

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

async function applyVoidwalkerThreatState(
  playerId: number,
  duration: number,
  source: string
) {
  const safeDuration =
    Math.max(
      1,
      Math.floor(
        Number(duration) || 1
      )
    );

  await db.query(
    `
      INSERT INTO player_status_effects
        (
          player_id,
          effect_key,
          value,
          charges,
          expires_at,
          source
        )
      VALUES
        (
          ?,
          'voidwalker_threat_generation_pct',
          ?,
          99,
          DATE_ADD(NOW(3), INTERVAL ? SECOND),
          ?
        )
      ON DUPLICATE KEY UPDATE
        value = VALUES(value),
        charges = VALUES(charges),
        expires_at = VALUES(expires_at),
        source = VALUES(source)
    `,
    [
      playerId,
      VOIDWALKER_THREAT_GENERATION_PERCENT,
      safeDuration,
      source
    ]
  );
}

// =====================================================
// SHARED VOID SHIELD
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
// Now also establishes Voidwalker tank threat.
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
      return `${spell.name} must use shield_maxhp_pct`;
    }

    if (
      buff.value <= 0
    ) {
      return `${spell.name} has an invalid shield percentage`;
    }

    if (
      buff.duration <= 0
    ) {
      return `${spell.name} has an invalid shield duration`;
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

    await applyVoidwalkerThreatState(
      playerId,
      duration,
      `spell:${spell.id}:voidwalker-threat`
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
              `with a ${shieldAmount}-point void barrier for ${duration}s ` +
              `and intensifying your threat generation!`
            )
          : (
              `🌌 You cast ${spell.name}, surrounding your ally ` +
              `with a ${shieldAmount}-point void barrier for ${duration}s ` +
              `and intensifying your threat generation!`
            ),

      appliedStatus:
        true,

      shieldAmount,

      shieldedTargetId:
        Number(
          targetId
        ),

      shieldDuration:
        duration,

      /*
       * Shielding is part of Voidwalker's tank identity,
       * so it now produces meaningful immediate threat.
       */
      threatGenerated:
        Math.max(
          100,
          Math.floor(
            shieldAmount *
            0.5
          )
        )
    };
  }
};

// =====================================================
// SPATIAL EXCHANGE
//
// Redirect support plus tank threat state.
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
      return `${spell.name} must use damage_redirect_pct`;
    }

    if (
      buff.value <= 0
    ) {
      return `${spell.name} has an invalid redirect percentage`;
    }

    if (
      buff.duration <= 0
    ) {
      return `${spell.name} has an invalid duration`;
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

    const redirectPercent =
      Math.max(
        1,
        Math.min(
          90,
          Math.floor(
            buff.value
          )
        )
      );

    if (
      Number(
        targetId
      ) ===
      Number(
        playerId
      )
    ) {
      await applyBuff(
        targetId,
        "damage_reduction",
        Math.max(
          1,
          Math.floor(
            redirectPercent *
            0.5
          )
        ),
        buff.duration,
        `spell:${spell.id}`
      );
    } else {
      await db.query(
        `
          INSERT INTO player_status_effects
            (
              player_id,
              effect_key,
              value,
              charges,
              expires_at,
              source
            )
          VALUES
            (
              ?,
              'spatial_exchange',
              ?,
              99,
              DATE_ADD(NOW(3), INTERVAL ? SECOND),
              ?
            )
          ON DUPLICATE KEY UPDATE
            value = VALUES(value),
            charges = VALUES(charges),
            expires_at = VALUES(expires_at),
            source = VALUES(source)
        `,
        [
          targetId,
          redirectPercent,
          buff.duration,
          `spatial_exchange:${playerId}`
        ]
      );
    }

    await applyVoidwalkerThreatState(
      playerId,
      buff.duration,
      `spell:${spell.id}:voidwalker-threat`
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
              `🌀 You cast ${spell.name}, bending incoming force ` +
              `through folded space and gaining ` +
              `${Math.max(
                1,
                Math.floor(
                  redirectPercent *
                  0.5
                )
              )}% damage reduction for ${buff.duration}s!`
            )
          : (
              `🌀 You cast ${spell.name}, linking yourself to your ally ` +
              `through folded space and redirecting ` +
              `${redirectPercent}% of their incoming damage to you for ` +
              `${buff.duration}s!`
            ),

      appliedStatus:
        true,

      shieldedTargetId:
        Number(
          targetId
        ),

      shieldDuration:
        buff.duration,

      redirectPercent,

      threatGenerated:
        150
    };
  }
};

// =====================================================
// ABYSSAL WARD
//
// Party-wide shield now generates threat proportional
// to the protection created.
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
      return `${spell.name} must use shield_maxhp_pct`;
    }

    if (
      buff.value <= 0
    ) {
      return `${spell.name} has an invalid shield percentage`;
    }

    if (
      buff.duration <= 0
    ) {
      return `${spell.name} has an invalid shield duration`;
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

    const targets =
      allies &&
      allies.length > 0
        ? allies.filter(
            ally =>
              Number(
                ally.hp
              ) > 0
          )
        : [{
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
          }];

    if (
      targets.length === 0
    ) {
      return {
        log:
          `🌑 You cast ${spell.name}, but there are no living allies to protect.`,

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

    await applyVoidwalkerThreatState(
      playerId,
      buff.duration,
      `spell:${spell.id}:voidwalker-threat`
    );

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

      shieldedTargetIds:
        targets.map(
          ally =>
            Number(
              ally.playerId
            )
        ),

      shieldDuration:
        buff.duration,

      totalShield,

      threatGenerated:
        Math.max(
          150,
          Math.floor(
            totalShield *
            0.25
          )
        )
    };
  }
};
