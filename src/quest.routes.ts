// routes/quest.routes.ts
import express from "express";
import { db } from "./db";
import { Router } from "express";
import {
  acceptQuest,
  getQuestLog,
  turnInAllAtOnce,
  claimQuestRewards,
  getJournalQuests,
  syncTurnInObjectivesFromInventory
} from "./services/questService";


const router = Router();

// Accept quest
router.post("/quests/:questId/accept", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ error: "Not logged in" });

    const questId = Number(req.params.questId);
    if (!Number.isFinite(questId)) return res.status(400).json({ error: "Invalid questId" });

    const out = await acceptQuest(pid, questId, "tavern");
    res.json(out);
  } catch (err: any) {
    // duplicate accept (unique constraint)
    if (String(err?.code) === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "Quest already accepted" });
    }
    console.error("🔥 /quests/:questId/accept ERROR:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// Quest log
router.get("/quests/log", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ error: "Not logged in" });

    await syncTurnInObjectivesFromInventory(pid);

    const rows = await getQuestLog(pid);
    res.json(rows);
  } catch (err) {
    console.error("🔥 /quests/log ERROR:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// Journal quests
router.get("/journal/quests", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ error: "Not logged in" });

    await syncTurnInObjectivesFromInventory(pid);

    const data = await getJournalQuests(pid);
    res.json(data);
  } catch (err) {
    console.error("🔥 GET /journal/quests ERROR:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// GET tracked quest
router.get("/quests/tracked", async (req, res) => {
  try {
    const pid = (req.session as any)?.playerId;
    if (!pid) return res.status(401).json({ error: "Not logged in" });

    await syncTurnInObjectivesFromInventory(pid);

    const [[p]]: any = await db.query(
      `SELECT tracked_player_quest_id AS trackedId FROM players WHERE id=? LIMIT 1`,
      [pid]
    );

    const trackedId = p?.trackedId ? Number(p.trackedId) : null;
    if (!trackedId) return res.json({ trackedId: null });

const [rows]: any = await db.query(
  `
  SELECT
    pq.id AS playerQuestId,
    pq.status,
    q.title,
    q.description,
    o.type AS objectiveType,
    o.required_count,
    o.region_name,
    o.target_item_id,
    o.target_creature_id,
    pqo.progress_count,
    pqo.is_complete,

    i.name AS item_name,
    i.icon AS item_icon,

    c.name AS creature_name,
    c.creatureimage AS creature_icon

  FROM player_quests pq
  JOIN quests q ON q.id = pq.quest_id
  JOIN player_quest_objectives pqo ON pqo.player_quest_id = pq.id
  JOIN quest_objectives o ON o.id = pqo.objective_id

  LEFT JOIN items i ON i.id = o.target_item_id
  LEFT JOIN creatures c ON c.id = o.target_creature_id   -- ✅ ADD THIS

  WHERE pq.player_id=?
    AND pq.id=?
    AND pq.status IN ('active','completed')
  ORDER BY o.id ASC
  `,
  [pid, trackedId]
);



    // If tracked quest no longer exists, clear it
    if (!rows || rows.length === 0) {
      await db.query(`UPDATE players SET tracked_player_quest_id=NULL WHERE id=?`, [pid]);
      return res.json({ trackedId: null });
    }

    res.json({ trackedId, rows });
  } catch (err) {
    console.error("🔥 GET /quests/tracked ERROR:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// GET quests that can be turned in at a location (tavern)
router.get("/quests/turnins/:locationId", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ error: "Not logged in" });

    const locationId = Number(req.params.locationId);
    if (!Number.isFinite(locationId)) return res.status(400).json({ error: "Invalid locationId" });

    const [rows]: any = await db.query(
      `
      SELECT
        pq.id AS playerQuestId,
        pq.status,
        q.id AS questId,
        q.title,
        q.description,

        o.type AS objectiveType,
        o.required_count,
        pqo.progress_count,
        pqo.is_complete,

        o.target_item_id,
        i.name AS item_name,
        i.icon AS item_icon,

        -- ✅ how many the player currently has (unequipped)
        COALESCE((
          SELECT SUM(inv.quantity)
          FROM inventory inv
          WHERE inv.player_id = pq.player_id
            AND inv.item_id = o.target_item_id
            AND inv.equipped = 0
        ), 0) AS have_qty

      FROM player_quests pq
      JOIN quests q ON q.id = pq.quest_id
      JOIN player_quest_objectives pqo ON pqo.player_quest_id = pq.id
      JOIN quest_objectives o ON o.id = pqo.objective_id
      LEFT JOIN items i ON i.id = o.target_item_id
      WHERE pq.player_id = ?
        AND pq.status IN ('active','accepted','in_progress','completed')

        AND q.turn_in_location_id = ?
      ORDER BY pq.id DESC, o.id ASC
      `,
      [pid, locationId]
    );

    res.json(rows || []);
  } catch (err) {
    console.error("🔥 GET /quests/turnins/:locationId ERROR:", err);
    res.status(500).json({ error: "server_error" });
  }
});


router.post("/quests/:playerQuestId/turn-in", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ error: "not_logged_in" });

    const playerQuestId = Number(req.params.playerQuestId);
    if (!Number.isFinite(playerQuestId)) return res.status(400).json({ error: "invalid_id" });

    // Try TURN_IN (items) first
    try {
      const out = await turnInAllAtOnce(pid, playerQuestId);
      return res.json(out);
    } catch (err: any) {
      const msg = String(err?.message || "");

      // ✅ If it’s not a TURN_IN quest OR it’s already completed, go to claim path
      if (msg !== "NO_TURNIN_OBJECTIVE" && msg !== "QUEST_NOT_ACTIVE") {
        throw err; // real error (not enough items, expired, etc)
      }
    }

    // ✅ Claim rewards path (KILL quests + completed quests)
    const out2 = await claimQuestRewards(pid, playerQuestId);
    return res.json(out2);

  } catch (err: any) {
    console.error("🔥 POST /quests/:playerQuestId/turn-in ERROR:", err);

    const msg = String(err?.message || "");
    if (msg === "NOT_ENOUGH_ITEMS") return res.status(400).json({ error: "not_enough" });
    if (msg === "PLAYER_QUEST_NOT_FOUND") return res.status(404).json({ error: "not_found" });
    if (msg === "QUEST_EXPIRED") return res.status(400).json({ error: "expired" });

    if (msg === "QUEST_NOT_COMPLETED") return res.status(400).json({ error: "not_completed" });
    if (msg === "ALREADY_CLAIMED") return res.status(400).json({ error: "already_claimed" });

    return res.status(500).json({ error: "server_error" });
  }
});




// POST set/clear tracked quest
router.post("/quests/track", async (req, res) => {
  try {
    const pid = (req.session as any)?.playerId;
    if (!pid) return res.status(401).json({ error: "Not logged in" });

    const raw = req.body?.playerQuestId;

    // clear
    if (raw === null || raw === undefined || raw === "") {
      await db.query(`UPDATE players SET tracked_player_quest_id=NULL WHERE id=?`, [pid]);
      return res.json({ success: true, trackedId: null });
    }

    const playerQuestId = Number(raw);
    if (!Number.isFinite(playerQuestId)) {
      return res.status(400).json({ error: "Invalid playerQuestId" });
    }

    const [[pq]]: any = await db.query(
      `SELECT id, status FROM player_quests WHERE id=? AND player_id=? LIMIT 1`,
      [playerQuestId, pid]
    );
    if (!pq) return res.status(404).json({ error: "Quest not found" });

    const status = String(pq.status || "").toLowerCase();
    if (!["active", "accepted", "in_progress", "completed"].includes(status)) {
      return res.status(400).json({ error: "Quest not trackable" });
    }

    await db.query(
      `UPDATE players SET tracked_player_quest_id=? WHERE id=?`,
      [playerQuestId, pid]
    );

    res.json({ success: true, trackedId: playerQuestId });
  } catch (err) {
    console.error("🔥 POST /quests/track ERROR:", err);
    res.status(500).json({ error: "server_error" });
  }
});

export default router;
