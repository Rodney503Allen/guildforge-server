//world-combat.js
// =======================================
// WORLD COMBAT (MODAL-ONLY, CLEAN)
// =======================================

let currentEnemy = null;
const spellCooldowns = {};
// { spellId: timestamp_when_ready }

// ✅ NEW: post-combat state flag (so we can enable close + reload on manual close)
let combatOver = false;
let combatStateInterval = null;
function maybeShowLootChest(data) {
  const chestId = data?.chest?.id ?? data?.chestId ?? null;
  if (!chestId) return;

  setTimeout(() => {
    if (typeof LootChestModal !== "undefined") {
      LootChestModal.setPending?.(chestId); // show indicator
      LootChestModal.show(chestId);         // open modal
    } else {
      console.warn("LootChestModal not loaded");
    }
  }, 250);
}

function startCombatStatePolling() {
  if (combatStateInterval) return;

  combatStateInterval = setInterval(async () => {
    try {
      const res = await fetch("/combat/state", { credentials: "include" });
      const data = await res.json();

      if (!data?.snapshot) return;

      syncCombatSnapshot(data.snapshot);

      if (data.snapshot?.state === "defeat" && !combatOver) {
        stopCombatStatePolling();
        currentEnemy = null;
        setTimeout(() => (window.location.href = "/death.html"), 500);
        return;
      }

      if (!data.inCombat && !combatOver) {
        if (data.snapshot?.state === "victory") {
          logCombat("🏆 Enemy defeated!");

          const rewards = data.snapshot.rewards;
          if (rewards) {
            if (rewards.exp) logCombat(`✨ You gained ${rewards.exp} EXP!`);
            if (rewards.gold) logCombat(`💰 You gained ${rewards.gold} gold!`);
            if (rewards.levelUp) logCombat("⬆ LEVEL UP!");

            maybeShowLootChest({
              chest: rewards.chest ?? null,
              quest: rewards.quest ?? null
            });
          }
        }

        enterPostCombatState();
      }
    } catch (err) {
      console.error("combat/state polling failed", err);
    }
  }, 200);
}

function stopCombatStatePolling() {
  if (combatStateInterval) {
    clearInterval(combatStateInterval);
    combatStateInterval = null;
  }
}

// ✅ NEW: enable/disable close button (top-right of modal)
function setCombatCloseEnabled(enabled) {
  const btn = document.getElementById("combatCloseBtn"); // <-- required in your HTML
  if (!btn) return;

  btn.disabled = !enabled;

  // lightweight visual affordance (won't break if no CSS)
  btn.style.pointerEvents = enabled ? "auto" : "none";
  btn.style.opacity = enabled ? "1" : "0.4";
}

// ✅ Disable/enable ALL combat modal buttons except the top-right close X
function setCombatUIEnabled(enabled) {
  const modal = document.getElementById("combatModal");
  if (!modal) return;

    // ✅ toggle dim state
  modal.classList.toggle("post-combat-dim", !enabled);
  
  // target all buttons inside modal
  const buttons = modal.querySelectorAll("button");

  buttons.forEach((b) => {
    if (b.id === "combatCloseBtn") return; // keep X controllable via setCombatCloseEnabled
    b.disabled = !enabled;
  });

  // Optional: also kill pointer interaction on non-button clickable tiles (if any)
  // This is safe even if none exist.
  modal.querySelectorAll(".hotbar-tile, .spell-tile, .spell-slot, .item-slot").forEach((el) => {
    // don't block tooltips/scrolling; just stop clicking
    el.style.pointerEvents = enabled ? "" : "none";
  });
}

// =======================
// POTION COOLDOWNS (PER SLOT)
// =======================
const POTION_CD_MS = 2000; // 2s cooldown PER potion slot

const potionCdEnd = {
  health: 0,
  mana: 0
};

const potionCdTimer = {
  health: null,
  mana: null
};

function getPotionEls(slot) {
  const isHealth = slot === "health";
  return {
    btn: document.getElementById(isHealth ? "hpPotionBtn" : "spPotionBtn"),
    cd:  document.getElementById(isHealth ? "potion-cd-hp" : "potion-cd-sp")
  };
}

function isPotionOnCooldown(slot) {
  return Date.now() < (potionCdEnd[slot] || 0);
}

function setPotionDimmed(slot, dimmed) {
  const { btn } = getPotionEls(slot);
  if (!btn) return;
  btn.classList.toggle("is-cooldown", !!dimmed);
  btn.style.pointerEvents = dimmed ? "none" : "";
}

function showPotionCooldown(slot, seconds) {
  const { cd } = getPotionEls(slot);
  if (!cd) return;
  cd.classList.remove("hidden");
  cd.textContent = String(seconds);
}

function hidePotionCooldown(slot) {
  const { cd } = getPotionEls(slot);
  if (!cd) return;
  cd.classList.add("hidden");
  cd.textContent = "";
}

function startPotionCooldown(slot, seconds = 2) {
  potionCdEnd[slot] = Date.now() + seconds * 1000;

  setPotionDimmed(slot, true);
  showPotionCooldown(slot, seconds);

  if (potionCdTimer[slot]) clearInterval(potionCdTimer[slot]);

  potionCdTimer[slot] = setInterval(() => {
    const remaining = Math.ceil((potionCdEnd[slot] - Date.now()) / 1000);

    if (remaining <= 0) {
      clearInterval(potionCdTimer[slot]);
      potionCdTimer[slot] = null;
      potionCdEnd[slot] = 0;

      hidePotionCooldown(slot);
      setPotionDimmed(slot, false);
      return;
    }

    showPotionCooldown(slot, remaining);
  }, 150);
}

function cancelPotionCooldown(slot) {
  potionCdEnd[slot] = 0;
  if (potionCdTimer[slot]) {
    clearInterval(potionCdTimer[slot]);
    potionCdTimer[slot] = null;
  }
  hidePotionCooldown(slot);
  setPotionDimmed(slot, false);
}

function cancelAllPotionCooldowns() {
  cancelPotionCooldown("health");
  cancelPotionCooldown("mana");
}


// ✅ NEW: put modal into "post-combat" mode instead of auto-closing
function enterPostCombatState() {
  combatOver = true;

  stopCombatStatePolling();

  // lock further combat actions safely
  currentEnemy = null;

  // ✅ disable everything in the modal except the close button
  setCombatUIEnabled(false);

  // ✅ allow closing now
  setCombatCloseEnabled(true);

  logCombat("✅ Combat ended. Close this window when you're ready.");
}


function updateEnemyHUD(hp, maxHP) {
  const bar = document.getElementById("enemyHPBar");
  const hpText = document.getElementById("enemyHP");
  const maxText = document.getElementById("enemyMaxHP");

  if (!bar) return;

  if (currentEnemy) {
    currentEnemy.hp = hp;
    if (Number.isFinite(maxHP)) {
      currentEnemy.maxHP = maxHP;
    }
  }

  if (hpText) hpText.innerText = hp;
  if (maxText) maxText.innerText = Number.isFinite(maxHP)
    ? maxHP
    : (currentEnemy?.maxHP ?? "");

  const effectiveMax = Number.isFinite(maxHP)
    ? maxHP
    : (currentEnemy?.maxHP ?? 0);

  if (effectiveMax > 0) {
    bar.style.width = Math.max(0, (hp / effectiveMax) * 100) + "%";
  }
}

function syncCombatSnapshot(snapshot) {
  if (!snapshot) return;

  const player = snapshot.player;
  const enemy = snapshot.enemy;

  if (player) {
    setText("playerHP", player.hp);
    setText("playerMaxHP", player.maxHp);
    setText("playerSP", player.sp);
    setText("playerMaxSP", player.maxSp);

    updateBar("playerHPBar", player.hp, player.maxHp);
    updateBar("playerSPBar", player.sp, player.maxSp);

    window.playerMaxHP = player.maxHp;
    window.playerMaxSP = player.maxSp;

    const playerGauge = Math.max(0, Math.min(100, Number(player.gauge || 0)));
    updateBar("playerATBBar", playerGauge, 100);
    setText("playerATBText", player.ready ? "READY" : `${Math.round(playerGauge)}%`);

    const playerPanel = document.querySelector(".player-panel");
    if (playerPanel) {
      playerPanel.classList.toggle("ready", !!player.ready);
    }
  }

  if (enemy) {
    if (currentEnemy) {
      currentEnemy.hp = Number(enemy.hp ?? currentEnemy.hp ?? 0);
      currentEnemy.maxHP = Number(enemy.maxHp ?? currentEnemy.maxHP ?? 1);
    }

    setText("enemyName", enemy.name);
    setText("enemyLevel", enemy.level);
    setText("enemyDescription", enemy.description);
    setText("enemyHP", enemy.hp);
    setText("enemyMaxHP", enemy.maxHp);
    updateBar("enemyHPBar", enemy.hp, enemy.maxHp);

    const enemyGauge = Math.max(0, Math.min(100, Number(enemy.gauge || 0)));
    updateBar("enemyATBBar", enemyGauge, 100);
    setText("enemyATBText", enemy.ready ? "READY" : `${Math.round(enemyGauge)}%`);

    const enemyPanel = document.querySelector(".enemy-panel");
    if (enemyPanel) {
      enemyPanel.classList.toggle("ready", !!enemy.ready);
    }
  }

  // Optional: disable Attack button unless player is ready
  const attackBtn = document.getElementById("combatAttackBtn");
  if (attackBtn && !combatOver) {
    attackBtn.disabled = !player?.ready;
  }
}
/* ===============================
   COMBAT MODAL CONTROL
================================ */

window.openCombatModal = async function (enemy) {
  await waitForEl("combatModal");
  cancelAllPotionCooldowns();
// ✅ NEW: always populate the hotbar ASAP
loadHotbarSpells();

  startCombatStatePolling();
  // ✅ Always show modal immediately (so user sees it)
  document.getElementById("combatModal").classList.remove("hidden");
  loadEquippedPotions();
    // ✅ Enemy portrait from creatures.creatureimage
const enemyImg = document.getElementById("enemyPortrait");
if (enemyImg) {
  let src = enemy?.img || "/images/default_creature.png";

  if (src && !src.startsWith("/") && !src.startsWith("http")) {
    src = "/" + src;
  }

  enemyImg.src = src;
  enemyImg.onerror = () => {
    enemyImg.onerror = null;
    enemyImg.src = "/images/default_creature.png";
  };
}
  // ✅ NEW: reset post-combat state + disable close while fighting
  combatOver = false;
  setCombatCloseEnabled(false);

    // ✅ re-enable combat UI buttons for a fresh fight
  setCombatUIEnabled(true);

  // ✅ Reset log immediately
  clearCombatLog();
  logCombat(`⚠ ${enemy?.name ?? "Enemy"} engages you!`);

  // ✅ Build a safe enemy object NOW (no NaN)
  const hp = Number(enemy?.hp);
  const max = Number(enemy?.maxHP ?? enemy?.maxhp ?? enemy?.max_hp ?? enemy?.maxhp ?? enemy?.hp);

  currentEnemy = {
    id: enemy?.id,
    name: enemy?.name ?? "Enemy",
    level: enemy?.level ?? "",
    description: enemy?.description ?? "",
    hp: Number.isFinite(hp) ? hp : 0,
    maxHP: Number.isFinite(max) ? max : (Number.isFinite(hp) ? hp : 1)
  };

  // ✅ Update ENEMY UI immediately (DO NOT wait on /me)
  setText("enemyName", currentEnemy.name);
  setText("enemyLevel", currentEnemy.level);
  setText("enemyDescription", currentEnemy.description);
  setText("enemyHP", currentEnemy.hp);
  setText("enemyMaxHP", currentEnemy.maxHP);
  updateBar("enemyHPBar", currentEnemy.hp, currentEnemy.maxHP);

   // Enemy actions now resolve through /combat/state polling

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
    const snap = state?.snapshot;

    if (state?.inCombat && snap?.enemy) {
      const ehp = Number(snap.enemy.hp);
      const emax = Number(snap.enemy.maxHp ?? snap.enemy.maxHP ?? snap.enemy.maxhp);

      if (Number.isFinite(ehp)) {
        currentEnemy.hp = ehp;
        setText("enemyHP", ehp);
      }
      if (Number.isFinite(emax)) {
        currentEnemy.maxHP = emax;
        setText("enemyMaxHP", emax);
      }

      updateBar("enemyHPBar", currentEnemy.hp, currentEnemy.maxHP);

      if (snap.player) {
        setText("playerHP", snap.player.hp);
        setText("playerMaxHP", snap.player.maxHp);
        setText("playerSP", snap.player.sp);
        setText("playerMaxSP", snap.player.maxSp);

        updateBar("playerHPBar", snap.player.hp, snap.player.maxHp);
        updateBar("playerSPBar", snap.player.sp, snap.player.maxSp);

        window.playerMaxHP = snap.player.maxHp;
        window.playerMaxSP = snap.player.maxSp;
      }
    }
  } catch (e) {
    console.warn("combat/state sync failed (non-fatal)", e);
  }
};

// ✅ CHANGED: stop polling too; only reload if combatOver is true
window.closeCombatModal = function () {
  stopCombatStatePolling();
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
  if (combatOver) return;
  if (!currentEnemy) return;
  if (playerAttackLocked) return;

  playerAttackLocked = true;
  setTimeout(() => {
    playerAttackLocked = false;
  }, 150);

  const res = await fetch("/combat/attack", { method: "POST" });
  const data = await res.json();

  if (data.error === "not_ready") {
    return;
  }

  if (data.error === "combat_over") {
    return;
  }

  if (data.error === "No enemy") {
    return;
  }

  if (data.error === "server_error") {
    return;
  }

  if (data.log) logCombat(data.log);

  if (data.damage !== undefined) {
    if (data.dodged) {
      logCombat("⚔ Your attack missed!");
    } else {
      logCombat(`⚔ You hit for ${data.damage}${data.crit ? " (CRITICAL!)" : ""}`);
    }
  }

  if (data.lifestealHeal) {
    logCombat(`🩸 You restore ${data.lifestealHeal} HP.`);
    await refreshPlayerCaps();
  }

  if (data.enemyHP !== undefined) {
    updateEnemyHP(data.enemyHP);
  }

  if (data.dead) {
    logCombat("🏆 Enemy defeated!");

    const exp = data.exp ?? data.expGained;
    const gold = data.gold ?? data.goldGained;

    if (exp) logCombat(`✨ You gained ${exp} EXP!`);
    if (gold) logCombat(`💰 You gained ${gold} gold!`);
    if (data.levelUp) logCombat("⬆ LEVEL UP!");

    enterPostCombatState();
    maybeShowLootChest(data);
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

  if (state?.inCombat && state?.snapshot?.enemy) {
    openCombatModal({
      id: state.snapshot.enemy.id,
      name: state.snapshot.enemy.name,
      level: state.snapshot.enemy.level,
      description: state.snapshot.enemy.description,
      hp: state.snapshot.enemy.hp,
      maxHP: state.snapshot.enemy.maxHp
    });

    if (state.snapshot) {
      syncCombatSnapshot(state.snapshot);
    }
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
  if (combatOver) return;

  // Client-side cooldown guard
  if (spellCooldowns[spellId] && Date.now() < spellCooldowns[spellId]) {
    return;
  }

  const response = await fetch("/spells/cast", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spellId })
  });

  const data = await response.json();

  if (data.error) {
    if (data.error === "cooldown") return;
    if (data.error === "not_ready") return;
    if (data.error === "combat_over") return;
    alert(data.error);
    return;
  }

  if (data.log) {
    logCombat(data.log);
  }

  if (data.cooldown && data.cooldown > 0) {
    spellCooldowns[spellId] = Date.now() + data.cooldown * 1000;
    startHotbarCooldown(spellId, data.cooldown);
  }

  if (data.enemyHP !== undefined) {
    updateEnemyHP(data.enemyHP);
  }

  if (data.playerHP !== undefined) {
    updatePlayerHP(data.playerHP);
  }

  if (data.playerSP !== undefined) {
    updatePlayerSP(data.playerSP);
  }

  if (data.dead) {
    logCombat("🏆 Enemy defeated!");

    const exp = data.exp ?? data.expGained;
    const gold = data.gold ?? data.goldGained;

    if (exp) logCombat(`✨ You gained ${exp} EXP!`);
    if (gold) logCombat(`💰 You gained ${gold} gold!`);
    if (data.levelUp) logCombat("⬆ LEVEL UP!");

    enterPostCombatState();
    maybeShowLootChest(data);
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

  if (slot !== "health" && slot !== "mana") return;

  // ✅ cooldown guard PER slot
  if (isPotionOnCooldown(slot)) return;

  // ✅ start cooldown immediately (prevents double-click spam)
  startPotionCooldown(slot, Math.ceil(POTION_CD_MS / 1000));

  try {
    const r = await fetch("/combat/potions-use", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot }) // "health" | "mana"
    });

    const data = await r.json();

    if (data.error) {
      // ❗ If the server rejected the use, refund the cooldown so it doesn't feel bad
      cancelPotionCooldown(slot);
      logCombat(`⚠ ${data.error}`);
      await loadEquippedPotions();
      return;
    }

    if (data.log) logCombat(data.log);

    if (data.playerHP !== undefined) updatePlayerHP(data.playerHP);
    if (data.playerSP !== undefined) updatePlayerSP(data.playerSP);

    await refreshPlayerCaps();
    await loadEquippedPotions(); // qty/empty refresh
  } catch (e) {
    // refund cooldown on network failure
    cancelPotionCooldown(slot);
    console.error("useHotbarPotion failed", e);
    logCombat("⚠ Failed to use potion.");
    await loadEquippedPotions();
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
