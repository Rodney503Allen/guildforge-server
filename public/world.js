let pendingCombatEnemy = null;
let lastMoveDir = null;
let travelMessageTimer = null;

// ✅ Movement cooldown
const MOVE_COOLDOWN_MS = 500;
let canMove = true;
let moveCooldownTimer = null;

let lastMoveAt = 0;
let moveLock = false;

// encounter pacing
const ENCOUNTER_CHANCE = 0.01;     // 8% per step
const ENCOUNTER_GAP_STEPS = 3;     // can't spawn again for 3 moves
let stepsSinceEncounter = 999;

// =======================
// HUD/Nav functions
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

  // quick nudge in the opposite direction (feels like the world shifts as you move)
  const map = { north:[0, 10], south:[0, -10], west:[10,0], east:[-10,0] };
  const v = map[dir] || [0,0];

  grid.animate(
    [
      { transform: `translate(${v[0]}px, ${v[1]}px)` },
      { transform: "translate(0px, 0px)" }
    ],
    { duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" }
  );
}
function dirToArrow(dir){
  return dir === "north" ? "↑" :
         dir === "south" ? "↓" :
         dir === "west"  ? "←" :
         dir === "east"  ? "→" : "";
}

// =======================
// WORLD MOVEMENT CONTROLS
// =======================
document.addEventListener("DOMContentLoaded", () => {
  loadRegionName();
  refreshWorld();
});

// =======================
// WORLD MOVEMENT CONTROLS
// =======================

function isInCombat() {
  const modal = document.getElementById("combatModal");
  return modal && !modal.classList.contains("hidden");
}



async function loadRegionName() {
  try {
    const res = await fetch("/world/current-region");
    const data = await res.json();

    const title = document.getElementById("world-title");
    if (title) {
      title.textContent = data.region_name;
    }
  } catch (err) {
    console.error("Failed to load region name", err);
  }
}

document.addEventListener("DOMContentLoaded", loadRegionName);

async function refreshWorld() {
  const res = await fetch("/world/partial", {
    credentials: "include"
  });

  const data = await res.json();
  const { player, tiles, guildMap } = data;

  const tileMap = {};
  tiles.forEach(t => tileMap[`${t.x},${t.y}`] = t);

  const grid = document.getElementById("Grid");
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

      grid.innerHTML += `
        <div class="tile ${t.terrain} ${isPlayer ? "player" : ""}">
          <div class="owner">${owner}</div>
          ${isPlayer && lastMoveDir ? `<div class="move-arrow">${lastMoveDir}</div>` : ""}
        </div>
      `;


      const currentTile = tileMap[`${player.map_x},${player.map_y}`];
const enterBtn = document.getElementById("enter-town-btn");

if (currentTile?.terrain === "town") {
  enterBtn.style.display = "inline-block";
} else {
  enterBtn.style.display = "none";
}

    }
  }

  // update coords
  document.querySelector(".coords").textContent =
    `Position: (${player.map_x}, ${player.map_y})`;
}

function enterTown() {
  window.location.href = "/town/enter";
}

// Load on page open
document.addEventListener("DOMContentLoaded", loadRegionName);


// Optional keyboard support (recommended)
document.addEventListener("keydown", (e) => {
  if (e.repeat) return;

  // ⛔ Block ALL movement keys during combat
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


document.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("/combat/state", {
      credentials: "include"
    });
    const data = await res.json();

    if (data.inCombat && data.enemy) {
      openCombatModal(data.enemy);
      return;
    }

    // Only load world if NOT in combat
    loadRegionName();
    refreshWorld();

  } catch (err) {
    console.error("Combat state check failed", err);
  }
});

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

async function moveWorld(dir) {
  if (isInCombat()) return;

  // movement cooldown (prevents spam)
  const now = Date.now();
  if (moveLock || (now - lastMoveAt) < MOVE_COOLDOWN_MS) return;

  moveLock = true;
  lastMoveAt = now;

  try {
    const res = await fetch(`/world/move/${dir}`, { credentials: "include" });
    const data = await res.json();
    if (!data.success) return;

    lastMoveDir = dirToArrow(dir);
    animateStep(dir);

    await refreshWorld();
    loadRegionName();

    updateNavHUD(data);

    // ---- encounter gating client-side (optional) ----
    // (best is server-side, but this is fast to test)
// If the server says you're in combat, always open it.
if (data.inCombat && data.enemy) {
  pendingCombatEnemy = data.enemy;
  queueCombatOpen();
}


  } catch (err) {
    console.error("World movement failed", err);
  } finally {
    setTimeout(() => { moveLock = false; }, MOVE_COOLDOWN_MS);
  }
}








