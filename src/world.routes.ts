//world.routes.ts
import express from "express";
import { db } from "./db";
import { trySpawnEnemy } from "./services/spawnService";
import { applyInteractProgress, applyEnterAreaProgress } from "./services/questService";
import { maybeSpawnResourceNodeForPlayer } from "./services/gatheringSpawnService";
import { advanceHuntObjective } from "./huntService";


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

async function getResourceNodesInRange(playerId: number, centerX: number, centerY: number, range = 3){
  const [rows]: any = await db.query(
    `
    SELECT
      srn.id AS spawnedNodeId,
      srn.map_x,
      srn.map_y,
      srn.remaining_uses,

      rn.name AS nodeName,
      rn.description,
      rn.image,
      rn.required_level,
      rn.rarity,
      rn.base_gather_time_ms,

      p.name AS professionName,

      a.name AS affixName
    FROM spawned_resource_nodes srn
    JOIN resource_nodes rn ON rn.id = srn.node_id
    JOIN professions p ON p.id = rn.profession_id
    LEFT JOIN resource_node_affixes a ON a.id = srn.affix_id
    WHERE srn.player_id = ?
      AND srn.remaining_uses > 0
      AND (srn.despawns_at IS NULL OR srn.despawns_at > NOW())
      AND srn.map_x BETWEEN ? AND ?
      AND srn.map_y BETWEEN ? AND ?
    ORDER BY srn.id ASC
    `,
    [
      playerId,
      centerX - range,
      centerX + range,
      centerY - range,
      centerY + range
    ]
  );

  return rows;
}

async function getHuntTargetsInRange(
  playerId: number,
  centerX: number,
  centerY: number,
  range = 3
) {
  const [rows]: any =
    await db.query(
      `
        SELECT
          ph.id AS party_hunt_id,
          ph.target_map_x,
          ph.target_map_y,
          ph.status,

          h.name AS hunt_name,

          ht.id AS hunt_target_id,
          ht.name AS target_name,
          ht.description,
          ht.image

          FROM party_members pm

          JOIN party_hunts ph
            ON ph.party_id =
              pm.party_id

          JOIN hunt_participants hp
            ON hp.party_hunt_id =
              ph.id
          AND hp.player_id =
              pm.player_id

          JOIN hunts h
            ON h.id =
              ph.hunt_id
        JOIN hunt_targets ht
          ON ht.hunt_id =
             h.id

        WHERE pm.player_id = ?

          AND ph.target_revealed = 1

          AND ph.status IN (
            'revealed',
            'engaged'
          )

          AND ph.target_map_x
            BETWEEN ? AND ?

          AND ph.target_map_y
            BETWEEN ? AND ?

        ORDER BY
          ph.accepted_at DESC

        LIMIT 1
      `,
      [
        playerId,

        centerX - range,
        centerX + range,

        centerY - range,
        centerY + range
      ]
    );

  return (rows || []).map(
    (row: any) => {

      const x =
        Number(
          row.target_map_x
        );

      const y =
        Number(
          row.target_map_y
        );

      const distance =
        Math.abs(
          centerX - x
        ) +
        Math.abs(
          centerY - y
        );

      return {
        id:
          Number(
            row.party_hunt_id
          ),

        partyHuntId:
          Number(
            row.party_hunt_id
          ),

        huntTargetId:
          Number(
            row.hunt_target_id
          ),

        name:
          String(
            row.target_name ||
            "Hunt Target"
          ),

        huntName:
          String(
            row.hunt_name ||
            "Hunt"
          ),

        description:
          row.description ?? null,

        image:
          row.image ?? null,

        object_type:
          "hunt_target",

        x,
        y,

        interaction_radius: 0,

        distance,

        inRange:
          distance === 0,

        status:
          String(
            row.status
          )
      };
    }
  );
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
    `
    SELECT map_x, map_y, level, steps_since_encounter
    FROM players
    WHERE id=?
    LIMIT 1
    `,
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

  const resourceNodes = await getResourceNodesInRange(Number(pid), player.map_x, player.map_y, 3);

  const huntTargets =
  await getHuntTargetsInRange(
    Number(pid),
    Number(player.map_x),
    Number(player.map_y),
    3
  );

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
  <link rel="stylesheet" href="/rest.css">
  <link rel="stylesheet" href="/ui/itemTooltip.css">
  <link rel="stylesheet" href="/hunt-ready-check.css">
  <link rel="stylesheet" href="/hunt-combat.css">
</head>

<body>
  <div class="world-frame">
    <span class="frame-border main" aria-hidden="true"></span>

    <!-- TOP: Zone Name -->
    <header class="world-head">
      <div class="world-head-inner">
        <div class="world-head-copy">
          <div id="world-title" class="world-title">World Map</div>

          <div class="coords">
            Position: (${player.map_x}, ${player.map_y})
          </div>
        </div>

      <div class="world-actions">
        <button
          id="enter-town-btn"
          class="world-action-btn"
          type="button"
          hidden
          onclick="enterTown()"
        >
          Enter Town
        </button>
      </div>
      </div>

      <span class="world-head-divider" aria-hidden="true"></span>
    </header>

    <!-- Responsive World Layout -->
    <div class="world-layout">
      <!-- LEFT: Tile Map -->
      <section class="world-map-panel" aria-label="World map">
        <span class="frame-border panel" aria-hidden="true"></span>

        <div class="map-stage">
          <div class="map-wrapper">
            <button
              class="move-btn up"
              type="button"
              aria-label="Move north"
              onclick="moveWorld('north')"
            >
              ⬆
            </button>

            <button
              class="move-btn left"
              type="button"
              aria-label="Move west"
              onclick="moveWorld('west')"
            >
              ⬅
            </button>

            <div class="grid" id="Grid">
              ${
                Array.from({ length: 7 }).map((_, r) => {
                  const y = minY + r;

                  return Array.from({ length: 7 }).map((_, c) => {
                    const x = minX + c;
                    const t = tileMap[x + "," + y];

                    if (!t) {
                      return `
                        <div
                          class="tile"
                          data-x="${x}"
                          data-y="${y}"
                        ></div>
                      `;
                    }

                    const isPlayer =
                      x === player.map_x &&
                      y === player.map_y;

                    const {
                      replaceSprite,
                      overlays
                    } = getTileVisualData(t, x, y, objectMap);

                    const baseStyle = replaceSprite
                      ? `style="background-image: url('${replaceSprite}');"`
                      : "";

                    return `
                      <div
                        class="tile ${replaceSprite ? "" : t.terrain} ${
                          isPlayer ? "player" : ""
                        }"
                        data-x="${x}"
                        data-y="${y}"
                        ${baseStyle}
                      >
                        ${
                          overlays.map((src) => `
                            <img
                              class="tile-overlay"
                              src="${src}"
                              alt=""
                              aria-hidden="true"
                            />
                          `).join("")
                        }
                      </div>
                    `;
                  }).join("");
                }).join("")
              }
            </div>

            <button
              class="move-btn right"
              type="button"
              aria-label="Move east"
              onclick="moveWorld('east')"
            >
              ➡
            </button>

            <button
              class="move-btn down"
              type="button"
              aria-label="Move south"
              onclick="moveWorld('south')"
            >
              ⬇
            </button>
          </div>
        </div>
      </section>

      <!-- RIGHT: Always-visible World Information -->
      <aside
        class="world-sidebar"
        id="nav-hud"
        aria-label="Nearby world information"
      >
<section class="field-actions-card world-sidebar-card">
  <div class="field-actions-grid">

    <button
      id="rest-btn"
      class="field-action frame-host"
      type="button"
      onclick="openRest()"
    >
      <span class="frame-border sub" aria-hidden="true"></span>

      <span class="field-action__icon" aria-hidden="true">
        🔥
      </span>

      <span class="field-action__copy">
        <strong>Rest</strong>
        <small>Recover health and spirit</small>
      </span>

      <span class="field-action__arrow" aria-hidden="true">
        ›
      </span>
    </button>


    <button
      id="partyQuickBtn"
      class="field-action frame-host"
      type="button"
      onclick="openPartyQuickView()"
    >
      <span class="frame-border sub" aria-hidden="true"></span>

      <span class="field-action__icon" aria-hidden="true">
        ⚔
      </span>

      <span class="field-action__copy">
        <strong>Party</strong>

        <small id="partyQuickStatus">
          Checking company...
        </small>
      </span>

      <span class="field-action__arrow" aria-hidden="true">
        ›
      </span>
    </button>

  </div>
</section>

        <!-- Travel Log -->
        <section class="flavor-card travel-log-card world-sidebar-card">
          <span class="frame-border sub" aria-hidden="true"></span>

          <div class="flavor-title">Travel Log</div>

          <div class="flavor-text" id="movement-flavor">
            You press onward.
          </div>
        </section>
        <!-- Field Actions -->

        <!-- Current Resource -->
        <!--
          This panel is populated dynamically. Do not add a frame-border
          child unless the rendering script preserves existing children.
        -->
        <section
          id="currentResourcePanel"
          class="resource-panel world-sidebar-card"
          hidden
        ></section>

        <!-- Nearby -->
<!-- Nearby -->
<section class="nav-card nearby-card world-sidebar-card">
  <span class="frame-border sub" aria-hidden="true"></span>

  <div class="nav-top">
    <div class="nav-title">
      <span class="nav-icon" aria-hidden="true">✦</span>
      <span class="nav-label">Nearby</span>
    </div>

    <span class="nav-badge" id="nav-nearby-count">0</span>
  </div>

  <!-- Permanent navigation entries -->
  <div class="nearby-destinations">
    <div class="nearby-destination">
      <span
        class="nearby-destination__icon"
        aria-hidden="true"
      >
        🏠
      </span>

      <div class="nearby-destination__details">
        <div class="nearby-destination__label">
          Nearest Haven
        </div>

        <div
          class="nearby-destination__name"
          id="nav-haven-name"
        >
          —
        </div>
      </div>

      <div class="nearby-destination__location">
        <span
          class="nearby-destination__arrow"
          id="nav-haven-arrow"
          aria-hidden="true"
        >
          •
        </span>

        <span
          class="nearby-destination__distance"
          id="nav-haven-dist"
        >
          — tiles
        </span>
      </div>
    </div>

    <div class="nearby-destination">
      <span
        class="nearby-destination__icon"
        aria-hidden="true"
      >
        🕳
      </span>

      <div class="nearby-destination__details">
        <div class="nearby-destination__label">
          Nearest Dungeon
        </div>

        <div
          class="nearby-destination__name"
          id="nav-dungeon-name"
        >
          —
        </div>
      </div>

      <div class="nearby-destination__location">
        <span
          class="nearby-destination__arrow"
          id="nav-dungeon-arrow"
          aria-hidden="true"
        >
          •
        </span>

        <span
          class="nearby-destination__distance"
          id="nav-dungeon-dist"
        >
          —
        </span>
      </div>
    </div>
  </div>

  <!-- Dynamic nearby objects -->
  <div class="nearby-interactions">
    <div class="nearby-interactions__heading">
      Interactions
    </div>

    <div
      class="world-interact__list"
      id="worldInteractList"
    >
      <div class="world-interact__empty">
        Nothing to interact with nearby.
      </div>
    </div>
  </div>
</section>

  <!-- Keep these outside the world frame -->
  <div class="world-right">
    <div id="statpanel-root"></div>
  </div>

  <!-- Party Quick View -->
<div
  id="partyQuickModal"
  class="party-quick-modal hidden"
  role="dialog"
  aria-modal="true"
  aria-labelledby="partyQuickTitle"
>
  <div
    class="party-quick-backdrop"
    onclick="closePartyQuickView()"
  ></div>

  <section class="party-quick-card frame-host">
    <span class="frame-border panel" aria-hidden="true"></span>

    <header class="party-quick-header">

      <div>
        <div class="party-quick-kicker">
          Adventuring Company
        </div>

        <h2 id="partyQuickTitle">
          Your Party
        </h2>
      </div>

      <button
        class="party-quick-close"
        type="button"
        onclick="closePartyQuickView()"
        aria-label="Close party view"
      >
        ✕
      </button>

    </header>


    <div
      id="partyQuickBody"
      class="party-quick-body"
    >
      <div class="party-quick-loading">
        Gathering your company...
      </div>
    </div>


    <footer class="party-quick-footer">

      <a
        href="/party.html"
        class="party-quick-manage"
      >
        Manage Party
      </a>

      <button
        class="party-quick-dismiss"
        type="button"
        onclick="closePartyQuickView()"
      >
        Close
      </button>

    </footer>

  </section>
</div>

  <!-- Hunt Ready Check -->
<div
  id="huntReadyModal"
  class="hunt-ready-modal hidden"
  role="dialog"
  aria-modal="true"
  aria-labelledby="huntReadyTitle"
  aria-describedby="huntReadyStatus"
>
  <div
    class="hunt-ready-backdrop"
    aria-hidden="true"
  ></div>

  <section class="hunt-ready-card frame-host">
    <span
      class="frame-border panel"
      aria-hidden="true"
    ></span>

    <header class="hunt-ready-header">
      <div>
        <div class="hunt-ready-kicker">
          Party Hunt
        </div>

        <h2 id="huntReadyTitle">
          Prepare for Battle
        </h2>
      </div>

      <div
        id="huntReadyCountdown"
        class="hunt-ready-countdown"
        aria-label="Time remaining"
      >
        --:--
      </div>
    </header>

    <div class="hunt-ready-content">
      <p
        id="huntReadyStatus"
        class="hunt-ready-status"
        aria-live="polite"
      >
        Waiting for the party...
      </p>

      <div
        id="huntReadyParticipants"
        class="hunt-ready-participants"
        aria-label="Hunt participants"
      >
        <div class="hunt-ready-loading">
          Gathering your company...
        </div>
      </div>

      <div
        id="huntReadyError"
        class="hunt-ready-error"
        role="alert"
        hidden
      ></div>
    </div>

    <footer class="hunt-ready-footer">
      <button
        id="huntReadyCancelBtn"
        class="hunt-ready-btn hunt-ready-btn--cancel"
        type="button"
        hidden
      >
        Cancel
      </button>

      <button
        id="huntReadyToggleBtn"
        class="hunt-ready-btn hunt-ready-btn--ready"
        type="button"
        disabled
      >
        Ready
      </button>
    </footer>
  </section>
</div>

<div id="combat-root"></div>
  <!-- Shared Party Hunt Combat -->
  <div id="hunt-combat-root"></div>
  <div id="rest-root"></div>


  <!-- Gathering Modal -->
  <div
    id="gatheringModal"
    class="gathering-modal hidden"
    role="dialog"
    aria-modal="true"
    aria-labelledby="gatheringModalTitle"
  >
    <div class="gathering-modal__card">
      <div
        class="gathering-modal__icon"
        id="gatheringModalIcon"
        aria-hidden="true"
      >
        ⛏️
      </div>

      <div
        class="gathering-modal__title"
        id="gatheringModalTitle"
      >
        Mining...
      </div>

      <div
        class="gathering-modal__sub"
        id="gatheringModalSub"
      >
        Gathering resources
      </div>

      <div
        class="gathering-progress"
        role="progressbar"
        aria-label="Gathering progress"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div
          id="gatheringProgressFill"
          class="gathering-progress__fill"
        ></div>
      </div>
    </div>
  </div>

  <!-- Loot Chest Modal -->
  <div
    id="lootChestModal"
    class="loot-modal hidden"
    role="dialog"
    aria-modal="true"
    aria-label="Loot chest"
  >
    <div class="loot-panel">
      <div id="lootChestSealed" class="loot-sealed">
        <img
          src="/images/chest.png"
          id="lootChestIcon"
          alt="Sealed loot chest"
        />

        <p>Click the chest to open</p>
      </div>

      <div id="lootChestOpened" class="loot-opened hidden">
        <h3>Loot</h3>

        <div id="lootItems"></div>

        <div class="loot-actions">
          <button
            id="lootClaimBtn"
            class="loot-btn primary"
            type="button"
          >
            Collect
          </button>

          <button
            id="lootCloseBtn"
            class="loot-btn secondary"
            type="button"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Lore Modal -->
  <div
    id="loreModal"
    class="lore-modal hidden"
    role="dialog"
    aria-modal="true"
    aria-labelledby="loreTitle"
  >
    <div class="lore-backdrop"></div>

    <div class="lore-card">
      <div class="lore-header">
        <div id="loreTitle" class="lore-title">
          Discovery
        </div>

        <button
          id="loreCloseBtn"
          class="lore-close-btn"
          type="button"
          aria-label="Close discovery"
        >
          ✕
        </button>
      </div>

      <div id="loreBody" class="lore-body"></div>

      <div class="lore-footer">
        <button
          id="loreOkBtn"
          class="lore-ok-btn"
          type="button"
        >
          Close
        </button>
      </div>
    </div>
  </div>

  <!-- Pending Chest Indicator -->
  <button
    id="pendingChestBtn"
    class="pending-chest hidden"
    type="button"
    title="You have unclaimed loot"
    aria-label="Open unclaimed loot"
  >
    <img src="/images/chest.png" alt="" aria-hidden="true" />
    <span class="pending-chest-dot" aria-hidden="true"></span>
  </button>

  <!-- Quest Tracker -->
  <aside
    id="questTracker"
    class="qtracker hidden"
    aria-label="Tracked quest"
  >
    <div class="qtrackerHead">
      <div class="qtrackerTitle" id="qtTitle">
        Tracking
      </div>

      <div class="qtrackerBtns">
        <button
          id="qtMinBtn"
          class="qtrackerBtn"
          type="button"
          title="Minimize"
          aria-label="Minimize quest tracker"
        >
          —
        </button>
      </div>
    </div>

    <div class="qtrackerBody" id="qtBody">—</div>
  </aside>

  <link rel="stylesheet" href="/statpanel.css" />
  <link rel="stylesheet" href="/ui/toast.css" />

  <script src="/ui/itemTooltip.js"></script>
  <script src="/lootChest.js"></script>

  <script>
    window.__RESOURCE_NODES__ =
      ${JSON.stringify(resourceNodes)};

    window.__HUNT_TARGETS__ =
      ${JSON.stringify(huntTargets)};
  </script>
<script>
  window.__PLAYER_ID__ =
    ${Number(player.id)};

  window.__RESOURCE_NODES__ =
    ${JSON.stringify(resourceNodes)};

  window.__HUNT_TARGETS__ =
    ${JSON.stringify(huntTargets)};
</script>
  <script src="/ui/toast.js"></script>
  <script src="/statpanel.js"></script>
  <script src="/world.page.js" defer></script>
  <script src="/world-quests.js"></script>
  <script src="/world-combat.js"></script>
  <script src="/world.js"></script>
  <script src="/hunt-ready-check.js"></script>
  <script src="/hunt-combat.js"></script>
  <script src="/rest.js" defer></script>
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







// =======================
// MOVE ROUTE — bundles world/partial + nearby-objects + region into one response
// =======================
router.get("/world/move/:dir", async (req, res) => {

  const pid = (req.session as any).playerId;
  const dir = req.params.dir;
  if (!pid || !directions[dir]) {
    return res.json({ success: false });
  }
const [[player]]: any = await db.query(
  `
  SELECT map_x, map_y, level, steps_since_encounter
  FROM players
  WHERE id=?
  LIMIT 1
  `,
  [pid]
);

const [dx, dy] = directions[dir];
const newX = Number(player.map_x) + dx;
const newY = Number(player.map_y) + dy;

const [huntClueRows]: any =
  await db.query(
    `
      SELECT
        phc.id,
        phc.map_x,
        phc.map_y,

        hc.name,
        hc.description,
        hc.icon,

        ph.id AS party_hunt_id,
        h.name AS hunt_name

      FROM party_members pm

      JOIN party_hunts ph
        ON ph.party_id =
           pm.party_id

      JOIN hunt_participants hp
        ON hp.party_hunt_id =
           ph.id
       AND hp.player_id =
           pm.player_id

      JOIN party_hunt_clues phc
        ON phc.party_hunt_id =
           ph.id

      JOIN hunt_clues hc
        ON hc.id =
           phc.hunt_clue_id

      JOIN hunts h
        ON h.id =
           ph.hunt_id

      WHERE pm.player_id = ?

        AND ph.status IN (
          'tracking',
          'revealed',
          'engaged'
        )

        AND phc.is_investigated = 0

        AND phc.map_x
          BETWEEN ? AND ?

        AND phc.map_y
          BETWEEN ? AND ?

      ORDER BY
        phc.id ASC
    `,
    [
      pid,
      newX - 3,
      newX + 3,
      newY - 3,
      newY + 3
    ]
  );

const [[tile]]: any = await db.query(
  `
  SELECT
    wm.terrain,
    wm.region_id,
    COALESCE(r.name, wm.region_name, 'Unknown Region') AS region_name,
    COALESCE(r.level_min, 1) AS level_min,
    COALESCE(r.level_max, 1) AS level_max,
    r.controlling_guild_id
  FROM world_map wm
  LEFT JOIN regions r ON r.id = wm.region_id
  WHERE wm.x=? AND wm.y=?
  LIMIT 1
  `,
  [newX, newY]
);

if (!tile) {
  return res.json({ success: false });
}

const movementConnection =
  await db.getConnection();

try {
  await movementConnection.beginTransaction();

  const [moveResult]: any =
    await movementConnection.query(
      `
        UPDATE players

        SET
          map_x = ?,
          map_y = ?

        WHERE id = ?
      `,
      [
        newX,
        newY,
        pid
      ]
    );

  if (
    Number(moveResult.affectedRows) !== 1
  ) {
    throw new Error(
      "Player could not be moved."
    );
  }

  /*
   * Moving away revokes Ready on any pending
   * Hunt ready check.
   */
  await movementConnection.query(
    `
      UPDATE hunt_ready_check_players hrcp

      JOIN hunt_ready_checks hrc
        ON hrc.id =
           hrcp.ready_check_id

      SET
        hrcp.is_ready = 0,
        hrcp.ready_at = NULL

      WHERE hrcp.player_id = ?
        AND hrc.status = 'pending'
        AND hrcp.is_ready = 1
    `,
    [pid]
  );

  await movementConnection.commit();

} catch (err) {

  await movementConnection.rollback();

  console.error(
    "World movement transaction failed:",
    err
  );

  return res
    .status(500)
    .json({
      success: false,
      error: "movement_failed"
    });

} finally {

  movementConnection.release();
}

const spawnedResourceNode =
  await maybeSpawnResourceNodeForPlayer(
    pid
  );

const resourceNodes =
  await getResourceNodesInRange(
    pid,
    newX,
    newY,
    3
  );

const huntTargets =
  await getHuntTargetsInRange(
    Number(pid),
    newX,
    newY,
    3
  );

const enterAreaResult =
  await applyEnterAreaProgress(
    pid,
    tile.region_id ?? null
  );
let huntProgress = null;

try {
  huntProgress =
    await advanceHuntObjective(
      Number(pid),
      {
        type: "ENTER_REGION",
        regionId:
          tile.region_id !== null &&
          tile.region_id !== undefined
            ? Number(tile.region_id)
            : undefined
      }
    );
} catch (err) {
  console.warn(
    "Hunt ENTER_REGION progress failed",
    err
  );
}
const playerLevel = Number(player.level ?? 1);
const levelMin = Number(tile.level_min ?? 1);
const levelMax = Number(tile.level_max ?? levelMin);



const difficulty =
  playerLevel < levelMin ? "hard" :
  playerLevel > levelMax ? "easy" :
  "even";

const regionName = String(tile.region_name || "Unknown Region");
const zoneLevel = levelMin;
const controllingGuildId = tile.controlling_guild_id ?? null;

let stepsSince = Number(player.steps_since_encounter ?? 999);
stepsSince += 1;

let enemy: any = null;

if (stepsSince >= ENCOUNTER_GAP_STEPS) {
  if (Math.random() < ENCOUNTER_CHANCE) {
    enemy = await trySpawnEnemy(pid, newX, newY, tile.terrain);
    if (enemy) stepsSince = 0;
  }
}

await db.query(
  `UPDATE players SET steps_since_encounter=? WHERE id=?`,
  [stepsSince, pid]
);

  // Nearest Haven
  let nearestHaven: any = null;
  let nearestDungeon: any = null;

  try {
    const [towns]: any = await db.query(`
      SELECT x, y, region_name
      FROM world_map
      WHERE terrain = 'town'
    `);

    const dist = (tx: number, ty: number) => Math.abs(tx - newX) + Math.abs(ty - newY);

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

  // =======================
  // BUNDLE: world/partial data
  // =======================
  const minX = newX - 3;
  const maxX = newX + 3;
  const minY = newY - 3;
  const maxY = newY + 3;

const [worldObjects]: any = await db.query(`
SELECT
  id,
  name,
  object_type,
  region_name,
  x,
  y,
  interaction_radius,
  icon,
  tile_sprite,
  tile_visual_type,
  z_index
FROM world_objects
WHERE is_active = 1
  AND x BETWEEN ? AND ?
  AND y BETWEEN ? AND ?
ORDER BY z_index ASC, id ASC
`, [minX, maxX, minY, maxY]);

  const [tiles]: any = await db.query(`
    SELECT *
    FROM world_map
    WHERE x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
  `, [minX, maxX, minY, maxY]);

  // =======================
  // BUNDLE: nearby-objects data
  // =======================

const nearbyObjects = worldObjects.map((r: any) => {
  const d = Math.abs(newX - Number(r.x)) + Math.abs(newY - Number(r.y));
  const radius = Math.max(0, Number(r.interaction_radius) || 1);

  return {
    id: Number(r.id),
    name: String(r.name || "Unknown Object"),
    object_type: String(r.object_type || "quest"),
    region_name: r.region_name ?? null,
    x: Number(r.x),
    y: Number(r.y),
    interaction_radius: radius,
    inRange: d <= radius,
    distance: d,
    icon: r.icon ?? null
  };
});

const nearbyHuntClues =
  (huntClueRows || []).map(
    (r: any) => {

      const distance =
        Math.abs(
          newX -
          Number(r.map_x)
        ) +
        Math.abs(
          newY -
          Number(r.map_y)
        );

      return {
        id:
          Number(r.id),

        name:
          String(
            r.name ||
            "Unknown Clue"
          ),

        object_type:
          "hunt_clue",

        region_name:
          null,

        x:
          Number(r.map_x),

        y:
          Number(r.map_y),

        interaction_radius:
          0,

        inRange:
          distance === 0,

        distance,

        icon:
          r.icon || "🐾",

        description:
          r.description ?? null,

        partyHuntId:
          Number(
            r.party_hunt_id
          ),

        huntName:
          String(
            r.hunt_name ||
            "Hunt"
          )
      };
    }
  );

  return res.json({
    success: true,
    pos: { x: newX, y: newY },
    terrain: tile.terrain,
    region: regionName,
    zoneLevel,
    spawnedResourceNode,
    flavor: terrainFlavor(tile.terrain),

    poi: {
      haven: nearestHaven,
      dungeon: nearestDungeon
    },

    questProgress: {
      enterArea: enterAreaResult
    },

    huntProgress,

    inCombat: !!enemy,
    enemy,

    // Bundled — replaces separate /world/partial fetch
world: {
  player: {
    map_x: newX,
    map_y: newY
  },

  tiles,
  worldObjects,
  resourceNodes,

  huntClues: nearbyHuntClues,
  huntTargets
},

    // Bundled — replaces separate /api/world/nearby-objects fetch
nearbyObjects: [
  ...nearbyObjects,
  ...nearbyHuntClues,
  ...huntTargets
],

    // Bundled — replaces separate /world/current-region fetch
    regionData: tile.region_id ? {
      region_name: regionName ?? "Unknown Region",
      level_min: levelMin,
      level_max: levelMax,
      difficulty,
      controlling_guild_id: controllingGuildId
    } : null
  });
});






router.get("/api/world/nearby-objects", async (req, res) => {
  try {
    const pid =
      (req.session as any)?.playerId;

    if (!pid) {
      return res
        .status(401)
        .json({
          error: "not_logged_in"
        });
    }

    const [[player]]: any =
      await db.query(
        `
          SELECT
            map_x,
            map_y

          FROM players

          WHERE id = ?

          LIMIT 1
        `,
        [pid]
      );

    if (!player) {
      return res
        .status(404)
        .json({
          error: "player_not_found"
        });
    }

    const px =
      Number(player.map_x);

    const py =
      Number(player.map_y);


    /* =========================================
       NORMAL WORLD OBJECTS
    ========================================= */

    const [rows]: any =
      await db.query(
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
        [
          px - 3,
          px + 3,
          py - 3,
          py + 3
        ]
      );


    const objects =
      (rows || []).map(
        (r: any) => {

          const dist =
            Math.abs(
              px - Number(r.x)
            ) +
            Math.abs(
              py - Number(r.y)
            );

          const radius =
            Math.max(
              0,
              Number(
                r.interaction_radius
              ) || 1
            );

          return {
            id:
              Number(r.id),

            name:
              String(
                r.name ||
                "Unknown Object"
              ),

            object_type:
              String(
                r.object_type ||
                "quest"
              ),

            region_name:
              r.region_name ?? null,

            x:
              Number(r.x),

            y:
              Number(r.y),

            interaction_radius:
              radius,

            inRange:
              dist <= radius,

            distance:
              dist,

            icon:
              r.icon ?? null
          };
        }
      );


    /* =========================================
       ACTIVE HUNT CLUES
    ========================================= */

    const [huntClueRows]: any =
      await db.query(
        `
          SELECT
            phc.id,
            phc.map_x,
            phc.map_y,

            hc.name,
            hc.description,
            hc.icon,

            ph.id AS party_hunt_id,
            h.name AS hunt_name

          FROM party_members pm

          JOIN party_hunts ph
            ON ph.party_id =
               pm.party_id

          JOIN hunt_participants hp
            ON hp.party_hunt_id =
               ph.id
           AND hp.player_id =
               pm.player_id

          JOIN party_hunt_clues phc
            ON phc.party_hunt_id =
               ph.id

          JOIN hunt_clues hc
            ON hc.id =
               phc.hunt_clue_id

          JOIN hunts h
            ON h.id =
               ph.hunt_id

          WHERE pm.player_id = ?

            AND ph.status IN (
              'tracking',
              'revealed',
              'engaged'
            )

            AND phc.is_investigated = 0

            AND phc.map_x
              BETWEEN ? AND ?

            AND phc.map_y
              BETWEEN ? AND ?

          ORDER BY
            phc.id ASC
        `,
        [
          pid,
          px - 3,
          px + 3,
          py - 3,
          py + 3
        ]
      );


    const huntClues =
      (huntClueRows || []).map(
        (r: any) => {

          const dist =
            Math.abs(
              px -
              Number(r.map_x)
            ) +
            Math.abs(
              py -
              Number(r.map_y)
            );

          return {
            id:
              Number(r.id),

            name:
              String(
                r.name ||
                "Unknown Clue"
              ),

            object_type:
              "hunt_clue",

            region_name:
              null,

            x:
              Number(r.map_x),

            y:
              Number(r.map_y),

            /*
             * Player must stand directly
             * on the clue.
             */
            interaction_radius:
              0,

            inRange:
              dist === 0,

            distance:
              dist,

            icon:
              r.icon ?? "🐾",

            description:
              r.description ?? null,

            partyHuntId:
              Number(
                r.party_hunt_id
              ),

            huntName:
              String(
                r.hunt_name ||
                "Hunt"
              )
          };
        }
      );

      const huntTargets =
  await getHuntTargetsInRange(
    Number(pid),
    px,
    py,
    3
  );


    /* =========================================
       RESPONSE
    ========================================= */

    return res.json({
      success: true,

      player: {
        x: px,
        y: py
      },

      objects: [
      ...objects,
      ...huntClues,
      ...huntTargets
    ]
    });

  } catch (err) {

    console.error(
      "🔥 GET /api/world/nearby-objects ERROR:",
      err
    );

    return res
      .status(500)
      .json({
        error: "server_error"
      });
  }
});

// =======================
// WORLD PARTIAL
// =======================

router.get("/world/partial", async (req, res) => {
  const pid =
    (req.session as any).playerId;

  if (!pid) {
    return res.status(401).json({
      error: "Not logged in"
    });
  }

  const [[player]]: any =
    await db.query(
      `
        SELECT
          map_x,
          map_y

        FROM players

        WHERE id = ?

        LIMIT 1
      `,
      [pid]
    );

  if (!player) {
    return res.status(404).json({
      error: "Player not found"
    });
  }

  const px =
    Number(player.map_x);

  const py =
    Number(player.map_y);

  const minX = px - 3;
  const maxX = px + 3;
  const minY = py - 3;
  const maxY = py + 3;


  /* =========================================
     WORLD OBJECTS
  ========================================= */

  const [worldObjects]: any =
    await db.query(
      `
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

        ORDER BY
          z_index ASC,
          id ASC
      `,
      [
        minX,
        maxX,
        minY,
        maxY
      ]
    );


  /* =========================================
     WORLD TILES
  ========================================= */

  const [tiles]: any =
    await db.query(
      `
        SELECT *

        FROM world_map

        WHERE x BETWEEN ? AND ?
          AND y BETWEEN ? AND ?
      `,
      [
        minX,
        maxX,
        minY,
        maxY
      ]
    );


  /* =========================================
     RESOURCE NODES
  ========================================= */

  const resourceNodes =
    await getResourceNodesInRange(
      Number(pid),
      px,
      py,
      3
    );

const huntTargets =
  await getHuntTargetsInRange(
    Number(pid),
    px,
    py,
    3
  );

  /* =========================================
     ACTIVE HUNT CLUES
  ========================================= */

  const [huntClueRows]: any =
    await db.query(
      `
        SELECT
          phc.id,
          phc.map_x,
          phc.map_y,

          hc.name,
          hc.description,
          hc.icon,

          ph.id AS party_hunt_id,
          h.name AS hunt_name

        FROM party_members pm

        JOIN party_hunts ph
          ON ph.party_id =
             pm.party_id

        JOIN hunt_participants hp
          ON hp.party_hunt_id =
             ph.id
         AND hp.player_id =
             pm.player_id

        JOIN party_hunt_clues phc
          ON phc.party_hunt_id =
             ph.id

        JOIN hunt_clues hc
          ON hc.id =
             phc.hunt_clue_id

        JOIN hunts h
          ON h.id =
             ph.hunt_id

        WHERE pm.player_id = ?

          AND ph.status IN (
            'tracking',
            'revealed',
            'engaged'
          )

          AND phc.is_investigated = 0

          AND phc.map_x
            BETWEEN ? AND ?

          AND phc.map_y
            BETWEEN ? AND ?

        ORDER BY
          phc.id ASC
      `,
      [
        pid,
        minX,
        maxX,
        minY,
        maxY
      ]
    );


  const huntClues =
    (huntClueRows || []).map(
      (row: any) => {

        const distance =
          Math.abs(
            px -
            Number(row.map_x)
          ) +
          Math.abs(
            py -
            Number(row.map_y)
          );

        return {
          id:
            Number(row.id),

          name:
            String(
              row.name ||
              "Unknown Clue"
            ),

          object_type:
            "hunt_clue",

          x:
            Number(row.map_x),

          y:
            Number(row.map_y),

          distance,

          inRange:
            distance === 0,

          interaction_radius:
            0,

          icon:
            row.icon || "🐾",

          description:
            row.description ?? null,

          partyHuntId:
            Number(
              row.party_hunt_id
            ),

          huntName:
            String(
              row.hunt_name ||
              "Hunt"
            )
        };
      }
    );


  /* =========================================
     RESPONSE
  ========================================= */

  return res.json({
    player,
    tiles,
    worldObjects,
    resourceNodes,
    huntClues,
    huntTargets
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