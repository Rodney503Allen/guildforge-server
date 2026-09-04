// src/dungeon.routes.ts
import express from "express";
import {
  abandonDungeon,
  createDungeonInstance,
  getActiveDungeonForPlayer,
  listAvailableDungeons,
} from "./services/dungeonService";

import {
  advanceDungeonAfterRestForPlayer,
  getCurrentDungeonEncounterForPlayer,
} from "./services/dungeonProgressionService";

import {
  getDungeonLootForPlayer,
  submitDungeonLootChoice,
} from "./services/dungeonLootService";
import {
  claimDungeonCompletionChest,
  getLatestDungeonCompletionChestForPlayer,
} from "./services/dungeonCompletionChestService";
import {
  getDungeonWipeStateForPlayer,
  retryDungeonRoomForPlayer,
} from "./services/dungeonWipeService";
import {
  destroyDungeonCombatSession,
} from "./services/dungeonCombatSessionService";

import {
  cancelDungeonReadyCheck,
  getDungeonReadyCheck,
  setDungeonReadyState,
  startDungeonReadyCheck,
} from "./services/dungeonReadyCheckService";

import {
  publishDungeonReadyCheck,
} from "./dungeonSocket";

const router = express.Router();

function requireLogin(req: any, res: any, next: any) {
  const playerId = Number(req.session?.playerId);
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return res.status(401).json({ ok: false, error: "Not logged in." });
  }
  next();
}

router.use(requireLogin);

router.get("/", async (req: any, res) => {
  try {
    const dungeons = await listAvailableDungeons(Number(req.session.playerId));
    res.json({ ok: true, dungeons });
  } catch (err: any) {
    console.error("GET /api/dungeons failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "Unable to load dungeons." });
  }
});

router.get("/active", async (req: any, res) => {
  try {
    const dungeon = await getActiveDungeonForPlayer(Number(req.session.playerId));
    res.json({ ok: true, active: Boolean(dungeon), dungeon });
  } catch (err: any) {
    console.error("GET /api/dungeons/active failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "Unable to load active dungeon." });
  }
});


router.get("/active/encounter", async (req: any, res) => {
  try {
    const encounter =
      await getCurrentDungeonEncounterForPlayer(
        Number(req.session.playerId)
      );

    res.json({
      ok: true,
      encounter,
    });
  } catch (err: any) {
    console.error(
      "GET /api/dungeons/active/encounter failed:",
      err
    );

    res.status(500).json({
      ok: false,
      error:
        err?.message ||
        "Unable to load dungeon encounter.",
    });
  }
});

router.get("/active/loot", async (req: any, res) => {
  try {
    const loot =
      await getDungeonLootForPlayer(
        Number(req.session.playerId)
      );

    res.json({
      ok: true,
      loot,
    });
  } catch (err: any) {
    console.error(
      "GET /api/dungeons/active/loot failed:",
      err
    );

    res.status(500).json({
      ok: false,
      error:
        err?.message ||
        "Unable to load dungeon loot.",
    });
  }
});

router.post("/active/loot/:rollId/choice", async (req: any, res) => {
  try {
    const rollId =
      Number(
        req.params.rollId
      );

    if (
      !Number.isInteger(rollId) ||
      rollId <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Invalid dungeon loot roll.",
      });
    }

    const choice =
      String(
        req.body?.choice ??
        ""
      ).toLowerCase();

    if (
      ![
        "need",
        "greed",
        "pass",
      ].includes(choice)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Choice must be need, greed, or pass.",
      });
    }

    const result =
      await submitDungeonLootChoice(
        Number(
          req.session.playerId
        ),
        rollId,
        choice as
          | "need"
          | "greed"
          | "pass",
      );

    res.json(result);
  } catch (err: any) {
    console.error(
      "POST /api/dungeons/active/loot/:rollId/choice failed:",
      err
    );

    res.status(400).json({
      ok: false,
      error:
        err?.message ||
        "Unable to submit dungeon loot choice.",
    });
  }
});

router.get("/active/wipe", async (req: any, res) => {
  try {
    const wipe =
      await getDungeonWipeStateForPlayer(
        Number(
          req.session.playerId
        )
      );

    res.json({
      ok: true,
      wiped:
        Boolean(wipe),
      wipe,
    });
  } catch (err: any) {
    console.error(
      "GET /api/dungeons/active/wipe failed:",
      err
    );

    res.status(500).json({
      ok: false,
      error:
        err?.message ||
        "Unable to load dungeon wipe state.",
    });
  }
});

router.post("/active/wipe/retry", async (req: any, res) => {
  try {
    const result =
      await retryDungeonRoomForPlayer(
        Number(
          req.session.playerId
        )
      );

    res.json(result);
  } catch (err: any) {
    console.error(
      "POST /api/dungeons/active/wipe/retry failed:",
      err
    );

    res.status(400).json({
      ok: false,
      error:
        err?.message ||
        "Unable to retry the dungeon room.",
    });
  }
});

router.post("/active/rest/advance", async (req: any, res) => {
  try {
    const result =
      await advanceDungeonAfterRestForPlayer(
        Number(req.session.playerId)
      );

    res.json(result);
  } catch (err: any) {
    console.error(
      "POST /api/dungeons/active/rest/advance failed:",
      err
    );

    res.status(400).json({
      ok: false,
      error:
        err?.message ||
        "Unable to advance the dungeon.",
    });
  }
});


/* =========================================================
   DUNGEON READY CHECK
========================================================= */

router.post("/:dungeonId/ready-check/start", async (req: any, res) => {
  try {
    const dungeonId = Number(req.params.dungeonId);

    if (!Number.isInteger(dungeonId) || dungeonId <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid dungeon." });
    }

    const playerId = Number(req.session.playerId);

    const result = await startDungeonReadyCheck(playerId, dungeonId);

    publishDungeonReadyCheck(
      result.readyCheck,
      result.dungeon
    );

    return res.json({
      ok: true,
      playerId,
      ...result,
    });
  } catch (err: any) {
    console.error("POST /api/dungeons/:dungeonId/ready-check/start failed:", err);
    return res.status(400).json({
      ok: false,
      error: err?.message || "Unable to start Dungeon ready check.",
    });
  }
});

router.get("/ready-check", async (req: any, res) => {
  try {
    const playerId = Number(req.session.playerId);
    const readyCheck = await getDungeonReadyCheck(playerId);

    return res.json({
      ok: true,
      playerId,
      readyCheck,
    });
  } catch (err: any) {
    console.error("GET /api/dungeons/ready-check failed:", err);
    return res.status(400).json({
      ok: false,
      error: err?.message || "Unable to load Dungeon ready check.",
    });
  }
});

router.post("/ready-check/ready", async (req: any, res) => {
  try {
    if (typeof req.body?.ready !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "Ready must be true or false.",
      });
    }

    const playerId = Number(req.session.playerId);

    const result = await setDungeonReadyState(
      playerId,
      req.body.ready,
    );

    publishDungeonReadyCheck(
      result.readyCheck,
      result.dungeon
    );

    return res.json({
      ok: true,
      playerId,
      ...result,
    });
  } catch (err: any) {
    console.error("POST /api/dungeons/ready-check/ready failed:", err);
    return res.status(400).json({
      ok: false,
      error: err?.message || "Unable to update Dungeon ready state.",
    });
  }
});

router.post("/ready-check/cancel", async (req: any, res) => {
  try {
    const playerId = Number(req.session.playerId);
    const result = await cancelDungeonReadyCheck(playerId);

    publishDungeonReadyCheck(
      result.readyCheck,
      result.dungeon
    );

    return res.json({
      ok: true,
      playerId,
      ...result,
    });
  } catch (err: any) {
    console.error("POST /api/dungeons/ready-check/cancel failed:", err);
    return res.status(400).json({
      ok: false,
      error: err?.message || "Unable to cancel Dungeon ready check.",
    });
  }
});

router.post("/:dungeonId/enter", async (req: any, res) => {
  try {
    const dungeonId = Number(req.params.dungeonId);
    if (!Number.isInteger(dungeonId) || dungeonId <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid dungeon." });
    }

    const dungeon = await createDungeonInstance(
      Number(req.session.playerId),
      dungeonId,
    );

    res.json({ ok: true, dungeon });
  } catch (err: any) {
    console.error("POST /api/dungeons/:dungeonId/enter failed:", err);
    res.status(400).json({ ok: false, error: err?.message || "Unable to enter dungeon." });
  }
});

router.get("/completion-chest", async (req: any, res) => {
  try {
    const chest =
      await getLatestDungeonCompletionChestForPlayer(
        Number(
          req.session.playerId
        ),
      );

    res.json({
      ok: true,
      chest,
    });
  } catch (err: any) {
    console.error(
      "GET /api/dungeons/completion-chest failed:",
      err
    );

    res.status(500).json({
      ok: false,
      error:
        err?.message ||
        "Unable to load dungeon completion chest.",
    });
  }
});

router.post("/completion-chest/:chestId/claim", async (req: any, res) => {
  try {
    const chestId =
      Number(
        req.params.chestId
      );

    if (
      !Number.isInteger(
        chestId
      ) ||
      chestId <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Invalid dungeon completion chest.",
      });
    }

    const result =
      await claimDungeonCompletionChest(
        Number(
          req.session.playerId
        ),
        chestId,
      );

    res.json(result);
  } catch (err: any) {
    console.error(
      "POST /api/dungeons/completion-chest/:chestId/claim failed:",
      err
    );

    res.status(400).json({
      ok: false,
      error:
        err?.message ||
        "Unable to claim dungeon completion chest.",
    });
  }
});

router.post("/abandon", async (req: any, res) => {
  try {
    const result =
      await abandonDungeon(
        Number(
          req.session.playerId
        )
      );

    /*
     * The database run is gone, so remove any cached combat
     * session for the same dungeon instance as well.
     */
    destroyDungeonCombatSession(
      Number(
        result.instanceId
      )
    );

    res.json(result);
  } catch (err: any) {
    console.error(
      "POST /api/dungeons/abandon failed:",
      err
    );

    res.status(400).json({
      ok: false,
      error:
        err?.message ||
        "Unable to abandon dungeon.",
    });
  }
});

export default router;
