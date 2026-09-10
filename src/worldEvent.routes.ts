// routes/worldEvent.routes.ts
import express from "express";
import { db } from "./db";

import {
  getActiveEventForRegion,
  getActiveWorldEvent,
  startWorldEvent,
  expireWorldEvent
} from "./services/worldEventService";

import {
  getPlayerWorldEventRewards,
  claimWorldEventReward,
  WorldEventRewardSource
} from "./services/worldEventRewardService";

import {
  getPlayerWorldEventContribution
} from "./services/worldEventProgressService";

import {
  resolveWorldEventOutcome
} from "./services/worldEventOutcomeService";

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
   CURRENT ACTIVE EVENT FOR REGION
========================================================= */

router.get(
  "/api/world-events/region/:regionId",
  requireLogin,
  async (req: any, res) => {
    try {
      const regionId =
        Number(req.params.regionId);

      if (
        !Number.isInteger(regionId) ||
        regionId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid region."
        });
      }

      const event =
        await getActiveEventForRegion(
          regionId
        );

      if (!event) {
        return res.json({
          ok: true,
          event: null,
          playerEvent: null
        });
      }

      const playerId =
        Number(req.session.playerId);

      const playerEvent =
        await getPlayerWorldEventContribution(
          event.id,
          playerId
        );

      return res.json({
        ok: true,
        event,
        playerEvent
      });

    } catch (err: any) {

      console.error(
        "GET /api/world-events/region/:regionId failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Unable to load active world event."
      });
    }
  }
);

/* =========================================================
   ACTIVE EVENT BY ID
========================================================= */

router.get(
  "/api/world-events/active/:activeEventId",
  requireLogin,
  async (req: any, res) => {
    try {
      const activeEventId =
        Number(
          req.params.activeEventId
        );

      if (
        !Number.isInteger(
          activeEventId
        ) ||
        activeEventId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid active world event."
        });
      }

      const event =
        await getActiveWorldEvent(
          activeEventId
        );

      if (!event) {
        return res.status(404).json({
          ok: false,
          error:
            "Active world event not found."
        });
      }

      return res.json({
        ok: true,
        event
      });

    } catch (err: any) {

      console.error(
        "GET /api/world-events/active/:activeEventId failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Unable to load world event."
      });
    }
  }
);

/* =========================================================
   DEV / TEST — START EVENT
========================================================= */

/*
 * TEMPORARY DEVELOPMENT ROUTE.
 *
 * Starts a world event definition manually so we can verify the
 * definition -> active event -> active objectives pipeline before
 * adding the scheduler.
 *
 * Remove or protect this route before public Alpha deployment.
 */
router.post(
  "/api/world-events/test/start/:eventId",
  requireLogin,
  async (req: any, res) => {
    try {
      const eventId =
        Number(req.params.eventId);

      if (
        !Number.isInteger(eventId) ||
        eventId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid world event."
        });
      }

      const event =
        await startWorldEvent(
          eventId
        );

      return res.json({
        ok: true,
        event
      });

    } catch (err: any) {

      console.error(
        "POST /api/world-events/test/start/:eventId failed:",
        err
      );

      return res.status(400).json({
        ok: false,
        error:
          err?.message ||
          "Unable to start world event."
      });
    }
  }
);

/* =========================================================
   DEV / TEST — EXPIRE EVENT
========================================================= */

/*
 * Useful while testing so we do not have to wait for the event timer.
 */
router.post(
  "/api/world-events/test/expire/:activeEventId",
  requireLogin,
  async (req: any, res) => {
    try {
      const activeEventId =
        Number(
          req.params.activeEventId
        );

      if (
        !Number.isInteger(
          activeEventId
        ) ||
        activeEventId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid active world event."
        });
      }

      await expireWorldEvent(
        activeEventId
      );

      return res.json({
        ok: true
      });

    } catch (err: any) {

      console.error(
        "POST /api/world-events/test/expire/:activeEventId failed:",
        err
      );

      return res.status(400).json({
        ok: false,
        error:
          err?.message ||
          "Unable to expire world event."
      });
    }
  }
);


/* =========================================================
   PLAYER EVENT REWARDS
========================================================= */

router.get(
  "/api/world-events/active/:activeEventId/rewards",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId = Number(req.session.playerId);
      const activeEventId = Number(req.params.activeEventId);

      if (!Number.isInteger(activeEventId) || activeEventId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Invalid active world event."
        });
      }

      const rewards = await getPlayerWorldEventRewards(
        activeEventId,
        playerId
      );

      return res.json({
        ok: true,
        rewards
      });
    } catch (err: any) {
      console.error(
        "GET /api/world-events/active/:activeEventId/rewards failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error: err?.message || "Unable to load world event rewards."
      });
    }
  }
);

router.post(
  "/api/world-events/active/:activeEventId/rewards/:outcomeId/:rewardSource/claim",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId = Number(req.session.playerId);
      const activeEventId = Number(req.params.activeEventId);
      const outcomeId = Number(req.params.outcomeId);
      const rewardSource =
        String(req.params.rewardSource || "").toUpperCase();

      if (!Number.isInteger(activeEventId) || activeEventId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Invalid active world event."
        });
      }

      if (!Number.isInteger(outcomeId) || outcomeId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Invalid world event outcome."
        });
      }

      if (
        rewardSource !== "PERSONAL" &&
        rewardSource !== "OUTCOME"
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid world event reward source."
        });
      }

      const result = await claimWorldEventReward(
        activeEventId,
        playerId,
        outcomeId,
        rewardSource as WorldEventRewardSource
      );

      return res.json({
        ok: true,
        reward: result
      });
    } catch (err: any) {
      console.error(
        "POST /api/world-events/active/:activeEventId/rewards/:outcomeId/:rewardSource/claim failed:",
        err
      );

      const message =
        err?.message || "Unable to claim world event reward.";

      const status =
        message.includes("not eligible") ? 403 :
        message.includes("already been claimed") ? 409 :
        400;

      return res.status(status).json({
        ok: false,
        error: message
      });
    }
  }
);


/* =========================================================
   PLAYER — PENDING WORLD EVENT REWARDS

   Lets the world UI rediscover unclaimed rewards even after the
   active regional event has completed and is no longer returned by
   /api/world-events/region/:regionId.
========================================================= */

router.get(
  "/api/world-events/rewards/pending",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const requestedRegionId =
        req.query.regionId == null
          ? null
          : Number(req.query.regionId);

      if (
        requestedRegionId != null &&
        (
          !Number.isInteger(requestedRegionId) ||
          requestedRegionId <= 0
        )
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid region."
        });
      }

      const params: any[] = [
        playerId
      ];

      let regionFilter = "";

      if (requestedRegionId != null) {
        regionFilter =
          "AND awe.region_id = ?";

        params.push(
          requestedRegionId
        );
      }

      const [rows]: any =
        await db.query(
          `
            SELECT DISTINCT
              pwer.active_event_id,
              awe.region_id,
              awe.event_id,
              awe.winning_outcome_id,
              we.name AS event_name

            FROM player_world_event_rewards pwer

            JOIN active_world_events awe
              ON awe.id =
                 pwer.active_event_id

            JOIN world_events we
              ON we.id =
                 awe.event_id

            WHERE pwer.player_id = ?
              AND pwer.claimed = 0
              ${regionFilter}

            ORDER BY
              pwer.active_event_id DESC

            LIMIT 10
          `,
          params
        );

      const events = [];

      for (const row of rows || []) {
        const activeEventId =
          Number(
            row.active_event_id
          );

        const rewards =
          await getPlayerWorldEventRewards(
            activeEventId,
            playerId
          );

        const pendingRewards =
          (rewards || []).filter(
            (reward: any) =>
              !reward.claimed
          );

        if (!pendingRewards.length) {
          continue;
        }

        events.push({
          activeEventId,
          eventId:
            Number(row.event_id),
          eventName:
            String(
              row.event_name ||
              "World Event"
            ),
          regionId:
            Number(row.region_id),
          winningOutcomeId:
            row.winning_outcome_id == null
              ? null
              : Number(
                  row.winning_outcome_id
                ),
          rewards:
            pendingRewards
        });
      }

      return res.json({
        ok: true,
        events
      });

    } catch (err: any) {
      console.error(
        "GET /api/world-events/rewards/pending failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          err?.message ||
          "Unable to load pending world event rewards."
      });
    }
  }
);

/* =========================================================
   DEV / TEST — RESOLVE EVENT
========================================================= */

router.post(
  "/api/world-events/test/resolve/:activeEventId",
  requireLogin,
  async (req: any, res) => {
    try {
      const activeEventId =
        Number(
          req.params.activeEventId
        );

      if (
        !Number.isInteger(activeEventId) ||
        activeEventId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid active world event."
        });
      }

      /*
       * Fast-forward the timer but still use the real
       * timer-driven resolution path.
       */
      await db.query(
        `
          UPDATE active_world_events
          SET ends_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)
          WHERE id = ?
            AND status = 'ACTIVE'
        `,
        [activeEventId]
      );

      const resolution =
        await resolveWorldEventOutcome(
          activeEventId
        );

      return res.json({
        ok: true,
        resolution
      });

    } catch (err: any) {
      console.error(
        "POST /api/world-events/test/resolve/:activeEventId failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          err?.message ||
          "Unable to resolve world event."
      });
    }
  }
);

export default router;
