// src/huntSocket.ts

import type {
  Server as SocketIOServer,
  Socket,
} from "socket.io";

import {
  getPartyByPlayer,
} from "./partyService";

import {
  getHuntReadyCheck,
} from "./services/huntReadyCheckService";

import {
  onHuntProgressEvent,
} from "./huntEvents";

import {
  ensureHuntCombatSessionForPlayer,
  advanceHuntCombatSession,
  buildHuntCombatSnapshot,
  type HuntCombatSession,
} from "./services/huntCombatSessionService";

let io: SocketIOServer | null = null;

let huntProgressBridgeInstalled =
  false;

const combatLoops =
  new Map<number, NodeJS.Timeout>();

const readyCheckExpiryTimers =
  new Map<number, NodeJS.Timeout>();

/*
 * 500ms remains intentional.
 * The browser interpolates combat timers between
 * authoritative snapshots, so smooth bars do not
 * require higher-frequency socket traffic.
 */
const COMBAT_TICK_MS = 500;

function partyRoom(
  partyId: number,
) {
  return `party:${partyId}`;
}

function encounterRoom(
  encounterId: number,
) {
  return `hunt:encounter:${encounterId}`;
}

export function registerHuntSocket(
  socketServer: SocketIOServer,
  socket: Socket,
) {
  io = socketServer;

  if (
    !huntProgressBridgeInstalled
  ) {
    huntProgressBridgeInstalled =
      true;

    onHuntProgressEvent(
      (
        partyId,
        progress,
      ) => {
        publishHuntProgress(
          partyId,
          progress,
        );
      },
    );
  }

  const playerId =
    Number(socket.data.playerId);

  if (
    !Number.isInteger(playerId) ||
    playerId <= 0
  ) {
    return;
  }

  socket.on(
    "hunt:subscribe",
    async (
      acknowledge?: Function,
    ) => {
      const ack =
        typeof acknowledge === "function"
          ? acknowledge
          : () => {};

      try {
        const party =
          await getPartyByPlayer(
            playerId,
          );

        if (party) {
          await socket.join(
            partyRoom(party.id),
          );
        }

        ack({
          ok: true,
          partyId:
            party?.id ?? null,
        });
      } catch (err: any) {
        console.error(
          "hunt:subscribe failed:",
          err,
        );

        ack({
          ok: false,
          error:
            err?.message ||
            "Unable to subscribe to Hunt updates.",
        });
      }
    },
  );

  socket.on(
    "hunt:combat:join",
    async (
      acknowledge?: Function,
    ) => {
      const ack =
        typeof acknowledge === "function"
          ? acknowledge
          : () => {};

      try {
        const session =
          await ensureHuntCombatSessionForPlayer(
            playerId,
          );

        if (!session) {
          return ack({
            ok: false,
            error:
              "No active Hunt encounter.",
          });
        }

        await socket.join(
          encounterRoom(
            session.encounterId,
          ),
        );

        startCombatLoop(
          session,
        );

        ack({
          ok: true,
          snapshot:
            buildHuntCombatSnapshot(
              session,
            ),
        });
      } catch (err: any) {
        console.error(
          "hunt:combat:join failed:",
          err,
        );

        ack({
          ok: false,
          error:
            err?.message ||
            "Unable to join Hunt combat channel.",
        });
      }
    },
  );

  socket.on(
    "hunt:combat:leave",
    () => {
      for (
        const room of
        socket.rooms
      ) {
        if (
          room.startsWith(
            "hunt:encounter:",
          )
        ) {
          void socket.leave(room);
        }
      }
    },
  );
}

function startCombatLoop(
  session: HuntCombatSession,
) {
  const encounterId =
    Number(session.encounterId);

  if (
    combatLoops.has(
      encounterId,
    )
  ) {
    return;
  }

  const timer =
    setInterval(
      async () => {
        try {
          await advanceHuntCombatSession(
            session,
          );

          publishHuntCombatSnapshot(
            buildHuntCombatSnapshot(
              session,
            ),
          );

          if (
            session.state !==
            "active"
          ) {
            stopCombatLoop(
              encounterId,
            );
          }
        } catch (err) {

          console.error(
            "Hunt combat loop failed:",
            {
              encounterId,
              err,
            },
          );


          /*
          * Do not allow an orphaned combat loop
          * to tick forever.
          */
          stopCombatLoop(
            encounterId
          );
        }      },
      COMBAT_TICK_MS,
    );

  combatLoops.set(
    encounterId,
    timer,
  );
}

function stopCombatLoop(
  encounterId: number,
) {
  const timer =
    combatLoops.get(
      encounterId,
    );

  if (timer) {
    clearInterval(timer);
  }

  combatLoops.delete(
    encounterId,
  );
}

export function publishHuntChanged(
  partyId: number,
  payload: any = {},
) {
  if (
    !io ||
    !Number.isInteger(
      Number(partyId),
    ) ||
    Number(partyId) <= 0
  ) {
    return;
  }

  io
    .to(
      partyRoom(
        Number(partyId),
      ),
    )
    .emit(
      "hunt:changed",
      payload,
    );
}

export function publishHuntProgress(
  partyId: number,
  progress: any,
) {
  if (
    !io ||
    !Number.isInteger(
      Number(partyId),
    ) ||
    Number(partyId) <= 0
  ) {
    return;
  }

  io
    .to(
      partyRoom(
        Number(partyId),
      ),
    )
    .emit(
      "hunt:progress",
      progress,
    );

  publishHuntChanged(
    Number(partyId),
    {
      partyHuntId:
        progress?.partyHuntId ??
        null,
    },
  );
}

export function publishHuntReadyCheck(
  readyCheck: any,
  encounter: any = null,
) {
  if (
    !readyCheck ||
    !io
  ) {
    return;
  }

  const partyId =
    Number(
      readyCheck.partyId,
    );

  if (
    !Number.isInteger(
      partyId,
    ) ||
    partyId <= 0
  ) {
    return;
  }

  io
    .to(
      partyRoom(
        partyId,
      ),
    )
    .emit(
      "hunt:ready-check",
      {
        readyCheck,
        encounter,
      },
    );

  scheduleReadyCheckExpiry(
    readyCheck,
  );
}

function scheduleReadyCheckExpiry(
  readyCheck: any,
) {
  const readyCheckId =
    Number(
      readyCheck?.id,
    );

  if (
    !Number.isInteger(
      readyCheckId,
    ) ||
    readyCheckId <= 0
  ) {
    return;
  }

  const existing =
    readyCheckExpiryTimers.get(
      readyCheckId,
    );

  if (existing) {
    clearTimeout(existing);
    readyCheckExpiryTimers.delete(
      readyCheckId,
    );
  }

  if (
    readyCheck.status !==
    "pending"
  ) {
    return;
  }

  const expiresAt =
    new Date(
      readyCheck.expiresAt,
    ).getTime();

  const delay =
    Math.max(
      0,
      expiresAt -
        Date.now() +
        50,
    );

  const timer =
    setTimeout(
      async () => {
        readyCheckExpiryTimers.delete(
          readyCheckId,
        );

        try {
          const playerId =
            Number(
              readyCheck.players?.[0]
                ?.playerId,
            );

          if (
            !Number.isInteger(
              playerId,
            ) ||
            playerId <= 0
          ) {
            return;
          }

          const snapshot =
            await getHuntReadyCheck(
              playerId,
            );

          if (
            snapshot &&
            Number(snapshot.id) ===
              readyCheckId
          ) {
            publishHuntReadyCheck(
              snapshot,
              null,
            );
          }
        } catch (err) {
          console.error(
            "Hunt ready-check expiry broadcast failed:",
            err,
          );
        }
      },
      delay,
    );

  readyCheckExpiryTimers.set(
    readyCheckId,
    timer,
  );
}

export function publishHuntCombatSnapshot(
  snapshot: any,
) {
  if (
    !io ||
    !snapshot
  ) {
    return;
  }

  const encounterId =
    Number(
      snapshot.encounterId,
    );

  if (
    !Number.isInteger(
      encounterId,
    ) ||
    encounterId <= 0
  ) {
    return;
  }

  io
    .to(
      encounterRoom(
        encounterId,
      ),
    )
    .emit(
      "hunt:combat-state",
      snapshot,
    );
}