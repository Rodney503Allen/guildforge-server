import type {
  EnemyMechanicParticipant,
  EnemyMechanicTargetRule,
  EnemyMechanicThreatState,
} from "./types";

function livingParticipants(
  participants: Iterable<EnemyMechanicParticipant>,
): EnemyMechanicParticipant[] {
  return Array.from(participants).filter((participant) => participant.hp > 0);
}

function threatFor(
  state: EnemyMechanicThreatState,
  playerId: number,
): number {
  return Math.max(0, Number(state.threat[Number(playerId)]) || 0);
}

function randomOne<T>(values: T[]): T[] {
  if (values.length === 0) return [];
  return [values[Math.floor(Math.random() * values.length)]];
}

export function selectEnemyMechanicTargets(
  rule: EnemyMechanicTargetRule,
  participants: Iterable<EnemyMechanicParticipant>,
  threatState: EnemyMechanicThreatState,
): EnemyMechanicParticipant[] {
  const living = livingParticipants(participants);
  if (living.length === 0 || rule === "self") return [];

  if (rule === "all_living_players") return living;
  if (rule === "random_living_player") return randomOne(living);

  if (rule === "lowest_hp_player") {
    return randomOne(
      living.filter(
        (participant) =>
          participant.hp / Math.max(1, participant.maxHp) ===
          Math.min(
            ...living.map((value) => value.hp / Math.max(1, value.maxHp)),
          ),
      ),
    );
  }

  if (rule === "highest_hp_player") {
    return randomOne(
      living.filter(
        (participant) =>
          participant.hp / Math.max(1, participant.maxHp) ===
          Math.max(
            ...living.map((value) => value.hp / Math.max(1, value.maxHp)),
          ),
      ),
    );
  }

  const ordered = [...living].sort((left, right) => {
    const threatDifference =
      threatFor(threatState, right.playerId) -
      threatFor(threatState, left.playerId);
    return threatDifference || left.playerId - right.playerId;
  });

  if (rule === "lowest_threat") return [ordered[ordered.length - 1]];
  if (rule === "second_highest_threat") return [ordered[1] ?? ordered[0]];
  return [ordered[0]];
}
