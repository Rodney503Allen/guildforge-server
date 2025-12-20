import express from "express";
import { db } from "./db";

const router = express.Router();

const REVIVE_COST = 50;
const WAIT_TIME = 5 * 60 * 1000; // 5 minutes


// =======================
// SANCTUARY PAGE
// =======================
router.get("/", async (req, res) => {

  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  const [[player]]: any = await db.query(`
    SELECT name,hpoints,maxhp,spoints,maxspoints,gold,location,revive_at
    FROM players WHERE id=?
  `,[pid]);


  // =======================
  // START TIMER AUTOMATICALLY IF DEAD
  // =======================
  if (player.hpoints <= 0 && !player.revive_at) {

    const reviveAt = Date.now() + WAIT_TIME;

    await db.query(`
      UPDATE players
      SET revive_at=?
      WHERE id=?
    `,[reviveAt, pid]);

    player.revive_at = reviveAt;
  }


  // =======================
  // AUTO REVIVE WHEN TIMER FINISHES
  // =======================
  if (player.revive_at && Date.now() >= player.revive_at) {

    await db.query(`
      UPDATE players
      SET revive_at = NULL,
          hpoints = maxhp,
          spoints = maxspoints
      WHERE id=?
    `,[pid]);

    player.hpoints = player.maxhp;
    player.spoints = player.maxspoints;
    player.revive_at = null;
  }


  // =======================
  // DEAD LOCK MODE
  // =======================
  let deadMessage = "";
  let waitMessage = "";
  let disableButtons = "";

  const isDead = player.hpoints <= 0;

  if (isDead) {

    deadMessage = `<p style="color:red;"><b>You walk between life and death...</b></p>`;
    disableButtons = "disabled";

    if (player.revive_at) {

      const secondsLeft = Math.max(
        0, Math.ceil((player.revive_at - Date.now()) / 1000)
      );

      waitMessage = `
        <p>🕯 Resurrection in
          <span id="timer">${secondsLeft}</span>
          seconds...
        </p>

        <script>
          let seconds = ${secondsLeft};

          const timer = setInterval(() => {
            seconds--;
            const el = document.getElementById("timer");
            if (!el) return;

            el.innerText = seconds;

            if (seconds <= 0) {
              clearInterval(timer);
              location.reload(); // triggers server revive
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

<div class="church">
  <h2>Sanctuary of Light</h2>
  <p><i>"Rest... your soul lingers here."</i></p>

  ${deadMessage}
  ${waitMessage}

  <div class="stat">❤️ Health: ${player.hpoints} / ${player.maxhp}</div>
  <div class="stat">✨ Spirit: ${player.spoints} / ${player.maxspoints}</div>
  <div class="stat">💰 Gold: ${player.gold}</div>

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

</body>
</html>
  `);
});


// =======================
// HEAL HP
// =======================
router.post("/heal", async (req, res) => {

  const pid = (req.session as any).playerId;

  const [[player]]: any = await db.query(
    "SELECT gold,hpoints,maxhp FROM players WHERE id=?",
    [pid]
  );

  if (player.hpoints <= 0) return res.redirect("/church");
  if (player.gold < 10) return res.send("Not enough gold.");

  await db.query(`
    UPDATE players
    SET hpoints = maxhp, gold = gold - 10
    WHERE id=?
  `,[pid]);

  res.redirect("/church");
});


// =======================
// RESTORE SP
// =======================
router.post("/restore", async (req, res) => {

  const pid = (req.session as any).playerId;

  const [[player]]: any = await db.query(
    "SELECT gold,hpoints,maxspoints FROM players WHERE id=?",
    [pid]
  );

  if (player.hpoints <= 0) return res.redirect("/church");
  if (player.gold < 10) return res.send("Not enough gold.");

  await db.query(`
    UPDATE players
    SET spoints = maxspoints, gold = gold - 10
    WHERE id=?
  `,[pid]);

  res.redirect("/church");
});


// =======================
// REVIVE (GOLD)
// =======================
router.post("/revive", async (req, res) => {

  const pid = (req.session as any).playerId;

  const [[player]]: any = await db.query(
    "SELECT gold,hpoints FROM players WHERE id=?",
    [pid]
  );

  if (player.hpoints > 0) return res.redirect("/church");
  if (player.gold < REVIVE_COST) return res.send("Not enough gold for revival.");

  await db.query(`
    UPDATE players
    SET hpoints = maxhp,
        spoints = maxspoints,
        gold = gold - ?,
        revive_at = NULL
    WHERE id=?
  `,[REVIVE_COST, pid]);

  res.redirect("/church");
});

export default router;
