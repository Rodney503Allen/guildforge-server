import express from "express";
import { db } from "./db";

const router = express.Router();
console.log("✅ TOWN ROUTES FILE LOADED");

// =======================
// TOWN UI
// =======================
router.get("/town", async (req, res) => {

  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  // =======================
  // LOAD PLAYER POSITION
  // =======================
  const [[player]]: any = await db.query(`
    SELECT map_x, map_y
    FROM players
    WHERE id = ?
  `, [pid]);

  // =======================
  // FIND LOCATION AT TILE
  // =======================
  const [[town]]: any = await db.query(`
    SELECT *
    FROM locations
    WHERE map_x = ? AND map_y = ?
    LIMIT 1
  `, [player.map_x, player.map_y]);

  if (!town) {
    return res.send(`
      <html>
      <body style="background:#050509;color:gold;font-family:Cinzel,serif;text-align:center;padding-top:100px">
        <h2>No town here.</h2>
        <a style="color:gold" href="/world">Return to World</a>
      </body>
      </html>
    `);
  }

  // =======================
  // LOAD TOWN SERVICES
  // =======================
  const [services]: any = await db.query(`
    SELECT *
    FROM location_services
    WHERE location_id = ?
    ORDER BY display_order ASC, name ASC
  `, [town.id]);

  // =======================
  // RENDER LINKS
  // =======================
  const buttons = services.map((s: any) => `
    <a class="service" href="${s.route}">
      <span class="icon">${s.icon || "🏛"}</span>
      <span class="label">${s.name}</span>
    </a>
  `).join("");

  // =======================
  // PAGE OUTPUT
  // =======================
  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>${town.name}</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">

<style>
body {
  background: radial-gradient(circle at top, #111, #050509);
  color: #f5e6b2;
  font-family: Cinzel, serif;
  text-align: center;
}

.panel {
  width: 440px;
  margin: 80px auto;
  padding: 24px;
  border: 2px solid gold;
  background: rgba(0,0,0,.88);
  border-radius: 12px;
  box-shadow: 0 0 30px rgba(255,215,100,.2), inset 0 0 10px rgba(255,215,100,.1);
}

h2 {
  letter-spacing: 3px;
  margin-bottom: 10px;
  text-shadow: 0 0 6px gold;
}

.desc {
  font-size: 14px;
  color: #aaa;
  margin-bottom: 12px;
}

.service {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px;
  margin: 10px;
  background: linear-gradient(#140a00, #070300);
  border-radius: 10px;
  border: 2px solid gold;
  color: gold;
  text-decoration: none;
  font-size: 17px;
  transition: .15s;
}

.service:hover {
  background: gold;
  color: black;
  transform: scale(1.05);
}

.icon {
  font-size: 20px;
}

.leave {
  margin-top: 14px;
  display: block;
  color: gold;
  font-size: 15px;
}
  #worldChat {
  width: 420px;
  margin: 10px auto;
  background: linear-gradient(#140a05, #060301);
  border: 2px solid gold;
  border-radius: 10px;
  box-shadow: 0 0 12px rgba(255,215,0,.4);
  padding: 8px;
  color: gold;
  font-family: Cinzel, serif;
}

#chatTitle {
  text-align: center;
  font-weight: bold;
  margin-bottom: 4px;
}

#chatLog {
  height: 140px;
  overflow-y: auto;
  background: black;
  border: 1px solid gold;
  padding: 6px;
  font-size: 12px;
  margin-bottom: 6px;
  border-radius: 6px;
}

.chatLine {
  margin-bottom: 4px;
}

.chatName {
  color: #7db2ff;
  font-weight: bold;
}

#chatInput {
  width: calc(100% - 8px);
  padding: 6px;
  background: #000;
  border: 1px solid gold;
  color: gold;
  border-radius: 6px;
  outline: none;
}

</style>

</head>
<body>

<div id="statpanel-root"></div>

<div class="panel">
  <h2>${town.name}</h2>
  <div class="desc">${town.description || "A place of faith, shelter, and fate."}</div>

  <a href="/inventory.html?from=town">🎒 Inventory</a>
  <a href="/equipment">⚔ Equipment</a>


  <hr>

  ${buttons || "<i>No services available yet.</i>"}

  <hr>

  <a class="leave" href="/world">🌍 Return to World</a>

</div>
  <div id="worldChat">
  <div id="chatTitle">🌍 World Chat</div>
  <div id="chatLog"></div>
  <input id="chatInput" placeholder="Say something..." maxlength="240" />
</div>

<link rel="stylesheet" href="/statpanel.css">
<script src="/statpanel.js"></script>
<script src="/world-chat.js"></script>
</body>
</html>
`);

});

export default router;
