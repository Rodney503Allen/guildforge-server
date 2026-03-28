// public/world.js

let pendingCombatEnemy = null;
let lastMoveDir = null;

// ✅ Movement cooldown
const MOVE_COOLDOWN_MS = 500;
let lastMoveAt = 0;
let moveLock = false;

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

    await loadRegionName();
    await refreshWorld();
    await loadNearbyObjects();
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

    const title = document.getElementById("world-title");
    if (!title) return;

    const min = Number(data.level_min ?? 1);
    const max = Number(data.level_max ?? min);
    const band = (min === max) ? `Lv ${min}` : `Lv ${min}–${max}`;

    title.textContent = `${data.region_name} (${band})`;

    title.classList.remove("zone-easy", "zone-even", "zone-hard");
    const diff = String(data.difficulty || "even").toLowerCase();
    title.classList.add(
      diff === "easy" ? "zone-easy"
      : diff === "hard" ? "zone-hard"
      : "zone-even"
    );
  } catch (err) {
    console.error("Failed to load region name", err);
  }
}



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
async function refreshWorld() {
  const res = await fetch("/world/partial", {
    credentials: "include"
  });

  const data = await res.json();
  const { player, tiles, guildMap, worldObjects } = data;

  const tileMap = {};
  for (const t of tiles || []) {
    tileMap[`${t.x},${t.y}`] = t;
  }

  const objectMap = buildWorldObjectMap(worldObjects || []);

  const grid = document.getElementById("Grid");
  if (!grid) return;

  grid.innerHTML = "";

  const minX = player.map_x - 3;
  const minY = player.map_y - 3;

  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const x = minX + c;
      const y = minY + r;
      const t = tileMap[`${x},${y}`];

      if (!t) {
        grid.innerHTML += `<div class="tile"></div>`;
        continue;
      }

      const owner = t.controlling_guild_id
        ? guildMap[t.controlling_guild_id]
        : "Neutral";

      const isPlayer = x === player.map_x && y === player.map_y;
      const { replaceSprite, overlays } = getTileVisualData(x, y, objectMap);

      const terrainClass = replaceSprite ? "" : t.terrain;
      const baseStyle = replaceSprite
        ? ` style="background-image: url('${escapeHtml(replaceSprite)}');"`
        : "";

        grid.innerHTML += `
          <div
            class="tile ${terrainClass} ${isPlayer ? "player" : ""} ${isPlayer && lastMoveDir ? `moving-${lastMoveDir}` : ""}"
            data-x="${x}"
            data-y="${y}"${baseStyle}
          >
          ${overlays.map(src => `
            <img class="tile-overlay" src="${escapeHtml(src)}" alt="">
          `).join("")}
          <div class="owner">${escapeHtml(owner)}</div>
        </div>
      `;
    }
  }

  const currentTile = tileMap[`${player.map_x},${player.map_y}`];
  const enterBtn = document.getElementById("enter-town-btn");
  if (enterBtn) {
    enterBtn.style.display = currentTile?.terrain === "town" ? "inline-block" : "none";
  }

  const coords = document.querySelector(".coords");
  if (coords) {
    coords.textContent = `Position: (${player.map_x}, ${player.map_y})`;
  }

  updateNavHUD(data);
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

  try {
    const res = await fetch(`/world/move/${dir}`, {
      credentials: "include"
    });
    const data = await res.json();

    if (!data?.success) return;

    lastMoveDir = normalizeMoveDir(dir);
    animateStep(dir);

    await refreshWorld();
    await loadNearbyObjects();
    await loadRegionName();

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