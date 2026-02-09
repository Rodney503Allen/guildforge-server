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

// ✅ NEW: post-combat state flag (so we can enable close + reload on manual close)
let combatOver = false;

// ✅ NEW: enable/disable close button (top-right of modal)
function setCombatCloseEnabled(enabled) {
  const btn = document.getElementById("combatCloseBtn"); // <-- required in your HTML
  if (!btn) return;

  btn.disabled = !enabled;

  // lightweight visual affordance (won't break if no CSS)
  btn.style.pointerEvents = enabled ? "auto" : "none";
  btn.style.opacity = enabled ? "1" : "0.4";
}

// ✅ NEW: put modal into "post-combat" mode instead of auto-closing
function enterPostCombatState() {
  combatOver = true;

  stopStatusPolling();
  stopEnemyAutoAttack();

  // lock further combat actions safely
  currentEnemy = null;

  // let player review the log
  setCombatCloseEnabled(true);

  logCombat("✅ Combat ended. Close this window when you're ready.");
}

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

        // ✅ CHANGED: do NOT auto-close
        // Put the modal into post-combat review state instead
        setTimeout(() => {
          enterPostCombatState();
        }, 200);

        return;
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
    bar.style.width = Math.max(0, (hp / currentEnemy.maxHP) * 100) + "%";
  }
}





/* ===============================
   COMBAT MODAL CONTROL
================================ */

window.openCombatModal = async function (enemy) {
  await waitForEl("combatModal");

// ✅ NEW: always populate the hotbar ASAP
loadHotbarSpells();

  startStatusPolling();

  // ✅ Always show modal immediately (so user sees it)
  document.getElementById("combatModal").classList.remove("hidden");
  loadEquippedPotions();
  // ✅ NEW: reset post-combat state + disable close while fighting
  combatOver = false;
  setCombatCloseEnabled(false);

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

// ✅ CHANGED: stop polling too; only reload if combatOver is true
window.closeCombatModal = function () {
  stopStatusPolling();
  stopEnemyAutoAttack();
  currentEnemy = null;

  document.getElementById("combatModal").classList.add("hidden");

  // ✅ If combat ended, closing means "continue" → refresh everything
  if (combatOver) {
    location.reload();
  } else {
    // if you ever allow manual closing mid-fight later, keep it disabled by default
    setCombatCloseEnabled(false);
  }

  combatOver = false;
};

/* ===============================
   COMBAT ACTIONS
================================ */
let playerAttackLocked = false;
async function combatAttack() {
  if (combatOver) return; // ✅ NEW: block actions in post-combat review mode
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

    // ✅ CHANGED: do NOT auto-close
    enterPostCombatState();
    return;
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
        logCombat(`💥 ${currentEnemy?.name ?? "Enemy"} hits you for ${data.damage}`);
      }

      if (data.playerDead) {
        logCombat("☠ You were slain!");
        stopEnemyAutoAttack();
        stopStatusPolling();
        currentEnemy = null;
        setTimeout(() => (window.location.href = "/death.html"), 600);
        return;
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
   HOTBAR
================================ */
function renderHotbarSpells(spells) {
  const bar = document.getElementById("combatHotbar");
  const manaBtn = document.getElementById("spPotionBtn");
  if (!bar || !manaBtn) return;

  // ✅ Remove ONLY previously-rendered spell buttons (leave potions)
  bar.querySelectorAll(".hotbar-spell").forEach(el => el.remove());

  const MAX = 6;
  const list = Array.isArray(spells) ? spells.slice(0, MAX) : [];

  for (let i = 0; i < MAX; i++) {
    const s = list[i];
    const key = (i + 1);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hotbar-tile hotbar-spell"; // <- marker class so we can remove later

    if (!s) {
      btn.classList.add("empty");
      btn.title = "Empty Slot";
      btn.innerHTML = `
        <img src="/icons/default.png" alt="">
        <span class="hotbar-key">${key}</span>
      `;
    } else {
      const name = (s.name ?? "Spell").toString();
      const icon = (s.icon ?? "default.png").toString();

      btn.title = name;
      btn.onclick = () => castSpell(s.id);
// Build a readable description (same logic as spellbook)
let description = "";
switch (s.type) {
  case "damage": description = `Damage: ${s.damage ?? 0}`; break;
  case "heal": description = `Heal: ${s.heal ?? 0}`; break;
  case "dot": description = `DOT: ${s.dot_damage ?? 0} / ${s.dot_tick_rate ?? 1}s (${s.dot_duration ?? 0}s)`; break;
  case "damage_dot": description = `Hit: ${s.damage ?? 0} + DOT: ${s.dot_damage ?? 0}/${s.dot_tick_rate ?? 1}s (${s.dot_duration ?? 0}s)`; break;
  case "buff": description = `Buff ${String(s.buff_stat || "").toUpperCase()} +${s.buff_value ?? 0} (${s.buff_duration ?? 0}s)`; break;
  case "debuff": description = `Debuff ${String(s.debuff_stat || "").toUpperCase()} ${s.debuff_value ?? 0} (${s.debuff_duration ?? 0}s)`; break;
  default: description = s.description || "";
}

btn.innerHTML = `
  <img src="/icons/spells/${icon}" alt="${name}" onerror="this.src='/icons/default.png'">
  <span class="hotbar-key">${key}</span>
  <div class="hotbar-cd hidden" id="hotbar-cd-${s.id}"></div>

  <!-- ✅ Tooltip -->
  <div class="hotbar-tooltip">
    <div class="tt-title">${name}</div>

    <div class="tt-row">
      <span class="tt-muted">Cost</span>
      <span>${s.scost ?? 0} SP</span>
    </div>

    ${s.cooldown ? `
      <div class="tt-row">
        <span class="tt-muted">Cooldown</span>
        <span>${s.cooldown}s</span>
      </div>
    ` : ""}

    <div class="tt-sep"></div>
    <div>${description || "<span class='tt-muted'>No description</span>"}</div>
  </div>
`;
    }

    // ✅ Insert spell buttons BEFORE the mana potion button
    bar.insertBefore(btn, manaBtn);
  }

  // ✅ Re-apply existing cooldowns
  Object.entries(spellCooldowns).forEach(([spellId, endTime]) => {
    const remaining = Math.ceil((endTime - Date.now()) / 1000);
    if (remaining > 0) startHotbarCooldown(spellId, remaining);
  });
}




function startHotbarCooldown(spellId, seconds) {
  const cdEl = document.getElementById(`hotbar-cd-${spellId}`);
  if (!cdEl || seconds <= 0) return;

  const endTime = Date.now() + seconds * 1000;

  cdEl.classList.remove("hidden");

  function tick() {
    const remaining = Math.ceil((endTime - Date.now()) / 1000);
    if (remaining <= 0) {
      cdEl.classList.add("hidden");
      cdEl.textContent = "";
      return;
    }
    cdEl.textContent = remaining;
    requestAnimationFrame(() => setTimeout(tick, 250));
  }

  tick();
}

/* ===============================
   CAST SPELL
================================ */
async function castSpell(spellId) {
  if (combatOver) return; // ✅ NEW: block actions in post-combat review mode

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
    spellCooldowns[spellId] = Date.now() + data.cooldown * 1000; // keep your guard working
    startHotbarCooldown(spellId, data.cooldown);
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

    // ✅ CHANGED: do NOT auto-close
    enterPostCombatState();
    closeSpellsModal();
    return;
  }

  closeSpellsModal();
}
async function loadHotbarSpells() {
  try {
    const res = await fetch("/combat/spells", { credentials: "include" });
    const spells = await res.json();
    if (Array.isArray(spells)) {
      renderHotbarSpells(spells);
    } else {
      renderHotbarSpells([]); // show empty slots
    }
  } catch (e) {
    console.warn("Hotbar spells load failed:", e);
    renderHotbarSpells([]); // fail gracefully
  }
}

/* ===============================
   LOAD/USE ITEMS
================================ */
function resolveItemIcon(rawIcon) {
  const raw = (rawIcon ?? "").toString().trim();
  if (!raw) return "/icons/default.png";

  // absolute url
  if (raw.startsWith("http")) return raw;

  // already a rooted path like "/icons/..."
  if (raw.startsWith("/")) return raw;

  // if DB stores "icons/xxx.png" or "potions/xxx.png", normalize to "/icons/..."
  if (raw.startsWith("icons/")) return "/" + raw;

  // if DB stores just "potion.png", assume it's in /icons/
  return "/icons/" + raw.replace(/^\/+/, "");
}

async function loadEquippedPotions() {
  try {
    const r = await fetch("/combat/potions-equipped", { credentials: "include" });
    const data = await r.json();
console.log("🧪 potions-equipped payload:", data);
console.log("🧪 health potion object:", data?.health);
console.log("🧪 mana potion object:", data?.mana);
    applyPotion("health", data?.health || null);
    applyPotion("mana", data?.mana || null);
  } catch (e) {
    console.warn("loadEquippedPotions failed", e);
    applyPotion("health", null);
    applyPotion("mana", null);
  }
}

function applyPotion(slot, potion) {
  const isHealth = slot === "health";

  const tip = document.getElementById(isHealth ? "hpPotionTooltip" : "spPotionTooltip");
  const btn = document.getElementById(isHealth ? "hpPotionBtn" : "spPotionBtn");
  const img = document.getElementById(isHealth ? "hpPotionImg" : "spPotionImg");
  const qtyEl = document.getElementById(isHealth ? "hpPotionQty" : "spPotionQty");

  // Tip is optional, but the rest must exist
  if (!btn || !img || !qtyEl) return;

  // ---- No potion equipped ----
  if (!potion) {
    btn.disabled = true;

    qtyEl.classList.add("hidden");
    qtyEl.textContent = "";

    if (tip) {
      tip.innerHTML = `
        <div class="tt-title">${isHealth ? "Health Potion" : "Mana Potion"}</div>
        <div class="tt-muted">No potion equipped</div>
      `;
    }
    return;
  }

  // ---- Potion equipped ----
  btn.disabled = false;

  // Icon
  const iconSrc = resolveItemIcon(potion.icon);
  if (iconSrc) img.src = iconSrc;

  // Quantity badge
  const qty = Number(potion.qty ?? potion.quantity ?? 1);
  if (qty > 1) {
    qtyEl.textContent = String(qty);
    qtyEl.classList.remove("hidden");
  } else {
    qtyEl.classList.add("hidden");
    qtyEl.textContent = "";
  }

  // Tooltip content
  const name = (potion.name ?? (isHealth ? "Health Potion" : "Mana Potion")).toString();

  // Try common fields that might exist in your DB
  const amount = Number(
  potion.effect_value ??
  potion.heal_amount ?? potion.restore_amount ??
  potion.heal ?? potion.restore ?? potion.amount ??
  0
);


  const desc = (potion.description ?? potion.desc ?? "").toString().trim();

  if (tip) {
    tip.innerHTML = `
      <div class="tt-title">${name}</div>
      <div class="tt-row">
        <span class="tt-muted">Effect</span>
        <span>${amount ? (isHealth ? `+${amount} HP` : `+${amount} SP`) : (isHealth ? "Restores HP" : "Restores SP")}</span>
      </div>
      ${desc ? `<div class="tt-sep"></div><div>${desc}</div>` : ""}
    `;
  }
}


async function useHotbarPotion(slot) {
  if (combatOver) return;

  try {
    const r = await fetch("/combat/potions-use", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot }) // "health" | "mana"
    });

    const data = await r.json();
    if (data.error) {
      logCombat(`⚠ ${data.error}`);
      return;
    }

    if (data.log) logCombat(data.log);

    if (data.playerHP !== undefined) updatePlayerHP(data.playerHP);
    if (data.playerSP !== undefined) updatePlayerSP(data.playerSP);

    await refreshPlayerCaps();
    await loadEquippedPotions(); // qty/empty refresh
  } catch (e) {
    console.error("useHotbarPotion failed", e);
    logCombat("⚠ Failed to use potion.");
  }
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

function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;

  el.textContent = value === undefined || value === null ? "" : String(value);
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
