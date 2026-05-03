// church.routes.ts — Guildforge Sanctuary (revamp, single panel)
// - Removed the Vitals side card + all its styling
// - Keeps timer + heal/restore/revive logic intact

import express from "express";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";

const router = express.Router();

const HEAL_COST = 10;
const RESTORE_COST = 10;
const REVIVE_COST = 50;
const WAIT_TIME = 5 * 60 * 1000; // 5 minutes

type BasePlayerRow = {
  id: number;
  name: string;
  level: number;
  hpoints: number;
  spoints: number;
  gold: number;
  revive_at: number | null;
};

function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) return res.redirect("/login.html");
  next();
}

async function loadBasePlayer(pid: number): Promise<BasePlayerRow | null> {
  const [[row]]: any = await db.query(
    `SELECT id, name, level, hpoints, spoints, gold, revive_at FROM players WHERE id=? LIMIT 1`,
    [pid]
  );
  if (!row) return null;

  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    level: Number(row.level ?? 1),
    hpoints: Number(row.hpoints ?? 0),
    spoints: Number(row.spoints ?? 0),
    gold: Number(row.gold ?? 0),
    revive_at:
      row.revive_at === null || row.revive_at === undefined ? null : Number(row.revive_at),
  };
}

async function loadFinal(pid: number) {
  return await getFinalPlayerStats(pid); // includes maxhp/maxspoints (guild perks)
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US").format(Number(n || 0));
}

// =======================
// SANCTUARY PAGE
// =======================
router.get("/", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  const base = await loadBasePlayer(pid);
  if (!base) return res.redirect("/login.html");

  const stats = await loadFinal(pid);
  if (!stats) return res.redirect("/login.html");

  // Trust computed maxes; clamp current values to max
  let hpoints = clamp(base.hpoints, 0, stats.maxhp);
  let spoints = clamp(base.spoints, 0, stats.maxspoints);
  let revive_at: number | null = base.revive_at;

  // If dead and no timer started, start it
  if (hpoints <= 0 && !revive_at) {
    const reviveAt = Date.now() + WAIT_TIME;
    await db.query(`UPDATE players SET revive_at=? WHERE id=?`, [reviveAt, pid]);
    revive_at = reviveAt;
  }

  // If timer finished, auto revive (free)
  if (revive_at && Date.now() >= revive_at) {
    await db.query(
      `
      UPDATE players
      SET revive_at=NULL,
          hpoints=?,
          spoints=?
      WHERE id=?
      `,
      [stats.maxhp, stats.maxspoints, pid]
    );
    hpoints = stats.maxhp;
    spoints = stats.maxspoints;
    revive_at = null;
  }

  const isDead = hpoints <= 0;
  const secondsLeft =
    revive_at ? Math.max(0, Math.ceil((revive_at - Date.now()) / 1000)) : 0;

  const hpFull = hpoints >= stats.maxhp;
  const spFull = spoints >= stats.maxspoints;

  const healDisabled = isDead || hpFull;
  const restoreDisabled = isDead || spFull;

  const healHint = isDead
    ? "Unavailable while dead"
    : hpFull
      ? "Already at full health"
      : `Cost: ${HEAL_COST}g`;

  const restoreHint = isDead
    ? "Unavailable while dead"
    : spFull
      ? "Already at full spirit"
      : `Cost: ${RESTORE_COST}g`;

  const reviveHint = !isDead ? "Only when dead" : `Cost: ${REVIVE_COST}g`;

res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Guildforge | Sanctuary</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">

  <link rel="stylesheet" href="/statpanel.css">
  <script defer src="/statpanel.js"></script>

  <link rel="stylesheet" href="/ui/toast.css">
  <script defer src="/ui/toast.js"></script>

  <link rel="stylesheet" href="/church.css">
  <script defer src="/church.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <script>
    window.__SANCTUARY_IS_DEAD__ = ${isDead ? "true" : "false"};
  </script>

  <audio id="sanctuaryDeathMusic" loop preload="auto">
    <source src="/music/sanctuary_dead.mp3" type="audio/mpeg">
  </audio>

  <main class="sanctuary-page">
    <div class="sanctuary-shell">

      <section class="sanctuary-hero">
        <div class="hero-title">
          <div class="hero-icon">⛪</div>
          <div>
            <h1>Sanctuary of Light</h1>
            <p>A quiet refuge from war, corruption, and death.</p>
          </div>
        </div>

        <div class="hero-actions">
          <a class="btn danger" href="/town">Return to Town</a>
        </div>
      </section>

      <section class="sanctuary-grid">

        <div class="card">
          <div class="cardHeader">
            <div class="cardTitle">
              <h2>Church Services</h2>
              <p>Rest, recover, and seek sacred aid.</p>
            </div>
            <span class="badge good">Sanctuary</span>
          </div>

          <div class="cardBody">

            <div class="storyBox">
              <p class="storyText">
                <i>"Kneel, and let the ember-lanterns burn your wounds away. The Sanctuary asks only a coin... or your patience."</i>
              </p>
            </div>

            <div class="divider"></div>

            <div class="serviceList">

              <div class="serviceTile">
                <div class="serviceIcon">❤️</div>
                <div class="serviceLabel">
                  <strong>Restore Health</strong>
                  <span>${healHint}</span>
                </div>
                <form method="POST" action="/church/heal">
                  <button class="btn ${healDisabled ? "disabled" : "primary"}" ${healDisabled ? "disabled" : ""}>
                    Heal (${HEAL_COST}g)
                  </button>
                </form>
              </div>

              <div class="serviceTile">
                <div class="serviceIcon">✨</div>
                <div class="serviceLabel">
                  <strong>Restore Spirit</strong>
                  <span>${restoreHint}</span>
                </div>
                <form method="POST" action="/church/restore">
                  <button class="btn ${restoreDisabled ? "disabled" : "primary"}" ${restoreDisabled ? "disabled" : ""}>
                    Restore (${RESTORE_COST}g)
                  </button>
                </form>
              </div>

              <div class="serviceTile isLocked">
                <div class="serviceIcon">🕊️</div>
                <div class="serviceLabel">
                  <strong>Blessings</strong>
                  <span>Temporary boons for your next venture.</span>
                </div>
                <button class="btn disabled" disabled>Coming Soon</button>
              </div>

              <div class="serviceTile isLocked">
                <div class="serviceIcon">🧿</div>
                <div class="serviceLabel">
                  <strong>Purification</strong>
                  <span>Cleanse curses and corruption.</span>
                </div>
                <button class="btn disabled" disabled>Coming Soon</button>
              </div>

              <div class="serviceTile isLocked">
                <div class="serviceIcon">📿</div>
                <div class="serviceLabel">
                  <strong>Donate</strong>
                  <span>Support the Sanctuary. Unlock favor later.</span>
                </div>
                <button class="btn disabled" disabled>Coming Soon</button>
              </div>

            </div>

            <div class="note">
              Future Sanctuary services can include buffs, curse removal, corruption cleansing, and favor rewards.
            </div>

          </div>
        </div>

        <aside class="right-stack">
          <div class="card ${isDead ? "isDanger" : "isMuted"}">
            <div class="cardHeader compact">
              <div class="cardTitle">
                <h2>Revival</h2>
                <p>${isDead ? "You walk between life and death." : "Only available when you fall in battle."}</p>
              </div>
              <span class="badge ${isDead ? "warn" : ""}">${isDead ? "Critical" : "Locked"}</span>
            </div>

            <div class="cardBody">
              <div class="reviveBox">
                <div class="reviveRow">
                  <div>
                    <div class="reviveTitle">🕯️ Revival Blessing</div>
                    <div class="reviveHint">${reviveHint}</div>
                  </div>

                  <form method="POST" action="/church/revive">
                    <button class="btn danger ${!isDead ? "disabled" : ""}" ${!isDead ? "disabled" : ""}>
                      Revive (${REVIVE_COST}g)
                    </button>
                  </form>
                </div>

                <div class="divider"></div>

                ${
                  revive_at
                    ? `
                      <div class="timerRow">
                        <div class="timerLabel">Free resurrection in</div>
                        <div class="timerPill">
                          <span id="timer" data-seconds="${secondsLeft}">${secondsLeft}</span>s
                        </div>
                      </div>
                      <div class="timerNote">
                        Wait it out and you’ll be restored to full health and spirit automatically.
                      </div>
                    `
                    : `
                      <div class="timerRow">
                        <div class="timerLabel">Free resurrection</div>
                        <div class="timerNote">
                          ${isDead ? "Timer will appear shortly if it hasn’t already." : "Not applicable while alive."}
                        </div>
                      </div>
                    `
                }
              </div>
            </div>
          </div>

                    <div class="card reputation-card">
            <div class="cardHeader compact">
              <div class="cardTitle">
                <h2>Sanctuary Reputation</h2>
                <p>Your devotion is remembered.</p>
              </div>
              <span class="badge warn">Coming Soon</span>
            </div>

            <div class="cardBody">
              <div class="repSummary">
                <div class="repSeal">✝</div>

                <div class="repInfo">
                  <div class="repLabel">Favor Level</div>
                  <div class="repLevel">1</div>

                  <div class="repBarWrap">
                    <div class="repBarFill" style="width: 0%;"></div>
                  </div>

                  <div class="repProgress">0 / 1,000 Favor</div>
                  <div class="repRank">Current Rank: <strong>Pilgrim</strong></div>
                  <div class="repNext">Next Rank: <strong>Acolyte</strong></div>
                </div>
              </div>

              <div class="divider"></div>

              <div class="repRanks">
                <div class="repRankRow active">
                  <span>Pilgrim</span>
                  <small>Entry rank. Sanctuary services unlocked.</small>
                </div>

                <div class="repRankRow">
                  <span>Acolyte</span>
                  <small>Minor healing discounts.</small>
                </div>

                <div class="repRankRow">
                  <span>Disciple</span>
                  <small>Basic blessings become available.</small>
                </div>

                <div class="repRankRow">
                  <span>Devotee</span>
                  <small>Improved discounts and stronger boons.</small>
                </div>

                <div class="repRankRow">
                  <span>Oathbound</span>
                  <small>Unlocks purification services.</small>
                </div>

                <div class="repRankRow">
                  <span>Anointed</span>
                  <small>Reduced revival cost.</small>
                </div>

                <div class="repRankRow">
                  <span>Radiant</span>
                  <small>Advanced Sanctuary blessings.</small>
                </div>

                <div class="repRankRow">
                  <span>Ascendant</span>
                  <small>Highest favor with the Sanctuary.</small>
                </div>
              </div>

              <div class="repNote">
                Reputation will be earned through donations, Sanctuary quests, purification tasks, and future faith-based services.
              </div>
            </div>
          </div>
        </aside>

      </section>
    </div>
  </main>

  <div class="toast-wrap" id="toastWrap"></div>
</body>
</html>
`);
});

// =======================
// HEAL HP
// =======================
router.post("/heal", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  const base = await loadBasePlayer(pid);
  if (!base) return res.redirect("/login.html");

  const stats = await loadFinal(pid);
  if (!stats) return res.redirect("/login.html");

  if (base.hpoints <= 0) return res.redirect("/church");
  if (base.hpoints >= stats.maxhp) return res.redirect("/church");
  if (base.gold < HEAL_COST) return res.send("Not enough gold.");

  await db.query(`UPDATE players SET hpoints=?, gold=gold-? WHERE id=?`, [
    stats.maxhp,
    HEAL_COST,
    pid,
  ]);

  res.redirect("/church");
});

// =======================
// RESTORE SP
// =======================
router.post("/restore", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  const base = await loadBasePlayer(pid);
  if (!base) return res.redirect("/login.html");

  const stats = await loadFinal(pid);
  if (!stats) return res.redirect("/login.html");

  if (base.hpoints <= 0) return res.redirect("/church");
  if (base.spoints >= stats.maxspoints) return res.redirect("/church");
  if (base.gold < RESTORE_COST) return res.send("Not enough gold.");

  await db.query(`UPDATE players SET spoints=?, gold=gold-? WHERE id=?`, [
    stats.maxspoints,
    RESTORE_COST,
    pid,
  ]);

  res.redirect("/church");
});

// =======================
// REVIVE (GOLD)
// =======================
router.post("/revive", requireLogin, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  const base = await loadBasePlayer(pid);
  if (!base) return res.redirect("/login.html");

  const stats = await loadFinal(pid);
  if (!stats) return res.redirect("/login.html");

  if (base.hpoints > 0) return res.redirect("/church");
  if (base.gold < REVIVE_COST) return res.send("Not enough gold for revival.");

  await db.query(
    `
    UPDATE players
    SET hpoints=?,
        spoints=?,
        gold=gold-?,
        revive_at=NULL
    WHERE id=?
    `,
    [stats.maxhp, stats.maxspoints, REVIVE_COST, pid]
  );

  res.redirect("/church");
});

export default router;
