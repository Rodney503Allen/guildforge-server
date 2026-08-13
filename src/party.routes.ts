//party.routes.ts
import express from "express";

import {
  getPartyByPlayer,
  createParty,
  invitePlayer,
  getPendingInvites,
  getPartyInvite,
  acceptInvite,
  declineInvite,
  leaveParty,
  kickPlayer,
  promoteLeader,
  disbandParty,
  searchPartyPlayers
} from "./partyService";

import {
  publishPartyInvite,
  publishPartyInviteDeclined,
  publishPartyChanged,
  publishPartyRemoved,
  publishPartyDisbanded,
} from "./partySocket";

const router = express.Router();

function requireLogin(
  req: any,
  res: any,
  next: any
) {
  if (
    !req.session ||
    !req.session.playerId
  ) {
    return res.status(401).json({
      ok: false,
      error: "Not logged in."
    });
  }

  next();
}

/* =========================================================
   CURRENT PARTY
========================================================= */

router.get(
  "/party",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const party =
        await getPartyByPlayer(
          playerId
        );

        return res.json({
        ok: true,
        currentPlayerId: playerId,
        party
        });

    } catch (err: any) {

      console.error(
        "GET /party failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Unable to load party."
      });
    }
  }
);

/* =========================================================
   CREATE
========================================================= */

router.post(
  "/party/create",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const party =
        await createParty(
          playerId
        );

      return res.json({
        ok: true,
        party
      });

    } catch (err: any) {

      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to create party."
      });
    }
  }
);

/* =========================================================
   INVITE
========================================================= */

router.post(
  "/party/invite",
  requireLogin,
  async (req: any, res) => {
    try {
      const inviterPlayerId =
        Number(req.session.playerId);

      const invitedPlayerId =
        Number(req.body.playerId);

      if (!invitedPlayerId) {
        return res.status(400).json({
          ok: false,
          error:
            "A player is required."
        });
      }

      const result =
        await invitePlayer(
          inviterPlayerId,
          invitedPlayerId
        );

      const party =
        await getPartyByPlayer(
          inviterPlayerId
        );

      const inviter =
        party?.members.find(
          member =>
            member.playerId ===
            inviterPlayerId
        );

      publishPartyInvite(
        invitedPlayerId,
        {
          inviteId: result.inviteId,
          partyId: result.partyId,
          inviterPlayerId,
          inviterName:
            inviter?.name || undefined,
        }
      );

      return res.json({
        ok: true,
        ...result
      });

    } catch (err: any) {

      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to invite player."
      });
    }
  }
);

/* =========================================================
   SEARCH
========================================================= */
router.get(
  "/party/player-search",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const search =
        String(req.query.q || "");

      const players =
        await searchPartyPlayers(
          playerId,
          search
        );

      return res.json({
        ok: true,
        players
      });

    } catch (err) {
      console.error(
        "GET /party/player-search failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error: "Unable to search players."
      });
    }
  }
);

/* =========================================================
   INVITES
========================================================= */

router.get(
  "/party/invites",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const invites =
        await getPendingInvites(
          playerId
        );

      return res.json({
        ok: true,
        invites
      });

    } catch (err) {

      console.error(
        "GET /party/invites failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Unable to load invitations."
      });
    }
  }
);

/* =========================================================
   ACCEPT
========================================================= */

router.post(
  "/party/invites/:id/accept",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const inviteId =
        Number(req.params.id);

      const party =
        await acceptInvite(
          inviteId,
          playerId
        );

      publishPartyChanged(
        party
      );

      return res.json({
        ok: true,
        party
      });

    } catch (err: any) {

      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to accept invitation."
      });
    }
  }
);

/* =========================================================
   DECLINE
========================================================= */

router.post(
  "/party/invites/:id/decline",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const inviteId =
        Number(req.params.id);

      const invite =
        await getPartyInvite(
          inviteId
        );

      await declineInvite(
        inviteId,
        playerId
      );

      if (invite) {
        publishPartyInviteDeclined(
          Number(
            invite.inviter_player_id
          ),
          {
            inviteId,
            invitedPlayerId:
              playerId,
          }
        );
      }

      return res.json({
        ok: true
      });

    } catch (err: any) {

      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to decline invitation."
      });
    }
  }
);

/* =========================================================
   LEAVE
========================================================= */

router.post(
  "/party/leave",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const partyBefore =
        await getPartyByPlayer(
          playerId
        );

      const result =
        await leaveParty(
          playerId
        );

      if (partyBefore) {
        publishPartyRemoved(
          playerId,
          {
            partyId:
              partyBefore.id,
            reason: "left",
          }
        );

        const updated =
          await getPartyByPlayer(
            partyBefore.members.find(
              member =>
                member.playerId !==
                playerId
            )?.playerId || 0
          );

        if (updated) {
          publishPartyChanged(
            updated
          );
        }
      }

      return res.json({
        ok: true,
        ...result
      });

    } catch (err: any) {

      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to leave party."
      });
    }
  }
);

/* =========================================================
   KICK
========================================================= */

router.post(
  "/party/kick",
  requireLogin,
  async (req: any, res) => {
    try {
      const leaderPlayerId =
        Number(req.session.playerId);

      const targetPlayerId =
        Number(req.body.playerId);

      const partyBefore =
        await getPartyByPlayer(
          leaderPlayerId
        );

      await kickPlayer(
        leaderPlayerId,
        targetPlayerId
      );

      if (partyBefore) {
        publishPartyRemoved(
          targetPlayerId,
          {
            partyId:
              partyBefore.id,
            reason: "kicked",
          }
        );

        const updated =
          await getPartyByPlayer(
            leaderPlayerId
          );

        if (updated) {
          publishPartyChanged(
            updated
          );
        }
      }

      return res.json({
        ok: true
      });

    } catch (err: any) {

      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to remove player."
      });
    }
  }
);

/* =========================================================
   PROMOTE
========================================================= */

router.post(
  "/party/promote",
  requireLogin,
  async (req: any, res) => {
    try {
      const leaderPlayerId =
        Number(req.session.playerId);

      const targetPlayerId =
        Number(req.body.playerId);

      await promoteLeader(
        leaderPlayerId,
        targetPlayerId
      );

      const updated =
        await getPartyByPlayer(
          leaderPlayerId
        );

      if (updated) {
        publishPartyChanged(
          updated
        );
      }

      return res.json({
        ok: true
      });

    } catch (err: any) {

      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to promote player."
      });
    }
  }
);

/* =========================================================
   DISBAND
========================================================= */

router.post(
  "/party/disband",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const party =
        await getPartyByPlayer(
          playerId
        );

      if (!party) {
        return res.status(400).json({
          ok: false,
          error:
            "You are not in a party."
        });
      }

      await disbandParty(
        party.id,
        playerId
      );

      publishPartyDisbanded(
        party
      );

      return res.json({
        ok: true
      });

    } catch (err: any) {

      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to disband party."
      });
    }
  }
);

export default router;