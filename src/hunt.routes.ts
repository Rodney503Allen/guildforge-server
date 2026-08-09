//hunt.routes.ts
import express from "express";

import {
  getAvailableHunts,
  getActivePartyHunt,
  acceptHunt,
  abandonHunt,
  investigateHuntClue,
  createHuntEncounter
} from "./huntService";

import {
  joinHuntEncounter
} from "./services/huntCombatService";

import {
  ensureHuntCombatSessionForPlayer,
  advanceHuntCombatSession,
  buildHuntCombatSnapshot,
  castHuntSpell
} from "./services/huntCombatSessionService";


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
   CONFRONT HUNT TARGET
========================================================= */

router.post(
  "/hunts/active/confront",
  requireLogin,
  async (req: any, res) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      const encounter =
        await createHuntEncounter(
          playerId
        );

      return res.json({
        ok: true,
        encounter
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
            "Unable to confront Hunt target."
        });
    }
  }
);


router.post(
  "/hunts/encounter/start",
  requireLogin,
  async (req: any, res) => {

    try {

      const playerId =
        Number(
          req.session.playerId
        );


      const encounter =
        await createHuntEncounter(
          playerId
        );


      return res.json({
        ok: true,
        encounter
      });

    } catch (err: any) {

      console.error(
        "POST /hunts/encounter/start failed:",
        err
      );


      return res
        .status(400)
        .json({
          ok: false,
          error:
            err.message ||
            "Unable to begin Hunt encounter."
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

      await advanceHuntCombatSession(
        session
      );

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


      await abandonHunt(
        playerId
      );


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