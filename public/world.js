// public/world.js

let pendingCombatEnemy = null;
let lastMoveDir = null;

// ✅ Movement cooldown
const MOVE_COOLDOWN_MS = 500;
let lastMoveAt = 0;
let moveLock = false;

let currentResourceNode = null;

let dungeonReadyCheck = null;
let dungeonReadySelfId = null;
let dungeonReadyPollTimer = null;
let dungeonReadyCountdownTimer = null;
let dungeonReadyBusy = false;
let dungeonReadyTransitioning = false;

let dungeonSocket = null;
let dungeonSocketBound = false;

/*
 * Once a ready check resolves, never allow an older pending snapshot
 * for that same check to render again. This protects against an
 * in-flight REST poll finishing after the websocket completion event.
 */
const resolvedDungeonReadyCheckIds =
  new Set();

let dungeonReadyFetchGeneration =
  0;

// =======================
// INIT
// =======================
document.addEventListener("DOMContentLoaded", initWorldPage);

async function initWorldPage() {
  bindLoreModal();

  /*
   * Bind Dungeon websocket before checking REST state so incoming
   * party ready checks can appear as soon as possible.
   */
  void connectDungeonSocket();

  try {
    const res = await fetch("/combat/state", {
      credentials: "include"
    });
    const data = await res.json();

    if (data?.inCombat && data?.enemy) {
      openCombatModal(data.enemy);
      return;
    }

    const restoredDungeonReady =
      await fetchDungeonReadyCheck();

    if (
      restoredDungeonReady?.status ===
      "pending"
    ) {
      startDungeonReadyPolling();
    }

    const dungeonResponse =
      await fetch(
        "/api/dungeons/active",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const dungeonData =
      await dungeonResponse.json();

    await refreshWorld();

    if (
      dungeonResponse.ok &&
      dungeonData?.dungeon &&
      typeof openDungeonModal ===
        "function"
    ) {
      await openDungeonModal();
      return;
    }
  } catch (err) {
    console.error("World init failed", err);
  }
}

function bindLoreModal() {
  const loreCloseBtn = document.getElementById("loreCloseBtn");
  const loreOkBtn = document.getElementById("loreOkBtn");
  const loreBackdrop = document.querySelector("#loreModal .lore-backdrop");

  loreCloseBtn?.addEventListener("click", closeLoreModal);
  loreOkBtn?.addEventListener("click", closeLoreModal);
  loreBackdrop?.addEventListener("click", closeLoreModal);
}

// =======================
// HUD / NAV
// =======================
function updateNavHUD(data) {
  const haven = data?.poi?.haven;
  const dungeon = data?.poi?.dungeon;

  // Haven
  const havenName = document.getElementById("nav-haven-name");
  const havenDist = document.getElementById("nav-haven-dist");
  const havenArrow = document.getElementById("nav-haven-arrow");

  if (havenName) havenName.textContent = haven?.name ?? "—";
  if (havenDist) havenDist.textContent = haven ? `${haven.distance} tiles` : "— tiles";
  if (havenArrow) havenArrow.textContent = haven?.arrow ?? "•";

  // Dungeon
  const dunName = document.getElementById("nav-dungeon-name");
  const dunDist = document.getElementById("nav-dungeon-dist");
  const dunArrow = document.getElementById("nav-dungeon-arrow");

  if (dungeon) {
    if (dunName) dunName.textContent = dungeon.name ?? "Unknown";
    if (dunDist) dunDist.textContent = `${dungeon.distance} tiles`;
    if (dunArrow) dunArrow.textContent = dungeon.arrow ?? "•";
  } else {
    if (dunName) dunName.textContent = "Coming Soon";
    if (dunDist) dunDist.textContent = "—";
    if (dunArrow) dunArrow.textContent = "•";
  }

  // Travel flavor
  const flavor = document.getElementById("movement-flavor");
  if (flavor) flavor.textContent = data?.flavor ?? "You press onward.";
}

function animateStep(dir) {
  const grid = document.getElementById("Grid");
  if (!grid) return;

  const map = {
    north: [0, 10],
    south: [0, -10],
    west: [10, 0],
    east: [-10, 0]
  };

  const v = map[dir] || [0, 0];

  grid.animate(
    [
      { transform: `translate(${v[0]}px, ${v[1]}px)` },
      { transform: "translate(0px, 0px)" }
    ],
    { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" }
  );
}

function normalizeMoveDir(dir) {
  return dir === "north" || dir === "south" || dir === "west" || dir === "east"
    ? dir
    : "";
}
function showHuntProgress(progress) {
  if (
    !progress ||
    !progress.advanced
  ) {
    return;
  }

  if (!window.GFToast?.show) {
    return;
  }

  const trackingText =
    `${progress.trackingProgress}/${progress.trackingRequired} Tracking`;

  if (progress.objectiveComplete) {
    GFToast.show(
      "Hunt Objective Complete",
      `+${progress.trackingGain} Tracking • ${trackingText}`,
      {
        type: "success",
        durationMs: 3000
      }
    );
  } else {
    GFToast.show(
      "Hunt Progress",
      `+${progress.trackingGain} Tracking • ${trackingText}`,
      {
        type: "success",
        durationMs: 2400
      }
    );
  }

  if (progress.targetRevealed) {
    setTimeout(() => {
      GFToast.show(
        "Quarry Located",
        "The trail is complete. Your party has discovered its target.",
        {
          type: "success",
          durationMs: 4500
        }
      );
    }, 650);
  }
}

window.showHuntProgress =
  showHuntProgress;
// =======================
// COMBAT HELPERS
// =======================
function isInCombat() {
  const combatModal =
    document.getElementById(
      "combatModal"
    );

  const huntCombatModal =
    document.getElementById(
      "huntCombatModal"
    );

  const normalCombatActive =
    Boolean(
      combatModal &&
      !combatModal.classList.contains(
        "hidden"
      )
    );

  const huntCombatActive =
    Boolean(
      huntCombatModal &&
      !huntCombatModal.classList.contains(
        "hidden"
      )
    );

  const dungeonModal =
    document.getElementById(
      "dungeonModal"
    );

  const dungeonActive =
    Boolean(
      dungeonModal &&
      !dungeonModal.classList.contains(
        "hidden"
      )
    );

  const dungeonReadyModal =
    document.getElementById(
      "dungeonReadyModal"
    );

  const dungeonReadyActive =
    Boolean(
      dungeonReadyModal &&
      !dungeonReadyModal.classList.contains(
        "hidden"
      )
    );

  return (
    normalCombatActive ||
    huntCombatActive ||
    dungeonActive ||
    dungeonReadyActive
  );
}

function queueCombatOpen() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (pendingCombatEnemy) {
        openCombatModal(pendingCombatEnemy);
        pendingCombatEnemy = null;
      }
    });
  });
}



function professionActionLabel(professionName) {
  switch (String(professionName || "").toLowerCase()) {
    case "mining":
      return "Mining...";
    case "herbalism":
      return "Harvesting...";
    case "woodcutting":
      return "Chopping...";
    default:
      return "Gathering...";
  }
}

function playGatheringSound(professionName) {
  let file;

  switch (String(professionName || "").toLowerCase()) {
    case "mining":
      file = "/sounds/gathering/mining2.ogg";
      break;

    case "herbalism":
      file = "/sounds/gathering/herbalism2.ogg";
      break;

    case "woodcutting":
      file = "/sounds/gathering/woodcutting2.ogg";
      break;

    default:
      return null;
  }



  const audio = new Audio(file);
  audio.volume = 0.5;
  audio.loop = true;

  audio.play().catch(() => {});

  return audio;
}

function playGatherCompleteSound() {
  const audio = new Audio("/sounds/gathering/collected.ogg");
  audio.volume = 0.6;
  audio.play().catch(() => {});
}

function playProfessionLevelSound() {
  const audio = new Audio("/sounds/profession-level.ogg");
  audio.volume = 0.65;
  audio.play().catch(() => {});
}
function showGatheringModal({ professionName, nodeName, durationMs }) {
  const modal = document.getElementById("gatheringModal");
  const icon = document.getElementById("gatheringModalIcon");
  const title = document.getElementById("gatheringModalTitle");
  const sub = document.getElementById("gatheringModalSub");
  const fill = document.getElementById("gatheringProgressFill");

  if (!modal || !icon || !title || !sub || !fill) return;



  icon.textContent = getResourceIcon(professionName);
  title.textContent = professionActionLabel(professionName);
  sub.textContent = nodeName || "Gathering resources";

  fill.style.transition = "none";
  fill.style.width = "0%";

  modal.classList.remove("hidden");

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.transition = `width ${durationMs}ms linear`;
      fill.style.width = "100%";
    });
  });
}

function hideGatheringModal() {
  const modal = document.getElementById("gatheringModal");
  if (modal) modal.classList.add("hidden");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}







// =======================
// ENEMY PORTRAIT
// =======================
function applyEnemyPortrait(enemy) {
  const img = document.getElementById("enemyPortrait");
  if (!img) return;

  let src = enemy?.img || "/images/default_creature.png";

  if (src && !src.startsWith("/") && !src.startsWith("http")) {
    src = "/" + src;
  }

  img.src = src;
  img.onerror = () => {
    img.onerror = null;
    img.src = "/images/default_creature.png";
  };
}

// =======================
// WORLD HEADER
// =======================
async function loadRegionName() {
  try {
    const res = await fetch("/world/current-region", {
      credentials: "include"
    });
    const data = await res.json();
    renderRegionHeader(data);
  } catch (err) {
    console.error("Failed to load region name", err);
  }
}

// Accepts either a /world/current-region response or a regionData block from /world/move
function renderRegionHeader(data) {
  const title =
    document.getElementById(
      "world-title"
    );

  if (!title || !data) {
    return;
  }

  /*
   * Normal regions/towns must NEVER retain
   * Dungeon-specific title styling.
   */
  title.classList.remove(
    "world-title--dungeon"
  );

  const min =
    Number(
      data.level_min ?? 1
    );

  const max =
    Number(
      data.level_max ?? min
    );

  const band =
    min === max
      ? `Lv ${min}`
      : `Lv ${min}–${max}`;

  const name =
    data.region_name ??
    "Unknown Region";

  title.textContent =
    `${name} (${band})`;

  title.classList.remove(
    "zone-easy",
    "zone-even",
    "zone-hard"
  );

  const diff =
    String(
      data.difficulty ||
      "even"
    ).toLowerCase();

  title.classList.add(
    diff === "easy"
      ? "zone-easy"
      : diff === "hard"
        ? "zone-hard"
        : "zone-even"
  );
}


async function renderDungeonWorldHeaderIfNeeded(
  terrain
) {
  if (
    String(
      terrain ||
      ""
    ).toLowerCase() !==
    "dungeon"
  ) {
    return false;
  }

  try {
    const response =
      await fetch(
        "/world/current-dungeon",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      data.ok === false ||
      !data.dungeon?.name
    ) {
      return false;
    }

    const dungeon =
      data.dungeon;

    const title =
      document.getElementById(
        "world-title"
      );

    if (!title) {
      return true;
    }

    title.classList.add(
  "world-title--dungeon"
);

    const minLevel =
      Math.max(
        1,
        Number(
          dungeon.min_level ??
          1
        ) || 1
      );

    const maxLevel =
      dungeon.max_level ==
        null
        ? null
        : Math.max(
            minLevel,
            Number(
              dungeon.max_level
            ) ||
            minLevel
          );

    const levelBand =
      maxLevel == null
        ? `Lv ${minLevel}+`
        : minLevel ===
          maxLevel
          ? `Lv ${minLevel}`
          : `Lv ${minLevel}–${maxLevel}`;

    title.textContent =
      `${dungeon.name} (${levelBand})`;

    title.classList.remove(
      "zone-easy",
      "zone-even",
      "zone-hard"
    );

    title.classList.add(
      "zone-even"
    );

    return true;
  } catch (error) {
    console.warn(
      "Unable to render Dungeon world header:",
      error
    );

    return false;
  }
}

// =======================
// SPRITE / OBJECT HELPERS
// =======================
function normalizeSpritePath(src) {
  if (!src) return null;
  return src.startsWith("/") ? src : `/${src}`;
}

function buildWorldObjectMap(worldObjects) {
  const map = new Map();

  for (const obj of worldObjects || []) {
    const key = `${Number(obj.x)},${Number(obj.y)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(obj);
  }

  for (const [, list] of map) {
    list.sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  }

  return map;
}

function getTileVisualData(x, y, objectMap) {
  const key = `${x},${y}`;
  const objects = objectMap.get(key) || [];

  let replaceSprite = null;
  const overlays = [];

  for (const obj of objects) {
    const sprite = normalizeSpritePath(obj.tile_sprite);
    const visualType = String(obj.tile_visual_type || "none").toLowerCase();

    if (!sprite || visualType === "none") continue;

    if (visualType === "replace") {
      replaceSprite = sprite;
    } else if (visualType === "overlay") {
      overlays.push(sprite);
    }
  }

  return { replaceSprite, overlays };
}

// =======================
// WORLD RENDER
// =======================
function renderCurrentResourcePanel(player, resourceNodes) {
  const panel = document.getElementById("currentResourcePanel");
  if (!panel) return;

  const node = (resourceNodes || []).find(n =>
    Number(n.map_x) === Number(player.map_x) &&
    Number(n.map_y) === Number(player.map_y)
  );

  if (!node) {
    currentResourceNode = null;
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  currentResourceNode = node;
  panel.hidden = false;

  const displayName = node.affixName
    ? `${node.affixName} ${node.nodeName}`
    : node.nodeName;

  panel.innerHTML = `
    <div class="resource-panel__head">
      <div class="resource-panel__icon">${getResourceIcon(node.professionName)}</div>
      <div>
        <div class="resource-panel__name">${escapeHtml(displayName)}</div>
        <div class="resource-panel__sub">
          ${escapeHtml(node.professionName)} • ${escapeHtml(node.rarity || "common")} • Uses: ${Number(node.remaining_uses || 0)}
        </div>
      </div>
    </div>

    <div class="resource-panel__body">
      <div class="resource-panel__desc">
        ${escapeHtml(node.description || "A harvestable resource node.")}
      </div>

      <div class="resource-panel__meta">
        Required Level: ${Number(node.required_level || 1)}
      </div>

      <button class="resource-panel__btn" onclick="gatherResourceNode(${Number(node.spawnedNodeId)})">
        Gather
      </button>
    </div>
  `;
}


// Shared render logic — used by both refreshWorld() and moveWorld()
function renderWorldFromData({
  player,
  tiles,
  guildMap,
  worldObjects,
  resourceNodes,
  huntClues = [],
  huntTargets = []
}) {
  const tileMap = {};

  for (const t of tiles || []) {
    tileMap[
      `${t.x},${t.y}`
    ] = t;
  }


  const objectMap =
    buildWorldObjectMap(
      worldObjects || []
    );


  const resourceMap =
    new Map();

  for (
    const node of
    resourceNodes || []
  ) {
    const key =
      `${Number(node.map_x)},${Number(node.map_y)}`;

    resourceMap.set(
      key,
      node
    );
  }


  const huntClueMap =
    new Map();

  for (
    const clue of
    huntClues || []
  ) {
    const key =
      `${Number(clue.x)},${Number(clue.y)}`;

    huntClueMap.set(
      key,
      clue
    );
  }


  const huntTargetMap =
    new Map();

  for (
    const target of
    huntTargets || []
  ) {
    const key =
      `${Number(target.x)},${Number(target.y)}`;

    huntTargetMap.set(
      key,
      target
    );
  }


  const grid =
    document.getElementById(
      "Grid"
    );

  if (!grid) return;

  const html = [];

  const minX =
    Number(player.map_x) - 3;

  const minY =
    Number(player.map_y) - 3;

  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const x = minX + c;
      const y = minY + r;
      const t = tileMap[`${x},${y}`];

      if (!t) {
        html.push(`<div class="tile"></div>`);
        continue;
      }

      const isPlayer = x === Number(player.map_x) && y === Number(player.map_y);
      const resourceNode =
        resourceMap.get(
          `${x},${y}`
        );

      const huntClue =
        huntClueMap.get(
          `${x},${y}`
        );

      const huntTarget =
        huntTargetMap.get(
          `${x},${y}`
        );

      const {
        replaceSprite,
        overlays
      } =
        getTileVisualData(
          x,
          y,
          objectMap
        );

      const terrainClass = replaceSprite ? "" : t.terrain;
      const baseStyle = replaceSprite
        ? ` style="background-image: url('${escapeHtml(replaceSprite)}');"`
        : "";

      const huntClueHtml =
  huntClue
    ? `
      <div
        class="hunt-clue-marker"
        title="${escapeHtml(huntClue.name)}"
      >
        ${
          huntClue.icon &&
          String(huntClue.icon).startsWith("/")
            ? `
              <img
                src="${escapeHtml(huntClue.icon)}"
                alt=""
              >
            `
            : `
              <span>
                ${escapeHtml(
                  huntClue.icon || "🐾"
                )}
              </span>
            `
        }
      </div>
    `
    : "";

    const huntTargetHtml =
  huntTarget
    ? `
      <div
        class="hunt-target-marker"
        title="${escapeHtml(
          huntTarget.name ||
          "Hunt Target"
        )}"
      >
        ${
          huntTarget.image
            ? `
              <img
                src="${escapeHtml(
                  huntTarget.image
                )}"
                alt=""
                onerror="
                  this.onerror=null;
                  this.src='/images/default_creature.png';
                "
              >
            `
            : `
              <span
                class="hunt-target-marker__symbol"
              >
                ☠
              </span>
            `
        }

        <span
          class="hunt-target-marker__badge"
        >
          HUNT
        </span>
      </div>
    `
    : "";

      const overlayHtml = overlays.map(src => `
        <img class="tile-overlay" src="${escapeHtml(src)}" alt="">
      `).join("");

      const resourceHtml = resourceNode ? `
        <div
          class="resource-node-marker"
          title="${escapeHtml(resourceNode.nodeName)}"
        >
          <img
            src="${escapeHtml(resourceNode.image)}"
            class="resource-node-image resource-${escapeHtml((resourceNode.affixName || "common").toLowerCase())}"
            alt="${escapeHtml(resourceNode.nodeName)}"
          >
        </div>
      ` : "";

      /*
       * Dungeon entrances use the terrain artwork itself:
       * /images/map_tiles/dungeon.webp
       */
      const dungeonHtml =
        "";

      html.push(`
        <div
          class="tile ${escapeHtml(terrainClass)} ${isPlayer ? "player" : ""} ${isPlayer && lastMoveDir ? `moving-${lastMoveDir}` : ""}"
          data-x="${x}"
          data-y="${y}"${baseStyle}
        >
          ${overlayHtml}
          ${resourceHtml}
          ${dungeonHtml}
          ${huntClueHtml}
          ${huntTargetHtml}
        </div>
      `);
    }
  }

  grid.innerHTML = html.join("");

  const currentTile = tileMap[`${player.map_x},${player.map_y}`];

  const enterTownBtn =
    document.getElementById(
      "enter-town-btn"
    );

  const enterDungeonBtn =
    document.getElementById(
      "enter-dungeon-btn"
    );

  const currentTerrain =
    String(
      currentTile?.terrain ||
      ""
    ).toLowerCase();

  if (enterTownBtn) {
    enterTownBtn.style.display =
      currentTerrain === "town"
        ? "inline-block"
        : "none";
  }

  if (enterDungeonBtn) {
    enterDungeonBtn.style.display =
      currentTerrain === "dungeon"
        ? "inline-block"
        : "none";
  }

  if (
    currentTerrain ===
    "dungeon"
  ) {
    void renderDungeonWorldHeaderIfNeeded(
      currentTerrain
    );
  }

  const coords = document.querySelector(".coords");
  if (coords) {
    coords.textContent = `Position: (${player.map_x}, ${player.map_y})`;
  }

  renderCurrentResourcePanel(player, resourceNodes || []);
}

// Initial page load — still fetches /world/partial directly
async function refreshWorld() {
  const res = await fetch("/world/partial", {
    credentials: "include"
  });

  const data = await res.json();

  renderWorldFromData(data);
  updateNavHUD(data);

  // NEW
  await loadNearbyObjects();
}

function enterTown() {
  window.location.href = "/town/enter";
}

let enteringDungeon =
  false;


async function connectDungeonSocket() {
  if (
    dungeonSocketBound &&
    dungeonSocket
  ) {
    return dungeonSocket;
  }

  try {
    let socket =
      window.GFSocket;

    if (
      !socket &&
      window.GFSocketReady
    ) {
      socket =
        await window.GFSocketReady;
    }

    if (
      !socket ||
      typeof socket.on !==
        "function"
    ) {
      console.warn(
        "Dungeon websocket is unavailable."
      );

      return null;
    }

    dungeonSocket =
      socket;

    if (
      !dungeonSocketBound
    ) {
      dungeonSocketBound =
        true;

      /*
       * Every ready-check mutation is pushed here immediately.
       * This is what makes the modal appear for party members
       * without them clicking Enter Dungeon themselves.
       */
      socket.on(
        "dungeon:ready-check",
        async (
          payload
        ) => {
          const check =
            payload?.readyCheck;

          if (
            !check
          ) {
            return;
          }

          const incomingReadyCheckId =
            Number(
              check.id
            );

          if (
            resolvedDungeonReadyCheckIds.has(
              incomingReadyCheckId
            )
          ) {
            return;
          }

          const me =
            (
              check.players ??
              []
            ).find(
              player =>
                Number(
                  player.playerId
                ) ===
                Number(
                  window.__PLAYER_ID__ ??
                  dungeonReadySelfId
                )
            );

          /*
           * Ignore malformed broadcasts not containing this player.
           * The server already targets frozen roster members directly,
           * but this protects us from stale party-room subscriptions.
           */
          const sameVisibleCheck =
            Number(
              dungeonReadyCheck?.id
            ) ===
            Number(
              check.id
            );

          if (
            !me &&
            !sameVisibleCheck
          ) {
            return;
          }

          if (
            me
          ) {
            dungeonReadySelfId =
              Number(
                me.playerId
              );
          }

          /*
           * A completed ready check must NEVER be rendered again.
           * Rendering first would remove .hidden and put the ready
           * modal back over the newly-opened Dungeon modal.
           */
          if (
            check.status ===
            "completed"
          ) {
            const resolvedId =
              Number(
                check.id
              );

            if (
              Number.isInteger(
                resolvedId
              ) &&
              resolvedId > 0
            ) {
              resolvedDungeonReadyCheckIds.add(
                resolvedId
              );
            }

            dungeonReadyFetchGeneration++;

            document
              .getElementById(
                "dungeonReadyModal"
              )
              ?.remove();

            await transitionDungeonReadyCheck(
              check
            );

            return;
          }

          renderDungeonReadyCheck(
            check
          );

          if (
            check.status ===
              "cancelled" ||
            check.status ===
              "expired"
          ) {
            setTimeout(
              closeDungeonReadyModal,
              900
            );
          }
        }
      );

      socket.on(
        "dungeon:ready-check-resolved",
        async (
          payload
        ) => {
          const check =
            payload?.readyCheck;

          if (
            !check
          ) {
            return;
          }

          /*
           * This event is emitted directly to every frozen ready-check
           * participant's private player socket room. Do not gate it on
           * dungeonReadySelfId: a non-initiating player may receive this
           * before their fallback REST poll ever learns their own ID.
           */
          if (
            check.status ===
            "completed"
          ) {
            const resolvedId =
              Number(
                check.id
              );

            if (
              Number.isInteger(
                resolvedId
              ) &&
              resolvedId > 0
            ) {
              resolvedDungeonReadyCheckIds.add(
                resolvedId
              );
            }

            dungeonReadyFetchGeneration++;

            document
              .getElementById(
                "dungeonReadyModal"
              )
              ?.remove();

            await transitionDungeonReadyCheck(
              check
            );

            return;
          }

          if (
            check.status ===
              "cancelled" ||
            check.status ===
              "expired"
          ) {
            renderDungeonReadyCheck(
              check
            );

            setTimeout(
              closeDungeonReadyModal,
              700
            );
          }
        }
      );


      socket.on(
        "dungeon:changed",
        async () => {
          /*
           * Reserved for broader Dungeon lifecycle updates.
           * Refresh active Dungeon state when we begin using this event.
           */
        }
      );

      socket.on(
        "connect",
        () => {
          socket.emit(
            "dungeon:subscribe"
          );
        }
      );
    }

    /*
     * Subscribe immediately if already connected. This joins the
     * current Dungeon party room for future party-wide updates.
     */
    if (
      socket.connected
    ) {
      socket.emit(
        "dungeon:subscribe"
      );
    }

    return socket;
  } catch (
    error
  ) {
    console.error(
      "Dungeon websocket setup failed:",
      error
    );

    return null;
  }
}


function ensureDungeonReadyModal() {
  let modal = document.getElementById("dungeonReadyModal");

  if (modal) return modal;

  document.body.insertAdjacentHTML("beforeend", `
    <div id="dungeonReadyModal" class="dungeon-ready-modal hidden" role="dialog" aria-modal="true">
      <div class="dungeon-ready-backdrop" aria-hidden="true"></div>

      <section class="dungeon-ready-card frame-host">
        <span class="frame-border panel" aria-hidden="true"></span>

        <header class="dungeon-ready-header">
          <div>
            <div class="dungeon-ready-kicker">Dungeon Expedition</div>
            <h2 id="dungeonReadyTitle">Ready Check</h2>
          </div>

          <div id="dungeonReadyCountdown" class="dungeon-ready-countdown">0:30</div>
        </header>

        <div class="dungeon-ready-content">
          <p id="dungeonReadyStatus" class="dungeon-ready-status">
            Waiting for the party...
          </p>

          <div id="dungeonReadyParticipants" class="dungeon-ready-participants"></div>
          <div id="dungeonReadyError" class="dungeon-ready-error" hidden></div>
        </div>

        <footer class="dungeon-ready-footer">
          <button id="dungeonReadyToggleBtn" class="dungeon-btn dungeon-btn--primary" type="button">
            Ready
          </button>

          <button id="dungeonReadyCancelBtn" class="dungeon-btn dungeon-btn--ghost" type="button">
            Cancel
          </button>
        </footer>
      </section>
    </div>
  `);

  modal = document.getElementById("dungeonReadyModal");

  document.getElementById("dungeonReadyToggleBtn")
    ?.addEventListener("click", toggleDungeonReadyState);

  document.getElementById("dungeonReadyCancelBtn")
    ?.addEventListener("click", cancelDungeonReadyCheck);

  return modal;
}

function showDungeonReadyError(message = "") {
  const root = document.getElementById("dungeonReadyError");
  if (!root) return;

  root.hidden = !message;
  root.textContent = message;
}

function stopDungeonReadyTimers() {
  if (dungeonReadyPollTimer) {
    clearInterval(dungeonReadyPollTimer);
    dungeonReadyPollTimer = null;
  }

  if (dungeonReadyCountdownTimer) {
    clearInterval(dungeonReadyCountdownTimer);
    dungeonReadyCountdownTimer = null;
  }
}

function closeDungeonReadyModal() {
  stopDungeonReadyTimers();

  dungeonReadyCheck =
    null;

  dungeonReadyBusy =
    false;

  enteringDungeon =
    false;

  document
    .getElementById(
      "dungeonReadyModal"
    )
    ?.remove();
}

function renderDungeonReadyCountdown() {
  const root = document.getElementById("dungeonReadyCountdown");
  if (!root || !dungeonReadyCheck) return;

  if (dungeonReadyCheck.status !== "pending") {
    root.textContent = "0:00";
    return;
  }

  const remaining = Math.max(
    0,
    new Date(dungeonReadyCheck.expiresAt).getTime() - Date.now()
  );

  const seconds = Math.ceil(remaining / 1000);

  root.textContent = `0:${String(seconds).padStart(2, "0")}`;
}

function renderDungeonReadyCheck(check) {
  if (!check) {
    return;
  }

  const readyCheckId =
    Number(
      check.id
    );

  const dungeonModal =
    document.getElementById(
      "dungeonModal"
    );

  const dungeonAlreadyOpen =
    Boolean(
      dungeonModal &&
      !dungeonModal.classList.contains(
        "hidden"
      )
    );

  /*
   * Never recreate the ready-check modal after this check has
   * completed, and never allow any ready-check UI to sit over
   * an already-open Dungeon session.
   */
  if (
    resolvedDungeonReadyCheckIds.has(
      readyCheckId
    ) ||
    dungeonAlreadyOpen
  ) {
    document
      .getElementById(
        "dungeonReadyModal"
      )
      ?.remove();

    return;
  }

  dungeonReadyCheck = check;

  const modal = ensureDungeonReadyModal();
  modal?.classList.remove("hidden");

  const title = document.getElementById("dungeonReadyTitle");
  if (title) title.textContent = check.dungeonName || "Dungeon Ready Check";

  const players = Array.isArray(check.players) ? check.players : [];
  const readyCount = players.filter(player => player.isReady).length;

  const status = document.getElementById("dungeonReadyStatus");

  if (status) {
    status.textContent =
      check.status === "pending"
        ? `${readyCount} of ${players.length} adventurers ready`
        : check.status === "completed"
          ? "The expedition is entering the dungeon..."
          : check.status === "expired"
            ? "The ready check expired."
            : "The ready check was cancelled.";
  }

  const list = document.getElementById("dungeonReadyParticipants");

  if (list) {
    list.innerHTML = players.map(player => `
      <div class="dungeon-ready-player ${player.isReady ? "is-ready" : ""}">
        <div>
          <strong>${escapeHtml(player.name)}</strong>
          <span>
            ${player.className ? `${escapeHtml(player.className)} • ` : ""}
            Lv. ${Number(player.level)}
          </span>
        </div>

        <div class="dungeon-ready-player__state">
          ${player.isReady ? "✓ Ready" : "… Waiting"}
        </div>
      </div>
    `).join("");
  }

  const me = players.find(
    player => Number(player.playerId) === Number(dungeonReadySelfId)
  );

  const toggle = document.getElementById("dungeonReadyToggleBtn");

  if (toggle) {
    toggle.disabled = dungeonReadyBusy || check.status !== "pending";
    toggle.textContent = me?.isReady ? "Unready" : "Ready";
  }

  const cancel = document.getElementById("dungeonReadyCancelBtn");

  if (cancel) {
    const canCancel =
      Number(check.createdByPlayerId) === Number(dungeonReadySelfId) ||
      Boolean(me?.isLeader);

    cancel.style.display = canCancel ? "inline-block" : "none";
    cancel.disabled = dungeonReadyBusy || check.status !== "pending";
  }

  renderDungeonReadyCountdown();
}

async function transitionDungeonReadyCheck(check) {
  if (
    check?.status !== "completed" ||
    !check.instanceId
  ) {
    return;
  }

  const readyCheckId =
    Number(
      check.id
    );

  /*
   * Mark this check resolved immediately. Any older pending snapshot
   * already in flight will be ignored when it eventually returns.
   */
  if (
    Number.isInteger(
      readyCheckId
    ) &&
    readyCheckId > 0
  ) {
    resolvedDungeonReadyCheckIds.add(
      readyCheckId
    );
  }

  dungeonReadyFetchGeneration++;

  if (
    dungeonReadyTransitioning
  ) {
    /*
     * Even if another completion handler is already opening the
     * Dungeon, make absolutely sure this overlay is gone.
     */
    document
      .getElementById(
        "dungeonReadyModal"
      )
      ?.remove();

    return;
  }

  dungeonReadyTransitioning =
    true;

  stopDungeonReadyTimers();

  dungeonReadyCheck =
    null;

  dungeonReadyBusy =
    false;

  enteringDungeon =
    false;

  document
    .getElementById(
      "dungeonReadyModal"
    )
    ?.remove();

  try {
    if (
      typeof openDungeonModal ===
      "function"
    ) {
      await openDungeonModal();
    } else {
      window.location.href =
        "/dungeon";

      return;
    }

    /*
     * Final DOM guarantee. If an old async render raced with the
     * Dungeon opening, remove the ready overlay again afterward.
     */
    document
      .getElementById(
        "dungeonReadyModal"
      )
      ?.remove();
  } catch (error) {
    console.error(
      "Failed to transition into Dungeon:",
      error
    );
  } finally {
    dungeonReadyTransitioning =
      false;
  }
}

async function fetchDungeonReadyCheck() {
  const fetchGeneration =
    dungeonReadyFetchGeneration;

  try {
    const response =
      await fetch(
        "/api/dungeons/ready-check",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const data =
      await response.json();

    /*
     * A completion event happened while this request was in flight.
     * Its response is now stale and must not touch the ready UI.
     */
    if (
      fetchGeneration !==
      dungeonReadyFetchGeneration
    ) {
      return null;
    }

    if (
      !response.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to load Dungeon ready check."
      );
    }

    dungeonReadySelfId =
      Number(
        data.playerId ||
        0
      ) ||
      dungeonReadySelfId;

    if (
      !data.readyCheck
    ) {
      if (
        dungeonReadyCheck
      ) {
        try {
          const activeResponse =
            await fetch(
              "/api/dungeons/active",
              {
                credentials:
                  "include",
                cache:
                  "no-store"
              }
            );

          const activeData =
            await activeResponse.json();

          if (
            fetchGeneration !==
            dungeonReadyFetchGeneration
          ) {
            return null;
          }

          if (
            activeResponse.ok &&
            activeData?.dungeon
          ) {
            stopDungeonReadyTimers();

            dungeonReadyCheck =
              null;

            dungeonReadyBusy =
              false;

            enteringDungeon =
              false;

            document
              .getElementById(
                "dungeonReadyModal"
              )
              ?.remove();

            if (
              typeof openDungeonModal ===
              "function"
            ) {
              await openDungeonModal();
            } else {
              window.location.href =
                "/dungeon";
            }

            document
              .getElementById(
                "dungeonReadyModal"
              )
              ?.remove();

            return null;
          }
        } catch (
          activeError
        ) {
          console.warn(
            "Could not verify Dungeon after ready-check cleanup:",
            activeError
          );
        }

        closeDungeonReadyModal();
      }

      return null;
    }

    const readyCheckId =
      Number(
        data.readyCheck.id
      );

    if (
      resolvedDungeonReadyCheckIds.has(
        readyCheckId
      )
    ) {
      return null;
    }

    if (
      data.readyCheck.status ===
      "completed"
    ) {
      await transitionDungeonReadyCheck(
        data.readyCheck
      );

      return data.readyCheck;
    }

    renderDungeonReadyCheck(
      data.readyCheck
    );

    if (
      data.readyCheck.status !==
      "pending"
    ) {
      setTimeout(
        closeDungeonReadyModal,
        900
      );
    }

    return data.readyCheck;
  } catch (error) {
    console.warn(
      "Dungeon ready-check refresh failed:",
      error
    );

    return null;
  }
}

function startDungeonReadyPolling() {
  stopDungeonReadyTimers();

  /*
   * WebSocket is authoritative for live updates.
   * This slow poll is only a reconnect/fallback safety net.
   */
  dungeonReadyPollTimer = window.setInterval(
    fetchDungeonReadyCheck,
    5000
  );

  dungeonReadyCountdownTimer = window.setInterval(
    renderDungeonReadyCountdown,
    200
  );
}

async function toggleDungeonReadyState() {
  if (
    dungeonReadyBusy ||
    !dungeonReadyCheck ||
    dungeonReadyCheck.status !== "pending"
  ) {
    return;
  }

  dungeonReadyBusy = true;
  showDungeonReadyError("");

  try {
    const me = dungeonReadyCheck.players?.find(
      player => Number(player.playerId) === Number(dungeonReadySelfId)
    );

    const response = await fetch("/api/dungeons/ready-check/ready", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ready: !Boolean(me?.isReady)
      })
    });

    const data = await response.json();

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Unable to update ready state.");
    }

    dungeonReadySelfId = Number(data.playerId || 0) || dungeonReadySelfId;
    renderDungeonReadyCheck(data.readyCheck);

    if (data.readyCheck?.status === "completed") {
      await transitionDungeonReadyCheck(data.readyCheck);
    }
  } catch (error) {
    showDungeonReadyError(error?.message || "Unable to update ready state.");
  } finally {
    dungeonReadyBusy = false;

    if (dungeonReadyCheck) {
      renderDungeonReadyCheck(dungeonReadyCheck);
    }
  }
}

async function cancelDungeonReadyCheck() {
  if (
    dungeonReadyBusy ||
    !dungeonReadyCheck ||
    dungeonReadyCheck.status !== "pending"
  ) {
    return;
  }

  dungeonReadyBusy = true;
  showDungeonReadyError("");

  try {
    const response = await fetch("/api/dungeons/ready-check/cancel", {
      method: "POST",
      credentials: "include"
    });

    const data = await response.json();

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Unable to cancel Dungeon ready check.");
    }

    renderDungeonReadyCheck(data.readyCheck);
    setTimeout(closeDungeonReadyModal, 700);
  } catch (error) {
    showDungeonReadyError(error?.message || "Unable to cancel Dungeon ready check.");
  } finally {
    dungeonReadyBusy = false;
  }
}


async function enterDungeonFromWorld() {
  if (
    isInCombat() ||
    enteringDungeon
  ) {
    return;
  }

  enteringDungeon =
    true;

  const button =
    document.getElementById(
      "enter-dungeon-btn"
    );

  if (button) {
    button.disabled =
      true;

    button.textContent =
      "Entering...";
  }

  try {
    /*
     * Ensure the current player is subscribed before the leader starts
     * the check. Other party members are still guaranteed delivery via
     * their private player socket rooms.
     */
    await connectDungeonSocket();

    /*
     * Resolve the dungeon from the player's current tile.
     * This keeps the world frontend generic; it does not
     * hard-code Stormvault's dungeon ID.
     */
    const resolveResponse =
      await fetch(
        "/world/current-dungeon",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const resolved =
      await resolveResponse.json();

    if (
      !resolveResponse.ok ||
      resolved.ok === false ||
      !resolved.dungeon?.id
    ) {
      throw new Error(
        resolved.error ===
          "not_on_dungeon_tile"
          ? "You must stand on the dungeon entrance."
          : resolved.error ===
              "dungeon_not_configured"
            ? "This dungeon entrance is not configured yet."
            : resolved.error ||
              "Unable to identify this dungeon."
      );
    }

    const dungeonId =
      Number(
        resolved.dungeon.id
      );

    /*
     * If the player already has an active dungeon,
     * rejoin that run instead of treating it as an error.
     */
    const activeResponse =
      await fetch(
        "/api/dungeons/active",
        {
          credentials:
            "include",
          cache:
            "no-store"
        }
      );

    const activeData =
      await activeResponse.json();

    if (
      activeResponse.ok &&
      activeData?.dungeon
    ) {
      if (
        typeof openDungeonModal ===
        "function"
      ) {
        await openDungeonModal();
      } else {
        window.location.href =
          "/dungeon";
      }

      return;
    }

    const readyResponse =
      await fetch(
        `/api/dungeons/${dungeonId}/ready-check/start`,
        {
          method: "POST",
          credentials: "include"
        }
      );

    const readyData =
      await readyResponse.json();

    if (
      !readyResponse.ok ||
      readyData.ok === false
    ) {
      throw new Error(
        readyData.error ||
        "Unable to start Dungeon ready check."
      );
    }

    dungeonReadySelfId =
      Number(
        readyData.playerId ||
        0
      ) ||
      dungeonReadySelfId;

    if (readyData.readyCheck) {
      renderDungeonReadyCheck(
        readyData.readyCheck
      );
    }

    if (
      readyData.readyCheck?.status ===
      "completed"
    ) {
      await transitionDungeonReadyCheck(
        readyData.readyCheck
      );

      return;
    }

    startDungeonReadyPolling();
    enteringDungeon = false;

  } catch (err) {
    console.error(
      "Dungeon entry failed:",
      err
    );

    showErrorToast(
      err?.message ||
      "Unable to enter the dungeon.",
      "Dungeon Entry Failed"
    );

    if (button) {
      button.disabled =
        false;

      button.textContent =
        "Enter Dungeon";
    }

    enteringDungeon =
      false;
  }
}

window.enterDungeonFromWorld =
  enterDungeonFromWorld;

// =======================
// MOVEMENT
// =======================
document.addEventListener("keydown", (e) => {
  if (e.repeat) return;

  if (isInCombat()) {
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case "ArrowUp":
    case "w":
    case "W":
      moveWorld("north");
      break;
    case "ArrowDown":
    case "s":
    case "S":
      moveWorld("south");
      break;
    case "ArrowLeft":
    case "a":
    case "A":
      moveWorld("west");
      break;
    case "ArrowRight":
    case "d":
    case "D":
      moveWorld("east");
      break;
  }
});


async function syncWorldAudio(region, terrain) {
  let audio = window.GFAudio;

  if (
    !audio ||
    typeof audio.playRegionMusic !== "function" ||
    typeof audio.playTerrainAmbience !== "function"
  ) {
    try {
      audio = await window.GFAudioReady;
    } catch (err) {
      console.warn(
        "Unable to initialize Guildforge world audio:",
        err
      );
      return;
    }
  }

  if (!audio) return;

  const tasks = [];

  if (
    region &&
    typeof audio.playRegionMusic === "function"
  ) {
    tasks.push(
      audio.playRegionMusic(region)
    );
  }

  if (
    terrain &&
    typeof audio.playTerrainAmbience === "function"
  ) {
    tasks.push(
      audio.playTerrainAmbience(terrain)
    );
  }

  if (document.body && terrain) {
    document.body.dataset.gfTerrain =
      String(terrain);
  }

  if (!tasks.length) return;

  await Promise.allSettled(tasks);
}

async function moveWorld(dir) {
  if (isInCombat()) return;

  const now = Date.now();
  if (moveLock || (now - lastMoveAt) < MOVE_COOLDOWN_MS) return;

  moveLock = true;
  lastMoveAt = now;

  // ⚡ Animate immediately — don't wait for the server response
  lastMoveDir = normalizeMoveDir(dir);
  animateStep(dir);

  try {
    const res = await fetch(`/world/move/${dir}`, {
      credentials: "include"
    });
    const data = await res.json();

    if (!data?.success) return;

    // Keep soundtrack + environment ambience synchronized
    // with the tile the player actually moved onto.
    syncWorldAudio(
      data.region,
      data.terrain
    ).catch(err => {
      console.warn(
        "Unable to sync world audio after movement:",
        err
      );
    });

    // Use bundled data from the single move response — no extra fetches
if (data.world) {
  renderWorldFromData(
    data.world
  );
}

if (data.nearbyObjects) {
  renderNearbyObjects(
    data.nearbyObjects
  );
}

if (data.regionData) {
  renderRegionHeader(
    data.regionData
  );
}

if (
  String(
    data.terrain ||
    ""
  ).toLowerCase() ===
  "dungeon"
) {
  await renderDungeonWorldHeaderIfNeeded(
    data.terrain
  );
}

updateNavHUD(data);

if (data.huntProgress?.advanced) {
  showHuntProgress(
    data.huntProgress
  );
}

if (data.inCombat && data.enemy) {
  pendingCombatEnemy =
    data.enemy;

  queueCombatOpen();
}
  } catch (err) {
    console.error("World movement failed", err);
  } finally {
    setTimeout(() => {
      moveLock = false;
    }, MOVE_COOLDOWN_MS);
  }
}

// =======================
// NEARBY OBJECTS / INTERACTIONS
// =======================

// Initial page load — still fetches directly
async function loadNearbyObjects() {
  try {
    const res = await fetch("/api/world/nearby-objects", {
      credentials: "include"
    });
    const data = await res.json();

    if (!data?.success) {
      renderNearbyObjects([]);
      return;
    }

    renderNearbyObjects(data.objects || []);
  } catch (err) {
    console.error("Failed to load nearby objects", err);
    renderNearbyObjects([]);
  }
}

function renderNearbyObjects(objects) {
  const list = document.getElementById("worldInteractList");
  if (!list) return;

  const badge = document.getElementById("nav-nearby-count");
  if (badge) {
    badge.textContent = String(
      objects?.length || 0
    );
  }

  if (!objects || objects.length === 0) {
    list.innerHTML = `
      <div class="world-interact__empty">
        Nothing to interact with nearby.
      </div>
    `;
    return;
  }

  const sorted = [...objects].sort((a, b) => {
    if (!!a.inRange !== !!b.inRange) {
      return a.inRange ? -1 : 1;
    }

    return (
      Number(a.distance || 0) -
      Number(b.distance || 0)
    );
  });

  list.innerHTML = sorted
    .map(obj => {

      const isHuntClue =
        obj.object_type ===
        "hunt_clue";

      const isHuntTarget =
        obj.object_type ===
        "hunt_target";

      const rangeText =
        obj.inRange
          ? `
            <span class="world-interact__status in-range">
              In range
            </span>
          `
          : `
            <span class="world-interact__status out-of-range">
              ${Number(obj.distance)} tiles away
            </span>
          `;

      let btn = "";

      if (!obj.inRange) {

        btn = `
          <button
            class="world-interact__btn"
            disabled
          >
            Too Far
          </button>
        `;

        } else if (isHuntClue) {

          btn = `
            <button
              class="world-interact__btn"
              onclick="
                investigateHuntClue(
                  ${Number(obj.id)}
                )
              "
            >
              Investigate
            </button>
          `;

} else if (isHuntTarget) {

  const huntStatus =
    String(
      obj.status || ""
    ).toLowerCase();

  const encounterEngaged =
    huntStatus === "engaged";

  btn = `
    <button
      class="
        world-interact__btn
        world-interact__btn--hunt
      "
      onclick="
        ${
          encounterEngaged
            ? "rejoinHuntEncounter()"
            : `confrontHuntTarget(${Number(obj.partyHuntId)})`
        }
      "
    >
      ${
        encounterEngaged
          ? "Rejoin"
          : "Confront"
      }
    </button>
  `;

} else {

        btn = `
          <button
            class="world-interact__btn"
            onclick="
              interactWithWorldObject(
                ${Number(obj.id)}
              )
            "
          >
            Interact
          </button>
        `;

      }

      const typeLabel =
        isHuntClue
          ? "Hunt Clue"
          : isHuntTarget
            ? "Hunt Quarry"
            : String(
                obj.object_type ||
                "object"
              );

      return `
        <div
          class="
            world-interact__row
            ${isHuntClue
              ? "world-interact__row--hunt-clue"
              : ""}

            ${isHuntTarget
              ? "world-interact__row--hunt-target"
              : ""}
          "
        >

          <div class="world-interact__meta">

            <div class="world-interact__name">
              ${
                obj.icon
                  ? `${escapeHtml(obj.icon)} `
                  : ""
              }
              ${escapeHtml(obj.name)}
            </div>

            <div class="world-interact__sub">
              (${Number(obj.x)}, ${Number(obj.y)})
              •
              ${escapeHtml(typeLabel)}
            </div>

          </div>

          <div class="world-interact__actions">
            ${rangeText}
            ${btn}
          </div>

        </div>
      `;
    })
    .join("");
}

async function investigateHuntClue(
  clueId
) {
  if (isInCombat()) {
    return;
  }

  try {

    const res =
      await fetch(
        `/hunts/clues/${clueId}/investigate`,
        {
          method: "POST",
          credentials: "include"
        }
      );

    const data =
      await res.json();


    if (
      !res.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to investigate clue."
      );
    }


    /*
     * Show the clue itself using the
     * existing discovery/lore modal.
     */
    if (data.clue) {
      openLoreModal(
        data.clue.name ||
          "Hunt Clue",

        data.clue.description ||
          "You examine the evidence."
      );
    }


    /*
     * Shared Hunt progress notification.
     */
    if (
      data.huntProgress?.advanced
    ) {
      showHuntProgress(
        data.huntProgress
      );
    }


    /*
     * Refresh Nearby so the clue
     * immediately disappears after
     * investigation.
     */
    await loadNearbyObjects();

  } catch (err) {

    console.error(
      "Hunt clue investigation failed:",
      err
    );

    showErrorToast(
      err.message ||
      "Unable to investigate clue."
    );

  }
}

let huntConfronting =
  false;

async function confrontHuntTarget(
  partyHuntId
) {
  if (
    isInCombat() ||
    huntConfronting
  ) {
    return;
  }

  huntConfronting = true;

  try {

    /*
     * Ask the server to create/start
     * the shared Hunt encounter.
     *
     * The server remains authoritative:
     * it should verify party membership,
     * Hunt state and player position.
     */
    const res =
      await fetch(
        "/hunts/active/confront",
        {
          method: "POST",
          credentials: "include",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              partyHuntId:
                Number(
                  partyHuntId
                )
            })
        }
      );

    const data =
      await res.json();

    if (
      !res.ok ||
      data.ok === false
    ) {
      throw new Error(
        data.error ||
        "Unable to confront the Hunt target."
      );
    }


    /*
     * Ensure this player is registered
     * as an active encounter participant.
     *
     * If createHuntEncounter() already
     * does this for the initiating player,
     * this route should simply return
     * the existing participation state.
     */



    /*
     * Open the shared combat UI.
     */
    if (
      typeof window
        .openHuntCombatModal ===
      "function"
    ) {

      await window
        .openHuntCombatModal();

    } else {

      throw new Error(
        "Hunt combat UI is unavailable."
      );
    }


    /*
     * Refresh world/Nearby state.
     * Hunt status should now be engaged.
     */
    await loadNearbyObjects();

  } catch (err) {

    console.error(
      "Hunt confrontation failed:",
      err
    );

    showErrorToast(
      err.message ||
      "Unable to confront the Hunt target.",
      "Hunt Failed"
    );

  } finally {

    huntConfronting =
      false;
  }
}

async function rejoinHuntEncounter() {
  if (
    isInCombat() ||
    huntConfronting
  ) {
    return;
  }

  huntConfronting = true;

  try {

    /*
     * Reattach this player to the
     * existing shared Hunt encounter.
     */
    const joinRes =
      await fetch(
        "/hunts/encounter/join",
        {
          method: "POST",
          credentials: "include"
        }
      );

    const joinData =
      await joinRes.json();

    if (
      !joinRes.ok ||
      joinData.ok === false
    ) {
      throw new Error(
        joinData.error ||
        "Unable to rejoin the Hunt encounter."
      );
    }


    /*
     * Now that the server has confirmed
     * participation, open the combat UI.
     */
    if (
      typeof window
        .openHuntCombatModal !==
      "function"
    ) {
      throw new Error(
        "Hunt combat UI is unavailable."
      );
    }

    await window
      .openHuntCombatModal();

  } catch (err) {

    console.error(
      "Hunt rejoin failed:",
      err
    );

    showErrorToast(
      err.message ||
      "Unable to rejoin the Hunt encounter.",
      "Hunt Failed"
    );

    /*
     * Refresh stale world state if the
     * encounter has actually ended.
     */
    try {
      await refreshWorld();
    } catch (_) {}

  } finally {

    huntConfronting =
      false;
  }
}

window.rejoinHuntEncounter =
  rejoinHuntEncounter;

window.rejoinHuntEncounter =
  rejoinHuntEncounter;

window.confrontHuntTarget =
  confrontHuntTarget;

async function interactWithWorldObject(objectId) {
  if (isInCombat()) return;

  try {
    const res = await fetch(`/api/world/interact/${objectId}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      }
    });

    const data = await res.json();

    if (!res.ok) {
      if (data?.error === "too_far_away") {
        alert("You are too far away to interact with that.");
        return;
      }

      if (data?.error === "world_object_not_found") {
        alert("That object is no longer available.");
        await loadNearbyObjects();
        return;
      }

      alert("Interaction failed.");
      return;
    }

    if (data?.lore) {
      openLoreModal(data.lore.title, data.lore.text);
    }

    await loadNearbyObjects();

    if (typeof refreshTrackedQuest === "function") {
      try {
        await refreshTrackedQuest();
      } catch (err) {
        console.warn("refreshTrackedQuest failed", err);
      }
    }

    if (typeof loadQuestList === "function") {
      try {
        await loadQuestList();
      } catch (err) {
        console.warn("loadQuestList failed", err);
      }
    }
  } catch (err) {
    console.error("Interaction failed", err);
    alert("Interaction failed.");
  }
}


function getResourceIcon(professionName) {
  switch (String(professionName || "").toLowerCase()) {
    case "mining":
      return "⛏️";
    case "herbalism":
      return "🌿";
    case "woodcutting":
      return "🪓";
    default:
      return "✨";
  }
}

function showErrorToast(message, title = "Action Failed") {
  if (window.GFToast?.show) {
    GFToast.show(title, message, {
      type: "error",
      durationMs: 2400
    });
    return;
  }

  console.warn(`${title}: ${message}`);
}

async function gatherResourceNode(spawnedNodeId) {
  if (isInCombat()) return;

  const panel = document.getElementById("currentResourcePanel");
  const btn = panel?.querySelector(".resource-panel__btn");

  let sound = null;

  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/gathering/gather/${spawnedNodeId}`, {
      method: "POST",
      credentials: "include"
    });

    const data = await res.json();

    if (!res.ok) {
      showErrorToast(
        formatGatheringError(data?.error || "Failed to gather resource.")
      );
      return;
    }

    const gatherTime = Number(data.gatherTimeMs || 1800);

    showGatheringModal({
      professionName: data.professionName,
      nodeName: data.nodeName,
      durationMs: gatherTime
    });

    sound = playGatheringSound(data.professionName);

    await sleep(gatherTime);

    playGatherCompleteSound();

    const itemsText = (data.gatheredItems || [])
      .map(item => `${item.quantity}x ${item.name}`)
      .join(", ");

    if (window.GFToast?.show) {
      GFToast.show(
        data.nodeName,
        `+${data.xpGained} ${data.professionName} XP${itemsText ? ` • ${itemsText}` : ""}`,
        {
          type: "success",
          durationMs: 2600
        }
      );
    }

    if (data.leveledUp && window.GFToast?.show) {
      playProfessionLevelSound();

      GFToast.show(
        "Profession Increased!",
        `${data.professionName} reached Level ${data.newLevel}!`,
        {
          type: "success",
          durationMs: 4500
        }
      );
    }

    await refreshWorld();

    if (typeof loadInventory === "function") {
      await loadInventory();
    }
  } catch (err) {
    console.error("Gathering failed", err);
    showErrorToast("Gathering failed.");
  } finally {
    if (sound) {
      sound.pause();
      sound.currentTime = 0;
      sound.loop = false;
    }

    hideGatheringModal();

    if (btn) btn.disabled = false;
  }
}
function formatGatheringError(error) {
  switch (String(error)) {
    case "inventory_full":
      return "Your inventory is full.";

    case "missing_gathering_tool":
      return "You don't have the required gathering tool equipped.";

    case "invalid_gathering_tool":
      return "The equipped tool is not valid for this resource.";

    case "profession_level_too_low":
      return "Your profession level is too low to gather this resource.";

    case "node_not_found_or_expired":
      return "That resource has already been depleted.";

    case "too_far_from_node":
      return "Move onto the resource before gathering.";

    default:
      return error || "Gathering failed.";
  }
}

// =======================
// REST MODAL
// =======================
async function openRest() {
  if (isInCombat()) return;

  const root = document.getElementById("rest-root");
  if (!root) {
    console.error("Missing #rest-root in world page.");
    return;
  }

  try {
    const res = await fetch("/rest/modal", {
      credentials: "include"
    });

    const html = await res.text();
    root.innerHTML = html;

    if (typeof window.initRestModal === "function") {
      window.initRestModal();
    }
  } catch (err) {
    console.error("Failed to open rest modal", err);
  }
}

function closeRestModal() {
  if (typeof window.clearRestIntervals === "function") {
    window.clearRestIntervals();
  }

  const root = document.getElementById("rest-root");
  if (root) root.innerHTML = "";
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    const modal = document.getElementById("rest-root");

    if (modal && modal.children.length) {
      closeRestModal();
    }
  }
});

window.openRest = openRest;
window.closeRestModal = closeRestModal;


// =======================
// LORE MODAL
// =======================
function openLoreModal(title, text) {
  const modal = document.getElementById("loreModal");
  const titleEl = document.getElementById("loreTitle");
  const bodyEl = document.getElementById("loreBody");

  if (!modal || !titleEl || !bodyEl) return;

  titleEl.textContent = title || "Discovery";
  bodyEl.textContent = text || "";
  modal.classList.remove("hidden");
}

function closeLoreModal() {
  const modal = document.getElementById("loreModal");
  if (!modal) return;
  modal.classList.add("hidden");
}

/* =========================================
   PARTY QUICK VIEW
========================================= */

function escapePartyHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


async function loadWorldPartyStatus() {
  const status =
    document.getElementById(
      "partyQuickStatus"
    );

  if (!status) return;

  try {

    const response =
      await fetch("/party");

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {
      throw new Error(
        data.error ||
        "Unable to load party."
      );
    }

    if (!data.party) {

      status.textContent =
        "No active party";

      return;
    }

    status.textContent =
      `${data.party.members.length} / ${data.party.maxMembers} adventurers`;

  } catch (err) {

    console.error(
      "Party status failed:",
      err
    );

    status.textContent =
      "Party unavailable";

  }
}


async function openPartyQuickView() {

  const modal =
    document.getElementById(
      "partyQuickModal"
    );

  const body =
    document.getElementById(
      "partyQuickBody"
    );

  if (!modal || !body) {
    return;
  }

  modal.classList.remove(
    "hidden"
  );

  body.innerHTML = `
    <div class="party-quick-loading">
      Gathering your company...
    </div>
  `;

  try {

    const response =
      await fetch("/party");

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {
      throw new Error(
        data.error ||
        "Unable to load party."
      );
    }

    const party =
      data.party;


    if (!party) {

      body.innerHTML = `
        <div class="party-quick-empty">
          You are not currently part of an
          adventuring company.
        </div>
      `;

      return;
    }


    body.innerHTML =
      party.members
        .map(renderPartyQuickMember)
        .join("");

  } catch (err) {

    console.error(
      "Party quick view failed:",
      err
    );

    body.innerHTML = `
      <div class="party-quick-empty">
        Unable to load your party.
      </div>
    `;

  }
}


function renderPartyQuickMember(
  member
) {

  const hpPercent =
    member.maxhp > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (
              member.hpoints /
              member.maxhp
            ) * 100
          )
        )
      : 0;


  const spPercent =
    member.maxspoints > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (
              member.spoints /
              member.maxspoints
            ) * 100
          )
        )
      : 0;


  return `
    <div class="party-quick-member">

      <div class="party-quick-member__top">

        <div>

          <div class="party-quick-member__name">
            ${escapePartyHtml(member.name)}
          </div>

          <div class="party-quick-member__meta">
            ${escapePartyHtml(member.className)}
            · Level ${member.level}
          </div>

        </div>

        ${
          member.isLeader
            ? `
              <span class="party-quick-leader">
                👑 Leader
              </span>
            `
            : ""
        }

      </div>


      <div class="party-quick-bars">

        <div class="party-quick-stat">

          <span>HP</span>

          <div class="party-quick-track">
            <div
              class="party-quick-fill hp"
              style="width:${hpPercent}%"
            ></div>
          </div>

          <span>
            ${member.hpoints}/${member.maxhp}
          </span>

        </div>


        <div class="party-quick-stat">

          <span>SP</span>

          <div class="party-quick-track">
            <div
              class="party-quick-fill sp"
              style="width:${spPercent}%"
            ></div>
          </div>

          <span>
            ${member.spoints}/${member.maxspoints}
          </span>

        </div>

      </div>

    </div>
  `;
}


function closePartyQuickView() {

  document
    .getElementById(
      "partyQuickModal"
    )
    ?.classList.add(
      "hidden"
    );
}
loadWorldPartyStatus();
// =======================
// UTILS
// =======================
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}