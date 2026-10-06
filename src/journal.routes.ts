// routes/journal.routes.ts
import express from "express";
import { db } from "./db";
import { getJournalQuests, syncTurnInObjectivesFromInventory } from "./services/questService";
import { acceptQuest, turnInAllAtOnce, claimQuestRewards } from "./services/questService";
/**
 * NOTE:
 * - This file serves the Journal page at GET /journal
 * - And serves the Journal data at GET /api/journal/quests
 * - It assumes you have session auth with req.session.playerId
 *
 * IMPORTANT:
 * - Your client-side journal.js MUST use fetch(..., { credentials: "include" })
 *   or your /api/journal/quests will return 401 even while logged in.
 */

const router = express.Router();

// =======================
// AUTH GUARD
// =======================
function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) return res.redirect("/login.html");
  next();
}
function requireLoginApi(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) {
    return res.status(401).json({ error: "not_logged_in" });
  }
  next();
}


// =======================
// JOURNAL MODAL + FALLBACK PAGE
// =======================
const journalModalMarkup = `
<div class="gf-reference-modal__header">
  <div>
    <div class="gf-reference-modal__kicker">Quest Log</div>
    <h2 class="gf-reference-modal__title">Adventurer's Journal</h2>
    <p class="gf-reference-modal__subtitle">Review active contracts, objectives, rumors, and completed adventures.</p>
  </div>
  <button class="gf-reference-modal__close" type="button" data-gf-reference-close aria-label="Close Quest Log">×</button>
</div>

<div class="gf-reference-layout gf-reference-layout--journal">
  <aside class="gf-reference-sidebar">
    <div id="journal-filters" class="gf-reference-filters">
      <button class="gf-reference-chip is-active" type="button" data-filter="active">Active</button>
      <button class="gf-reference-chip" type="button" data-filter="completed">Completed</button>
      <button class="gf-reference-chip" type="button" data-filter="claimed">Claimed</button>
      <button class="gf-reference-chip" type="button" data-filter="rumors">Rumors</button>
      <button class="gf-reference-chip" type="button" data-filter="all">All</button>
    </div>
    <div id="journal-status" class="gf-reference-status">Loading quest records…</div>
    <div id="quest-list" class="gf-reference-list"></div>
  </aside>

  <section class="gf-reference-detail">
    <div id="quest-detail" class="gf-reference-detail__inner">
      <div class="gf-reference-empty">
        <div class="gf-reference-empty__sigil">☉</div>
        <div>Choose a quest to inspect its details.</div>
      </div>
    </div>
  </section>
</div>`;

router.get("/ui/journal-modal", requireLogin, async (_req, res) => {
  res.type("html").send(journalModalMarkup);
});

router.get("/journal", requireLogin, async (_req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Guildforge | Quest Log</title>
  <link rel="stylesheet" href="/guildforge-reference-modal.css" />
  <link rel="stylesheet" href="/ui/toast.css" />
</head>
<body class="gf-reference-fallback">
  <script src="/ui/toast.js"></script>
  <script src="/guildforge-reference-modal.js"></script>
  <script>
    window.addEventListener("DOMContentLoaded", () => {
      window.GFReferenceModal?.open("journal");
    });
  </script>
</body>
</html>`);
});

// =======================
// TYPES (server-side only)
// =======================
type JournalResponse = {
  active: QuestLogRow[];
  completed: QuestLogRow[];
  claimed: QuestLogRow[];
  rumors: RumorRow[];
};

type QuestLogRow = {
  playerQuestId: number;
  status: string;

  questId: number;
  type: "quest" | "bounty";
  title: string;
  description: string | null;

  objectiveId: number;
  objectiveType: "KILL" | "TURN_IN" | "INTERACT" | "LOCATION" | "ENTER_AREA";
  required_count: number;
  target_item_id: number | null;
  target_creature_id: number | null;
  region_name: string | null;
  target_world_object_id: number | null;

  progress_count: number;
  is_complete: number;

  reward_gold: number;
  reward_xp: number;
};

type RumorRow = {
  questId: number;
  type: "quest" | "bounty";
  title: string;
  description: string | null;
  town_id: number | null;
  town_name: string | null;
  rumor_hint: string | null;
  min_level: number;
};

// =======================
// JOURNAL DATA API
// =======================
router.get("/api/journal/quests", requireLoginApi, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  try {
    await syncTurnInObjectivesFromInventory(pid); // ✅ keeps TURN_IN progress truthful
    const payload = await getJournalQuests(pid);
    res.json(payload);
    } catch (err: any) {
    console.error("journal api failed:", err);
    console.error("code:", err?.code);
    console.error("message:", err?.message);
    console.error("sql:", err?.sql);
    res.status(500).json({ error: "server_error" });
    }

});

// accept quest
router.post("/api/journal/quests/:questId/accept", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);
  const questId = Number(req.params.questId);
  const source = (req.body?.source === "bounty_board") ? "bounty_board" : "tavern";

  try {
    const out = await acceptQuest(pid, questId, source);
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || "ACCEPT_FAILED") });
  }
});

// turn-in (TURN_IN quests)
router.post("/api/journal/player-quests/:playerQuestId/turn-in", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);
  const playerQuestId = Number(req.params.playerQuestId);

  try {
    const out = await turnInAllAtOnce(pid, playerQuestId);
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || "TURNIN_FAILED") });
  }
});

// claim rewards
router.post("/api/journal/player-quests/:playerQuestId/claim", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);
  const playerQuestId = Number(req.params.playerQuestId);

  try {
    const out = await claimQuestRewards(pid, playerQuestId);
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || "CLAIM_FAILED") });
  }
});

export default router;
