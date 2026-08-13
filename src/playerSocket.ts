// src/playerSocket.ts

import type {
  Server as SocketIOServer,
  Socket,
} from "socket.io";

import { db } from "./db";

const TAVERN_PRESENCE_ROOM = "presence:tavern";

// playerId -> connected socket IDs
const playerConnections = new Map<number, Set<string>>();

type OnlinePlayer = {
  id: number;
  name: string;
  level: number;
  pclass: string;
  location: string;
};

export function registerPlayerSocket(
  io: SocketIOServer,
  socket: Socket,
) {
  const playerId = Number(socket.data.playerId);

  if (!Number.isInteger(playerId) || playerId <= 0) {
    return;
  }

  let connections = playerConnections.get(playerId);
  const wasOffline = !connections || connections.size === 0;

  if (!connections) {
    connections = new Set<string>();
    playerConnections.set(playerId, connections);
  }

  connections.add(socket.id);

  console.log(
    "Player socket registered:",
    playerId,
    "connections:",
    connections.size,
  );

  if (wasOffline) {
    void broadcastTavernPresence(io);
  }

  socket.on(
    "player:ready",
    (acknowledge?: Function) => {
      const ack =
        typeof acknowledge === "function"
          ? acknowledge
          : () => {};

      ack({
        ok: true,
        playerId,
      });
    },
  );

  socket.on(
    "presence:join-tavern",
    async (acknowledge?: Function) => {
      const ack =
        typeof acknowledge === "function"
          ? acknowledge
          : () => {};

      try {
        await socket.join(TAVERN_PRESENCE_ROOM);

        ack({
          ok: true,
          ...(await getOnlineSnapshot()),
        });
      } catch (err: any) {
        console.error("presence:join-tavern failed:", err);

        ack({
          ok: false,
          error:
            err?.message ||
            "Unable to load online players.",
        });
      }
    },
  );

  socket.on("presence:leave-tavern", () => {
    void socket.leave(TAVERN_PRESENCE_ROOM);
  });

  socket.on(
    "presence:get-online",
    async (acknowledge?: Function) => {
      const ack =
        typeof acknowledge === "function"
          ? acknowledge
          : () => {};

      try {
        ack({
          ok: true,
          ...(await getOnlineSnapshot()),
        });
      } catch (err: any) {
        console.error("presence:get-online failed:", err);

        ack({
          ok: false,
          error:
            err?.message ||
            "Unable to load online players.",
        });
      }
    },
  );

  socket.on("disconnect", () => {
    const connections = playerConnections.get(playerId);
    if (!connections) return;

    connections.delete(socket.id);

    console.log(
      "Player socket removed:",
      playerId,
      "remaining connections:",
      connections.size,
    );

    // Still online in another Guildforge tab.
    if (connections.size > 0) {
      return;
    }

    playerConnections.delete(playerId);
    void broadcastTavernPresence(io);
  });

}

export function isPlayerOnline(playerId: number) {
  const connections = playerConnections.get(playerId);

  return Boolean(
    connections &&
    connections.size > 0,
  );
}

export function getOnlinePlayerIds() {
  return Array.from(playerConnections.keys());
}

export function getOnlinePlayerCount() {
  return playerConnections.size;
}

async function getOnlinePlayers(): Promise<OnlinePlayer[]> {
  const playerIds = getOnlinePlayerIds();

  if (playerIds.length === 0) {
    return [];
  }

  const placeholders =
    playerIds.map(() => "?").join(",");

  const [rows]: any = await db.query(
    `
      SELECT
        id,
        name,
        level,
        pclass,
        location
      FROM players
      WHERE id IN (${placeholders})
    `,
    playerIds,
  );

  const players: OnlinePlayer[] = (rows || []).map(
    (row: any) => ({
      id: Number(row.id),
      name: String(row.name || "Unknown"),
      level: Number(row.level || 1),
      pclass: String(row.pclass || ""),
      location: String(row.location || "Unknown"),
    }),
  );

  players.sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return players;
}

async function getOnlineSnapshot() {
  const players = await getOnlinePlayers();

  return {
    count: players.length,
    players,
  };
}

async function broadcastTavernPresence(
  io: SocketIOServer,
) {
  try {
    const snapshot = await getOnlineSnapshot();

    io
      .to(TAVERN_PRESENCE_ROOM)
      .emit("presence:changed", snapshot);
  } catch (err) {
    console.error(
      "Unable to broadcast Tavern presence:",
      err,
    );
  }
}