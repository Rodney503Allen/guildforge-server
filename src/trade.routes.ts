import express from "express";

import {
  searchTradePlayers,
  createTradeRequest,
  getIncomingTradeRequests,
  acceptTradeRequest,
  declineTradeRequest,
  getTradeForPlayer,
  getTradeInventory,
  updateTradeOffer,
  confirmTrade,
  acceptTrade,
  cancelTrade,
} from "./services/tradeService";
import {
  publishTradeChanged,
  publishTradeRequestsChanged,
  publishTradeCompleted,
  publishTradeCancelled,
} from "./tradeSocket";

const router = express.Router();

function requireLogin(
  req: any,
  res: any,
  next: any,
) {
  if (!req.session || !req.session.playerId) {
    return res.status(401).json({
      ok: false,
      error: "Not logged in.",
    });
  }

  next();
}

/* =========================================================
   PLAYER SEARCH
========================================================= */

router.get(
  "/trade/player-search",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId = Number(req.session.playerId);
      const search = String(req.query.q || "");

      const players = await searchTradePlayers(
        playerId,
        search,
      );

      return res.json({
        ok: true,
        players,
      });
    } catch (err) {
      console.error(
        "GET /trade/player-search failed:",
        err,
      );

      return res.status(500).json({
        ok: false,
        error: "Unable to search players.",
      });
    }
  },
);

/* =========================================================
   SEND TRADE REQUEST
========================================================= */

router.post(
  "/trade/request",
  requireLogin,
  async (req: any, res) => {
    try {
      const initiatorPlayerId = Number(
        req.session.playerId,
      );

      const recipientPlayerId = Number(
        req.body.playerId,
      );

      const trade = await createTradeRequest(
        initiatorPlayerId,
        recipientPlayerId,
      );

      publishTradeChanged(trade);
      publishTradeRequestsChanged(recipientPlayerId);

      return res.json({
        ok: true,
        trade,
      });
    } catch (err: any) {
      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to send trade request.",
      });
    }
  },
);

/* =========================================================
   INCOMING REQUESTS
========================================================= */

router.get(
  "/trade/requests",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId = Number(req.session.playerId);

      const requests = await getIncomingTradeRequests(
        playerId,
      );

      return res.json({
        ok: true,
        requests,
      });
    } catch (err) {
      console.error(
        "GET /trade/requests failed:",
        err,
      );

      return res.status(500).json({
        ok: false,
        error: "Unable to load trade requests.",
      });
    }
  },
);

/* =========================================================
   ACCEPT / DECLINE REQUEST
========================================================= */

router.post(
  "/trade/requests/:id/accept",
  requireLogin,
  async (req: any, res) => {
    try {
      const tradeId = Number(req.params.id);
      const playerId = Number(req.session.playerId);

      const trade = await acceptTradeRequest(
        tradeId,
        playerId,
      );

      publishTradeChanged(trade);
      publishTradeRequestsChanged(playerId);

      return res.json({
        ok: true,
        trade,
      });
    } catch (err: any) {
      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to accept trade request.",
      });
    }
  },
);

router.post(
  "/trade/requests/:id/decline",
  requireLogin,
  async (req: any, res) => {
    try {
      const tradeId = Number(req.params.id);
      const playerId = Number(req.session.playerId);

      const trade = await getTradeForPlayer(tradeId, playerId);

      await declineTradeRequest(
        tradeId,
        playerId,
      );

      trade.status = "declined";
      publishTradeChanged(trade);
      publishTradeRequestsChanged(playerId);

      return res.json({
        ok: true,
      });
    } catch (err: any) {
      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to decline trade request.",
      });
    }
  },
);

/* =========================================================
   TRADE WINDOW DATA
========================================================= */

router.get(
  "/trade/:id",
  requireLogin,
  async (req: any, res) => {
    try {
      const tradeId = Number(req.params.id);
      const playerId = Number(req.session.playerId);

      const trade = await getTradeForPlayer(
        tradeId,
        playerId,
      );

      return res.json({
        ok: true,
        trade,
      });
    } catch (err: any) {
      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to load trade.",
      });
    }
  },
);

router.get(
  "/trade/:id/inventory",
  requireLogin,
  async (req: any, res) => {
    try {
      const tradeId = Number(req.params.id);
      const playerId = Number(req.session.playerId);

      const items = await getTradeInventory(
        tradeId,
        playerId,
      );

      return res.json({
        ok: true,
        items,
      });
    } catch (err: any) {
      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to load trade inventory.",
      });
    }
  },
);

/* =========================================================
   EDIT OFFER

   Changing an offer automatically resets both confirmations
   and both accepts in the service.
========================================================= */

router.post(
  "/trade/:id/offer",
  requireLogin,
  async (req: any, res) => {
    try {
      const tradeId = Number(req.params.id);
      const playerId = Number(req.session.playerId);

      const items = Array.isArray(req.body.items)
        ? req.body.items
        : [];

      const gold = Number(req.body.gold ?? 0);

      const trade = await updateTradeOffer(
        tradeId,
        playerId,
        items,
        gold,
      );

      publishTradeChanged(trade);

      return res.json({
        ok: true,
        trade,
      });
    } catch (err: any) {
      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to update trade offer.",
      });
    }
  },
);

/* =========================================================
   CONFIRM OFFER

   Both players confirm before either can accept.
========================================================= */

router.post(
  "/trade/:id/confirm",
  requireLogin,
  async (req: any, res) => {
    try {
      const tradeId = Number(req.params.id);
      const playerId = Number(req.session.playerId);

      const trade = await confirmTrade(
        tradeId,
        playerId,
      );

      publishTradeChanged(trade);

      return res.json({
        ok: true,
        trade,
      });
    } catch (err: any) {
      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to confirm trade.",
      });
    }
  },
);

/* =========================================================
   ACCEPT TRADE

   When both confirmed players accept, the service performs
   the inventory and gold transfers atomically.
========================================================= */

router.post(
  "/trade/:id/accept",
  requireLogin,
  async (req: any, res) => {
    try {
      const tradeId = Number(req.params.id);
      const playerId = Number(req.session.playerId);

      const trade = await acceptTrade(
        tradeId,
        playerId,
      );

      if (trade.status === "completed") {
        publishTradeCompleted(trade);
      } else {
        publishTradeChanged(trade);
      }

      return res.json({
        ok: true,
        trade,
      });
    } catch (err: any) {
      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to accept trade.",
      });
    }
  },
);

/* =========================================================
   CANCEL
========================================================= */

router.post(
  "/trade/:id/cancel",
  requireLogin,
  async (req: any, res) => {
    try {
      const tradeId = Number(req.params.id);
      const playerId = Number(req.session.playerId);

      const trade = await getTradeForPlayer(tradeId, playerId);
      await cancelTrade(tradeId, playerId);

      trade.status = "cancelled";
      publishTradeCancelled(trade);
      publishTradeRequestsChanged(
        Number(trade.recipient.playerId),
      );

      return res.json({
        ok: true,
      });
    } catch (err: any) {
      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to cancel trade.",
      });
    }
  },
);

export default router;