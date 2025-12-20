// =======================
// COMBAT LOG
// =======================
function log(msg) {
  const box = document.getElementById("log");
  const div = document.createElement("div");
  div.innerText = msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}


// =======================
// LOAD PLAYER LIMITS
// =======================
let MAX_HP = 1;
let MAX_SP = 1;

fetch("/me")
  .then(r => r.json())
  .then(p => {
    MAX_HP = p.maxhp;
    MAX_SP = p.maxspoints;
  });


// =======================
// UPDATE HUD BARS
// =======================
function updateHUD(hp, sp) {

  const hpText = document.getElementById("hp-text");
  const spText = document.getElementById("sp-text");

  if (hpText) hpText.innerText = hp + " / " + MAX_HP;
  if (spText && sp !== undefined) spText.innerText = sp + " / " + MAX_SP;

  const hpBar = document.getElementById("hp-bar");
  const spBar = document.getElementById("sp-bar");

  if (hpBar) hpBar.style.width = Math.max(0, (hp / MAX_HP) * 100) + "%";
  if (spBar && sp !== undefined) spBar.style.width = Math.max(0, (sp / MAX_SP) * 100) + "%";
}


// =======================
// ATTACK
// =======================
function attack() {

  fetch("/api/combat/attack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ battleId })
  })
  .then(r => r.json())
  .then(data => {

    // Player dead
    if (data.playerDead) {
      log("☠ YOU HAVE BEEN SLAIN");
      return setTimeout(() => location.href = "/death", 1800);
    }

    // Enemy dead
    if (data.dead) {

      log("🏆 Enemy defeated!");
      log("⭐ Gained " + data.exp + " EXP");
      if (data.gold) log("💰 Gained " + data.gold + " gold");

      if (data.leveled) {
        log("✨ YOU LEVELED UP!");
        log("+5 stat points gained");
        log("❤️ HP and 🔮 SP restored");
      }

      return setTimeout(() => location.reload(), 1800);
    }

    // Normal hit
    document.getElementById("pText").innerText = data.playerHP;
    document.getElementById("eText").innerText = data.enemyHP;

    updateHUD(data.playerHP);

    log("⚔ You dealt " + data.pHit + " damage");
    log("🩸 Enemy hit you for " + data.eHit);

  })
  .catch(err => console.error("Combat error:", err));
}


// =======================
// FLEE
// =======================
function flee() {
  fetch("/api/combat/flee", { method: "POST" })
    .then(() => location.href = "/");
}


// =======================
// SPELLS
// =======================
function spells() {

  fetch("/api/combat/spells")
    .then(r => r.json())
    .then(list => {

      if (!list.length) {
        return log("📖 You know no spells.");
      }

      let html = "<b>🔮 Spells:</b><br>";
      list.forEach(s => {
        html += `<button class="combat-btn" onclick="cast(${s.id})">
                  ${s.name} (${s.cost} SP)
                </button><br>`;
      });

      document.getElementById("log").innerHTML = html;
    });
}


function cast(id) {

  fetch("/api/combat/cast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spellId: id })
  })
  .then(r => r.json())
  .then(data => {

    if (data.error) return log("❌ " + data.error);

    // Player dead
    if (data.playerDead) {
      log("☠ YOU HAVE BEEN KILLED BY COUNTER-ATTACK");
      return setTimeout(() => location.href = "/death", 1600);
    }

    log("🔮 Spell dealt " + data.dmg + " damage");

    if (data.retaliation) {
      log("🩸 Enemy retaliates for " + data.retaliation);
    }

    if (data.dead) {
      log("🏆 Enemy incinerated!");
      //return setTimeout(() => location.reload(), 1800);
    }

    updateHUD(data.playerHP, data.playerSP);

  });
}


// =======================
// ITEMS
// =======================
function items() {

  fetch("/api/combat/items")
    .then(r => r.json())
    .then(list => {

      if (!list.length) return log("🎒 No usable items");

      let html = "<b>🎒 Inventory:</b><br>";
      list.forEach(i => {
        html += `<button class="combat-btn" onclick="useItem(${i.randid})">
                  ${i.name}
                </button><br>`;
      });

      document.getElementById("log").innerHTML = html;
    });
}


function useItem(id) {

  fetch("/api/combat/use", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ randid: id })
  })
  .then(r => r.json())
  .then(d => {

    log("🧪 Healed " + d.value + " HP");
    updateHUD(d.hp);

  });
}
