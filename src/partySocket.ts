// src/partySocket.ts

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

let io: SocketIOServer | null = null;

function partyRoom(partyId: number) {
  return `party:${partyId}`;
}

export function registerPartySocket(
  socketServer: SocketIOServer,
  socket: Socket,
) {
  io = socketServer;

  const playerId = Number(
    socket.data.playerId,
  );

  if (
    !Number.isInteger(playerId) ||
    playerId <= 0
  ) {
    return;
  }

  socket.on(
    "party:join-current",
    async (
      acknowledge?: Function,
    ) => {
      const ack =
        typeof acknowledge === "function"
          ? acknowledge
          : () => {};

      try {
        // Remove any old party rooms first.
        for (const room of socket.rooms) {
          if (
            room.startsWith("party:") &&
            room !== socket.id
          ) {
            await socket.leave(room);
          }
        }

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
          party,
        });
      } catch (err: any) {
        console.error(
          "party:join-current failed:",
          err,
        );

        ack({
          ok: false,
          error:
            err?.message ||
            "Unable to join party channel.",
        });
      }
    },
  );
}

export function publishPartyInvite(
  invitedPlayerId: number,
  payload: {
    inviteId: number;
    partyId: number;
    inviterPlayerId: number;
    inviterName?: string;
  },
) {
  emitToPlayer(
    invitedPlayerId,
    "party:invite",
    payload,
  );

  emitToPlayer(
    invitedPlayerId,
    "party:invites-changed",
    {
      inviteId: payload.inviteId,
      partyId: payload.partyId,
    },
  );
}

export function publishPartyInviteDeclined(
  inviterPlayerId: number,
  payload: {
    inviteId: number;
    invitedPlayerId: number;
  },
) {
  emitToPlayer(
    inviterPlayerId,
    "party:invite-declined",
    payload,
  );
}

export function publishPartyChanged(
  party: any,
) {
  if (!party) return;

  const partyId =
    Number(party.id);

  if (
    !Number.isInteger(partyId) ||
    partyId <= 0
  ) {
    return;
  }

  // Party room broadcast for party-page clients.
  io
    ?.to(partyRoom(partyId))
    .emit(
      "party:changed",
      {
        partyId,
      },
    );

  // Personal-room broadcast ensures every member gets
  // the update even if they are not currently on party.html.
  for (const member of party.members || []) {
    const playerId =
      Number(member.playerId);

    if (
      Number.isInteger(playerId) &&
      playerId > 0
    ) {
      emitToPlayer(
        playerId,
        "party:changed",
        {
          partyId,
        },
      );
    }
  }
}

export function publishPartyRemoved(
  playerId: number,
  payload: {
    partyId: number;
    reason:
      | "left"
      | "kicked"
      | "disbanded";
  },
) {
  emitToPlayer(
    playerId,
    "party:removed",
    payload,
  );
}

export function publishPartyDisbanded(
  party: any,
) {
  if (!party) return;

  const partyId =
    Number(party.id);

  for (const member of party.members || []) {
    const playerId =
      Number(member.playerId);

    if (
      Number.isInteger(playerId) &&
      playerId > 0
    ) {
      publishPartyRemoved(
        playerId,
        {
          partyId,
          reason: "disbanded",
        },
      );
    }
  }

  io
    ?.to(partyRoom(partyId))
    .emit(
      "party:disbanded",
      {
        partyId,
      },
    );
}