// src/socketServer.ts

import type { Server as HttpServer } from "http";
import {
  Server as SocketIOServer,
  type Socket,
} from "socket.io";

import { registerTradeSocket } from "./tradeSocket";
import { registerPlayerSocket } from "./playerSocket";
import { registerPartySocket } from "./partySocket";
import { registerHuntSocket } from "./huntSocket";
import { registerCombatSocket } from "./combatSocket";
import { registerDungeonSocket } from "./dungeonSocket";

import {
  onPlayerStatePatch,
  onPlayerLevelUp,
} from "./playerStateEvents";

let io: SocketIOServer | null = null;

export function playerRoom(playerId: number) {
  return `player:${playerId}`;
}

export function initializeSocketServer(
  server: HttpServer,
  sessionMiddleware: any,
) {
  if (io) {
    return io;
  }

  io = new SocketIOServer(server);

  // Allow Socket.IO's initial HTTP request to use the
  // same Express session as the rest of Guildforge.
  io.engine.use(sessionMiddleware);

  // Authenticate EVERY socket connection once here.
  io.use((socket, next) => {
    const playerId = Number(
      (socket.request as any).session?.playerId,
    );

    if (
      !Number.isInteger(playerId) ||
      playerId <= 0
    ) {
      return next(
        new Error("Not logged in."),
      );
    }

    socket.data.playerId = playerId;

    next();
  });


  /*
   * Forward service-level player state events to all
   * connected tabs belonging to that authenticated player.
   *
   * This keeps deep services independent of socketServer.ts
   * and avoids circular imports.
   */
  onPlayerStatePatch(
    (
      playerId,
      patch,
    ) => {
      emitPlayerStatePatch(
        playerId,
        patch,
      );
    },
  );


  /*
   * Level-up presentation event.
   * The client uses this for the existing banner + sound.
   */
  onPlayerLevelUp(
    (
      playerId,
      levelUp,
    ) => {
      emitToPlayer(
        playerId,
        "player:level-up",
        {
          levelUp,
        },
      );
    },
  );

  io.on("connection", socket => {
    const playerId = Number(
      socket.data.playerId,
    );

    // Every logged-in player automatically gets
    // their own private socket room.
    socket.join(playerRoom(playerId));

    console.log(
      "Socket connected:",
      socket.id,
      "player:",
      playerId,
    );

    // Register feature-specific socket handlers.
    registerPlayerSocket(io!, socket);
    registerTradeSocket(io!, socket);
    registerPartySocket(io!, socket);
    registerHuntSocket(io!, socket);
    registerCombatSocket(io!, socket);
    registerDungeonSocket(io!, socket);

    socket.on("disconnect", reason => {
      console.log(
        "Socket disconnected:",
        socket.id,
        "player:",
        playerId,
        "reason:",
        reason,
      );
    });
  });

  return io;
}

export function getSocketServer() {
  if (!io) {
    throw new Error(
      "Socket server has not been initialized.",
    );
  }

  return io;
}

export function emitToPlayer(
  playerId: number,
  event: string,
  payload?: any,
) {
  if (!io) return;

  if (
    !Number.isInteger(playerId) ||
    playerId <= 0
  ) {
    return;
  }

  io
    .to(playerRoom(playerId))
    .emit(event, payload);
}

export function emitPlayerStatePatch(
  playerId: number,
  patch: Record<string, any>,
) {
  if (!patch || typeof patch !== "object") {
    return;
  }

  emitToPlayer(
    playerId,
    "player:state",
    patch,
  );
}
