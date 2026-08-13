// src/tradeSocket.ts

import type {
  Server as SocketIOServer,
  Socket,
} from "socket.io";

import {
  updateTradeOffer,
} from "./services/tradeService";

let io: SocketIOServer | null = null;

function playerRoom(
  playerId: number,
) {
  return `player:${playerId}`;
}

export function registerTradeSocket(
  socketServer: SocketIOServer,
  socket: Socket,
) {
  io = socketServer;

  const playerId = Number(
    socket.data.playerId,
  );

  console.log(
    "Trade socket registered:",
    socket.id,
    "player:",
    playerId,
  );

  socket.on(
    "trade:update-offer",
    async (
      payload: any,
      acknowledge?: Function,
    ) => {
      console.log(
        "Received trade:update-offer:",
        socket.id,
        payload,
      );

      const ack =
        typeof acknowledge === "function"
          ? acknowledge
          : () => {};

      try {
        const tradeId = Number(
          payload?.tradeId,
        );

        const items = Array.isArray(
          payload?.items,
        )
          ? payload.items
          : [];

        const gold =
          payload?.gold ?? 0;

        const trade =
          await updateTradeOffer(
            tradeId,
            playerId,
            items,
            gold,
          );

        const playerIds = [
          Number(
            trade.initiator?.playerId,
          ),
          Number(
            trade.recipient?.playerId,
          ),
        ].filter(
          id =>
            Number.isInteger(id) &&
            id > 0,
        );

        for (
          const id of
          new Set(playerIds)
        ) {
          io
            ?.to(playerRoom(id))
            .emit(
              "trade:changed",
              {
                tradeId:
                  Number(trade.id),

                status:
                  String(
                    trade.status,
                  ),

                originSocketId:
                  socket.id,
              },
            );
        }

        console.log(
          "Acknowledging trade update:",
          trade.id,
        );

        ack({
          ok: true,
          trade,
        });
      } catch (err: any) {
        console.error(
          "trade:update-offer failed:",
          err,
        );

        ack({
          ok: false,

          error:
            err?.message ||
            "Unable to update trade offer.",
        });
      }
    },
  );
}

export function publishTradeChanged(
  trade: any,
) {
  if (!io || !trade) return;

  const playerIds = [
    Number(
      trade.initiator?.playerId,
    ),
    Number(
      trade.recipient?.playerId,
    ),
  ].filter(
    playerId =>
      Number.isInteger(playerId) &&
      playerId > 0,
  );

  for (
    const playerId of
    new Set(playerIds)
  ) {
    io
      .to(playerRoom(playerId))
      .emit(
        "trade:changed",
        {
          tradeId:
            Number(trade.id),

          status:
            String(trade.status),
        },
      );
  }
}

export function publishTradeRequestsChanged(
  playerId: number,
) {
  if (
    !io ||
    !Number.isInteger(playerId) ||
    playerId <= 0
  ) {
    return;
  }

  io
    .to(playerRoom(playerId))
    .emit(
      "trade:requests-changed",
    );
}

export function publishTradeCompleted(
  trade: any,
) {
  if (!io || !trade) return;

  const playerIds = [
    Number(
      trade.initiator?.playerId,
    ),
    Number(
      trade.recipient?.playerId,
    ),
  ].filter(
    playerId =>
      Number.isInteger(playerId) &&
      playerId > 0,
  );

  for (
    const playerId of
    new Set(playerIds)
  ) {
    const room =
      playerRoom(playerId);

    io
      .to(room)
      .emit(
        "trade:completed",
        {
          tradeId:
            Number(trade.id),
        },
      );

    io
      .to(room)
      .emit(
        "trade:changed",
        {
          tradeId:
            Number(trade.id),

          status: "completed",
        },
      );
  }
}

export function publishTradeCancelled(
  trade: any,
) {
  if (!io || !trade) return;

  const playerIds = [
    Number(
      trade.initiator?.playerId,
    ),
    Number(
      trade.recipient?.playerId,
    ),
  ].filter(
    playerId =>
      Number.isInteger(playerId) &&
      playerId > 0,
  );

  for (
    const playerId of
    new Set(playerIds)
  ) {
    const room =
      playerRoom(playerId);

    io
      .to(room)
      .emit(
        "trade:cancelled",
        {
          tradeId:
            Number(trade.id),
        },
      );

    io
      .to(room)
      .emit(
        "trade:changed",
        {
          tradeId:
            Number(trade.id),

          status: "cancelled",
        },
      );
  }
}