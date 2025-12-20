// church.routes.ts
import express from "express";
import { db } from "./db";
import { computePlayerStats, type ItemMods, type BasePlayerStats } from "./services/statEngine";

import { getActiveBuffs } from "./services/buffService";


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

async function loadGearMods(pid: number): Promise<ItemMods[]> {
  const [gear]: any = await db.query(
    `
    SELECT i.*
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.player_id=? AND inv.equipped=1
    `,
    [pid]
  );

  return (gear || []).map((g: any) => ({
    attack: Number(g.attack || 0),
    defense: Number(g.defense || 0),
    agility: Number(g.agility || 0),
    vitality: Number(g.vitality || 0),
    intellect: Number(g.intellect || 0),
    crit: Number(g.crit || 0),
  }));
}

async function loadBuffMods(pid: number): Promise<ItemMods[]> {
  const buffs = await getActiveBuffs(pid);
  return (buffs || []).map((b: any) => ({
    [b.stat]: Number(b.value || 0),
  })) as ItemMods[];
}

async function getFinalStatsForPlayer(pid: number, base: BasePlayerRow) {
  const gearMods = await loadGearMods(pid);
  const buffMods = await loadBuffMods(pid);
  // IMPORTANT: compute from RAW base + gear + buffs (no double-derivation)
  return computePlayerStats(base as BasePlayerStats, gearMods, buffMods);
}

// =======================
// SANCTUARY PAGE
// =======================
router.get("/", async (req, res) => {
  const pid = (req.session as any).playerId as number;
  if (!pid) return res.redirect("/login.html");

  const base = await loadBasePlayer(pid);
  if (!base) return res.redirect("/login.html");

  const stats = await getFinalStatsForPlayer(pid, base);
  if (!stats) return res.redirect("/login.html");

  // Clamp current values to computed max (prevents showing > max)
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
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
<style>
body { 
  background:#050509; 
  color:#f5e1a4; 
  font-family:Cinzel, serif;
  text-align:center;
}
.church {
  width:430px;
  margin:80px auto;
  border:2px solid gold;
  background:rgba(0,0,0,.75);
  padding:20px;
  border-radius:12px;
  box-shadow:0 0 25px gold;
}
button {
  width:100%;
  padding:12px;
  margin-top:8px;
  background:#6b4226;
  border:2px solid gold;
  color:white;
  font-weight:bold;
  font-size:16px;
  cursor:pointer;
}
button:disabled {
  opacity:0.5;
  cursor:not-allowed;
}
button:hover { box-shadow:0 0 12px gold; }
.stat { margin-top:8px; }
a { color:gold; display:block; margin-top:15px; }
</style>
</head>
<body>

<div id="statpanel-root"></div>

<div class="church">
  <h2>Sanctuary of Light</h2>
  <p><i>"Rest... your soul lingers here."</i></p>

  ${deadMessage}
  ${waitMessage}

  <div class="stat">❤️ Health: ${hpoints} / ${stats.maxhp}</div>
  <div class="stat">✨ Spirit: ${spoints} / ${stats.maxspoints}</div>
  <div class="stat">💰 Gold: ${base.gold}</div>

  <form method="POST" action="/church/heal">
    <button ${disableButtons}>Restore Health (10 gold)</button>
  </form>

  <form method="POST" action="/church/restore">
    <button ${disableButtons}>Restore Spirit (10 gold)</button>
  </form>

  <form method="POST" action="/church/revive">
    <button>Revival Blessing (${REVIVE_COST} gold)</button>
  </form>

  ${isDead ? "" : `<a href="/town">⬅ Return to Town</a>`}
</div>

<link rel="stylesheet" href="/statpanel.css">
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

  const stats = await getFinalStatsForPlayer(pid, base);
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

  const stats = await getFinalStatsForPlayer(pid, base);
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

  const stats = await getFinalStatsForPlayer(pid, base);
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
