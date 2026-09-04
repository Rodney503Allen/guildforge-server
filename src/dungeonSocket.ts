// src/dungeonSocket.ts
//
// Shared Dungeon Socket.IO channel.
//
// Ready checks are broadcast BOTH:
//   1) to the party dungeon room, and
//   2) directly to every frozen ready-check player's private room.
//
// The direct player broadcast is intentional: it guarantees that a party
// member receives the ready check even if their dungeon subscription has
// not finished yet when the leader starts it.

import type {
  Server as SocketIOServer,
  Socket,
} from "socket.io";

import {
  getPartyByPlayer,
} from "./partyService";

import {
  emitToPlayer,
} from "./socketServer";

import {
  deleteResolvedDungeonReadyCheck,
  getDungeonReadyCheck,
} from "./services/dungeonReadyCheckService";

let io:
  SocketIOServer | null =
  null;

const readyCheckExpiryTimers =
  new Map<
    number,
    NodeJS.Timeout
  >();

function partyRoom(
  partyId: number,
) {
  return `dungeon:party:${partyId}`;
}

function instanceRoom(
  instanceId: number,
) {
  return `dungeon:instance:${instanceId}`;
}

export function registerDungeonSocket(
  socketServer:
    SocketIOServer,
  socket:
    Socket,
) {
  io =
    socketServer;

  const playerId =
    Number(
      socket.data.playerId
    );

  if (
    !Number.isInteger(
      playerId
    ) ||
    playerId <= 0
  ) {
    return;
  }

  /*
   * World pages call this automatically.
   *
   * It gives us a shared party room for future Dungeon state,
   * while ready checks are also sent directly to private player
   * rooms so there is no subscription race.
   */
  socket.on(
    "dungeon:subscribe",
    async (
      acknowledge?: Function,
    ) => {
      const ack =
        typeof acknowledge ===
        "function"
          ? acknowledge
          : () => {};

      try {
        /*
         * Leave stale dungeon-party rooms before joining the
         * player's current party. Party membership can change
         * while the tab remains open.
         */
        for (
          const room of
          socket.rooms
        ) {
          if (
            room.startsWith(
              "dungeon:party:"
            )
          ) {
            await socket.leave(
              room
            );
          }
        }

        const party =
          await getPartyByPlayer(
            playerId
          );

        if (
          party
        ) {
          await socket.join(
            partyRoom(
              Number(
                party.id
              )
            )
          );
        }

        ack({
          ok: true,

          partyId:
            party?.id ??
            null,
        });
      } catch (
        err: any
      ) {
        console.error(
          "dungeon:subscribe failed:",
          err
        );

        ack({
          ok: false,

          error:
            err?.message ||
            "Unable to subscribe to Dungeon updates.",
        });
      }
    }
  );

  socket.on(
    "dungeon:instance:join",
    async (
      instanceIdRaw:
        unknown,
      acknowledge?: Function,
    ) => {
      const ack =
        typeof acknowledge ===
        "function"
          ? acknowledge
          : () => {};

      const instanceId =
        Number(
          instanceIdRaw
        );

      if (
        !Number.isInteger(
          instanceId
        ) ||
        instanceId <= 0
      ) {
        return ack({
          ok: false,
          error:
            "Invalid Dungeon instance.",
        });
      }

      /*
       * Membership is still enforced by the HTTP/service layer for
       * authoritative actions. This room is only a delivery channel.
       */
      await socket.join(
        instanceRoom(
          instanceId
        )
      );

      ack({
        ok: true,
        instanceId,
      });
    }
  );

  socket.on(
    "dungeon:instance:leave",
    (
      instanceIdRaw:
        unknown
    ) => {
      const instanceId =
        Number(
          instanceIdRaw
        );

      if (
        Number.isInteger(
          instanceId
        ) &&
        instanceId > 0
      ) {
        void socket.leave(
          instanceRoom(
            instanceId
          )
        );
      }
    }
  );
}

export function publishDungeonReadyCheck(
  readyCheck:
    any,
  dungeon:
    any = null,
) {
  if (
    !readyCheck
  ) {
    return;
  }

  const payload = {
    readyCheck,
    dungeon,
  };

  /*
   * Guaranteed delivery path for everyone in the frozen roster.
   * Every authenticated socket automatically joins player:<id>
   * in socketServer.ts.
   */
  const playerIds: number[] =
    Array.from(
      new Set<number>(
        (
          readyCheck.players ??
          []
        )
          .map(
            (
              player: any
            ) =>
              Number(
                player.playerId
              )
          )
          .filter(
            (
              playerId: number
            ) =>
              Number.isInteger(
                playerId
              ) &&
              playerId > 0
          )
      )
    );

  for (
    const playerId of
    playerIds
  ) {
    emitToPlayer(
      playerId,
      "dungeon:ready-check",
      payload
    );

    /*
     * Terminal states get a second, explicit private-player event.
     *
     * The ready-check DB row is deleted immediately after the route
     * publishes the terminal snapshot. This dedicated event ensures
     * non-initiating party members do not have to rediscover a row
     * that no longer exists in order to close their ready modal and
     * transition into the Dungeon.
     */
    if (
      readyCheck.status !==
      "pending"
    ) {
      emitToPlayer(
        playerId,
        "dungeon:ready-check-resolved",
        payload
      );
    }
  }

  /*
   * Also broadcast to the Dungeon party room. This gives us the same
   * architecture as Hunts and lets future Dungeon UI updates reuse it.
   */
  const partyId =
    Number(
      readyCheck.partyId
    );

  if (
    io &&
    Number.isInteger(
      partyId
    ) &&
    partyId > 0
  ) {
    const room =
      io.to(
        partyRoom(
          partyId
        )
      );

    room.emit(
      "dungeon:ready-check",
      payload
    );

    if (
      readyCheck.status !==
      "pending"
    ) {
      room.emit(
        "dungeon:ready-check-resolved",
        payload
      );
    }
  }

  scheduleDungeonReadyCheckExpiry(
    readyCheck
  );
}

function scheduleDungeonReadyCheckExpiry(
  readyCheck:
    any,
) {
  const readyCheckId =
    Number(
      readyCheck?.id
    );

  if (
    !Number.isInteger(
      readyCheckId
    ) ||
    readyCheckId <= 0
  ) {
    return;
  }

  const existing =
    readyCheckExpiryTimers.get(
      readyCheckId
    );

  if (
    existing
  ) {
    clearTimeout(
      existing
    );

    readyCheckExpiryTimers.delete(
      readyCheckId
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
      readyCheck.expiresAt
    ).getTime();

  if (
    !Number.isFinite(
      expiresAt
    )
  ) {
    return;
  }

  const delay =
    Math.max(
      0,
      expiresAt -
      Date.now() +
      75
    );

  const timer =
    setTimeout(
      async () => {
        readyCheckExpiryTimers.delete(
          readyCheckId
        );

        try {
          const playerId =
            Number(
              readyCheck.players?.[0]
                ?.playerId
            );

          if (
            !Number.isInteger(
              playerId
            ) ||
            playerId <= 0
          ) {
            return;
          }

          /*
           * getDungeonReadyCheck() performs the expiry transition if
           * the deadline has passed, then returns the current snapshot.
           */
          const snapshot =
            await getDungeonReadyCheck(
              playerId
            );

          if (
            snapshot &&
            Number(
              snapshot.id
            ) ===
            readyCheckId
          ) {
            publishDungeonReadyCheck(
              snapshot,
              null
            );

            if (
              snapshot.status !==
              "pending"
            ) {
              await deleteResolvedDungeonReadyCheck(
                readyCheckId
              );
            }
          }
        } catch (
          err
        ) {
          console.error(
            "Dungeon ready-check expiry broadcast failed:",
            err
          );
        }
      },
      delay
    );

  readyCheckExpiryTimers.set(
    readyCheckId,
    timer
  );
}

export function publishDungeonChanged(
  readyCheck:
    any,
  payload:
    any = {},
) {
  if (
    !readyCheck
  ) {
    return;
  }

  const playerIds: number[] =
    Array.from(
      new Set<number>(
        (
          readyCheck.players ??
          []
        )
          .map(
            (
              player: any
            ) =>
              Number(
                player.playerId
              )
          )
          .filter(
            (
              playerId: number
            ) =>
              Number.isInteger(
                playerId
              ) &&
              playerId > 0
          )
      )
    );

  for (
    const playerId of
    playerIds
  ) {
    emitToPlayer(
      playerId,
      "dungeon:changed",
      payload
    );
  }
}

export function publishDungeonInstanceState(
  instanceId:
    number,
  snapshot:
    any,
) {
  if (
    !io ||
    !Number.isInteger(
      Number(
        instanceId
      )
    ) ||
    Number(
      instanceId
    ) <= 0
  ) {
    return;
  }

  io
    .to(
      instanceRoom(
        Number(
          instanceId
        )
      )
    )
    .emit(
      "dungeon:state",
      snapshot
    );
}
