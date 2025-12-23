let pendingCombatEnemy = null;
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
          <div class="region">${t.region_name}</div>
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

  try {
    const res = await fetch(`/world/move/${dir}`, {
      credentials: "include"
    });

    const data = await res.json();
    if (!data.success) return;

    // ✅ Fully resolve world FIRST
    await refreshWorld();
    loadRegionName();

    // ✅ Schedule combat AFTER world is stable
    if (data.inCombat && data.enemy) {
      pendingCombatEnemy = data.enemy;
      queueCombatOpen();
    }

  } catch (err) {
    console.error("World movement failed", err);
  }
}




