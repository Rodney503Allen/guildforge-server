//world.routes.ts
import express from "express";
import { db } from "./db";
import { trySpawnEnemy } from "./services/spawnService";
import { applyInteractProgress, applyEnterAreaProgress } from "./services/questService";


const router = express.Router();

const directions: Record<string, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  west: [-1, 0],
  east: [1, 0]
};
const ENCOUNTER_CHANCE = 0.18;     // ~5–6 step average
const ENCOUNTER_GAP_STEPS = 2;     // prevents constant back-to-back

function normalizeSpritePath(src?: string | null) {
  if (!src) return null;
  return src.startsWith("/") ? src : `/${src}`;
}

function buildWorldObjectMap(rows: any[]) {
  const map = new Map<string, any[]>();

  for (const row of rows || []) {
    const key = `${Number(row.x)},${Number(row.y)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }

  for (const [, list] of map) {
    list.sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  }

  return map;
}

function getTileVisualData(
  tile: any,
  x: number,
  y: number,
  objectMap: Map<string, any[]>
) {
  const key = `${x},${y}`;
  const objects = objectMap.get(key) || [];

  let replaceSprite: string | null = null;
  const overlays: string[] = [];

  for (const obj of objects) {
    const sprite = normalizeSpritePath(obj.tile_sprite);
    const visualType = String(obj.tile_visual_type || "none");

    if (!sprite || visualType === "none") continue;

    if (visualType === "replace") {
      replaceSprite = sprite;
    } else if (visualType === "overlay") {
      overlays.push(sprite);
    }
  }

  return {
    replaceSprite,
    overlays
  };
}

router.get("/world/current-region", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const [[player]]: any = await db.query(
    `SELECT map_x, map_y, level FROM players WHERE id = ? LIMIT 1`,
    [pid]
  );
  if (!player) return res.status(404).json({ error: "Player not found" });

  const [[row]]: any = await db.query(
    `
    SELECT
      wm.region_id,
      COALESCE(r.name, wm.region_name, 'Unknown Region') AS region_name,
      COALESCE(r.level_min, 1) AS level_min,
      COALESCE(r.level_max, 1) AS level_max,
      r.controlling_guild_id
    FROM world_map wm
    LEFT JOIN regions r ON r.id = wm.region_id
    WHERE wm.x = ? AND wm.y = ?
    LIMIT 1
    `,
    [player.map_x, player.map_y]
  );

  const levelMin = Number(row?.level_min ?? 1);
  const levelMax = Number(row?.level_max ?? levelMin);
  const playerLevel = Number(player.level ?? 1);



  // difficulty banding:
  // - hard = player below zone min
  // - easy = player above zone max
  // - even = in the band
  const difficulty =
    playerLevel < levelMin ? "hard" :
    playerLevel > levelMax ? "easy" :
    "even";

  if (!row) {
    return res.json({
      region_id: null,
      region_name: "Unknown Region",
      level_min: 1,
      level_max: 1,
      player_level: playerLevel,
      difficulty: "even",
      controlling_guild_id: null
    });
  }

  res.json({
    region_id: row.region_id ?? null,
    region_name: row.region_name,
    level_min: levelMin,
    level_max: levelMax,
    player_level: playerLevel,
    difficulty,
    controlling_guild_id: row.controlling_guild_id ?? null
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
  const [worldObjects]: any = await db.query(`
    SELECT
      id,
      name,
      x,
      y,
      tile_sprite,
      tile_visual_type,
      z_index
    FROM world_objects
    WHERE is_active = 1
      AND x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
    ORDER BY z_index ASC, id ASC
  `, [minX, maxX, minY, maxY]);

  const objectMap = buildWorldObjectMap(worldObjects);
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
  <link rel="stylesheet" href="/world.css">
  <link rel="stylesheet" href="/ui/itemTooltip.css">
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

        <button id="btnQuestLog" class="world-action-btn world-action-btn-secondary">
          Quest Log
        </button>
      </div>
    </div>
  </div>

  <!-- World Map -->
  <div class="world-body">
    <div class="map-stage">
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

                const { replaceSprite, overlays } = getTileVisualData(t, x, y, objectMap);

                const baseStyle = replaceSprite
                  ? `style="background-image: url('${replaceSprite}');"`
                  : "";

                return `
                  <div
                    class="tile ${replaceSprite ? "" : t.terrain} ${isPlayer ? "player" : ""}"
                    data-x="${x}"
                    data-y="${y}"
                    ${baseStyle}
                  >
                    ${
                      overlays.map((src) => `
                        <img class="tile-overlay" src="${src}" alt="" />
                      `).join("")
                    }
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
  </div>

  <!-- Bottom HUD -->
  <div class="world-foot">
    <div class="nav-hud" id="nav-hud">

      <!-- Travel Log -->
      <div class="flavor-card travel-log-card">
        <div class="flavor-title">Travel Log</div>
        <div class="flavor-text" id="movement-flavor">You press onward.</div>
      </div>

      <!-- 3-column lower HUD -->
      <div class="nav-grid">
        <!-- Nearest Haven -->
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

        <!-- Nearby -->
        <div class="nav-card nearby-card">
          <div class="nav-top">
            <div class="nav-title">
              <span class="nav-icon">✦</span>
              <span class="nav-label">Nearby</span>
            </div>
            <span class="nav-badge" id="nav-nearby-count">0</span>
          </div>

          <div class="world-interact__list" id="worldInteractList">
            <div class="world-interact__empty">
              Nothing to interact with nearby.
            </div>
          </div>
        </div>

        <!-- Nearest Dungeon -->
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
      </div>
    </div>
  </div>
</div>
  <!-- keep these outside the frame -->
  <div class="world-right">
    <div id="statpanel-root"></div>
  </div>

  <div id="combat-root"></div>

  <!-- LOOT CHEST MODAL -->
<div id="lootChestModal" class="loot-modal hidden">
  <div class="loot-panel">
    <div id="lootChestSealed" class="loot-sealed">
      <img src="/images/chest.png" id="lootChestIcon" />
      <p>Click the chest to open</p>
    </div>

    <div id="lootChestOpened" class="loot-opened hidden">
      <h3>Loot</h3>
      <div id="lootItems"></div>
      <button id="lootClaimBtn">Collect</button>
    </div>
  </div>
</div>

<div id="loreModal" class="lore-modal hidden">
  <div class="lore-backdrop"></div>

  <div class="lore-card">
    <div class="lore-header">
      <div id="loreTitle" class="lore-title">Discovery</div>
      <button id="loreCloseBtn" class="lore-close-btn" type="button">✕</button>
    </div>

    <div id="loreBody" class="lore-body"></div>

    <div class="lore-footer">
      <button id="loreOkBtn" class="lore-ok-btn" type="button">Close</button>
    </div>
  </div>
</div>

<!-- PENDING CHEST INDICATOR -->
<button id="pendingChestBtn" class="pending-chest hidden" title="You have unclaimed loot">
  <img src="/images/chest.png" alt="Chest">
  <span class="pending-chest-dot"></span>
</button>
  <script src="/ui/itemTooltip.js"></script>
  <script src="/lootChest.js"></script>
  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>
  <script src="/world.page.js" defer></script>

<!-- QUEST TRACKER (hidden until a quest is tracked) -->
<div id="questTracker" class="qtracker hidden">
  <div class="qtrackerHead">
    <div class="qtrackerTitle" id="qtTitle">Tracking</div>
    <div class="qtrackerBtns">
      <button id="qtMinBtn" class="qtrackerBtn" title="Minimize">—</button>
    </div>
  </div>
  <div class="qtrackerBody" id="qtBody">—</div>
</div>


<!-- QUEST MODAL -->
<div id="questModal" class="qmodal hidden">
  <div class="qmodalBackdrop"></div>
  <div class="qmodalCard">
    <div class="qmodalHeader">
      <div>
        <div class="qmodalTitle">Quest Log</div>
        <div class="qmodalSub">Select a quest to track on the map.</div>
      </div>
      <button id="btnQuestClose" class="qbtn">✕</button>
    </div>

    <div class="qmodalBody">
      <div id="questList" class="qlist"></div>
    </div>

    <div class="qmodalFooter">
      <button id="btnQuestClearTrack" class="qbtn ghost">Clear Tracking</button>
      <button id="btnQuestRefresh" class="qbtn">Refresh</button>
    </div>
  </div>
</div>
  <script src="world-quests.js"></script>
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
    `
    SELECT terrain, region_id
    FROM world_map
    WHERE x=? AND y=?
    LIMIT 1
    `,
    [newX, newY]
  );
  if (!tile) {
    return res.json({ success: false });
  }

  await db.query(
    "UPDATE players SET map_x=?, map_y=? WHERE id=?",
    [newX, newY, pid]
  );

  const enterAreaResult = await applyEnterAreaProgress(pid, tile.region_id ?? null);
  // ✅ Optional: region/zone data (only if you have it)
  // If you don't have these tables/columns yet, keep this block but allow it to fail safely.
  let regionName: string | null = null;
  let zoneLevel: number | null = null;

  if (tile.region_id) {
    const [[regionRow]]: any = await db.query(
      `
      SELECT name, level_min
      FROM regions
      WHERE id = ?
      LIMIT 1
      `,
      [tile.region_id]
    );

    if (regionRow) {
      regionName = String(regionRow.name || "");
      zoneLevel = Number(regionRow.level_min || 1);
    }
  }


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
// =======================
// ENCOUNTER PACING (server-side)
// =======================
const [[pstate]]: any = await db.query(
  `SELECT steps_since_encounter FROM players WHERE id=? LIMIT 1`,
  [pid]
);

let stepsSince = Number(pstate?.steps_since_encounter ?? 999);
stepsSince += 1;

let enemy: any = null;

// only attempt encounter if we've walked enough steps since last one
if (stepsSince >= ENCOUNTER_GAP_STEPS) {
  if (Math.random() < ENCOUNTER_CHANCE) {
    enemy = await trySpawnEnemy(pid, newX, newY, tile.terrain);

    // only reset if something actually spawned
    if (enemy) stepsSince = 0;
  }
}

await db.query(
  `UPDATE players SET steps_since_encounter=? WHERE id=?`,
  [stepsSince, pid]
);


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

    questProgress: {
      enterArea: enterAreaResult
    },

    inCombat: !!enemy,
    enemy
  });
});


router.get("/api/world/nearby-objects", async (req, res) => {
  try {
    const pid = (req.session as any)?.playerId;
    if (!pid) return res.status(401).json({ error: "not_logged_in" });

    const [[player]]: any = await db.query(
      `
      SELECT map_x, map_y
      FROM players
      WHERE id=?
      LIMIT 1
      `,
      [pid]
    );

    if (!player) return res.status(404).json({ error: "player_not_found" });

    const px = Number(player.map_x);
    const py = Number(player.map_y);

    const [rows]: any = await db.query(
      `
      SELECT
        id,
        name,
        object_type,
        region_name,
        x,
        y,
        interaction_radius,
        is_active,
        icon,
        lore_title,
        lore_text
      FROM world_objects
      WHERE is_active = 1
        AND x BETWEEN ? AND ?
        AND y BETWEEN ? AND ?
      ORDER BY id ASC
      `,
      [px - 3, px + 3, py - 3, py + 3]
    );

    const objects = (rows || []).map((r: any) => {
      const dist = Math.abs(px - Number(r.x)) + Math.abs(py - Number(r.y));
      const radius = Math.max(0, Number(r.interaction_radius) || 1);

      return {
        id: Number(r.id),
        name: String(r.name || "Unknown Object"),
        object_type: String(r.object_type || "quest"),
        region_name: r.region_name ?? null,
        x: Number(r.x),
        y: Number(r.y),
        interaction_radius: radius,
        inRange: dist <= radius,
        distance: dist,
        icon: r.icon ?? null
      };
    });

    res.json({
      success: true,
      player: { x: px, y: py },
      objects
    });
  } catch (err) {
    console.error("🔥 GET /api/world/nearby-objects ERROR:", err);
    res.status(500).json({ error: "server_error" });
  }
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

    const [worldObjects]: any = await db.query(`
    SELECT
      id,
      name,
      x,
      y,
      tile_sprite,
      tile_visual_type,
      z_index
    FROM world_objects
    WHERE is_active = 1
      AND x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
  `, [minX, player.map_x + 3, minY, player.map_y + 3]);

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
    guildMap,
    worldObjects
  });
});

router.post("/api/world/interact/:objectId", async (req, res) => {
  try {
    const pid = (req.session as any)?.playerId;
    if (!pid) return res.status(401).json({ error: "not_logged_in" });

    const objectId = Number(req.params.objectId);
    if (!Number.isFinite(objectId)) {
      return res.status(400).json({ error: "invalid_object_id" });
    }

    const out = await applyInteractProgress(pid, objectId);
    return res.json(out);
  } catch (err: any) {
    const msg = String(err?.message || "");
    console.error("🔥 POST /api/world/interact/:objectId ERROR:", err);

    if (msg === "PLAYER_NOT_FOUND") return res.status(404).json({ error: "player_not_found" });
    if (msg === "WORLD_OBJECT_NOT_FOUND") return res.status(404).json({ error: "world_object_not_found" });
    if (msg === "TOO_FAR_AWAY") return res.status(400).json({ error: "too_far_away" });

    return res.status(500).json({ error: "server_error" });
  }
});


export default router;

