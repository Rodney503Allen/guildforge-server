// rest.routes.ts
import express from "express";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";

const router = express.Router();

const CAMPFIRE_DURATION = 5 * 60 * 1000;
const REST_TICK_MS = 10 * 1000;

const BASE_REST_PERCENT = 0.05;
const CAMPFIRE_REST_PERCENT = 0.10;

function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) return res.redirect("/login.html");
  next();
}

async function hasActiveCreature(playerId: number) {
  const [[row]]: any = await db.query(
    `SELECT id FROM player_creatures WHERE player_id=? LIMIT 1`,
    [playerId]
  );

  return !!row;
}

async function ensureRestSession(playerId: number) {
  const now = Date.now();

  await db.query(
    `
    INSERT IGNORE INTO player_rest
      (player_id, started_at, campfire_expires_at, last_tick_at, state)
    VALUES (?, ?, 0, ?, 'resting')
    `,
    [playerId, now, now]
  );
}

async function applyRestTicks(playerId: number) {
  const [[camp]]: any = await db.query(
    `SELECT * FROM player_rest WHERE player_id=? LIMIT 1`,
    [playerId]
  );

  if (!camp) return null;

  const now = Date.now();

  const stats = await getFinalPlayerStats(playerId);
  if (!stats) return camp;

  const hasCampfire = Number(camp.campfire_expires_at || 0) > now;
  const restorePercent = hasCampfire ? CAMPFIRE_REST_PERCENT : BASE_REST_PERCENT;

  const ticks = Math.floor((now - Number(camp.last_tick_at)) / REST_TICK_MS);
  if (ticks <= 0) return camp;

  const hpGain = Math.max(1, Math.floor(stats.maxhp * restorePercent)) * ticks;
  const spGain = Math.max(1, Math.floor(stats.maxspoints * restorePercent)) * ticks;

  await db.query(
    `
    UPDATE players
    SET hpoints = LEAST(hpoints + ?, ?),
        spoints = LEAST(spoints + ?, ?)
    WHERE id=?
      AND hpoints > 0
    `,
    [hpGain, stats.maxhp, spGain, stats.maxspoints, playerId]
  );

  const newLastTick = Number(camp.last_tick_at) + ticks * REST_TICK_MS;

  await db.query(
    `UPDATE player_rest SET last_tick_at=? WHERE player_id=?`,
    [newLastTick, playerId]
  );

  return {
    ...camp,
    last_tick_at: newLastTick
  };
}

async function renderRestContent(pid: number, isModal = false) {
  const inCombat = await hasActiveCreature(pid);

  if (!inCombat) {
    await ensureRestSession(pid);
    await applyRestTicks(pid);
  }

  const [[player]]: any = await db.query(
    `
    SELECT id, name, level, hpoints, spoints, gold
    FROM players
    WHERE id=?
    LIMIT 1
    `,
    [pid]
  );

  if (!player) return null;

  const [[camp]]: any = await db.query(
    `SELECT * FROM player_rest WHERE player_id=? LIMIT 1`,
    [pid]
  );

  const now = Date.now();
  const hasCampfire = camp && Number(camp.campfire_expires_at || 0) > now;
  const campfireSeconds = hasCampfire
    ? Math.max(0, Math.ceil((Number(camp.campfire_expires_at) - now) / 1000))
    : 0;

  const isDead = Number(player.hpoints) <= 0;

  return `
    <section class="rest-panel" data-rest-active="true">
      <div class="rest-hero">
        <div>
          <div class="rest-kicker">Wilderness Camp</div>
          <h1>Rest & Camp</h1>
          <p>Light a fire, recover your strength, and prepare for the road ahead.</p>
        </div>

        ${
          isModal
            ? `<button class="rest-btn ghost" onclick="closeRestModal()">Close</button>`
            : `<a class="rest-btn ghost" href="/world">Return to World</a>`
        }
      </div>

      <div class="rest-grid">
        <section class="rest-scene">
          <div class="scene-overlay">
            <div class="camp-status ${hasCampfire ? "good" : "bad"}">
              ${hasCampfire ? "🔥 Campfire Active" : "🔥 No Campfire"}
            </div>
            <p>
              ${
                hasCampfire
                  ? `Fire expires in <span data-campfire-seconds="${campfireSeconds}">${campfireSeconds}</span>. Recovery increased to 10% every 10 seconds.`
                  : `Base recovery active: 5% Health and Spirit every 10 seconds.`
              }
            </p>
          </div>
        </section>

        <section class="rest-actions">
          <div class="rest-card">
            <div>
              <h2>Campfire</h2>
              <p>Double your recovery rate while resting in the wilderness.</p>
              ${
                inCombat
                  ? `<span class="warn">You cannot start a fire in combat.</span>`
                  : isDead
                    ? `<span class="warn">You cannot start a fire while dead.</span>`
                    : hasCampfire
                      ? `<span class="good-text">Campfire recovery active.</span>`
                      : `<span class="warn">No campfire active.</span>`
              }
            </div>

            <button
                class="rest-btn primary"
                onclick="startCampfire(event)"
                ${inCombat || isDead ? "disabled" : ""}
                >
                ${hasCampfire ? "Refresh Fire" : "Start Fire"}
            </button>
          </div>

          <div class="rest-card">
            <div>
              <h2>Resting</h2>
              <p>
                Resting begins automatically when you open this page.
                Without a campfire, you recover 5% Health and Spirit every 10 seconds.
                With a campfire, you recover 10% every 10 seconds.
              </p>
              ${
                isDead
                  ? `<span class="warn">You cannot rest while dead.</span>`
                  : inCombat
                    ? `<span class="warn">You cannot rest in combat.</span>`
                    : hasCampfire
                      ? `<span class="good-text">Enhanced rest active: 10% every 10 seconds.</span>`
                      : `<span class="good-text">Base rest active: 5% every 10 seconds.</span>`
              }
            </div>
          </div>

          <div class="activity-card locked">
            <div class="activity-icon">🧪</div>
            <h3>Use Items</h3>
            <p>Use potions and future camp consumables.</p>
            <span>Coming Soon</span>
          </div>

            <div class="activity-card locked">
              <div class="activity-icon">🍖</div>
              <h3>Cook</h3>
              <p>Prepare meals at your campfire.</p>
              <span>Coming Soon</span>
            </div>

            <div class="activity-card locked">
              <div class="activity-icon">🛠️</div>
              <h3>Craft</h3>
              <p>Create basic survival tools and supplies.</p>
              <span>Coming Soon</span>
            </div>

            <div class="activity-card locked">
              <div class="activity-icon">🛡️</div>
              <h3>Prepare</h3>
              <p>Apply future buffs before adventuring.</p>
              <span>Coming Soon</span>
            </div>
          </div>
        </section>
      </div>
    </section>
  `;
}

router.get("/", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);
  const content = await renderRestContent(pid, false);

  if (!content) return res.redirect("/login.html");

  res.send(`
<!doctype html>
<html>
<head>
  <title>Guildforge | Rest</title>
  <link rel="stylesheet" href="/statpanel.css">
  <link rel="stylesheet" href="/rest.css">
  <script defer src="/statpanel.js"></script>
  <script defer src="/rest.js"></script>
</head>
<body>
  <div id="statpanel-root"></div>

  <main class="rest-wrap">
    ${content}
  </main>
</body>
</html>
  `);
});

router.get("/modal", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);
  const content = await renderRestContent(pid, true);

  if (!content) return res.status(401).send("");

  res.send(`
    <div id="restModal" class="rest-modal-shell">
      <div class="rest-modal-backdrop" onclick="closeRestModal()"></div>
      <div class="rest-modal-content">
        ${content}
      </div>
    </div>
  `);
});

router.get("/tick", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  if (!(await hasActiveCreature(pid))) {
    await ensureRestSession(pid);
    await applyRestTicks(pid);
  }

  const [[player]]: any = await db.query(
    `SELECT hpoints, spoints FROM players WHERE id=? LIMIT 1`,
    [pid]
  );

  const stats = await getFinalPlayerStats(pid);

  res.json({
    success: true,
    hpoints: Number(player?.hpoints || 0),
    spoints: Number(player?.spoints || 0),
    maxhp: Number(stats?.maxhp || 0),
    maxspoints: Number(stats?.maxspoints || 0)
  });
});

router.post("/start-fire", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  if (await hasActiveCreature(pid)) return res.redirect("/rest");

  const [[player]]: any = await db.query(
    `SELECT hpoints FROM players WHERE id=? LIMIT 1`,
    [pid]
  );

  if (!player || Number(player.hpoints) <= 0) return res.redirect("/rest");

  await ensureRestSession(pid);
  await applyRestTicks(pid);

  const now = Date.now();
  const expires = now + CAMPFIRE_DURATION;

  await db.query(
    `
    UPDATE player_rest
    SET campfire_expires_at=?,
        state='resting'
    WHERE player_id=?
    `,
    [expires, pid]
  );

  res.json({ success: true });
});

router.post("/leave", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  await applyRestTicks(pid);

  await db.query(`DELETE FROM player_rest WHERE player_id=?`, [pid]);

  res.redirect("/world");
});

router.post("/stop", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  // Apply one last tick so the player doesn't lose progress
  await applyRestTicks(pid);

  await db.query(
    `DELETE FROM player_rest WHERE player_id=?`,
    [pid]
  );

  res.json({ success: true });
});

export default router;