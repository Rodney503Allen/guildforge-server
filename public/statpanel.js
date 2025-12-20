// =======================
// SAFE SETTER
// =======================
function setText(id, val) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn("Missing HUD element:", id);
    return;
  }
  el.innerText = (val !== undefined && val !== null) ? val : "";
}

// =======================
// LOAD PLAYER DATA
// =======================
function loadStatPanel() {

  fetch("/me")
    .then(res => res.json())
    .then(p => {
      console.log("HUD RECEIVED:", p);

      if (!p) {
        console.error("No player data returned");
        return;
      }

      // =======================
      // BASIC INFO
      // =======================
      setText("player-name", p.name);
      setText("player-class", p.pclass);
      setText("player-location", p.location);
      setText("player-level", p.level);

      // =======================
      // SAFE NUMBERS
      // =======================
      const hp = Number(p.hpoints || 0);
      const maxhp = Number(p.maxhp || 1);
      const sp = Number(p.spoints || 0);
      const maxsp = Number(p.maxspoints || 1);
      const exp = Number(p.exper || 0);
      const level = Number(p.level || 1);

      // =======================
      // BARS
      // =======================
      const hpPct = Math.max(0, Math.min(100, (hp / maxhp) * 100));
      const spPct = Math.max(0, Math.min(100, (sp / maxsp) * 100));
      const xpNeed = (level * 50) + (level * level * 50);
      const xpPct = Math.max(0, Math.min(100, (exp / xpNeed) * 100));

      const hpBar = document.getElementById("hp-bar");
      const spBar = document.getElementById("sp-bar");
      const xpBar = document.getElementById("xp-bar");

      if (hpBar) hpBar.style.width = hpPct + "%";
      if (spBar) spBar.style.width = spPct + "%";
      if (xpBar) xpBar.style.width = xpPct + "%";

      setText("hp-text", `${hp} / ${maxhp}`);
      setText("sp-text", `${sp} / ${maxsp}`);
      setText("xp-text", `${exp} / ${xpNeed}`);

      // =======================
      // STATS
      // =======================
      setText("player-atk", p.attack);
      setText("player-def", p.defense);
      setText("player-agility", p.agility);
      setText("player-vitality", p.vitality);
      setText("player-intellect", p.intellect);
      setText("player-crit", p.crit);
      setText("player-gold", p.gold);

      // =======================
      // GUILD
      // =======================
      if (p.guild_name) {
        setText("player-guild", `${p.guild_name} (${p.guild_rank || "Member"})`);
      } else {
        setText("player-guild", "No Guild");
      }

      // =======================
      // LEVEL UP BUTTON
      // =======================
      const levelBox = document.getElementById("levelup-box");
      if (levelBox) {
        levelBox.style.display = (p.stat_points > 0) ? "flex" : "none";
      }

    })
    .catch(err => console.error("Statpanel load failed:", err));
}

// =======================
// INSERT HUD INTO PAGE
// =======================
function loadHUD() {

  const root = document.getElementById("statpanel-root");
  if (!root) {
    console.error("statpanel-root not found");
    return;
  }

  fetch("/statpanel.html")
    .then(res => {
      if (!res.ok) throw new Error("statpanel.html not found");
      return res.text();
    })
    .then(html => {
      root.innerHTML = html;
      requestAnimationFrame(loadStatPanel);
    })
    .catch(err => console.error("HUD inject failed:", err));
}

// =======================
// AUTO LOAD
// =======================
window.addEventListener("DOMContentLoaded", loadHUD);
