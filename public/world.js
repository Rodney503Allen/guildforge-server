// public/world.js

let pendingCombatEnemy = null;
let lastMoveDir = null;

// ✅ Movement cooldown
const MOVE_COOLDOWN_MS = 500;
let lastMoveAt = 0;
let moveLock = false;

let currentResourceNode = null;

// =======================
// INIT
// =======================
document.addEventListener("DOMContentLoaded", initWorldPage);

async function initWorldPage() {
  bindLoreModal();

  try {
    const res = await fetch("/combat/state", {
      credentials: "include"
    });
    const data = await res.json();

    if (data?.inCombat && data?.enemy) {
      openCombatModal(data.enemy);
      return;
    }

    await refreshWorld();
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

// =======================
// COMBAT HELPERS
// =======================
function isInCombat() {
  const modal = document.getElementById("combatModal");
  return !!(modal && !modal.classList.contains("hidden"));
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
  const title = document.getElementById("world-title");
  if (!title || !data) return;

  const min = Number(data.level_min ?? 1);
  const max = Number(data.level_max ?? min);
  const band = (min === max) ? `Lv ${min}` : `Lv ${min}–${max}`;
  const name = data.region_name ?? "Unknown Region";

  title.textContent = `${name} (${band})`;

  title.classList.remove("zone-easy", "zone-even", "zone-hard");
  const diff = String(data.difficulty || "even").toLowerCase();
  title.classList.add(
    diff === "easy" ? "zone-easy"
    : diff === "hard" ? "zone-hard"
    : "zone-even"
  );
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
function renderWorldFromData({ player, tiles, guildMap, worldObjects, resourceNodes }) {
  const tileMap = {};
  for (const t of tiles || []) {
    tileMap[`${t.x},${t.y}`] = t;
  }

  const objectMap = buildWorldObjectMap(worldObjects || []);

  const resourceMap = new Map();
  for (const node of resourceNodes || []) {
    const key = `${Number(node.map_x)},${Number(node.map_y)}`;
    resourceMap.set(key, node);
  }

  const grid = document.getElementById("Grid");
  if (!grid) return;

  const html = [];

  const minX = Number(player.map_x) - 3;
  const minY = Number(player.map_y) - 3;

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
      const resourceNode = resourceMap.get(`${x},${y}`);
      const { replaceSprite, overlays } = getTileVisualData(x, y, objectMap);

      const terrainClass = replaceSprite ? "" : t.terrain;
      const baseStyle = replaceSprite
        ? ` style="background-image: url('${escapeHtml(replaceSprite)}');"`
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

      html.push(`
        <div
          class="tile ${escapeHtml(terrainClass)} ${isPlayer ? "player" : ""} ${isPlayer && lastMoveDir ? `moving-${lastMoveDir}` : ""}"
          data-x="${x}"
          data-y="${y}"${baseStyle}
        >
          ${overlayHtml}
          ${resourceHtml}
        </div>
      `);
    }
  }

  grid.innerHTML = html.join("");

  const currentTile = tileMap[`${player.map_x},${player.map_y}`];

  const enterBtn = document.getElementById("enter-town-btn");
  if (enterBtn) {
    enterBtn.style.display = currentTile?.terrain === "town" ? "inline-block" : "none";
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

    // Use bundled data from the single move response — no extra fetches
    if (data.world) renderWorldFromData(data.world);
    if (data.nearbyObjects) renderNearbyObjects(data.nearbyObjects);
    if (data.regionData) renderRegionHeader(data.regionData);

    updateNavHUD(data);

    if (data.inCombat && data.enemy) {
      pendingCombatEnemy = data.enemy;
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
  if (badge) badge.textContent = String(objects?.length || 0);

  if (!objects || objects.length === 0) {
    list.innerHTML = `<div class="world-interact__empty">Nothing to interact with nearby.</div>`;
    return;
  }

  const sorted = [...objects].sort((a, b) => {
    if (!!a.inRange !== !!b.inRange) return a.inRange ? -1 : 1;
    return Number(a.distance || 0) - Number(b.distance || 0);
  });

  list.innerHTML = sorted.map(obj => {
    const rangeText = obj.inRange
      ? `<span class="world-interact__status in-range">In range</span>`
      : `<span class="world-interact__status out-of-range">${obj.distance} tiles away</span>`;

    const btn = obj.inRange
      ? `<button class="world-interact__btn" onclick="interactWithWorldObject(${Number(obj.id)})">Interact</button>`
      : `<button class="world-interact__btn" disabled>Too Far</button>`;

    return `
      <div class="world-interact__row">
        <div class="world-interact__meta">
          <div class="world-interact__name">${escapeHtml(obj.name)}</div>
          <div class="world-interact__sub">
            (${Number(obj.x)}, ${Number(obj.y)}) • ${escapeHtml(obj.object_type || "object")}
          </div>
        </div>
        <div class="world-interact__actions">
          ${rangeText}
          ${btn}
        </div>
      </div>
    `;
  }).join("");
}

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