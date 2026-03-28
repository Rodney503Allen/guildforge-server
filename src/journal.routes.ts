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
// JOURNAL PAGE (HTML)
// =======================
router.get("/journal", requireLogin, async (req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Guildforge | Journal</title>
    <link rel="stylesheet" href="/statpanel.css" />
    <link rel="stylesheet" href="/journal.css" />
  <link rel="stylesheet" href="/journal.css" />

</head>

<body>
<div id="statpanel-root"></div>
<main class="gf-wrap">
  <section class="gf-panel">
    <header class="gf-panel__header">
      <div class="gf-title">
        <div class="gf-journalbar">
            <button id="btn-return" class="gf-btn gf-btn--return" type="button">← Return</button>
        </div>
        <div class="gf-title__kicker">Codex</div>
        <h1 class="gf-title__h1">The Journal</h1>
        <div class="gf-title__sub">A record of contracts, triumphs, and whispers.</div>
      </div>
    </header>

    <div class="gf-panel__body">
      <div id="journal-status" class="gf-status">Loading…</div>

      <!-- Open-book layout -->
      <div id="journal-book" class="gf-book" hidden>
        <!-- LEFT PAGE -->
        <aside class="gf-page gf-page--left">
          <div class="gf-page__head">
            <h2 class="gf-page__title">Quests</h2>
            <div class="gf-page__hint">Select an entry to read details.</div>
          </div>

          <div class="gf-filter">
            <button class="gf-chip is-active" type="button" data-filter="active">Active</button>
            <button class="gf-chip" type="button" data-filter="completed">Completed</button>
            <button class="gf-chip" type="button" data-filter="claimed">Claimed</button>
            <button class="gf-chip" type="button" data-filter="rumors">Rumors</button>
            <button class="gf-chip" type="button" data-filter="all">All</button>
          </div>

          <div id="quest-list" class="gf-list"></div>
        </aside>

        <!-- RIGHT PAGE -->
        <section class="gf-page gf-page--right">
          <div id="quest-detail" class="gf-detail">
            <div class="gf-detail__empty">
              <div class="gf-detail__sigil">☉</div>
              <div class="gf-detail__msg">Choose a quest from the left page.</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>

  <script src="/statpanel.js" defer></script>
  <script src="/journal.js" defer></script>
</main>
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
