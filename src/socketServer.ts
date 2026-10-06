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


/*
 * Lightweight world-presence broadcast.
 *
 * Movement remains authoritative in world.routes.ts. This event only tells
 * connected World clients that an authenticated player successfully moved.
 * Clients decide whether the player falls inside their current 11x11 buffer.
 */
export function isPlayerOnline(
  playerId: number
) {
  if (
    !io ||
    !Number.isInteger(playerId) ||
    playerId <= 0
  ) {
    return false;
  }

  const room =
    io.sockets.adapter.rooms.get(
      playerRoom(playerId)
    );

  return Boolean(
    room &&
    room.size > 0
  );
}

export function getOnlinePlayerIds() {
  if (!io) {
    return new Set<number>();
  }

  const online =
    new Set<number>();

  for (
    const [
      roomName,
      sockets
    ] of
    io.sockets.adapter.rooms
  ) {
    if (
      !roomName.startsWith(
        "player:"
      ) ||
      sockets.size <= 0
    ) {
      continue;
    }

    const playerId =
      Number(
        roomName.slice(
          "player:".length
        )
      );

    if (
      Number.isInteger(
        playerId
      ) &&
      playerId > 0
    ) {
      online.add(
        playerId
      );
    }
  }

  return online;
}

export function publishWorldPlayerMoved(payload: {
  playerId: number;
  name: string;
  level: number;
  x: number;
  y: number;
  partyMemberIds?: number[];
}) {
  if (!io) return;

  io.emit("world:player-moved", payload);
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

    /*
     * Presence is based on authenticated socket connectivity, not stale
     * database coordinates. A player with at least one connected tab is online.
     */
    io!.emit(
      "world:player-presence",
      {
        playerId,
        online: true,
      },
    );

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
      /*
       * Socket.IO has already removed this socket from its rooms when the
       * disconnect event fires. Only announce offline when no other tab/socket
       * for this authenticated player remains connected.
       */
      if (!isPlayerOnline(playerId)) {
        io!.emit(
          "world:player-presence",
          {
            playerId,
            online: false,
          },
        );
      }

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
