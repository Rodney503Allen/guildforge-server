import express from "express";
import { db } from "./db";
import { trySpawnEnemy } from "./services/spawnService";

const router = express.Router();

const directions: Record<string, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  west: [-1, 0],
  east: [1, 0]
};
router.get("/world/current-region", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const [[player]]: any = await db.query(
    `SELECT map_x, map_y FROM players WHERE id = ?`,
    [pid]
  );

  if (!player) return res.status(404).json({ error: "Player not found" });

  const [[tile]]: any = await db.query(
    `
    SELECT region_name
    FROM world_map
    WHERE x = ? AND y = ?
    LIMIT 1
    `,
    [player.map_x, player.map_y]
  );

  res.json({
    region_name: tile?.region_name ?? "Unknown Region"
  });
});
// =======================
// WORLD VIEW
// =======================
router.get("/world", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  // Load player
  const [[player]]: any = await db.query(
    "SELECT map_x, map_y FROM players WHERE id=?",
    [pid]
  );

  const minX = player.map_x - 3;
  const maxX = player.map_x + 3;
  const minY = player.map_y - 3;
  const maxY = player.map_y + 3;

  // Load tiles
  const [tiles]: any = await db.query(`
    SELECT *
    FROM world_map
    WHERE x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
  `, [minX, maxX, minY, maxY]);

  // Guild ownership
  const [guilds]: any = await db.query("SELECT id,name FROM guilds");
  const guildMap: any = {};
  guilds.forEach((g: any) => guildMap[g.id] = g.name);

  const tileMap: any = {};
  tiles.forEach((t: any) => tileMap[`${t.x},${t.y}`] = t);

  res.send(`
<!DOCTYPE html>
<html>
<head>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&display=swap" rel="stylesheet">
<style>
html, body {
  margin: 0;
  padding: 0;
  background: #0a0a0f;
  color: #f5e1a4;
  font-family: Cinzel, serif;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.world-title {
  font-size: 26px;
  color: gold;
  margin-top: 60px;
}

.coords {
  font-size: 14px;
  color: #aaa;
}

.world-container {
  margin-top: 100px;
  display: flex;
  justify-content: center;
  width: 100%;
}

.map-wrapper {
  position: relative;
}

.grid {
  display: grid;
  grid-template-columns: repeat(7, 70px);
  gap: 4px;
  padding: 14px;
  background: linear-gradient(135deg, #2a1f12, #0b0703);
  border: 4px solid #c9a44c;
  border-radius: 14px;
}

.tile {
  width: 70px;
  height: 70px;
  border: 2px solid #222;
  border-radius: 6px;
  position: relative;
  box-shadow: inset 0 0 8px #000;
}

.tile.player {
  outline: 3px solid gold;
  box-shadow: 0 0 12px gold;
}

.owner {
  position: absolute;
  top: 2px;
  left: 2px;
  right: 2px;
  font-size: 9px;
  background: #000;
  color: gold;
  text-align: center;
}

.region {
  position: absolute;
  bottom: 2px;
  left: 2px;
  right: 2px;
  font-size: 9px;
  text-align: center;
}

.plains { background:url("/images/map_tiles/plains.png") center/cover; }
.forest { background:url("/images/map_tiles/forest.png") center/cover; }
.mountain { background:url("/images/map_tiles/mountain.png") center/cover; }
.swamp { background:url("/images/map_tiles/swamp.png") center/cover; }
.town { background:url("/images/map_tiles/town.png") center/cover; }
.castle { background:url("/images/map_tiles/castle.png") center/cover; }
.desert { background:url("/images/map_tiles/desert.png") center/cover; }

/* Movement buttons */
.move-btn {
  position: absolute;
  background: linear-gradient(#2a1f12, #0b0703);
  border: 2px solid #c9a44c;
  color: #f5e1a4;
  font-weight: bold;
  border-radius: 10px;
  cursor: pointer;
}

.move-btn.up, .move-btn.down {
  width: 84px;
  height: 42px;
  left: 50%;
  transform: translateX(-50%);
}

.move-btn.left, .move-btn.right {
  width: 42px;
  height: 84px;
  top: 50%;
  transform: translateY(-50%);
}

.move-btn.up { top: -64px; }
.move-btn.down { bottom: -64px; }
.move-btn.left { left: -64px; }
.move-btn.right { right: -64px; }

/* ================================
   WORLD ACTION BUTTON
================================ */

.world-action-btn {
  margin-top: 14px;
  padding: 10px 22px;

  font-family: Cinzel, serif;
  font-size: 14px;
  font-weight: bold;
  letter-spacing: 1px;

  color: #f5e1a4;
  background: linear-gradient(to bottom, #2a1f12, #0b0703);

  border: 2px solid #c9a44c;
  border-radius: 10px;

  cursor: pointer;
  box-shadow:
    inset 0 0 8px rgba(0,0,0,0.8),
    0 0 8px rgba(201,164,76,0.3);

  transition: all 0.15s ease-in-out;
}

.world-action-btn:hover {
  background: linear-gradient(to bottom, #3a2b18, #120a04);
  color: gold;

  box-shadow:
    inset 0 0 10px rgba(0,0,0,0.9),
    0 0 14px rgba(255,215,0,0.6);

  transform: scale(1.05);
}

.world-action-btn:active {
  transform: scale(0.98);
  box-shadow:
    inset 0 0 12px rgba(0,0,0,1);
}
.world-actions {
  display: flex;
  justify-content: center;
}


</style>
</head>

<body>

  <div id="world-title" class="world-title">World Map</div>
  <div class="coords">
    Position: (${player.map_x}, ${player.map_y})
  </div>
<div class="world-actions">
  <button id="enter-town-btn"
          class="world-action-btn"
          style="display:none"
          onclick="enterTown()">
    🏘 ENTER TOWN
  </button>
</div>


  <div class="world-container">

    <div id="worldUI" class="world-layout">

      <!-- MAP COLUMN -->
      <div class="map-center-anchor">
        <div class="map-column">
          <div class="map-wrapper">

            <!-- MOVE BUTTONS -->
            <button class="move-btn up" onclick="moveWorld('north')">⬆</button>
            <button class="move-btn left" onclick="moveWorld('west')">⬅</button>

            <!-- MAP GRID -->
            <div class="grid" id="Grid">
              ${
                Array.from({ length: 7 }).map((_, r) => {
                  const y = minY + r;
                  return Array.from({ length: 7 }).map((_, c) => {
                    const x = minX + c;
                    const t = tileMap[x + "," + y];
                    if (!t) return '<div class="tile"></div>';

                    const owner = t.controlling_guild_id
                      ? guildMap[t.controlling_guild_id]
                      : "Neutral";

                    const isPlayer = x === player.map_x && y === player.map_y;

                    return `
                      <div class="tile ${t.terrain} ${isPlayer ? "player" : ""}">
                        <div class="owner">${owner}</div>
                        <div class="region">${t.region_name}</div>
                      </div>
                    `;
                  }).join("");
                }).join("")
              }
            </div>

            <button class="move-btn right" onclick="moveWorld('east')">➡</button>
            <button class="move-btn down" onclick="moveWorld('south')">⬇</button>

          </div>
        </div>
      </div>


      <!-- STAT PANEL COLUMN -->
      <div class="world-right">
        <div id="statpanel-root"></div>
      </div>

    </div>
  </div>
<div id="combat-root"></div>
  <!-- STAT PANEL -->
  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>

  <script>
    fetch("/statpanel.html")
      .then(r => r.text())
      .then(html => {
        document.getElementById("statpanel-root").innerHTML = html;
      });
  </script>

  <!-- WORLD MOVEMENT -->
  <!-- COMBAT MODAL -->
    <script>
      fetch("/combat-modal.html")
        .then(r => r.text())
        .then(html => {
          document.getElementById("combat-root").innerHTML = html;
        });
    </script>

  <script src="/world-combat.js"></script>
  <script src="/world.js"></script>
</body>

</html>
`);
});

router.get("/town/enter", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  const [[player]]: any = await db.query(
    "SELECT map_x, map_y FROM players WHERE id=?",
    [pid]
  );

  const [[tile]]: any = await db.query(
    `
    SELECT terrain
    FROM world_map
    WHERE x=? AND y=?
    LIMIT 1
    `,
    [player.map_x, player.map_y]
  );

  if (!tile || tile.terrain !== "town") {
    return res.status(403).send("You are not in a town.");
  }

  // ✅ Valid town entry
  res.redirect("/town");
});

// =======================
// MOVE PLAYER
// =======================
router.get("/world/move/:dir", async (req, res) => {
  const pid = (req.session as any).playerId;
  const dir = req.params.dir;
  if (!pid || !directions[dir]) {
    return res.json({ success: false });
  }

  const [[player]]: any = await db.query(
    "SELECT map_x, map_y FROM players WHERE id=?",
    [pid]
  );

  const [dx, dy] = directions[dir];
  const newX = player.map_x + dx;
  const newY = player.map_y + dy;

  const [[tile]]: any = await db.query(
    "SELECT terrain FROM world_map WHERE x=? AND y=?",
    [newX, newY]
  );

  if (!tile) {
    return res.json({ success: false });
  }

  // Move player
  await db.query(
    "UPDATE players SET map_x=?, map_y=? WHERE id=?",
    [newX, newY, pid]
  );

  // 🔥 Attempt spawn AFTER move
const enemy = await trySpawnEnemy(
  pid,
  newX,
  newY,
  tile.terrain
);

return res.json({
  success: true,
  inCombat: !!enemy,
  enemy
});

  
});



//WORLD PARTIAL

router.get("/world/partial", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const [[player]]: any = await db.query(
    "SELECT map_x, map_y FROM players WHERE id=?",
    [pid]
  );

  const minX = player.map_x - 3;
  const minY = player.map_y - 3;

  const [tiles]: any = await db.query(`
    SELECT *
    FROM world_map
    WHERE x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
  `, [minX, player.map_x + 3, minY, player.map_y + 3]);

  const [guilds]: any = await db.query("SELECT id,name FROM guilds");
  const guildMap: any = {};
  guilds.forEach((g: any) => guildMap[g.id] = g.name);

  res.json({
    player,
    tiles,
    guildMap
  });
});




export default router;

