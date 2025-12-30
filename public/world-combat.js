console.log("🔥 world-combat.js LOADED");
// =======================================
// WORLD COMBAT (MODAL-ONLY, CLEAN)
// =======================================

let currentEnemy = null;
let enemyAttackTimer = null;
const spellCooldowns = {}; 
// { spellId: timestamp_when_ready }
// =======================
// STATUS POLLING
// =======================
let statusPollInterval = null;

function startStatusPolling() {
  if (statusPollInterval) return;

  console.log("🔥 startStatusPolling");

  statusPollInterval = setInterval(async () => {
    try {
      const r = await fetch("/combat/poll");
      const data = await r.json();

      console.log("[POLL]", data);

      if (data.enemyDead || data.enemyHP <= 0) {
        stopStatusPolling();
        stopEnemyAutoAttack();

        updateEnemyHUD(0, data.enemyMaxHP || 1);

        logCombat("🏆 Enemy defeated!");

        if (data.exp) {
          logCombat(`✨ You gained ${data.exp} EXP`);
        }

        if (data.gold) {
          logCombat(`💰 You gained ${data.gold} gold`);
        }

        if (data.levelUp) {
          logCombat("⬆ LEVEL UP!");
        }

        return setTimeout(() => {
          closeCombatModal();
          location.reload();
        }, 1600);
      }


      if (data.stop) {
        stopStatusPolling();
        return;
      }

      updateEnemyHUD(data.enemyHP, data.enemyMaxHP);
    } catch (err) {
      console.error("Status polling failed:", err);
      stopStatusPolling();
    }
  }, 1000);
}

function stopStatusPolling() {
  if (statusPollInterval) {
    clearInterval(statusPollInterval);
    statusPollInterval = null;
  }
}
function updateEnemyHUD(hp, maxHP) {
  const bar = document.getElementById("enemyHPBar");
  const hpText = document.getElementById("enemyHP");
  const maxText = document.getElementById("enemyMaxHP");

  if (!bar || !currentEnemy) return;

  // 🔥 UPDATE CANONICAL STATE
  currentEnemy.hp = hp;
  if (Number.isFinite(maxHP)) {
    currentEnemy.maxHP = maxHP;
  }

  if (hpText) hpText.innerText = hp;
  if (maxText) maxText.innerText = currentEnemy.maxHP;

  if (currentEnemy.maxHP > 0) {
    bar.style.width =
      Math.max(0, (hp / currentEnemy.maxHP) * 100) + "%";
  }
}

/* ===============================
   COMBAT MODAL CONTROL
================================ */

window.openCombatModal = async function (enemy) {
  await waitForEl("combatModal");
  startStatusPolling();
  // ✅ Always show modal immediately (so user sees it)
  document.getElementById("combatModal").classList.remove("hidden");

  // ✅ Reset log immediately
  clearCombatLog();
  logCombat(`⚠ ${enemy?.name ?? "Enemy"} engages you!`);

  // ✅ Build a safe enemy object NOW (no NaN)
  const hp = Number(enemy?.hp);
  const max = Number(enemy?.maxHP ?? enemy?.maxhp ?? enemy?.max_hp ?? enemy?.maxhp ?? enemy?.hp);

  currentEnemy = {
    id: enemy?.id,
    name: enemy?.name ?? "Enemy",
    hp: Number.isFinite(hp) ? hp : 0,
    maxHP: Number.isFinite(max) ? max : (Number.isFinite(hp) ? hp : 1)
  };

  // ✅ Update ENEMY UI immediately (DO NOT wait on /me)
  setText("enemyName", currentEnemy.name);
  setText("enemyHP", currentEnemy.hp);
  setText("enemyMaxHP", currentEnemy.maxHP);
  updateBar("enemyHPBar", currentEnemy.hp, currentEnemy.maxHP);

  // ✅ Start enemy loop AFTER enemy exists
  startEnemyAutoAttack();

  // ✅ In parallel: load player stats (doesn't block enemy UI)
  try {
    const player = await fetch("/me", { credentials: "include" }).then(r => r.json());

    setText("playerName", player.name);
    setText("playerClass", player.pclass);
    setText("playerLevel", player.level);
    setText("playerHP", player.hpoints);
    setText("playerMaxHP", player.maxhp);
    setText("playerSP", player.spoints);
    setText("playerMaxSP", player.maxspoints);

    updateBar("playerHPBar", player.hpoints, player.maxhp);
    updateBar("playerSPBar", player.spoints, player.maxspoints);

    window.playerMaxHP = player.maxhp;
    window.playerMaxSP = player.maxspoints;
  } catch (e) {
    console.error("Failed to load player in combat modal", e);
  }

  // ✅ OPTIONAL BUT STRONG: Immediately sync enemy from authoritative server state
  // (prevents NaN / stale state if enemy payload was incomplete)
  try {
    const state = await fetch("/combat/state", { credentials: "include" }).then(r => r.json());
    if (state?.inCombat && state?.enemy) {
      const ehp = Number(state.enemy.hp);
      const emax = Number(state.enemy.maxHP ?? state.enemy.maxhp);

      if (Number.isFinite(ehp)) {
        currentEnemy.hp = ehp;
        setText("enemyHP", ehp);
      }
      if (Number.isFinite(emax)) {
        currentEnemy.maxHP = emax;
        setText("enemyMaxHP", emax);
      }

      updateBar("enemyHPBar", currentEnemy.hp, currentEnemy.maxHP);
    }
  } catch (e) {
    console.warn("combat/state sync failed (non-fatal)", e);
  }
};

window.openSpellsModal = function () {
  document.getElementById("spellsModal").classList.remove("hidden");
  loadCombatSpells();
};
window.closeCombatModal = function () {
  stopEnemyAutoAttack();
  currentEnemy = null;
  document.getElementById("combatModal").classList.add("hidden");
}

/* ===============================
   COMBAT ACTIONS
================================ */
let playerAttackLocked = false;
async function combatAttack() {
  if (playerAttackLocked) return;
  if (!currentEnemy) return;

  const res = await fetch("/combat/attack", { method: "POST" });
  const data = await res.json();

  if (data.error === "cooldown") {
    return; // server rejected — do nothing
  }
    playerAttackLocked = true;

  if (data.cooldownMs) {
    setTimeout(() => {
      playerAttackLocked = false;
    }, data.cooldownMs);
  } else {
    playerAttackLocked = false;
  }
  if (data.log) logCombat(data.log);

  if (data.damage !== undefined) {
    logCombat(`⚔ You hit for ${data.damage}${data.crit ? " (CRITICAL!)" : ""}`);
  }

  if (data.enemyHP !== undefined) {
    updateEnemyHP(data.enemyHP);
  }

if (data.dead) {
  logCombat("🏆 Enemy defeated!");

  if (data.exp) {
    logCombat(`✨ You gained ${data.exp} EXP!`);
  }

  if (data.gold) {
    logCombat(`💰 You gained ${data.gold} gold!`);
  }

  if (data.levelUp) {
    logCombat(`⬆ LEVEL UP!`);
  }

  setTimeout(closeCombatModal, 1200);
}

}

async function combatFlee() {
  try {
    const res = await fetch("/combat/flee", {
      method: "POST",
      credentials: "include"
    });

    const data = await res.json();
    if (!data.success) return;

    logCombat("🏃 You fled from combat!");

    stopEnemyAutoAttack();
    closeCombatModal();

    // Reload world cleanly (server is now authoritative)
    setTimeout(() => {
      location.reload();
    }, 500);

  } catch (err) {
    console.error("Flee failed", err);
  }
}



/* ===============================
   ENEMY AUTO ATTACK
================================ */
function startEnemyAutoAttack() {
  if (enemyAttackTimer) return;

  enemyAttackTimer = setInterval(async () => {
    try {
      const res = await fetch("/combat/enemy-attack", { method: "POST" });
      const data = await res.json();

      if (data.log) logCombat(data.log);

    if (data.playerHP !== undefined) {
      updatePlayerHP(data.playerHP);
      logCombat(`💥 ${currentEnemy.name} hits you for ${data.damage}`);
    }

      if (data.dead) {
        logCombat("☠ You were slain!");
        stopEnemyAutoAttack();
        setTimeout(() => location.href = "/death", 1000);
      }

      if (data.stop) {
        stopEnemyAutoAttack();
      }
    } catch (err) {
      console.error("Enemy attack loop failed", err);
      stopEnemyAutoAttack();
    }
  }, 1500);
}

function stopEnemyAutoAttack() {
  if (enemyAttackTimer) {
    clearInterval(enemyAttackTimer);
    enemyAttackTimer = null;
  }
}

/* ===============================
   MOVEMENT LOCK
================================ */
function isCombatOpen() {
  const modal = document.getElementById("combatModal");
  return modal && !modal.classList.contains("hidden");
}

/* Override movement hook safely */
const originalMoveWorld = window.moveWorld;

window.moveWorld = function (dir) {
  if (isCombatOpen()) {
    logCombat("⚠ You cannot move during combat!");
    return;
  }
  originalMoveWorld(dir);
};

document.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch("/combat/state");
  const state = await res.json();

  if (state.inCombat && state.enemy) {
    openCombatModal(state.enemy);
  }
});

function waitForEl(id, tries = 40) {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const el = document.getElementById(id);
      if (el) {
        clearInterval(t);
        resolve(el);
      } else if (--tries <= 0) {
        clearInterval(t);
        reject(new Error(`Missing element: ${id}`));
      }
    }, 25);
  });
}
window.openCombatModal = openCombatModal;
/* ===============================
   LOAD/CAST SPELL
================================ */
async function loadCombatSpells() {
  const grid = document.getElementById("combatSpellsGrid");
  if (!grid) {
    console.error("❌ combatSpellsGrid missing from DOM");
    return;
  }

  let spells;
  try {
    const res = await fetch("/combat/spells", { credentials: "include" });
    spells = await res.json();
  } catch (err) {
    console.error("❌ Failed to fetch spells", err);
    return;
  }

  if (!Array.isArray(spells)) {
    console.error("❌ Spells response is not an array:", spells);
    return;
  }

grid.innerHTML = "";

if (spells.length === 0) {
  grid.innerHTML = "<em>No spells available</em>";
  return;
}

spells.forEach(s => {
  let description = "";

  switch (s.type) {
    case "damage":
      description = `DAMAGE: ${s.damage ?? 0}`;
      break;

    case "heal":
      description = `HEAL: ${s.heal ?? 0}`;
      break;

    case "dot": {
      const perTick = s.dot_damage ?? 0;
      const dur = s.dot_duration ?? 0;
      const tick = s.dot_tick_rate ?? 1;
      description = `DOT: ${perTick} / ${tick}s for ${dur}s`;
      break;
    }

    case "damage_dot": {
      const dmg = s.damage ?? 0;
      const perTick = s.dot_damage ?? 0;
      const dur = s.dot_duration ?? 0;
      const tick = s.dot_tick_rate ?? 1;
      description = `DMG: ${dmg} + DOT: ${perTick}/${tick}s for ${dur}s`;
      break;
    }

    case "buff":
      description = `BUFF ${String(s.buff_stat || "").toUpperCase()} +${s.buff_value ?? 0} (${s.buff_duration ?? 0}s)`;
      break;

    case "debuff":
      description = `DEBUFF ${String(s.debuff_stat || "").toUpperCase()} ${s.debuff_value ?? 0} (${s.debuff_duration ?? 0}s)`;
      break;

    default:
      description = s.description || "";
  }

  grid.innerHTML += `
    <div class="spell-slot" onclick="castSpell(${s.id})">
      <div class="spell-icon-wrapper">
        <img class="spell-icon" src="/icons/spells/${s.icon}">
        <div class="spell-cooldown hidden" id="spell-cd-${s.id}"></div>
      </div>

      <div class="spell-info">
        <strong>${s.name}</strong>
        <div>Cost: ${s.scost} SP</div>
        <div>${description}</div>
        ${s.cooldown ? `<div class="cooldown-text">CD: ${s.cooldown}s</div>` : ""}
      </div>
    </div>
  `;
});
Object.entries(spellCooldowns).forEach(([spellId, endTime]) => {
  const remaining = Math.ceil((endTime - Date.now()) / 1000);
  if (remaining > 0) {
    startSpellCooldown(spellId, remaining);
  }
});

}




/* ===============================
   CAST SPELL
================================ */
async function castSpell(spellId) {
  // Client-side cooldown guard
  if (spellCooldowns[spellId] && Date.now() < spellCooldowns[spellId]) {
    return;
  }

  const response = await fetch("/spells/cast", {
    method: "POST",
    credentials: "include", // 🔥 REQUIRED for sessions
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spellId })
  });

  const data = await response.json();

  if (data.error) {
    if (data.error === "cooldown") return;
    alert(data.error);
    return;
  }

  if (data.log) {
    logCombat(data.log);
  }

  if (data.cooldown && data.cooldown > 0) {
    startSpellCooldown(spellId, data.cooldown);
  }

  if (data.enemyHP !== undefined) {
    updateEnemyHP(data.enemyHP);
  }

  if (data.playerHP !== undefined) {
    await refreshPlayerCaps();
  }

  if (data.playerSP !== undefined) {
    updatePlayerSP(data.playerSP);
  }

if (data.dead) {
  logCombat("🏆 Enemy defeated!");

  if (data.exp) {
    logCombat(`✨ You gained ${data.exp} EXP!`);
  }

  if (data.gold) {
    logCombat(`💰 You gained ${data.gold} gold!`);
  }

  if (data.levelUp) {
    logCombat(`⬆ LEVEL UP!`);
  }

  stopEnemyAutoAttack();
  setTimeout(closeCombatModal, 1200);
}


  closeSpellsModal();
}


/* ===============================
   LOAD/USE ITEMS
================================ */
async function useCombatItem(inventoryId) {
  const res = await fetch("/combat/use-item", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId })
  });

  const data = await res.json();
  if (data.error) return alert(data.error);

  logCombat(data.log);
  updatePlayerHP(data.playerHP);
  await refreshPlayerCaps();
  closeItemsModal();
}
async function loadCombatItems() {
  const res = await fetch("/combat/items");
  const items = await res.json();

  const grid = document.getElementById("combatItemsGrid");
  grid.innerHTML = "";

  items.forEach(i => {
    grid.innerHTML += `
      <div class="item-slot" onclick="useCombatItem(${i.inventory_id})">
        <img src="/icons/${i.icon}">
        <div class="qty">${i.quantity}</div>
      </div>
    `;
  });
}
/* ===============================
   COMBAT LOG HELPERS
================================ */
function logCombat(text) {
  const log = document.getElementById("combatLog");
  if (!log) return;
  log.innerHTML += `<div>${text}</div>`;
  log.scrollTop = log.scrollHeight;
}

function clearCombatLog() {
  const log = document.getElementById("combatLog");
  if (log) log.innerHTML = "";
}

function openItemsModal() {
  document.getElementById("itemsModal").classList.remove("hidden");
  loadCombatItems();
}

function closeItemsModal() {
  document.getElementById("itemsModal").classList.add("hidden");
}
function openSpellsModal() {
  document.getElementById("spellsModal").classList.remove("hidden");
  loadCombatSpells();
}

function closeSpellsModal() {
  document.getElementById("spellsModal").classList.add("hidden");
}

async function refreshPlayerCaps() {
  const res = await fetch("/me");
  const p = await res.json();

  window.playerMaxHP = p.maxhp;
  window.playerMaxSP = p.maxspoints;

  updateBar("playerHPBar", p.hpoints, p.maxhp);
  updateBar("playerSPBar", p.spoints, p.maxspoints);

  setText("playerHP", p.hpoints);
  setText("playerSP", p.spoints);
}
function startSpellCooldown(spellId, seconds) {
  const cdEl = document.getElementById(`spell-cd-${spellId}`);
  const spellSlot = cdEl?.closest(".spell-slot");
  if (!cdEl || seconds <= 0) return;

  const endTime = Date.now() + seconds * 1000;
  spellCooldowns[spellId] = endTime;

  cdEl.classList.remove("hidden");
  spellSlot?.classList.add("on-cooldown");

  function tick() {
    const remaining = Math.ceil((endTime - Date.now()) / 1000);

    if (remaining <= 0) {
      cdEl.classList.add("hidden");
      spellSlot?.classList.remove("on-cooldown");
      delete spellCooldowns[spellId];
      return;
    }

    cdEl.textContent = remaining;
    requestAnimationFrame(() => setTimeout(tick, 250));
  }

  tick();
}
function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;

  el.textContent =
    value === undefined || value === null ? "" : String(value);
}

function updateBar(barId, current, max) {
  const bar = document.getElementById(barId);
  if (!bar || max <= 0) return;
  const pct = Math.max(0, Math.min(100, (current / max) * 100));
  bar.style.width = pct + "%";
}
function updateEnemyHP(hp) {
  if (!currentEnemy) return;
  updateEnemyHUD(hp, currentEnemy.maxHP);
}



function updatePlayerHP(currentHP) {
  setText("playerHP", currentHP);
  updateBar("playerHPBar", currentHP, window.playerMaxHP);
}

function updatePlayerSP(currentSP) {
  setText("playerSP", currentSP);
  updateBar("playerSPBar", currentSP, window.playerMaxSP);
}
