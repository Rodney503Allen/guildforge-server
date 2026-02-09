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

function loadStatPanel() {
  fetch("/me")
    .then(res => res.json())
    .then(p => {
      if (!p) return;
      // ✅ STAT POINTS GLOW (portrait)
      const frame = document.querySelector(".portrait-frame");
      if (frame) {
        const hasPoints = Number(p.stat_points) > 0;
        frame.classList.toggle("portrait-glow", hasPoints);
        console.log("🟡 portrait glow:", hasPoints, "stat_points:", p.stat_points);
      } else {
        console.warn("portrait-frame not found (HUD not injected yet?)");
      }

      // =======================
      // BASIC INFO
      // =======================
      setText("player-name", p.name);
      setText("player-class", p.pclass);
      setText("player-level", p.level);

      // =======================
      // PORTRAIT & GUILD
      // =======================
      const portrait = document.getElementById("player-portrait");
      if (portrait) {
        portrait.src = p.portrait_url || "/images/portraits/default.png";
      }

      const banner = document.getElementById("guild-banner-img");
      if (banner) {
        banner.src = p.guild_banner || "/images/guilds/default-banner.png";
      }

      setText(
        "player-guild",
        p.guild_name
          ? `${p.guild_name} (${p.guild_rank || "Member"})`
          : "No Guild"
      );

      // =======================
      // FINAL STATS (FROM ENGINE)
      // =======================
      const hp = Number(p.hpoints);
      const maxhp = Number(p.maxhp);
      const sp = Number(p.spoints);
      const maxsp = Number(p.maxspoints);
      


      renderBuffs(p.buffs || []);




      // =======================
      // BARS
      // =======================
      const hpPct = maxhp > 0 ? (hp / maxhp) * 100 : 0;
      const spPct = maxsp > 0 ? (sp / maxsp) * 100 : 0;

      const hpBar = document.getElementById("hp-bar");
      const spBar = document.getElementById("sp-bar");

      if (hpBar) hpBar.style.width = `${hpPct}%`;
      if (spBar) spBar.style.width = `${spPct}%`;

      setText("hp-text", `${hp} / ${maxhp}`);
      setText("sp-text", `${sp} / ${maxsp}`);

      // =======================
      // XP BAR (UNCHANGED)
      // =======================
      const xpNeed = p.level * 50 + p.level * p.level * 50;
      const xpPct = Math.min(100, (p.exper / xpNeed) * 100);

      const xpBar = document.getElementById("xp-bar");
      if (xpBar) xpBar.style.width = `${xpPct}%`;

      setText("xp-text", `${p.exper} / ${xpNeed}`);

      // =======================
      // OPTIONAL: DEBUG / FUTURE
      // =======================
      // p.spellPower
      // p.dodgeChance
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
function renderBuffs(buffs) {
  const tooltip = document.getElementById("buff-tooltip");
  if (!tooltip) return;

  tooltip.innerHTML = "";

  if (!buffs.length) {
    tooltip.innerHTML = `<div class="buff-row">No active buffs</div>`;
    return;
  }

  buffs.forEach(buff => {
    const row = document.createElement("div");
    row.className = "buff-row";

    row.innerHTML = `
      <div class="buff-stat">${buff.stat.toUpperCase()}</div>
      <div class="buff-value">+${buff.value}</div>
      <div class="buff-timer" data-exp="${buff.expires_at}"></div>
    `;

    tooltip.appendChild(row);
  });

  updateBuffTimers();
}


function updateBuffTimers() {
  const timers = document.querySelectorAll(".buff-timer");

  timers.forEach(t => {
    const exp = new Date(t.dataset.exp).getTime();
    const now = Date.now();
    const diff = Math.max(0, Math.floor((exp - now) / 1000));

    if (diff <= 0) {
      t.textContent = "Expired";
    } else if (diff < 60) {
      t.textContent = `${diff}s`;
    } else {
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      t.textContent = `${m}:${s.toString().padStart(2, "0")}`;
    }
  });
}
setInterval(updateBuffTimers, 1000);
// =======================
// AUTO LOAD
// =======================
window.addEventListener("DOMContentLoaded", loadHUD);
