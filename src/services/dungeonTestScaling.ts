// src/services/dungeonTestScaling.ts
//
// TEMPORARY dungeon test scaling.
// Disable DUNGEON_TEST_SCALING_ENABLED when 5-player testing is available.

export const DUNGEON_TEST_SCALING_ENABLED = true;
export const DUNGEON_TEST_MIN_PARTY_SIZE = 3;
export const DUNGEON_DESIGN_PARTY_SIZE = 5;

export type DungeonTestScale = {
  partySize: number;
  hp: number;
  attack: number;
};

export function getEffectiveDungeonMinPartySize(
  configuredMinPartySize: number,
) {
  const configured = Math.max(
    1,
    Number(configuredMinPartySize || 1),
  );

  if (!DUNGEON_TEST_SCALING_ENABLED) {
    return configured;
  }

  return Math.min(
    configured,
    DUNGEON_TEST_MIN_PARTY_SIZE,
  );
}

export function getDungeonTestScale(
  partySize: number,
): DungeonTestScale {
  const size = Math.max(
    1,
    Number(partySize || 1),
  );

  if (
    !DUNGEON_TEST_SCALING_ENABLED ||
    size >= DUNGEON_DESIGN_PARTY_SIZE
  ) {
    return {
      partySize: size,
      hp: 1,
      attack: 1,
    };
  }

  // 3 players: 65% HP / 80% attack
  // 4 players: 82.5% HP / 90% attack
  // 5+ players: 100%
  const progress = Math.max(
    0,
    Math.min(
      1,
      (size - DUNGEON_TEST_MIN_PARTY_SIZE) /
        (DUNGEON_DESIGN_PARTY_SIZE -
          DUNGEON_TEST_MIN_PARTY_SIZE),
    ),
  );

  return {
    partySize: size,
    hp:
      0.65 +
      (1 - 0.65) * progress,
    attack:
      0.80 +
      (1 - 0.80) * progress,
  };
}
