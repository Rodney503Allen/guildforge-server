// src/services/playerDamageMitigationService.ts

import { db } from "../db";

export type PlayerDamageMitigationResult = {
  incomingDamage: number;
  finalDamage: number;

  absorbedDamage: number;
  shieldBroken: boolean;

  interceptTriggered: boolean;
  interceptReductionPercent: number;

  aegisTriggered: boolean;
  aegisPreventedDeath: boolean;
  aegisReductionPercent: number;
};


// =====================================================
// SHIELDS
// =====================================================

async function absorbDamageWithPlayerShields(
  playerId: number,
  incomingDamage: number
) {
  let remainingDamage =
    Math.max(
      0,
      Math.floor(
        Number(incomingDamage) || 0
      )
    );

  let absorbedDamage = 0;
  let shieldBroken = false;

  if (remainingDamage <= 0) {
    return {
      absorbedDamage: 0,
      remainingDamage: 0,
      shieldBroken: false
    };
  }

  await db.query(
    `
      DELETE FROM player_shields

      WHERE player_id = ?
        AND (
          expires_at <= NOW(3)
          OR remaining_absorb <= 0
        )
    `,
    [playerId]
  );

  const [shields]: any =
    await db.query(
      `
        SELECT
          id,
          remaining_absorb,
          source

        FROM player_shields

        WHERE player_id = ?
          AND expires_at > NOW(3)
          AND remaining_absorb > 0

        ORDER BY
          expires_at ASC,
          id ASC
      `,
      [playerId]
    );

  for (
    const shield of
    shields
  ) {
    if (
      remainingDamage <= 0
    ) {
      break;
    }

    const availableAbsorb =
      Math.max(
        0,
        Number(
          shield.remaining_absorb
        ) || 0
      );

    if (
      availableAbsorb <= 0
    ) {
      continue;
    }

    const absorbedFromShield =
      Math.min(
        remainingDamage,
        availableAbsorb
      );

    const newRemainingAbsorb =
      availableAbsorb -
      absorbedFromShield;

    remainingDamage -=
      absorbedFromShield;

    absorbedDamage +=
      absorbedFromShield;

    if (
      newRemainingAbsorb <= 0
    ) {
      await db.query(
        `
          DELETE FROM player_shields

          WHERE id = ?
        `,
        [shield.id]
      );

      shieldBroken = true;

    } else {

      await db.query(
        `
          UPDATE player_shields

          SET remaining_absorb = ?

          WHERE id = ?
        `,
        [
          newRemainingAbsorb,
          shield.id
        ]
      );
    }
  }

  return {
    absorbedDamage,
    remainingDamage,
    shieldBroken
  };
}


// =====================================================
// INTERCEPT
// =====================================================

async function applyIntercept(
  playerId: number,
  incomingDamage: number
) {
  const damage =
    Math.max(
      0,
      Math.floor(
        Number(incomingDamage) || 0
      )
    );

  if (
    damage <= 0
  ) {
    return {
      damage: 0,
      triggered: false,
      reductionPercent: 0
    };
  }

  await db.query(
    `
      DELETE FROM player_status_effects

      WHERE player_id = ?
        AND effect_key = 'intercept'
        AND (
          expires_at <= NOW(3)
          OR charges <= 0
        )
    `,
    [playerId]
  );

  const [[effect]]: any =
    await db.query(
      `
        SELECT
          id,
          charges,
          value

        FROM player_status_effects

        WHERE player_id = ?
          AND effect_key = 'intercept'
          AND expires_at > NOW(3)
          AND charges > 0

        ORDER BY
          expires_at ASC,
          id ASC

        LIMIT 1
      `,
      [playerId]
    );

  if (!effect) {
    return {
      damage,
      triggered: false,
      reductionPercent: 0
    };
  }

  const reductionPercent =
    Math.max(
      0,
      Math.min(
        90,
        Number(
          effect.value
        ) || 0
      )
    );

  const reducedDamage =
    Math.max(
      1,
      Math.ceil(
        damage *
        (
          1 -
          reductionPercent /
            100
        )
      )
    );

  const remainingCharges =
    Math.max(
      0,
      Number(
        effect.charges
      ) - 1
    );

  if (
    remainingCharges <= 0
  ) {
    await db.query(
      `
        DELETE FROM player_status_effects

        WHERE id = ?
      `,
      [effect.id]
    );

  } else {

    await db.query(
      `
        UPDATE player_status_effects

        SET charges = ?

        WHERE id = ?
      `,
      [
        remainingCharges,
        effect.id
      ]
    );
  }

  return {
    damage:
      reducedDamage,

    triggered:
      true,

    reductionPercent
  };
}


// =====================================================
// AEGIS OF FAITH
// =====================================================

async function applyAegisOfFaith(
  playerId: number,
  currentHP: number,
  incomingDamage: number
) {
  const damage =
    Math.max(
      0,
      Math.floor(
        Number(incomingDamage) || 0
      )
    );

  if (
    damage <= 0
  ) {
    return {
      damage: 0,
      triggered: false,
      preventedDeath: false,
      reductionPercent: 0
    };
  }

  await db.query(
    `
      DELETE FROM player_status_effects

      WHERE player_id = ?
        AND effect_key = 'death_prevention'
        AND (
          expires_at <= NOW(3)
          OR charges <= 0
        )
    `,
    [playerId]
  );

  const [[effect]]: any =
    await db.query(
      `
        SELECT
          id,
          charges,
          value

        FROM player_status_effects

        WHERE player_id = ?
          AND effect_key = 'death_prevention'
          AND expires_at > NOW(3)
          AND charges > 0

        ORDER BY
          expires_at ASC,
          id ASC

        LIMIT 1
      `,
      [playerId]
    );

  if (!effect) {
    return {
      damage,
      triggered: false,
      preventedDeath: false,
      reductionPercent: 0
    };
  }

  const reductionPercent =
    Math.max(
      0,
      Math.min(
        100,
        Number(
          effect.value
        ) || 0
      )
    );

  let reducedDamage =
    Math.max(
      1,
      Math.ceil(
        damage *
        (
          1 -
          reductionPercent /
            100
        )
      )
    );

  let preventedDeath =
    false;

  if (
    reducedDamage >=
    currentHP
  ) {
    reducedDamage =
      Math.max(
        0,
        currentHP - 1
      );

    preventedDeath =
      true;
  }

  const remainingCharges =
    Math.max(
      0,
      Number(
        effect.charges
      ) - 1
    );

  if (
    remainingCharges <= 0
  ) {
    await db.query(
      `
        DELETE FROM player_status_effects

        WHERE id = ?
      `,
      [effect.id]
    );

  } else {

    await db.query(
      `
        UPDATE player_status_effects

        SET charges = ?

        WHERE id = ?
      `,
      [
        remainingCharges,
        effect.id
      ]
    );
  }

  return {
    damage:
      reducedDamage,

    triggered:
      true,

    preventedDeath,

    reductionPercent
  };
}


// =====================================================
// UNIVERSAL PLAYER DAMAGE MITIGATION
// =====================================================

export async function mitigateIncomingPlayerDamage(
  playerId: number,
  currentHP: number,
  incomingDamage: number
): Promise<PlayerDamageMitigationResult> {

  const incoming =
    Math.max(
      0,
      Math.floor(
        Number(
          incomingDamage
        ) || 0
      )
    );

  let finalDamage =
    incoming;


  // -------------------------
  // ABSORB SHIELDS
  // -------------------------

  const shieldResult =
    await absorbDamageWithPlayerShields(
      playerId,
      finalDamage
    );

  finalDamage =
    shieldResult.remainingDamage;


  // -------------------------
  // INTERCEPT
  // -------------------------

  const interceptResult =
    await applyIntercept(
      playerId,
      finalDamage
    );

  finalDamage =
    interceptResult.damage;


  // -------------------------
  // AEGIS OF FAITH
  // -------------------------

  const aegisResult =
    await applyAegisOfFaith(
      playerId,
      currentHP,
      finalDamage
    );

  finalDamage =
    aegisResult.damage;


  return {
    incomingDamage:
      incoming,

    finalDamage,

    absorbedDamage:
      shieldResult.absorbedDamage,

    shieldBroken:
      shieldResult.shieldBroken,

    interceptTriggered:
      interceptResult.triggered,

    interceptReductionPercent:
      interceptResult.reductionPercent,

    aegisTriggered:
      aegisResult.triggered,

    aegisPreventedDeath:
      aegisResult.preventedDeath,

    aegisReductionPercent:
      aegisResult.reductionPercent
  };
}