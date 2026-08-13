//hunt.routes.ts
import express from "express";

import {
  getAvailableHunts,
  getActivePartyHunt,
  acceptHunt,
  abandonHunt,
  investigateHuntClue
} from "./huntService";

import {
  startHuntReadyCheck,
  getHuntReadyCheck,
  setHuntReadyState,
  cancelHuntReadyCheck
} from "./services/huntReadyCheckService";

import {
  joinHuntEncounter
} from "./services/huntCombatService";

import {
  ensureHuntCombatSessionForPlayer,
  buildHuntCombatSnapshot,
  castHuntSpell
} from "./services/huntCombatSessionService";



import {
  publishHuntChanged,
  publishHuntReadyCheck,
  publishHuntCombatSnapshot
} from "./huntSocket";

import {
  getPartyByPlayer
} from "./partyService";


const router =
  express.Router();


function requireLogin(
  req: any,
  res: any,
  next: any
) {

  if (
    !req.session ||
    !req.session.playerId
  ) {

    return res
      .status(401)
      .json({
        ok: false,
        error:
          "Not logged in."
      });
  }

  next();
}


/* =========================================================
   AVAILABLE HUNTS
========================================================= */

router.get(
  "/hunts",
  requireLogin,
  async (
    req: any,
    res
  ) => {

    try {

      const hunts =
        await getAvailableHunts();

      return res.json({
        ok: true,
        hunts
      });

    } catch (err) {

      console.error(
        "GET /hunts failed:",
        err
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load Hunts."
        });

    }

  }
);

/* =========================================================
   START HUNT READY CHECK
========================================================= */

router.post(
  "/hunts/active/confront",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const result =
        await startHuntReadyCheck(
          playerId
        );

      publishHuntReadyCheck(
        result.readyCheck,
        result.encounter
      );

      return res.json({
        ok: true,
        ...result
      });

    } catch (err: any) {
      console.error(
        "POST /hunts/active/confront failed:",
        err
      );

      return res
        .status(400)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to start Hunt ready check."
        });
    }
  }
);

/* =========================================================
   GET CURRENT HUNT READY CHECK
========================================================= */

router.get(
  "/hunts/ready-check",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const readyCheck =
        await getHuntReadyCheck(
          playerId
        );

      return res.json({
        ok: true,
        readyCheck
      });

    } catch (err: any) {
      console.error(
        "GET /hunts/ready-check failed:",
        err
      );

      return res
        .status(400)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to load Hunt ready check."
        });
    }
  }
);


/* =========================================================
   SET READY STATE
========================================================= */

router.post(
  "/hunts/ready-check/ready",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      if (
        typeof req.body?.ready !==
        "boolean"
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Ready must be true or false."
          });
      }

      const result =
        await setHuntReadyState(
          playerId,
          req.body.ready
        );

      publishHuntReadyCheck(
        result.readyCheck,
        result.encounter
      );

      return res.json({
        ok: true,
        ...result
      });

    } catch (err: any) {
      console.error(
        "POST /hunts/ready-check/ready failed:",
        err
      );

      return res
        .status(400)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to update ready state."
        });
    }
  }
);


/* =========================================================
   CANCEL READY CHECK
========================================================= */

router.post(
  "/hunts/ready-check/cancel",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const result =
        await cancelHuntReadyCheck(
          playerId
        );

      publishHuntReadyCheck(
        result.readyCheck,
        result.encounter
      );

      return res.json({
        ok: true,
        ...result
      });

    } catch (err: any) {
      console.error(
        "POST /hunts/ready-check/cancel failed:",
        err
      );

      return res
        .status(400)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to cancel Hunt ready check."
        });
    }
  }
);

router.post(
  "/hunts/encounter/join",
  requireLogin,
  async (req: any, res) => {

    try {

      const playerId =
        Number(
          req.session.playerId
        );


      const result =
        await joinHuntEncounter(
          playerId
        );


      return res.json({
        ok: true,
        ...result
      });

    } catch (err: any) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to join Hunt encounter."
        });
    }
  }
);



router.get(
  "/hunts/encounter",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      const session =
        await ensureHuntCombatSessionForPlayer(
          playerId
        );

      if (!session) {
        return res.json({
          ok: true,
          encounter: null
        });
      }

      return res.json({
        ok: true,
        encounter:
          buildHuntCombatSnapshot(
            session
          )
      });

    } catch (err: any) {
      console.error(
        "GET /hunts/encounter failed:",
        err
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to load Hunt encounter."
        });
    }
  }
);

router.post(
  "/hunts/encounter/spells/cast",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      const spellId =
        Number(
          req.body?.spellId
        );

      const targetPlayerId =
        req.body?.targetPlayerId != null
          ? Number(
              req.body.targetPlayerId
            )
          : null;

      if (
        !Number.isInteger(spellId) ||
        spellId <= 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error: "Invalid spell."
          });
      }

      const session =
        await ensureHuntCombatSessionForPlayer(
          playerId
        );

      if (!session) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "No active Hunt encounter."
          });
      }

      const result =
        await castHuntSpell(
          session,
          playerId,
          spellId,
          targetPlayerId
        );

      if (result.snapshot) {
        publishHuntCombatSnapshot(
          result.snapshot
        );
      }

      if (!result.ok) {
        return res
          .status(400)
          .json(result);
      }

      return res.json(
        result
      );

    } catch (err: any) {
      console.error(
        "POST Hunt spell cast failed:",
        err
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to cast spell."
        });
    }
  }
);

/* =========================================================
   ACTIVE PARTY HUNT
========================================================= */

router.get(
  "/hunts/active",
  requireLogin,
  async (
    req: any,
    res
  ) => {

    try {

      const playerId =
        Number(
          req.session.playerId
        );

      const hunt =
        await getActivePartyHunt(
          playerId
        );

      return res.json({
        ok: true,
        hunt
      });

    } catch (err) {

      console.error(
        "GET /hunts/active failed:",
        err
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to load active Hunt."
        });

    }

  }
);


/* =========================================================
   ACCEPT HUNT
========================================================= */

router.post(
  "/hunts/:id/accept",
  requireLogin,
  async (
    req: any,
    res
  ) => {

    try {

      const playerId =
        Number(
          req.session.playerId
        );

      const huntId =
        Number(
          req.params.id
        );


      if (
        !Number.isInteger(huntId) ||
        huntId <= 0
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid Hunt."
          });

      }


      const hunt =
        await acceptHunt(
          playerId,
          huntId
        );

      publishHuntChanged(
        hunt.partyId,
        {
          type: "accepted",
          partyHuntId:
            hunt.partyHuntId
        }
      );

      return res.json({
        ok: true,
        hunt
      });

    } catch (err: any) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to accept Hunt."
        });

    }

  }
);


/* =========================================================
   ABANDON HUNT
========================================================= */

router.post(
  "/hunts/active/abandon",
  requireLogin,
  async (
    req: any,
    res
  ) => {

    try {

      const playerId =
        Number(
          req.session.playerId
        );


      const party =
        await getPartyByPlayer(
          playerId
        );

      const active =
        await getActivePartyHunt(
          playerId
        );

      await abandonHunt(
        playerId
      );

      if (party) {
        publishHuntChanged(
          party.id,
          {
            type: "abandoned",
            partyHuntId:
              active?.partyHuntId ??
              null
          }
        );
      }

      return res.json({
        ok: true
      });

    } catch (err: any) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to abandon Hunt."
        });

    }

  }
);

/* =========================================================
   INVESTIGATE CLUE
========================================================= */

router.post(
  "/hunts/clues/:id/investigate",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(req.session.playerId);

      const clueId =
        Number(req.params.id);

      if (
        !Number.isInteger(clueId) ||
        clueId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid Hunt clue."
        });
      }

      const result =
        await investigateHuntClue(
          playerId,
          clueId
        );

      return res.json({
        ok: true,
        ...result
      });

    } catch (err: any) {
      console.error(
        "POST /hunts/clues/:id/investigate failed:",
        err
      );

      return res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Unable to investigate Hunt clue."
      });
    }
  }
);


export default router;