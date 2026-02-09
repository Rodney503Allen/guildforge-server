// church.routes.ts
import express from "express";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";



const router = express.Router();

const REVIVE_COST = 50;
const WAIT_TIME = 5 * 60 * 1000; // 5 minutes

type BasePlayerRow = {
  id: number;
  name: string;
  level: number;

  attack: number;
  defense: number;
  agility: number;
  vitality: number;
  intellect: number;
  crit: number;

  hpoints: number;
  spoints: number;

  gold: number;
  revive_at: number | null;

  // these may exist in DB but we do NOT trust them for display/healing
  maxhp?: number;
  maxspoints?: number;
};

async function loadBasePlayer(pid: number): Promise<BasePlayerRow | null> {
  const [[row]]: any = await db.query(`SELECT * FROM players WHERE id=?`, [pid]);
  if (!row) return null;

  return {
    ...row,
    id: Number(row.id),
    level: Number(row.level),

    attack: Number(row.attack),
    defense: Number(row.defense),
    agility: Number(row.agility),
    vitality: Number(row.vitality),
    intellect: Number(row.intellect),
    crit: Number(row.crit),

    hpoints: Number(row.hpoints),
    spoints: Number(row.spoints),

    gold: Number(row.gold),
    revive_at: row.revive_at === null || row.revive_at === undefined ? null : Number(row.revive_at),
  };
}


async function getFinalStatsForPlayer(pid: number) {
  const player = await getFinalPlayerStats(pid);
  return player; // includes maxhp/maxspoints already computed with guild perks
}


// =======================
// SANCTUARY PAGE
// =======================
router.get("/", async (req, res) => {
  const pid = (req.session as any).playerId as number;
  if (!pid) return res.redirect("/login.html");

const base = await loadBasePlayer(pid);
if (!base) return res.redirect("/login.html");

const stats = await getFinalStatsForPlayer(pid);
if (!stats) return res.redirect("/login.html");

// use computed maxes
let hpoints = Math.min(base.hpoints, stats.maxhp);
let spoints = Math.min(base.spoints, stats.maxspoints);
let revive_at: number | null = base.revive_at;


  // =======================
  // START TIMER AUTOMATICALLY IF DEAD
  // =======================
  if (hpoints <= 0 && !revive_at) {
    const reviveAt = Date.now() + WAIT_TIME;
    await db.query(`UPDATE players SET revive_at=? WHERE id=?`, [reviveAt, pid]);
    revive_at = reviveAt;
  }

  // =======================
  // AUTO REVIVE WHEN TIMER FINISHES
  // =======================
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

  // =======================
  // DEAD LOCK MODE
  // =======================
  const isDead = hpoints <= 0;
  let deadMessage = "";
  let waitMessage = "";
  const disableButtons = isDead ? "disabled" : "";

  if (isDead) {
    deadMessage = `<p style="color:red;"><b>You walk between life and death...</b></p>`;

    if (revive_at) {
      const secondsLeft = Math.max(0, Math.ceil((revive_at - Date.now()) / 1000));
      waitMessage = `
        <p>🕯 Resurrection in <span id="timer">${secondsLeft}</span> seconds...</p>
        <script>
          let seconds = ${secondsLeft};
          const timer = setInterval(() => {
            seconds--;
            const el = document.getElementById("timer");
            if (!el) return;
            el.innerText = seconds;
            if (seconds <= 0) {
              clearInterval(timer);
              location.reload();
            }
          }, 1000);
        </script>
      `;
    }
  }

res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Sanctuary of Light</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/statpanel.css">
  <style>
    /* =========================
       CHURCH / SANCTUARY — Grit Iron/Ember Theme
       ========================= */
    :root{
      --bg0:#07090c;
      --bg1:#0b0f14;
      --panel:#0e131a;
      --panel2:#0a0f15;

      --ink:#d7dbe2;
      --muted:#9aa3af;

      --iron:#2b3440;
      --ember:#b64b2e;
      --blood:#7a1e1e;
      --bone:#c9b89a;

      --shadow: rgba(0,0,0,.60);
      --frame: rgba(255,255,255,.04);
      --glass: rgba(0,0,0,.18);
    }

    *{ box-sizing:border-box; }

    body{
      margin:0;
      color: var(--ink);
      font-family: Cinzel, ui-serif, Georgia, "Times New Roman", serif;
      text-align:center;

      background:
        radial-gradient(1100px 600px at 18% 0%, rgba(182,75,46,.12), transparent 60%),
        radial-gradient(900px 500px at 82% 10%, rgba(122,30,30,.08), transparent 55%),
        linear-gradient(180deg, var(--bg1), var(--bg0));
    }

    /* grit overlay */
    body::before{
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      opacity:.10;
      background:
        repeating-linear-gradient(0deg, rgba(255,255,255,.04) 0 1px, transparent 1px 3px),
        repeating-linear-gradient(90deg, rgba(0,0,0,.25) 0 2px, transparent 2px 7px);
      mix-blend-mode: overlay;
    }

    .wrap{
      width: min(980px, 94vw);
      margin: 0 auto;
      padding: 22px 0 28px;
    }

    .church{
      position:relative;
      width: min(520px, 94vw);
      margin: 18px auto 14px;
      padding: 18px;
      border-radius: 12px;

      border: 1px solid rgba(43,52,64,.95);
      background:
        radial-gradient(900px 260px at 18% 0%, rgba(182,75,46,.12), transparent 60%),
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.20)),
        linear-gradient(180deg, var(--panel), var(--panel2));

      box-shadow: 0 18px 40px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.06);
    }

    .church::before{
      content:"";
      position:absolute;
      inset:10px;
      pointer-events:none;
      border: 0;
      border-radius: 10px;
    }

    h2{
      margin: 0 0 8px;
      letter-spacing: 2.6px;
      text-transform: uppercase;
      color: var(--bone);
      text-shadow:
        0 0 10px rgba(182,75,46,.20),
        0 10px 18px rgba(0,0,0,.85);
      font-size: 20px;
      position:relative;
      z-index:1;
    }

    .quote{
      margin: 0 0 12px;
      color: var(--muted);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      position:relative;
      z-index:1;
    }

    .status{
      margin: 10px 0 12px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 13px;
      color: var(--ink);
      position:relative;
      z-index:1;
    }

    .status.danger{
      border-color: rgba(122,30,30,.65);
      box-shadow: 0 0 0 1px rgba(122,30,30,.14);
    }
    .status.danger b{ color: #ffd6d6; }

    .rule{
      height:1px;
      border:none;
      margin: 14px 0;
      background: linear-gradient(90deg, transparent, rgba(182,75,46,.65), transparent);
      opacity:.85;
      position:relative;
      z-index:1;
    }

    .stats{
      display:grid;
      grid-template-columns: 1fr;
      gap: 8px;
      margin: 6px 0 12px;
      position:relative;
      z-index:1;
      text-align:left;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    }

    .stat{
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
      color: var(--ink);
      font-size: 13px;
    }

    .stat .k{
      color: var(--muted);
      letter-spacing: .6px;
      text-transform: uppercase;
      font-weight: 800;
      font-size: 12px;
      display:flex;
      align-items:center;
      gap: 8px;
    }
    .stat .v{
      color: rgba(255,255,255,.92);
      font-weight: 900;
    }

    .actions{
      display:flex;
      flex-direction:column;
      gap: 10px;
      position:relative;
      z-index:1;
      margin-top: 10px;
    }

    button{
      width:100%;
      padding: 12px 12px;

      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);

      background: rgba(0,0,0,.18);
      color: var(--ink);

      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 13px;
      font-weight: 900;
      letter-spacing: .6px;
      text-transform: uppercase;

      cursor:pointer;
      box-shadow: 0 12px 24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
      transition: transform .12s ease, border-color .12s ease, filter .12s ease;
    }

    button:hover{
      border-color: rgba(182,75,46,.45);
      transform: translateY(-1px);
    }

    button:active{ transform: translateY(0px) scale(.99); }

    button:disabled{
      opacity: .55;
      cursor:not-allowed;
      transform:none;
      filter:none;
    }

    /* Make the REVIVE button “primary” */
    .primary{
      border-color: rgba(182,75,46,.55);
      background: linear-gradient(180deg, rgba(182,75,46,.92), rgba(122,30,30,.88));
      color: #f3e7db;
      box-shadow: 0 14px 28px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.12);
    }
    .primary:hover{ filter: brightness(1.06); }

    a{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap: 8px;

      margin-top: 14px;
      padding: 10px 12px;

      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      color: #f3e7db;

      text-decoration:none;

      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 13px;
      font-weight: 900;
      letter-spacing: .6px;
      text-transform: uppercase;

      box-shadow: 0 12px 24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
      transition: transform .12s ease, border-color .12s ease;
      position:relative;
      z-index:1;
    }

    a:hover{
      border-color: rgba(182,75,46,.45);
      transform: translateY(-1px);
    }

    /* Mobile */
    @media (max-width: 520px){
      .church{ margin-top: 70px; padding: 16px; }
      h2{ font-size: 18px; letter-spacing: 2px; }
    }
      
  </style>
</head>
<body>

  <div id="statpanel-root"></div>

  <div class="wrap">
    <div class="church">
      <h2>Sanctuary of Light</h2>
      <p class="quote"><i>"Rest... your soul lingers here."</i></p>

      ${isDead ? `<div class="status danger">${deadMessage}${waitMessage}</div>` : ""}

      <hr class="rule">

      <div class="stats">
        <div class="stat">
          <div class="k">❤️ Health</div>
          <div class="v">${hpoints} / ${stats.maxhp}</div>
        </div>
        <div class="stat">
          <div class="k">✨ Spirit</div>
          <div class="v">${spoints} / ${stats.maxspoints}</div>
        </div>
        <div class="stat">
          <div class="k">💰 Gold</div>
          <div class="v">${base.gold}</div>
        </div>
      </div>

      <div class="actions">
        <form method="POST" action="/church/heal">
          <button ${disableButtons}>Restore Health (10 gold)</button>
        </form>

        <form method="POST" action="/church/restore">
          <button ${disableButtons}>Restore Spirit (10 gold)</button>
        </form>

        <form method="POST" action="/church/revive">
          <button class="primary">Revival Blessing (${REVIVE_COST} gold)</button>
        </form>
      </div>

      ${isDead ? "" : `<a href="/town">⬅ Return to Town</a>`}
    </div>
  </div>
  <script src="/statpanel.js"></script>
  
</body>
</html>
`);

});

// =======================
// HEAL HP
// =======================
router.post("/heal", async (req, res) => {
  const pid = (req.session as any).playerId as number;
  if (!pid) return res.redirect("/login.html");

  const base = await loadBasePlayer(pid);
  if (!base) return res.redirect("/login.html");

  const stats = await getFinalStatsForPlayer(pid);

  if (!stats) return res.redirect("/login.html");

  if (base.hpoints <= 0) return res.redirect("/church");
  if (base.gold < 10) return res.send("Not enough gold.");

  await db.query(`UPDATE players SET hpoints=?, gold=gold-10 WHERE id=?`, [
    stats.maxhp,
    pid,
  ]);

  res.redirect("/church");
});

// =======================
// RESTORE SP
// =======================
router.post("/restore", async (req, res) => {
  const pid = (req.session as any).playerId as number;
  if (!pid) return res.redirect("/login.html");

  const base = await loadBasePlayer(pid);
  if (!base) return res.redirect("/login.html");

  const stats = await getFinalStatsForPlayer(pid);

  if (!stats) return res.redirect("/login.html");

  if (base.hpoints <= 0) return res.redirect("/church");
  if (base.gold < 10) return res.send("Not enough gold.");

  await db.query(`UPDATE players SET spoints=?, gold=gold-10 WHERE id=?`, [
    stats.maxspoints,
    pid,
  ]);

  res.redirect("/church");
});

// =======================
// REVIVE (GOLD)
// =======================
router.post("/revive", async (req, res) => {
  const pid = (req.session as any).playerId as number;
  if (!pid) return res.redirect("/login.html");

  const base = await loadBasePlayer(pid);
  if (!base) return res.redirect("/login.html");

  const stats = await getFinalStatsForPlayer(pid);

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
