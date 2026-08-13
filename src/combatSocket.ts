// src/combatSocket.ts

import type {
  Server as SocketIOServer,
  Socket,
} from "socket.io";

import {
  advanceCombatSession,
  buildCombatSnapshot,
  createCombatSession,
  ensureCombatSession,
  destroyCombatSession,
  type CombatSession,
} from "./services/combatSessionService";

const COMBAT_TICK_MS = 250;

const combatLoops =
  new Map<
    number,
    ReturnType<typeof setInterval>
  >();

const combatTickRunning =
  new Set<number>();

function combatRoom(
  playerId: number,
) {
  return `combat:player:${playerId}`;
}

function playerRoom(
  playerId: number,
) {
  return `player:${playerId}`;
}

function stopCombatLoop(
  playerId: number,
) {
  const timer =
    combatLoops.get(
      playerId
    );

  if (timer) {
    clearInterval(
      timer
    );

    combatLoops.delete(
      playerId
    );
  }

  combatTickRunning.delete(
    playerId
  );
}

async function stopLoopIfUnused(
  io: SocketIOServer,
  playerId: number,
) {
  const sockets =
    await io
      .in(
        combatRoom(
          playerId
        )
      )
      .allSockets();

  if (
    sockets.size === 0
  ) {
    stopCombatLoop(
      playerId
    );
  }
}

export function publishWorldCombatSnapshot(
  io: SocketIOServer,
  playerId: number,
  snapshot: any,
) {
  if (
    !Number.isInteger(
      playerId
    ) ||
    playerId <= 0
  ) {
    return;
  }

  io
    .to(
      playerRoom(
        playerId
      )
    )
    .emit(
      "combat:state",
      {
        inCombat:
          snapshot?.state ===
          "active",

        snapshot:
          snapshot ?? null,
      },
    );
}

function startCombatLoop(
  io: SocketIOServer,
  playerId: number,
) {
  if (
    combatLoops.has(
      playerId
    )
  ) {
    return;
  }

  const timer =
    setInterval(
      async () => {
        if (
          combatTickRunning.has(
            playerId
          )
        ) {
          return;
        }

        combatTickRunning.add(
          playerId
        );

        try {
          const session =
            ensureCombatSession(
              playerId
            );

          if (!session) {
            stopCombatLoop(
              playerId
            );

            io
              .to(
                playerRoom(
                  playerId
                )
              )
              .emit(
                "combat:state",
                {
                  inCombat:
                    false,

                  snapshot:
                    null,
                },
              );

            return;
          }

          await advanceCombatSession(
            session
          );

          const snapshot =
            buildCombatSnapshot(
              session
            );

          publishWorldCombatSnapshot(
            io,
            playerId,
            snapshot,
          );

          if (
            session.state !==
            "active"
          ) {
            stopCombatLoop(
              playerId
            );
          }
        } catch (error) {
          console.error(
            "World combat socket tick failed:",
            {
              playerId,
              error,
            },
          );
        } finally {
          combatTickRunning.delete(
            playerId
          );
        }
      },
      COMBAT_TICK_MS,
    );

  combatLoops.set(
    playerId,
    timer
  );
}

async function getOrCreateCombatSession(
  playerId: number,
): Promise<CombatSession | null> {
  let session =
    ensureCombatSession(
      playerId
    );

  /*
   * Finished combat sessions are retained in memory long
   * enough for the final victory/defeat snapshot to reach
   * the browser.
   *
   * They must NOT be reused when the player encounters a
   * new world creature.
   */
  if (
    session &&
    session.state !==
      "active"
  ) {
    destroyCombatSession(
      playerId
    );

    session =
      null;
  }

  if (!session) {
    session =
      await createCombatSession(
        playerId
      );
  }

  return session;
}

export function registerCombatSocket(
  io: SocketIOServer,
  socket: Socket,
) {
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

  socket.on(
    "combat:join",
    async (
      acknowledge?: Function,
    ) => {
      const ack =
        typeof acknowledge ===
        "function"
          ? acknowledge
          : () => {};

      try {
        const session =
          await getOrCreateCombatSession(
            playerId
          );

        if (!session) {
          ack({
            ok: true,
            inCombat: false,
            snapshot: null,
          });

          return;
        }

        await socket.join(
          combatRoom(
            playerId
          )
        );

        startCombatLoop(
          io,
          playerId
        );

        const snapshot =
          buildCombatSnapshot(
            session
          );

        ack({
          ok: true,
          inCombat:
            session.state ===
            "active",
          snapshot,
        });
      } catch (error: any) {
        console.error(
          "combat:join failed:",
          error
        );

        ack({
          ok: false,
          error:
            error?.message ||
            "Unable to join combat.",
        });
      }
    },
  );

  socket.on(
    "combat:leave",
    async () => {
      await socket.leave(
        combatRoom(
          playerId
        )
      );

      await stopLoopIfUnused(
        io,
        playerId
      );
    },
  );

  socket.on(
    "disconnect",
    () => {
      setTimeout(
        () => {
          void stopLoopIfUnused(
            io,
            playerId
          );
        },
        0,
      );
    },
  );
}