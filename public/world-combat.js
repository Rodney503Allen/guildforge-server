// =======================
// WORLD COMBAT SYSTEM (v1)
// =======================

let WORLD_COMBAT = {
  inCombat: false,
  enemy: null,
  playerHP: 0,
  playerSP: 0,
  maxHP: 1,
  maxSP: 1
};

let enemyAttackTimer = null;

(function injectCombatStyles() {
  const style = document.createElement("style");
  style.innerHTML = `
  /* ========== GLOBAL RESET ========== */
  button {
    background: linear-gradient(#6b4226, #332010);
    border: 2px solid gold;
    color: #f5d27d;
    font-family: Cinzel, serif;
    font-weight: bold;
    cursor: pointer;
    border-radius: 6px;
    transition: 0.15s;
    padding: 8px;
  }

  button:hover:not(:disabled) {
    background: gold;
    color: black;
    box-shadow: 0 0 10px gold;
    transform: scale(1.05);
  }

  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    filter: grayscale(1);
  }

  /* ========== WORLD MAP TILES ========== */
  .tile {
    box-shadow: inset 0 0 10px rgba(0,0,0,.8), 0 0 4px rgba(0,0,0,.8);
    border: 2px solid #222;
    transition: 0.15s;
  }

  .tile.player {
    outline: 3px solid gold;
    box-shadow: 0 0 12px gold;
  }

  /* ========== COMBAT PANEL ========== */
#worldCombatPanel {
  position: relative;
  margin: 12px auto 0;

  width: 420px;
  max-width: 95vw;
  padding: 14px;

  background: linear-gradient(#140a05, #060301);
  border: 2px solid gold;
  border-radius: 12px;
  box-shadow: 0 0 16px rgba(255,215,0,.45);

  color: #f5d27d;
  z-index: 9999;

  pointer-events: auto;
}
  /* ========== WORLD DIM LAYER ========== */

  #combatTitle {
    font-size: 20px;
    text-align: center;
    margin-bottom: 4px;
  }

  #combatLog {
    height: 110px;
    overflow-y: auto;
    background: black;
    margin-top: 6px;
    padding: 6px;
    border: 1px solid gold;
    font-size: 12px;
    border-radius: 6px;
  }

  /* ========== COMBAT BUTTON GRID ========== */
  #combatButtons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 10px;
  }

  .combat-btn {
    width: 100%;
    font-size: 15px;
    padding: 10px;
  }

  /* ========== MOVEMENT UI ========== */
  .movement-grid {
    margin-top: 8px;
  }

  .movement-grid button {
    width: 60px;
    height: 40px;
    font-size: 18px;
  }

  /* ========== ENTER LOCATION BUTTON ========== */
  #enterBox {
    margin-top: 10px;
  }

  #enterBox button {
    width: 220px;
    font-size: 16px;
    background: linear-gradient(#2e4a7f, #121f3b);
    border-color: #7db2ff;
    color: #cfe2ff;
  }

  #enterBox button:hover {
    background: #7db2ff;
    color: black;
    box-shadow: 0 0 14px #7db2ff;
  }


  #worldUI {
    position: relative;
    z-index: 10;
  }

  `;

  (function injectSpellbookStyles() {
    const style2 = document.createElement("style");
    style2.innerHTML = `
      #spellbookOverlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.7);
        z-index: 2000;
        display: none;
        align-items: center;
        justify-content: center;
      }

      #spellbook {
        width: 420px;
        max-height: 520px;
        overflow-y: auto;
        background: linear-gradient(#140c07, #050302);
        border: 2px solid gold;
        border-radius: 12px;
        box-shadow: 0 0 20px rgba(255,215,0,.6);
        padding: 10px;
        color: gold;
        font-family: Cinzel, serif;
      }

      #spellbookHeader {
        display:flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }

      #spellbookHeader h2 {
        margin: 0;
        font-size: 18px;
      }

      #closeSpellbook {
        background: darkred;
        color: white;
        border: none;
        cursor:pointer;
        font-weight:bold;
        width: 26px;
        height: 26px;
        border-radius: 4px;
      }

      #spellGrid {
        display:grid;
        grid-template-columns: repeat(4, 1fr);
        gap:10px;
      }

      .spellSlot {
        width: 80px;
        height: 80px;
        background: black;
        border: 2px solid gold;
        border-radius: 6px;
        position: relative;
        cursor: pointer;
      }

      .spellSlot img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .spellSlot.disabled {
        opacity: 0.4;
        pointer-events: none;
      }

      .spellName {
        position:absolute;
        bottom:0;
        width:100%;
        background:rgba(0,0,0,.7);
        font-size:9px;
        text-align:center;
        color:gold;
      }

      .spellTooltip {
        position:absolute;
        inset:auto auto 90px 0;
        width:160px;
        padding:8px;
        background:black;
        border:1px solid gold;
        font-size:11px;
        display:none;
        z-index:50;
      }

      .spellSlot:hover .spellTooltip {
        display:block;
      }
      #worldUI, #Grid {
        position: relative;
        z-index: 500;
      }







.movement-middle {
  display: flex;
  justify-content: center;
  gap: 8px;
}

#enterLocationBtn {
  width: 90px;
  background: #222;
  border: 2px solid #333;
  color: #888;
  cursor: not-allowed;
}

/* ACTIVE STATE */
#enterLocationBtn.active {
  background: linear-gradient(#2e4a7f, #121f3b);
  border-color: #7db2ff;
  color: #cfe2ff;
  cursor: pointer;
}

#enterLocationBtn.active:hover {
  background: #7db2ff;
  color: black;
}

    `;
    document.head.appendChild(style2);
  })();

  document.head.appendChild(style);
})();

createWorldCombatPanel();
createSpellbookOverlay();
createItemOverlay();
updateCombatState(false);

if (window.worldEnemy && !WORLD_COMBAT.inCombat && !WORLD_COMBAT.enemy) {
  startWorldCombat(window.worldEnemy);
}

// =======================
// CREATE COMBAT PANEL
// =======================
function createWorldCombatPanel() {
  if (document.getElementById("worldCombatPanel")) return;

  const panel = document.createElement("div");
  panel.id = "worldCombatPanel";

  panel.innerHTML = `
<div id="combatTitle" style="font-size:20px;text-align:center;">
  🧭 Exploration Mode
</div>

<!-- 🧟 ENEMY PANEL (NESTED) -->
<div id="enemyPanel" style="
  display:none;
  border:2px solid darkred;
  background:linear-gradient(#120000,#050000);
  border-radius:10px;
  padding:8px;
  margin-bottom:8px;
">
  <div style="display:flex;gap:10px;align-items:center">
    <img id="enemyImage" src="/images/default_creature.png" style="
      width:72px;
      height:72px;
      object-fit:cover;
      border:2px solid crimson;
      border-radius:6px;
    ">
    <div style="flex:1">
      <div id="enemyTitle" style="font-size:16px;color:#ffb0b0"></div>
      <div id="enemyLevel" style="font-size:12px;color:#aaa"></div>
      <div style="height:10px;background:black;border:1px solid darkred;border-radius:5px;overflow:hidden;margin-top:6px">
        <div id="enemyHPFill" style="height:100%;width:100%;background:linear-gradient(crimson,darkred)"></div>
      </div>
      <div id="enemyHPText" style="font-size:12px;margin-top:4px"></div>
      <div id="enemyDesc" style="font-size:11px;color:#ccc"></div>
    </div>
  </div>
</div>

<div id="combatLog" style="
  height:110px;
  overflow-y:auto;
  background:#000;
  padding:6px;
  border:1px solid gold;
  font-size:12px;
  border-radius:6px;
"></div>

<div id="combatButtons" style="margin-top:8px">
  <button id="btnAttack" class="combat-btn" onclick="worldAttack()">⚔ Attack</button>
  <button class="combat-btn" onclick="openWorldSpells()">🔮 Spells</button>
  <button class="combat-btn" onclick="openWorldItems()">🎒 Items</button>
  <button id="btnFlee" class="combat-btn" onclick="fleeWorld()">🏃 Flee</button>
</div>

<hr>

<div class="movement-grid">
  <b>Movement</b><br>

  <button onclick="moveWorld('north')">⬆</button><br>

  <div class="movement-middle">
    <button onclick="moveWorld('west')">⬅</button>

    <!-- ENTER LOCATION BUTTON -->
    <button id="enterLocationBtn" disabled>ENTER</button>

    <button onclick="moveWorld('east')">➡</button>
  </div>

  <br>
  <button onclick="moveWorld('south')">⬇</button>
</div>

`;
document.getElementById("combatAnchor").appendChild(panel);





}

// =======================
// SPELLBOOK OVERLAY
// =======================
function createSpellbookOverlay() {
  if (document.getElementById("spellbookOverlay")) return;

  const div = document.createElement("div");
  div.id = "spellbookOverlay";

  div.innerHTML = `
    <div id="spellbook">
      <div id="spellbookHeader">
        <h2>📖 Spellbook</h2>
        <button id="closeSpellbook" onclick="closeWorldSpells()">X</button>
      </div>
      <div id="spellGrid"></div>
    </div>
  `;

  document.body.appendChild(div);
}
// =======================
// ITEM OVERLAY
// =======================
function createItemOverlay() {
  if (document.getElementById("itemOverlay")) return;

  const div = document.createElement("div");
  div.id = "itemOverlay";

  div.innerHTML = `
    <div id="itemBox">
      <div id="itemHeader">
        <h2>🎒 Inventory</h2>
        <button id="closeItemBox" onclick="closeWorldItems()">X</button>
      </div>
      <div id="itemList"></div>
    </div>
  `;

  document.body.appendChild(div);

  // Inject styles
  const style = document.createElement("style");
  style.innerHTML = `
    #itemOverlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.7);
      z-index: 2000;
      display: none;
      align-items: center;
      justify-content: center;
    }

    #itemBox {
      width: 360px;
      max-height: 460px;
      overflow-y: auto;
      background: linear-gradient(#140c07, #050302);
      border: 2px solid gold;
      border-radius: 12px;
      box-shadow: 0 0 20px rgba(255,215,0,.6);
      padding: 10px;
      color: gold;
      font-family: Cinzel, serif;
    }

    #itemHeader {
      display:flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    #closeItemBox {
      background: darkred;
      color: white;
      border: none;
      cursor:pointer;
      font-weight:bold;
      width: 26px;
      height: 26px;
      border-radius: 4px;
    }

    .itemEntry {
      border: 1px solid gold;
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 6px;
      display:flex;
      justify-content: space-between;
      align-items: center;
      background:black;
      font-size: 13px;
    }

    .useBtn {
      background: linear-gradient(#3d7eff, #1c3cb3);
      border: 1px solid #93b4ff;
      color: white;
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 4px;
      font-size: 12px;
    }

    .useBtn:hover {
      background: #7db2ff;
      color: black;
    }
  `;
  document.head.appendChild(style);
}
// =======================
// COMBAT STATE UI
// =======================
function updateCombatState(inCombat) {
  const attackBtn = document.getElementById("btnAttack");
  const fleeBtn = document.getElementById("btnFlee");
  const title = document.getElementById("combatTitle");
  const enemyPanel = document.getElementById("enemyPanel");

  if (!attackBtn || !fleeBtn || !title || !enemyPanel) return;

  if (inCombat && WORLD_COMBAT.enemy) {
    attackBtn.disabled = false;
    fleeBtn.disabled = false;
    title.innerText = "⚔ Combat Mode";
    enemyPanel.style.display = "block";
    showEnemyPanel(WORLD_COMBAT.enemy);
  } else {
    attackBtn.disabled = true;
    fleeBtn.disabled = true;
    title.innerText = "🧭 Exploration Mode";
    enemyPanel.style.display = "none";
  }
}

// =======================
// INITIAL PLAYER LOAD
// =======================
fetch("/me")
  .then(r => r.json())
  .then(p => {
    WORLD_COMBAT.playerHP = p.hpoints;
    WORLD_COMBAT.playerSP = p.spoints;
    WORLD_COMBAT.maxHP = p.maxhp;
    WORLD_COMBAT.maxSP = p.maxspoints;
    updateHUD(p.hpoints, p.spoints);
  });

// =======================
// HUD UPDATE
// =======================
function updateHUD(hp, sp) {
  const hpText = document.getElementById("hp-text");
  const spText = document.getElementById("sp-text");

  if (hpText) hpText.innerText = hp + " / " + WORLD_COMBAT.maxHP;
  if (spText) spText.innerText = sp + " / " + WORLD_COMBAT.maxSP;

  const hpBar = document.getElementById("hp-bar");
  const spBar = document.getElementById("sp-bar");

  if (hpBar) hpBar.style.width = Math.max(0, (hp / WORLD_COMBAT.maxHP) * 100) + "%";
  if (spBar) spBar.style.width = Math.max(0, (sp / WORLD_COMBAT.maxSP) * 100) + "%";
}

// =======================
// WORLD REFRESH
// =======================
function refreshWorld() {
  fetch("/world/partial")
    .then(r => r.text())
    .then(html => {
      const grid = document.getElementById("Grid");
      if (grid) grid.replaceWith(
  (() => {
    const t = document.createElement("div");
    t.innerHTML = html;
    return t.firstElementChild;
  })()
);
    });
  setTimeout(() => updateCombatState(WORLD_COMBAT.inCombat), 50);
}

// =======================
// MOVE
// =======================
function moveWorld(dir) {
  if (WORLD_COMBAT.inCombat) {
    worldLog("⚠ You cannot move during combat!");
    return;
  }

  fetch("/world/move/" + dir)
    .then(r => r.json())
    .then(res => {
      // UPDATE COORDINATES LIVE
      if (res.map_x !== undefined && res.map_y !== undefined) {
        const coords = document.querySelector(".coords");
        if (coords) {
          coords.innerText = `Position: (${res.map_x}, ${res.map_y})`;
        }
}
      if (!res.success) {
        if (res.reason === "combat") {
          worldLog("⚔ You are in combat!");
        } else {
          worldLog("❌ Can't move that way.");
        }
        return;
      }

      window.worldEnemy = res.enemy || null;

      if (res.enemy) {
        startWorldCombat(res.enemy);
        startEnemyAutoAttack(res.enemy);
      } else {
        WORLD_COMBAT.inCombat = false;
        stopEnemyAutoAttack();
      }
const enterBtn = document.getElementById("enterLocationBtn");

if (res.location && res.location.id) {
  enterBtn.classList.add("active");
  enterBtn.disabled = false;
  enterBtn.innerText = "ENTER";
  enterBtn.onclick = () => enterLocation(res.location.id);
} else {
  enterBtn.classList.remove("active");
  enterBtn.disabled = true;
  enterBtn.innerText = "ENTER";
  enterBtn.onclick = null;
}
// ===============================
// TOWN BUTTON UI UPDATE (LIVE)
// ===============================



      refreshWorld();
    });
}

// =======================
// UPDATE PLAYER HP (API)
// =======================
function updatePlayerHP() {
  fetch("/api/player/hp")
    .then(res => res.json())
    .then(data => {
      const hpBar = document.getElementById("hp-value");
      const hpText = document.getElementById("hp-text");

      if (!hpBar || !hpText) return;

      hpBar.style.width = data.percent + "%";
      hpText.innerText = data.current + " / " + data.max;
    })
    .catch(err => console.error("HP refresh failed", err));
}

// =======================
// COMBAT LOG
// =======================
function worldLog(msg) {
  const box = document.getElementById("combatLog");
  if (!box) return;
  const div = document.createElement("div");
  div.innerText = msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// =======================
// ENTER COMBAT
// =======================
function startWorldCombat(enemy) {
  WORLD_COMBAT.inCombat = true;
  WORLD_COMBAT.enemy = enemy;

  if (enemy.firstStrike) {
    WORLD_COMBAT.playerHP -= enemy.firstStrike;
    worldLog(`💥 ${enemy.name} strikes first for ${enemy.firstStrike}!`);
    updateHUD(WORLD_COMBAT.playerHP, WORLD_COMBAT.playerSP);

    if (WORLD_COMBAT.playerHP <= 0) {
      worldLog("☠ You were slain before you could react!");
      return setTimeout(() => location.href = "/death", 1000);
    }
  }

  worldLog(`⚠ ${enemy.name} engages you in combat!`);
  updateCombatState(true);

}

// =======================
// ENEMY AUTO ATTACK
// =======================
function startEnemyAutoAttack(enemy) {
  if (enemyAttackTimer) return;

  const speed = enemy.attack_speed || 1500;

  enemyAttackTimer = setInterval(async () => {
    try {
      const r = await fetch("/api/world/enemy-attack", {
        method: "POST"
      });

      if (!r.ok) {
        console.error("Enemy attack HTTP error", r.status);
        stopEnemyAutoAttack();
        return;
      }

      const data = await r.json();

      if (data.dead || data.stop) {
        stopEnemyAutoAttack();
        if (data.log) worldLog(data.log);

        if (data.dead) {
          setTimeout(() => location.href = "/death", 1000);
        }
        return;
      }

      if (typeof data.playerHP === "number") {
        WORLD_COMBAT.playerHP = data.playerHP;
        updateHUD(WORLD_COMBAT.playerHP, WORLD_COMBAT.playerSP);
      } else {
        updatePlayerHP();
      }

      if (data.log) worldLog(data.log);
    } catch (err) {
      console.error("Enemy loop crashed", err);
      stopEnemyAutoAttack();
    }
  }, speed);
}

function stopEnemyAutoAttack() {
  if (enemyAttackTimer) {
    clearInterval(enemyAttackTimer);
    enemyAttackTimer = null;
  }
}

// =======================
// LEAVE COMBAT
// =======================
function endWorldCombat() {
  WORLD_COMBAT.inCombat = false;
  WORLD_COMBAT.enemy = null;

  worldLog("✅ Combat ended.");
  updateCombatState(false);

}

// =======================
// ATTACK
// =======================
function worldAttack() {
  if (!WORLD_COMBAT.inCombat || !WORLD_COMBAT.enemy) return;



  fetch("/api/world/combat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  })
    .then(r => r.json())
.then(res => {

  // ✅ ALWAYS SHOW DAMAGE FIRST
  if (typeof res.pHit === "number") {
    worldLog(`⚔ You hit for ${res.pHit}${res.pCrit ? " (CRITICAL!)" : ""}`);
  }

  // ✅ NOW HANDLE DEATH
  if (res.dead) {
    worldLog(`🏆 Enemy defeated! +${res.exp} EXP, +${res.gold} gold`);

    if (res.loot) worldLog(`🎁 Loot: ${res.loot}`);

    WORLD_COMBAT.enemy = null;
    WORLD_COMBAT.inCombat = false;
    updateCombatState(false);
    endWorldCombat();
    return;
  }

  // ✅ UPDATE ENEMY HP IF STILL ALIVE
  WORLD_COMBAT.enemy.hp = res.enemyHP;
  updateEnemyHUD();
});

}

// =======================
// UPDATE ENEMY PANEL
// =======================
function updateEnemyHUD() {
  if (!WORLD_COMBAT.enemy) return;
  updateEnemyPanelHP(WORLD_COMBAT.enemy.hp, WORLD_COMBAT.enemy.maxhp);
}

function updateEnemyPanelHP(hp, max) {
  const fill = document.getElementById("enemyHPFill");
  const text = document.getElementById("enemyHPText");

  if (!fill || !text) return;

  const percent = Math.max(0, Math.round((hp / max) * 100));
  fill.style.width = percent + "%";
  text.innerText = `HP: ${hp} / ${max}`;
}

// =======================
// SPELLS / ITEMS
// =======================
function openWorldSpells() {
  fetch("/api/combat/spells")
    .then(r => r.json())
    .then(list => {
      const grid = document.getElementById("spellGrid");
      if (!grid) return;

      grid.innerHTML = "";

      list.forEach(spell => {
        const disabled = spell.is_combat && !WORLD_COMBAT.inCombat;
        const image = spell.image || "/images/spells/default.png";

        const div = document.createElement("div");
        div.className = "spellSlot";
        if (disabled) div.classList.add("disabled");

        div.innerHTML = `
          <img src="${image}" />
          <div class="spellName">${spell.name}</div>
          <div class="spellTooltip">
            <b>${spell.name}</b><br>
            Type: ${spell.type}<br>
            Cost: ${spell.scost} SP<br>
            Power: ${spell.svalue}<br>
            ${spell.is_combat ? "⚔ Combat Spell" : "🌍 World Spell"}
          </div>
        `;

        if (!disabled) {
          div.onclick = () => castWorld(spell.id);
        }

        grid.appendChild(div);
      });

      document.getElementById("spellbookOverlay").style.display = "flex";
    });
}

function closeWorldSpells() {
  const overlay = document.getElementById("spellbookOverlay");
  if (overlay) overlay.style.display = "none";
}

function castWorld(spellId) {
  fetch("/api/world/combat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spellId })
  })
    .then(r => r.json())
    .then(res => {
      if (res.error) {
        worldLog("❌ " + res.error);
        return;
      }

      if (res.log) worldLog(res.log);

      if (res.playerHP !== undefined) {
        WORLD_COMBAT.playerHP = res.playerHP;
        updateHUD(WORLD_COMBAT.playerHP, WORLD_COMBAT.playerSP);
      }

      if (res.enemyHP !== undefined && WORLD_COMBAT.enemy) {
        WORLD_COMBAT.enemy.hp = res.enemyHP;
        updateEnemyHUD();
      }

      if (res.dead) {
        worldLog("🏆 Enemy defeated!");
        if (res.loot) worldLog("🎁 Loot: " + res.loot);
        if (res.gold) worldLog("💰 Gold gained: " + res.gold);
        if (res.exp) worldLog("⭐ EXP gained: " + res.exp);
        endWorldCombat();
      }

      closeWorldSpells();
    });
}

function openWorldItems() {

  fetch("/api/combat/items")
    .then(r => r.json())
    .then(list => {

      if (!Array.isArray(list)) {
        console.error("❌ INVALID ITEM DATA:", list);
        worldLog("❌ Inventory failed to load.");
        return;
      }

      const box = document.getElementById("itemList");
      if (!box) return;

      box.innerHTML = "";

      if (!list.length) {
        box.innerHTML = "<div style='text-align:center;color:#aaa'>No usable items</div>";
      }

      list.forEach(i => {
        const div = document.createElement("div");
        div.className = "itemEntry";

        div.innerHTML = `
          <div>${i.name} x${i.quantity}</div>
          <button class="useBtn" onclick="useWorldItem(${i.randid})">Use</button>
        `;

        box.appendChild(div);
      });

      // ✅ SHOW OVERLAY
      document.getElementById("itemOverlay").style.display = "flex";
    })
    .catch(err => {
      console.error("❌ ITEMS FETCH ERROR:", err);
      worldLog("❌ Inventory crashed");
    });

}

function closeWorldItems() {
  const overlay = document.getElementById("itemOverlay");
  if (overlay) overlay.style.display = "none";
}
// =======================
// USE ITEM
// =======================
function useWorldItem(randomId) {

  fetch("/api/combat/use-item", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
    randid: randomId,
    inCombat: WORLD_COMBAT.inCombat
})

  })
  .then(r => r.json())
  .then(res => {

    if (res.error) {
      worldLog("❌ " + res.error);
      return;
    }

    if (res.log) worldLog(res.log);

    // ✅ UPDATE PLAYER STATS IF CHANGED
    if (typeof res.playerHP === "number") {
      WORLD_COMBAT.playerHP = res.playerHP;
      updateHUD(WORLD_COMBAT.playerHP, WORLD_COMBAT.playerSP);
    }

    if (typeof res.playerSP === "number") {
      WORLD_COMBAT.playerSP = res.playerSP;
      updateHUD(WORLD_COMBAT.playerHP, WORLD_COMBAT.playerSP);
    }

    // ✅ REFRESH ITEM LIST AFTER USE
    openWorldItems();

  })
  .catch(err => {
    console.error("Item use failed:", err);
    worldLog("❌ Item failed.");
  });
}


// =======================
// ENEMY PANEL POPULATION
// =======================
function showEnemyPanel(enemy) {
  const panel = document.getElementById("enemyPanel");
  if (!panel || !enemy) return;

  const title = document.getElementById("enemyTitle");
  const level = document.getElementById("enemyLevel");
  const desc  = document.getElementById("enemyDesc");
  const imgEl = document.getElementById("enemyImage");

  if (title) title.innerText = enemy.name;
  if (level) level.innerText = "Level " + (enemy.level || "?");
  if (desc)  desc.innerText  = enemy.description || "";

  const img = enemy.image || enemy.creatureimage || "/images/default_creature.png";
  if (imgEl) imgEl.src = img;

  updateEnemyPanelHP(enemy.hp, enemy.maxhp);
  panel.style.display = "block";
}

// =======================
// FLEE
// =======================
function fleeWorld() {
  fetch("/api/world/flee", { method: "POST" })
    .then(() => {
      worldLog("🏃 You fled!");
      WORLD_COMBAT.enemy = null;
      WORLD_COMBAT.inCombat = false;
      updateEnemyHUD();
      updateCombatState(false);
      refreshWorld();
      endWorldCombat();
    });
}

function enterLocation(id) {
  fetch("/world/enter/" + id)
    .then(r => r.json())
    .then(res => {
      if (!res.success) {
        alert(res.error || "Cannot enter.");
        return;
      }
      window.location.href = res.redirect;
    });
}


