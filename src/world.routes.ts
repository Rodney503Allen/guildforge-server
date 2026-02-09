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
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&display=swap" rel="stylesheet">

  <title>Guildforge | World Map</title>

  <style>
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

      --tile: 70px;
      --gap: 6px;
    }

    *{ box-sizing:border-box; }

    html, body{
      margin:0;
      padding:0;
      min-height:100%;
      color: var(--ink);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;

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

    /* Top header (FIXED: centered + stacked) */
    .top{
      width: min(980px, 94vw);
      margin: 72px auto 0;

      display:flex;
      flex-direction: column;     /* ✅ stack */
      align-items: center;        /* ✅ center */
      justify-content: center;
      gap: 10px;

      text-align: center;         /* ✅ center text */
    }
    /* Make the title/coords block center properly */
    .top > div{
      display:flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .world-title{
      font-family: Cinzel, ui-serif, Georgia, "Times New Roman", serif;
      font-size: 22px;
      letter-spacing: 2.2px;
      text-transform: uppercase;
      color: var(--bone);
      text-shadow:
        0 0 10px rgba(182,75,46,.20),
        0 10px 18px rgba(0,0,0,.85);
      margin:0;
    }

    .coords{
      color: var(--muted);
      font-size: 12px;
      letter-spacing: .6px;
      text-transform: uppercase;
      white-space: nowrap;
      margin-top: 0;
    }

    /* Center the action button under coords */
    .world-actions{
      width: 100%;
      display:flex;
      justify-content: center;    /* ✅ center the button */
      align-items: center;
      gap: 10px;
    }

    /* Primary action button (matches new theme) */
    .world-action-btn{
      padding: 10px 12px;
      min-width: 150px;

      border-radius: 10px;
      border: 1px solid rgba(182,75,46,.55);
      background: linear-gradient(180deg, rgba(182,75,46,.92), rgba(122,30,30,.88));
      color: #f3e7db;

      font-weight: 900;
      font-size: 12px;
      letter-spacing: .7px;
      text-transform: uppercase;

      cursor: pointer;
      box-shadow: 0 14px 28px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.12);
      transition: transform .12s ease, filter .12s ease;
    }

    .world-action-btn:hover{
      filter: brightness(1.06);
      transform: translateY(-1px);
    }

    .world-action-btn:active{
      transform: translateY(0) scale(.99);
    }

    /* World layout wrapper (keeps your structure but cleans it up) */
    .world-container{
      width:100%;
      margin-top: 75px; /* ✅ pushes map (and arrows) down */
      display:flex;
      justify-content:center;
    }

    .world-layout{
      width: min(980px, 94vw);
      display:flex;
      justify-content:center;
    }

/* === MAP WRAPPER (make room for arrows inside the frame) === */
.map-wrapper{
  position: relative;
  display: inline-block;

  /* creates a gutter around the grid so arrows can live INSIDE the box */
  padding: 70px; /* tweak 62-78 depending on taste */
}

    /* Map frame */
    .grid{
      display:grid;
      grid-template-columns: repeat(7, var(--tile));
      gap: var(--gap);
      padding: 14px;

      border-radius: 14px;
      border: 1px solid rgba(43,52,64,.95);

      background:
        radial-gradient(900px 260px at 18% 0%, rgba(182,75,46,.10), transparent 60%),
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.20)),
        linear-gradient(180deg, var(--panel), var(--panel2));

      box-shadow: 0 18px 40px rgba(0,0,0,.70), inset 0 1px 0 rgba(255,255,255,.06);
      position: relative;
      overflow: visible;
    }

    .grid::before{
      content:"";
      position:absolute;
      inset:10px;
      pointer-events:none;
      border: 0;
      border-radius: 12px;
    }

    .tile{
      width: var(--tile);
      height: var(--tile);
      border-radius: 10px;
      position: relative;

      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.22);

      box-shadow:
        inset 0 0 16px rgba(0,0,0,.85),
        inset 0 1px 0 rgba(255,255,255,.05);

      overflow: hidden;
    }

    /* Player tile highlight */
    .tile.player{
      border-color: rgba(182,75,46,.75);
      box-shadow:
        0 0 0 1px rgba(182,75,46,.14),
        0 0 22px rgba(182,75,46,.35),
        inset 0 0 16px rgba(0,0,0,.85),
        inset 0 1px 0 rgba(255,255,255,.06);
    }

    /* Tile text chips */
    /* Tile owner nameplate */
    .owner{
      position: absolute;
      top: 0;
      left: 0;
      right: 0;

      height: 22px;
      display: flex;
      align-items: center;      /* vertical center */
      justify-content: center;  /* horizontal center */

      font-size: 10px;
      letter-spacing: .8px;
      text-transform: uppercase;

      color: rgba(215,219,226,.95);
      background: rgba(0,0,0,.65);

      text-shadow: 0 1px 2px rgba(0,0,0,.9);
      pointer-events: none;
    }
    .tile.player .owner{
      background:
        linear-gradient(
          180deg,
          rgba(182,75,46,.75),
          rgba(122,30,30,.55)
        );
      border-bottom-color: rgba(182,75,46,.6);
      box-shadow: 0 0 12px rgba(182,75,46,.35);
    }

    .owner::after{
      content:"";
      display:block;
      height: 1px;
      margin: 4px auto 0;
      width: 80%;

      background: linear-gradient(
        90deg,
        transparent,
        rgba(182,75,46,.55),
        rgba(215,219,226,.20),
        rgba(182,75,46,.55),
        transparent
      );
      opacity: .9;
    }
    /* Terrain images (keep your assets) */
    .plains   { background:url("/images/map_tiles/plains.png") center/cover; }
    .forest   { background:url("/images/map_tiles/forest.png") center/cover; }
    .mountain { background:url("/images/map_tiles/mountain.png") center/cover; }
    .swamp    { background:url("/images/map_tiles/swamp.png") center/cover; }
    .town     { background:url("/images/map_tiles/town.png") center/cover; }
    .castle   { background:url("/images/map_tiles/castle.png") center/cover; }
    .desert   { background:url("/images/map_tiles/desert.png") center/cover; }

    /* Movement buttons — same placement, new theme */
/* === MOVE BUTTONS (place INSIDE wrapper padding, no negatives) === */
.move-btn{
  position:absolute;
  background: rgba(0,0,0,.22);
  border: 1px solid rgba(43,52,64,.95);
  color: #f3e7db;

  font-weight: 900;
  border-radius: 12px;
  cursor:pointer;

  box-shadow: 0 14px 28px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.06);
  transition: transform .12s ease, border-color .12s ease, filter .12s ease;
}

.move-btn:hover{
  border-color: rgba(182,75,46,.55);
  filter: brightness(1.06);
  transform: translateY(-1px);
}

.move-btn:active{
  transform: translateY(0) scale(.99);
}

.move-btn.up, .move-btn.down{
  width: 92px;
  height: 44px;
  left: 50%;
  transform: translateX(-50%);
}

.move-btn.left, .move-btn.right{
  width: 44px;
  height: 92px;
  top: 50%;
  transform: translateY(-50%);
}

/* ✅ NO MORE negative offsets */
.move-btn.up   { top: 12px; }
.move-btn.down { bottom: 12px; }
.move-btn.left { left: 12px; }
.move-btn.right{ right: 12px; }
.nav-hud{
  width: min(980px, 94vw);
  margin: 10px auto 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.nav-card, .flavor-card{
  border-radius: 14px;
  border: 1px solid rgba(43,52,64,.95);
  background:
    radial-gradient(700px 180px at 20% 0%, rgba(182,75,46,.10), transparent 60%),
    linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.22)),
    linear-gradient(180deg, var(--panel), var(--panel2));
  box-shadow: 0 18px 40px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
  padding: 12px 12px;
}

.nav-top{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.nav-title{
  display:flex;
  align-items:center;
  gap: 8px;
  min-width: 0;
}

.nav-icon{
  filter: drop-shadow(0 0 8px rgba(182,75,46,.25));
}

.nav-label{
  font-size: 11px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}

.nav-badge{
  min-width: 34px;
  height: 26px;
  padding: 0 10px;

  display:flex;
  align-items:center;
  justify-content:center;

  border-radius: 999px;
  border: 1px solid rgba(182,75,46,.55);
  background: rgba(0,0,0,.22);
  color: #f3e7db;

  font-weight: 900;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
}

.nav-main{
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap: 10px;
}

.nav-name{
  font-family: Cinzel, ui-serif, Georgia, "Times New Roman", serif;
  font-weight: 800;
  letter-spacing: .6px;
  color: var(--bone);
  text-shadow: 0 10px 18px rgba(0,0,0,.65);
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  max-width: 70%;
}

.nav-meta{
  display:flex;
  gap: 8px;
  align-items:center;
}

.nav-pill{
  font-size: 11px;
  letter-spacing: .6px;
  text-transform: uppercase;
  color: rgba(215,219,226,.92);

  padding: 6px 10px;
  border-radius: 999px;

  background: rgba(0,0,0,.35);
  border: 1px solid rgba(43,52,64,.85);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
}

.flavor-card{
  grid-column: 1 / -1;
}

.flavor-title{
  font-size: 11px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
}

.flavor-text{
  color: rgba(215,219,226,.92);
  font-size: 13px;
  line-height: 1.35;
}

/* Responsive */
@media (max-width: 820px){
  .nav-hud{ grid-template-columns: 1fr; }
  .nav-name{ max-width: 100%; }
  .nav-main{ align-items:flex-start; }
}

    /* Responsive: scale tile size down */
    @media (max-width: 820px){
      :root{ --tile: 62px; --gap: 5px; }
      .top{ margin-top: 68px; }
    }
/* mobile tweak */
@media (max-width: 520px){
  .map-wrapper{ padding: 62px; }
  .move-btn.up, .move-btn.down{ width: 86px; }
}
    @media (max-width: 520px){
      :root{ --tile: 52px; --gap: 4px; }
      .top{
        flex-direction: column;
        align-items: flex-start;
        gap: 10px;
      }
      .world-actions{ width:100%; justify-content:flex-start; }
      .world-action-btn{ width:100%; }
      .move-btn.up, .move-btn.down{ width: 86px; }
    }
    /* === ONE WORLD FRAME === */
.world-frame{
  width: min(980px, 94vw);
  margin: 72px auto 0;
  border-radius: 18px;
  border: 1px solid rgba(43,52,64,.95);

  background:
    radial-gradient(900px 340px at 18% 0%, rgba(182,75,46,.10), transparent 60%),
    linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.22)),
    linear-gradient(180deg, var(--panel), var(--panel2));

  box-shadow: 0 26px 70px rgba(0,0,0,.70), inset 0 1px 0 rgba(255,255,255,.06);
  overflow: hidden;
}

/* Header zone */
.world-head{
  padding: 18px 18px 10px;
  border-bottom: 1px solid rgba(43,52,64,.70);
  background: linear-gradient(180deg, rgba(0,0,0,.20), transparent);
}
.world-head-inner{
  display:flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 8px;
}

/* Body zone (map area) */
.world-body{
  padding: 16px 18px 22px;
  display:flex;
  justify-content:center;
}

/* === NAV HUD SHOULD FEEL LIKE AN AIDE === */
.nav-hud{
  width: 100%;
  margin: 10px 0 0;
  display:grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

/* flatten the HUD: less shadow, less border contrast */
.nav-card, .flavor-card{
  border-radius: 14px;
  border: 1px solid rgba(43,52,64,.65);
  background: rgba(0,0,0,.22);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05); /* remove the big outer shadow */
  padding: 12px;
  opacity: .92;                 /* slightly subdued */
}
.nav-card:hover, .flavor-card:hover{
  opacity: 1;
}

/* reduce visual loudness */
.nav-name{
  font-size: 13px;
  text-shadow: none;
}
.nav-pill{
  background: rgba(0,0,0,.28);
}

/* === MAP SHOULD FEEL HEAVIER THAN HUD === */
.map-wrapper{
  position: relative;
  display: inline-block;
}

/* stronger map frame than HUD */
.grid{
  border-radius: 16px;
  border: 1px solid rgba(43,52,64,.95);
  box-shadow: 0 22px 55px rgba(0,0,0,.80), inset 0 1px 0 rgba(255,255,255,.06);
}

/* reduce dead vertical whitespace (you had a huge margin-top) */
.world-container{ margin-top: 0; } /* if it still exists anywhere */
.top{ margin: 0; width: auto; }    /* if top still exists anywhere */
/* subtle divider between title/coords and HUD */
.coords{
  margin-bottom: 2px;
}
.nav-hud{
  padding-top: 8px;
  border-top: 1px solid rgba(43,52,64,.55);
}
/* NEW: footer zone for nav hud */
.world-foot{
  padding: 0 18px 18px;
}

.world-foot .nav-hud{
  width: 100%;
  margin: 0;                 /* no auto-centering margin needed inside frame */
  padding-top: 14px;
  border-top: 1px solid rgba(43,52,64,.55);
}

  </style>
</head>

<body>
  <div class="world-frame">
    <!-- TOP: Zone Name -->
    <div class="world-head">
      <div class="world-head-inner">
        <div id="world-title" class="world-title">World Map</div>

        <!-- Coordinates -->
        <div class="coords">Position: (${player.map_x}, ${player.map_y})</div>

        <!-- Enter Town Button -->
        <div class="world-actions">
          <button id="enter-town-btn"
                  class="world-action-btn"
                  style="display:none"
                  onclick="enterTown()">
            Enter Town
          </button>
        </div>
      </div>
    </div>

    <!-- World Map -->
    <div class="world-body">
      <div class="map-wrapper">
        <button class="move-btn up" onclick="moveWorld('north')">⬆</button>
        <button class="move-btn left" onclick="moveWorld('west')">⬅</button>

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

    <!-- Nav HUD (BOTTOM) -->
    <div class="world-foot">
      <div class="nav-hud" id="nav-hud">
        <div class="nav-card">
          <div class="nav-top">
            <div class="nav-title">
              <span class="nav-icon">🏠</span>
              <span class="nav-label">Nearest Haven</span>
            </div>
            <span class="nav-badge" id="nav-haven-arrow">•</span>
          </div>

          <div class="nav-main">
            <div class="nav-name" id="nav-haven-name">—</div>
            <div class="nav-meta">
              <span class="nav-pill" id="nav-haven-dist">— tiles</span>
            </div>
          </div>
        </div>

        <div class="nav-card">
          <div class="nav-top">
            <div class="nav-title">
              <span class="nav-icon">🕳</span>
              <span class="nav-label">Nearest Dungeon</span>
            </div>
            <span class="nav-badge" id="nav-dungeon-arrow">•</span>
          </div>

          <div class="nav-main">
            <div class="nav-name" id="nav-dungeon-name">—</div>
            <div class="nav-meta">
              <span class="nav-pill" id="nav-dungeon-dist">—</span>
            </div>
          </div>
        </div>

        <div class="flavor-card">
          <div class="flavor-title">Travel Log</div>
          <div class="flavor-text" id="movement-flavor">You press onward.</div>
        </div>
      </div>
    </div>
  </div>

  <!-- keep these outside the frame -->
  <div class="world-right">
    <div id="statpanel-root"></div>
  </div>

  <div id="combat-root"></div>

  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>

  <script>
    fetch("/statpanel.html")
      .then(r => r.text())
      .then(html => {
        document.getElementById("statpanel-root").innerHTML = html;
      });
  </script>

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
// helpers (put near top of file)
function dirArrow(dx: number, dy: number) {
  const h = dx === 0 ? "" : (dx > 0 ? "→" : "←");
  const v = dy === 0 ? "" : (dy > 0 ? "↓" : "↑");
  if (h && v) {
    if (v === "↑" && h === "→") return "↗";
    if (v === "↑" && h === "←") return "↖";
    if (v === "↓" && h === "→") return "↘";
    if (v === "↓" && h === "←") return "↙";
  }
  return v || h || "•";
}

function terrainFlavor(terrain: string) {
  const t = String(terrain || "").toLowerCase();
  const lines: Record<string, string[]> = {
plains: [
  "Tall grass brushes your boots.",
  "The air smells faintly of rain.",
  "Insects hum in the distance.",
  "Clouds drift lazily across the open sky."
],

forest: [
  "Branches creak overhead.",
  "You hear something moving between the trees.",
  "Sap and smoke linger in the air.",
  "Filtered sunlight dances across the forest floor."
],

desert: [
  "Heat shimmers across the ground.",
  "Dry wind bites at your eyes.",
  "Sand shifts underfoot.",
  "The horizon wavers like a mirage."
],

swamp: [
  "Mud pulls at your steps.",
  "Something bubbles below the surface.",
  "The stench of rot hangs heavy.",
  "Mosquitoes swarm in thick, whining clouds."
],

snow: [
  "Frost clings to your armor.",
  "Your breath fogs the air.",
  "Snow crunches underfoot.",
  "A bitter wind cuts through every gap in your gear."
],

road: [
  "The road feels safer than the wilds.",
  "Worn stones mark countless journeys.",
  "Wheel ruts cut through the dirt.",
  "Footprints come and go, but never linger long."
],

ruins: [
  "Broken stone juts like teeth.",
  "Ash drifts across the ground.",
  "Old magic prickles at your skin.",
  "Silence presses in where voices once echoed."
],

mountain: [
  "Cold air burns your lungs with every breath.",
  "Loose gravel skitters down the slope below you.",
  "The wind howls between jagged peaks.",
  "Far below, the world looks small and fragile."
]
  };

  const bucket = lines[t] || ["You press onward."];
  return bucket[Math.floor(Math.random() * bucket.length)];
}

// inside your route:
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

  await db.query(
    "UPDATE players SET map_x=?, map_y=? WHERE id=?",
    [newX, newY, pid]
  );

  // ✅ Optional: region/zone data (only if you have it)
  // If you don't have these tables/columns yet, keep this block but allow it to fail safely.
  let regionName: string | null = null;
  let zoneLevel: number | null = null;
  try {
    const [[r]]: any = await db.query(
      `SELECT region_name, level
       FROM world_regions
       WHERE x=? AND y=?
       LIMIT 1`,
      [newX, newY]
    );
    if (r) {
      regionName = r.region_name;
      zoneLevel = Number(r.level);
    }
  } catch {}

// ✅ Nearest "Haven" = nearest town tile in world_map
let nearestHaven: any = null;
let nearestDungeon: any = null; // keep for later if you add dungeons as POIs

try {
  const [towns]: any = await db.query(`
    SELECT x, y, region_name
    FROM world_map
    WHERE terrain = 'town'
  `);

  const dist = (tx:number, ty:number) => Math.abs(tx - newX) + Math.abs(ty - newY);

  if (Array.isArray(towns) && towns.length) {
    let best = towns[0];
    let bestD = dist(best.x, best.y);

    for (const t of towns) {
      const d = dist(t.x, t.y);
      if (d < bestD) { best = t; bestD = d; }
    }

    nearestHaven = {
      name: best.region_name || "Town",
      level: zoneLevel ?? 1,
      distance: bestD,
      arrow: dirArrow(best.x - newX, best.y - newY)
    };
  }
} catch (e) {
  console.warn("nearest town lookup failed", e);
}

  // 🔥 Attempt spawn AFTER move
const enemy = await trySpawnEnemy(pid, newX, newY, tile.terrain);

  return res.json({
    success: true,
    pos: { x: newX, y: newY },
    terrain: tile.terrain,
    region: regionName,
    zoneLevel,
    flavor: terrainFlavor(tile.terrain),

    poi: {
      haven: nearestHaven,
      dungeon: nearestDungeon
    },

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

