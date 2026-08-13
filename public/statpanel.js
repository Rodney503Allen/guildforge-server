// =======================
// GLOBAL SOCKET BOOTSTRAP
// =======================
//
// statpanel.js is already loaded on authenticated
// Guildforge pages, so it can bootstrap the shared
// Socket.IO client for the rest of the frontend.
//
// You do NOT need to manually add these to every page:
//   /socket.io/socket.io.js
//   /guildforgeSocket.js
//
// Feature scripts should use window.GFSocket when ready.

function loadGuildforgeScriptOnce(src, id) {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id);

    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }

      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = false;

    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );

    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load ${src}`)),
      { once: true }
    );

    document.head.appendChild(script);
  });
}

async function ensureGuildforgeSocket() {
  // Another feature may already have created the shared socket.
  if (
    window.GFSocket &&
    typeof window.GFSocket.on === "function"
  ) {
    return window.GFSocket;
  }

  // Socket.IO exposes window.io.
  if (typeof window.io !== "function") {
    await loadGuildforgeScriptOnce(
      "/socket.io/socket.io.js",
      "guildforge-socketio-client"
    );
  }

  if (
    window.GFSocket &&
    typeof window.GFSocket.on === "function"
  ) {
    return window.GFSocket;
  }

  await loadGuildforgeScriptOnce(
    "/guildforgeSocket.js",
    "guildforge-global-socket"
  );

  if (
    !window.GFSocket ||
    typeof window.GFSocket.on !== "function"
  ) {
    throw new Error(
      "Guildforge global socket did not initialize."
    );
  }

  return window.GFSocket;
}

window.GFSocketReady = ensureGuildforgeSocket()
  .catch(err => {
    console.error(
      "Guildforge socket bootstrap failed:",
      err
    );

    return null;
  });

// =======================
// GLOBAL BANNER LOADER
// =======================
if (!window.GFBanners && !window.__gfBannerScriptLoading) {
  window.__gfBannerScriptLoading = true;

  const script = document.createElement("script");
  script.src = "/bannerNotifications.js";
  script.onload = () => {
    window.__gfBannerScriptLoading = false;
  };
  document.head.appendChild(script);
}

let statPanelPlayer = null;

function setText(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerText = (val !== undefined && val !== null) ? val : "";
}

function renderStatPanelPlayer(p) {
  if (!p) return;

  statPanelPlayer = {
    ...(statPanelPlayer || {}),
    ...p
  };

  const player = statPanelPlayer;

  const portraitFrame = document.querySelector(
    "#statpanel .portrait-frame"
  );

  const rawStatPoints =
    player.stat_points ??
    player.statPoints ??
    player.statpoints ??
    player.available_stat_points ??
    player.availableStatPoints ??
    0;

  const statPoints = Number(rawStatPoints);

  if (portraitFrame) {
    portraitFrame.classList.toggle(
      "portrait-glow",
      Number.isFinite(statPoints) && statPoints > 0
    );
  }

  setText("player-name", player.name);
  setText("player-class", player.pclass);
  setText("player-level", player.level);
  setText("player-gold", Number(player.gold || 0).toLocaleString());

  const portrait = document.getElementById("player-portrait");
  if (portrait) {
    portrait.src =
      player.portrait_url ||
      "/images/portraits/default.png";
  }

  const banner = document.getElementById("guild-banner-img");
  if (banner) {
    banner.src =
      player.guild_banner ||
      "/images/guilds/default-banner.png";
  }

  setText("player-guild", player.guild_name || "No Guild");

  const hp = Number(player.hpoints || 0);
  const maxhp = Number(player.maxhp || 0);
  const sp = Number(player.spoints || 0);
  const maxsp = Number(player.maxspoints || 0);

  if (Array.isArray(player.buffs)) {
    renderBuffs(player.buffs);
  }

  const hpPct =
    maxhp > 0
      ? Math.max(0, Math.min(100, (hp / maxhp) * 100))
      : 0;

  const spPct =
    maxsp > 0
      ? Math.max(0, Math.min(100, (sp / maxsp) * 100))
      : 0;

  const hpBar = document.getElementById("hp-bar");
  const spBar = document.getElementById("sp-bar");

  if (hpBar) hpBar.style.width = `${hpPct}%`;
  if (spBar) spBar.style.width = `${spPct}%`;

  setText("hp-text", `${hp} / ${maxhp}`);
  setText("sp-text", `${sp} / ${maxsp}`);

  const exper = Number(player.exper || 0);
  const xpNeed = Number(player.xpNeeded || 0);

  const xpPct =
    xpNeed > 0
      ? Math.max(0, Math.min(100, (exper / xpNeed) * 100))
      : 0;

  const xpBar = document.getElementById("xp-bar");
  if (xpBar) xpBar.style.width = `${xpPct}%`;

  setText("xp-text", `${exper} / ${xpNeed}`);
}

function loadStatPanel() {
  return fetch("/me", {
    credentials: "include",
    cache: "no-store"
  })
    .then(res => {
      if (!res.ok) {
        throw new Error(`Failed to load player data: ${res.status}`);
      }
      return res.json();
    })
    .then(p => {
      if (!p) return;
      statPanelPlayer = p;
      renderStatPanelPlayer(p);
    })
    .catch(err => {
      console.error("Statpanel load failed:", err);
      throw err;
    });
}

function applyStatPanelPatch(patch) {
  if (!patch || typeof patch !== "object") return;

  const needsDerivedRefresh =
    Boolean(
      patch.refreshDerivedStats
    );

  const safePatch = {
    ...patch
  };

  delete safePatch.refreshDerivedStats;

  renderStatPanelPlayer(
    safePatch
  );

  if (needsDerivedRefresh) {
    loadStatPanel()
      .catch(err => {
        console.warn(
          "Unable to refresh derived player stats:",
          err
        );
      });
  }
}

async function connectStatPanelSocket() {
  let socket = window.GFSocket;

  if (
    !socket ||
    typeof socket.on !== "function"
  ) {
    socket = await window.GFSocketReady;
  }

  if (
    !socket ||
    typeof socket.on !== "function"
  ) {
    return;
  }

  if (window.__GFStatPanelSocketBound) {
    return;
  }

  window.__GFStatPanelSocketBound = true;

  socket.on("player:state", patch => {
    applyStatPanelPatch(patch);
  });

  window.addEventListener(
    "guildforge:socket-connected",
    () => {
      if (!document.getElementById("statpanel")) return;

      loadStatPanel().catch(err => {
        console.warn(
          "Unable to reconcile stat panel after socket reconnect:",
          err
        );
      });
    }
  );
}

function loadHUD() {
  const root = document.getElementById("statpanel-root");

  if (!root) {
    console.error("statpanel-root not found");
    return;
  }

  fetch("/statpanel.html", { cache: "no-store" })
    .then(res => {
      if (!res.ok) throw new Error("statpanel.html not found");
      return res.text();
    })
    .then(html => {
      root.innerHTML = html;
      connectStatPanelSocket().catch(err => {
        console.error(
          "Unable to connect stat panel socket:",
          err
        );
      });
      requestAnimationFrame(() => {
        loadStatPanel().catch(() => {});
      });
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
      <div class="buff-stat">${String(buff.stat || "").toUpperCase()}</div>
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
      const row = t.closest(".buff-row");
      if (row) row.remove();

      if (statPanelPlayer && Array.isArray(statPanelPlayer.buffs)) {
        const nowMs = Date.now();
        statPanelPlayer.buffs = statPanelPlayer.buffs.filter(buff => {
          const expiresAt = new Date(buff.expires_at).getTime();
          return Number.isFinite(expiresAt) && expiresAt > nowMs;
        });
      }

      const tooltip = document.getElementById("buff-tooltip");
      if (tooltip && !tooltip.querySelector(".buff-row")) {
        tooltip.innerHTML = `<div class="buff-row">No active buffs</div>`;
      }
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

window.addEventListener("guildforge:player-updated", () => {
  loadStatPanel().catch(err => {
    console.error("Failed to refresh stat panel:", err);
  });
});

window.loadStatPanel = loadStatPanel;
window.applyStatPanelPatch = applyStatPanelPatch;

window.addEventListener("DOMContentLoaded", loadHUD);