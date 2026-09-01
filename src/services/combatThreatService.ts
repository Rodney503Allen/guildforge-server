import { db } from "../db";

export type CombatThreatTable = Record<number, number>;

export type CombatThreatParticipant = {
  playerId: number;
  hp: number;
};

export type CombatThreatState = {
  threat: CombatThreatTable;
  targetPlayerId: number | null;
};

export type CombatThreatCalculation = {
  damage?: number;
  effectiveHealing?: number;
  healingThreatMultiplier?: number;
  threatMultiplier?: number;
  bonusThreat?: number;
};

export const DEFAULT_HEALING_THREAT_MULTIPLIER = 0.5;

export async function getPlayerCombatThreatMultiplier(
  playerId: number
): Promise<number> {
  const [[effect]]: any = await db.query(
    `SELECT COALESCE(SUM(value), 0) AS total_value
     FROM player_status_effects
     WHERE player_id = ?
       AND effect_key IN (
         'sentinel_threat_generation_pct',
         'knight_threat_generation_pct',
         'paladin_threat_generation_pct',
         'voidwalker_threat_generation_pct'
       )
       AND expires_at > NOW(3)
       AND value > 0`,
    [playerId]
  );

  const increasedPercent = Math.max(
    0,
    Number(effect?.total_value) || 0
  );

  return 1 + increasedPercent / 100;
}

export function createCombatThreatTable(
  playerIds: Iterable<number>
): CombatThreatTable {
  return Object.fromEntries(
    Array.from(playerIds, playerId => [
      Number(playerId),
      0
    ])
  );
}

export function calculateCombatThreat({
  damage = 0,
  effectiveHealing = 0,
  healingThreatMultiplier = DEFAULT_HEALING_THREAT_MULTIPLIER,
  threatMultiplier = 1,
  bonusThreat = 0
}: CombatThreatCalculation): number {
  const normalThreat =
    Math.max(0, Number(damage) || 0) +
    Math.max(0, Number(effectiveHealing) || 0) *
      Math.max(
        0,
        Number(healingThreatMultiplier) || 0
      );

  return Math.max(
    0,
    normalThreat *
      Math.max(
        0,
        Number(threatMultiplier) || 0
      ) +
      Math.max(
        0,
        Number(bonusThreat) || 0
      )
  );
}

export function getCombatThreat(
  state: CombatThreatState,
  playerId: number
): number {
  return Math.max(
    0,
    Number(
      state.threat[
        Number(playerId)
      ]
    ) || 0
  );
}

export function getHighestThreatTarget<
  T extends CombatThreatParticipant
>(
  state: CombatThreatState,
  participants: Iterable<T>
): T | null {
  const livingParticipants =
    Array.from(participants).filter(
      participant =>
        participant.hp > 0
    );

  if (
    livingParticipants.length === 0
  ) {
    return null;
  }

  const highestThreat =
    Math.max(
      ...livingParticipants.map(
        participant =>
          getCombatThreat(
            state,
            participant.playerId
          )
      )
    );

  const eligibleTargets =
    livingParticipants.filter(
      participant =>
        getCombatThreat(
          state,
          participant.playerId
        ) === highestThreat
    );

  const currentTarget =
    eligibleTargets.find(
      participant =>
        participant.playerId ===
        state.targetPlayerId
    );

  if (currentTarget) {
    return currentTarget;
  }

  return (
    eligibleTargets.sort(
      (left, right) =>
        left.playerId -
        right.playerId
    )[0] ??
    null
  );
}

export function refreshCombatThreatTarget<
  T extends CombatThreatParticipant
>(
  state: CombatThreatState,
  participants: Iterable<T>
): T | null {
  const target =
    getHighestThreatTarget(
      state,
      participants
    );

  state.targetPlayerId =
    target?.playerId ??
    null;

  return target;
}

export function addCombatThreat<
  T extends CombatThreatParticipant
>(
  state: CombatThreatState,
  participants: Iterable<T>,
  playerId: number,
  amount: number
): number {
  const normalizedPlayerId =
    Number(playerId);

  const participantList =
    Array.from(participants);

  const participantExists =
    participantList.some(
      participant =>
        participant.playerId ===
        normalizedPlayerId
    );

  if (!participantExists) {
    return 0;
  }

  const normalizedAmount =
    Math.max(
      0,
      Number(amount) || 0
    );

  state.threat[
    normalizedPlayerId
  ] =
    getCombatThreat(
      state,
      normalizedPlayerId
    ) +
    normalizedAmount;

  refreshCombatThreatTarget(
    state,
    participantList
  );

  return state.threat[
    normalizedPlayerId
  ];
}
