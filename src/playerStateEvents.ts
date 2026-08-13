// src/playerStateEvents.ts

import { EventEmitter } from "events";

export type PlayerStatePatch = Record<string, any>;

type PlayerStateEvent = {
  playerId: number;
  patch: PlayerStatePatch;
};

const playerStateEvents = new EventEmitter();

/*
 * Player state changes can originate deep inside services
 * that should not import socketServer.ts directly.
 *
 * Services publish here; socketServer.ts forwards the
 * resulting patch to the authenticated player's room.
 */
export function publishPlayerStatePatch(
  playerId: number,
  patch: PlayerStatePatch,
) {
  if (
    !Number.isInteger(playerId) ||
    playerId <= 0 ||
    !patch ||
    typeof patch !== "object"
  ) {
    return;
  }

  playerStateEvents.emit(
    "player-state",
    {
      playerId,
      patch,
    } satisfies PlayerStateEvent,
  );
}

export function onPlayerStatePatch(
  listener: (
    playerId: number,
    patch: PlayerStatePatch,
  ) => void,
) {
  const handler = (
    event: PlayerStateEvent,
  ) => {
    listener(
      event.playerId,
      event.patch,
    );
  };

  playerStateEvents.on(
    "player-state",
    handler,
  );

  return () => {
    playerStateEvents.off(
      "player-state",
      handler,
    );
  };
}


export type PlayerLevelUpPayload = Record<string, any>;

type PlayerLevelUpEvent = {
  playerId: number;
  levelUp: PlayerLevelUpPayload;
};

/*
 * Dedicated progression event for things that need
 * presentation behavior in the browser (banner + sound),
 * rather than only a stat-panel reconciliation.
 */
export function publishPlayerLevelUp(
  playerId: number,
  levelUp: PlayerLevelUpPayload,
) {
  if (
    !Number.isInteger(playerId) ||
    playerId <= 0 ||
    !levelUp ||
    typeof levelUp !== "object"
  ) {
    return;
  }

  playerStateEvents.emit(
    "player-level-up",
    {
      playerId,
      levelUp,
    } satisfies PlayerLevelUpEvent,
  );
}

export function onPlayerLevelUp(
  listener: (
    playerId: number,
    levelUp: PlayerLevelUpPayload,
  ) => void,
) {
  const handler = (
    event: PlayerLevelUpEvent,
  ) => {
    listener(
      event.playerId,
      event.levelUp,
    );
  };

  playerStateEvents.on(
    "player-level-up",
    handler,
  );

  return () => {
    playerStateEvents.off(
      "player-level-up",
      handler,
    );
  };
}