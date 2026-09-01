// =======================
// SHARED SCRIPT LOADER
// =======================

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

// =======================
// SHARED STYLESHEET LOADER
// =======================

function loadGuildforgeStylesheetOnce(href, id) {
  if (document.getElementById(id)) return;

  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

loadGuildforgeStylesheetOnce(
  "/audioSettings.css",
  "guildforge-audio-settings-css"
);

// =======================
// GLOBAL AUDIO BOOTSTRAP
// =======================

async function ensureGuildforgeAudio() {
  if (
    window.GFAudio &&
    typeof window.GFAudio.playMusic === "function"
  ) {
    return window.GFAudio;
  }

  await loadGuildforgeScriptOnce(
    "/audioManager.js",
    "guildforge-global-audio"
  );

  if (
    !window.GFAudio ||
    typeof window.GFAudio.playMusic !== "function"
  ) {
    throw new Error(
      "Guildforge global audio manager did not initialize."
    );
  }

  return window.GFAudio;
}

window.GFAudioReady = ensureGuildforgeAudio()
  .catch(err => {
    console.error(
      "Guildforge audio bootstrap failed:",
      err
    );
    return null;
  });

// =======================
// GLOBAL SPELL CAST EVENTS
// =======================

window.GFSpellEventsReady = loadGuildforgeScriptOnce(
  "/spellCastEvents.js",
  "guildforge-spell-cast-events"
).catch(err => {
  console.error(
    "Guildforge spell cast event bootstrap failed:",
    err
  );

  return null;
});

// =======================
// GLOBAL SOCKET BOOTSTRAP
// =======================

async function ensureGuildforgeSocket() {
  if (
    window.GFSocket &&
    typeof window.GFSocket.on === "function"
  ) {
    return window.GFSocket;
  }

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
let lastAudioLocation = null;

// =======================
// REGION MUSIC SYNC
// =======================

async function syncPlayerLocationAudio(location) {
  const normalizedLocation =
    String(location || "").trim();

  if (!normalizedLocation) return;

  if (normalizedLocation === lastAudioLocation) {
    return;
  }

  let audio = window.GFAudio;

  if (
    !audio ||
    typeof audio.playRegionMusic !== "function"
  ) {
    audio = await window.GFAudioReady;
  }

  if (
    !audio ||
    typeof audio.playRegionMusic !== "function"
  ) {
    return;
  }

  lastAudioLocation = normalizedLocation;

  await audio.playRegionMusic(
    normalizedLocation
  );
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (!el) return;

  el.innerText =
    (val !== undefined && val !== null)
      ? val
      : "";
}

// =======================
// SHARED BUFF STATE
// =======================
//
// The stat panel already receives authoritative
// player buff state. Expose that same state to
// combat interfaces so they do not need their
// own buff polling/database path.

function publishGuildforgeBuffState(buffs) {
  const activeBuffs =
    Array.isArray(buffs)
      ? buffs
      : [];

  window.__GF_ACTIVE_BUFFS__ =
    activeBuffs;

  window.dispatchEvent(
    new CustomEvent(
      "guildforge:buffs-updated",
      {
        detail: {
          buffs: activeBuffs
        }
      }
    )
  );
}

function renderStatPanelPlayer(p) {
  if (!p) return;

  statPanelPlayer = {
    ...(statPanelPlayer || {}),
    ...p
  };

  const player = statPanelPlayer;

  syncPlayerLocationAudio(player.location)
    .catch(err => {
      console.warn(
        "Unable to sync player region music:",
        err
      );

      if (
        String(player.location || "").trim() ===
        lastAudioLocation
      ) {
        lastAudioLocation = null;
      }
    });

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
  setText(
    "player-gold",
    Number(player.gold || 0).toLocaleString()
  );

  const portrait =
    document.getElementById("player-portrait");

  if (portrait) {
    portrait.src =
      player.portrait_url ||
      "/images/portraits/default.png";
  }

  const banner =
    document.getElementById("guild-banner-img");

  if (banner) {
    banner.src =
      player.guild_banner ||
      "/images/guilds/default-banner.png";
  }

  setText(
    "player-guild",
    player.guild_name || "No Guild"
  );

  const hp = Number(player.hpoints || 0);
  const maxhp = Number(player.maxhp || 0);
  const sp = Number(player.spoints || 0);
  const maxsp = Number(player.maxspoints || 0);

  if (Array.isArray(player.buffs)) {
    renderBuffs(player.buffs);
  }

  const hpPct =
    maxhp > 0
      ? Math.max(
          0,
          Math.min(100, (hp / maxhp) * 100)
        )
      : 0;

  const spPct =
    maxsp > 0
      ? Math.max(
          0,
          Math.min(100, (sp / maxsp) * 100)
        )
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
      ? Math.max(
          0,
          Math.min(
            100,
            (exper / xpNeed) * 100
          )
        )
      : 0;

  const xpBar =
    document.getElementById("xp-bar");

  if (xpBar) {
    xpBar.style.width = `${xpPct}%`;
  }

  setText(
    "xp-text",
    `${exper} / ${xpNeed}`
  );
}

function loadStatPanel() {
  return fetch("/me", {
    credentials: "include",
    cache: "no-store"
  })
    .then(res => {
      if (!res.ok) {
        throw new Error(
          `Failed to load player data: ${res.status}`
        );
      }

      return res.json();
    })
    .then(p => {
      if (!p) return;

      statPanelPlayer = p;
      renderStatPanelPlayer(p);
    })
    .catch(err => {
      console.error(
        "Statpanel load failed:",
        err
      );

      throw err;
    });
}

function applyStatPanelPatch(patch) {
  if (!patch || typeof patch !== "object") {
    return;
  }

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

  socket.on(
    "player:state",
    patch => {
      applyStatPanelPatch(patch);
    }
  );

  window.addEventListener(
    "guildforge:socket-connected",
    () => {
      if (
        !document.getElementById(
          "statpanel"
        )
      ) {
        return;
      }

      loadStatPanel()
        .catch(err => {
          console.warn(
            "Unable to reconcile stat panel after socket reconnect:",
            err
          );
        });
    }
  );
}

// =======================
// AUDIO SETTINGS MODAL
// =======================

function setAudioSliderVisual(input, valueEl) {
  if (!input || !valueEl) return;

  const value = Math.max(
    0,
    Math.min(100, Number(input.value) || 0)
  );

  valueEl.textContent = `${Math.round(value)}%`;

  input.style.setProperty(
    "--gf-audio-level",
    `${value}%`
  );
}

async function initializeAudioSettingsModal() {
  const openBtn =
    document.getElementById("audio-settings-btn");

  const modal =
    document.getElementById("audio-settings-modal");

  const closeBtn =
    document.getElementById("audio-settings-close");

  const backdrop =
    modal?.querySelector(".gf-audio-modal-backdrop");

  const musicSlider =
    document.getElementById("gf-music-volume");

  const sfxSlider =
    document.getElementById("gf-sfx-volume");

  const environmentSlider =
    document.getElementById("gf-environment-volume");

  const musicValue =
    document.getElementById("gf-music-volume-value");

  const sfxValue =
    document.getElementById("gf-sfx-volume-value");

  const environmentValue =
    document.getElementById(
      "gf-environment-volume-value"
    );

  if (
    !openBtn ||
    !modal ||
    !closeBtn ||
    !musicSlider ||
    !sfxSlider ||
    !environmentSlider
  ) {
    return;
  }

  if (openBtn.dataset.audioBound === "true") {
    return;
  }

  openBtn.dataset.audioBound = "true";

  let audio = window.GFAudio;

  if (
    !audio ||
    typeof audio.getState !== "function"
  ) {
    audio = await window.GFAudioReady;
  }

  if (!audio) return;

  function syncControlsFromAudio() {
    const state =
      typeof audio.getState === "function"
        ? audio.getState()
        : null;

    const settings =
      state?.settings || {};

    musicSlider.value =
      String(
        Math.round(
          Number(settings.musicVolume ?? 1) * 100
        )
      );

    sfxSlider.value =
      String(
        Math.round(
          Number(settings.sfxVolume ?? 1) * 100
        )
      );

    environmentSlider.value =
      String(
        Math.round(
          Number(settings.ambienceVolume ?? 1) * 100
        )
      );

    setAudioSliderVisual(
      musicSlider,
      musicValue
    );

    setAudioSliderVisual(
      sfxSlider,
      sfxValue
    );

    setAudioSliderVisual(
      environmentSlider,
      environmentValue
    );
  }

  function openModal() {
    syncControlsFromAudio();

    modal.classList.add("is-open");
    modal.setAttribute(
      "aria-hidden",
      "false"
    );

    requestAnimationFrame(
      () => closeBtn.focus()
    );
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute(
      "aria-hidden",
      "true"
    );

    openBtn.focus();
  }

  function bindSlider(
    slider,
    valueEl,
    setterName
  ) {
    slider.addEventListener(
      "input",
      () => {
        setAudioSliderVisual(
          slider,
          valueEl
        );

        const setter =
          audio?.[setterName];

        if (
          typeof setter === "function"
        ) {
          setter.call(
            audio,
            Number(slider.value) / 100
          );
        }
      }
    );
  }

  bindSlider(
    musicSlider,
    musicValue,
    "setMusicVolume"
  );

  bindSlider(
    sfxSlider,
    sfxValue,
    "setSfxVolume"
  );

  bindSlider(
    environmentSlider,
    environmentValue,
    "setAmbienceVolume"
  );

  openBtn.addEventListener(
    "click",
    openModal
  );

  closeBtn.addEventListener(
    "click",
    closeModal
  );

  backdrop?.addEventListener(
    "click",
    closeModal
  );

  modal.addEventListener(
    "click",
    event => {
      const target =
        event.target;

      if (
        target instanceof HTMLElement &&
        target.dataset.audioClose === "true"
      ) {
        closeModal();
      }
    }
  );

  document.addEventListener(
    "keydown",
    event => {
      if (
        event.key === "Escape" &&
        modal.classList.contains("is-open")
      ) {
        closeModal();
      }
    }
  );

  window.addEventListener(
    "guildforge:audio-settings-changed",
    syncControlsFromAudio
  );

  syncControlsFromAudio();
}

function loadHUD() {
  const root =
    document.getElementById(
      "statpanel-root"
    );

  if (!root) {
    console.error(
      "statpanel-root not found"
    );

    return;
  }

  fetch(
    "/statpanel.html",
    {
      cache: "no-store"
    }
  )
    .then(res => {
      if (!res.ok) {
        throw new Error(
          "statpanel.html not found"
        );
      }

      return res.text();
    })
    .then(html => {
      root.innerHTML = html;

      initializeAudioSettingsModal()
        .catch(err => {
          console.error(
            "Unable to initialize audio settings:",
            err
          );
        });

      connectStatPanelSocket()
        .catch(err => {
          console.error(
            "Unable to connect stat panel socket:",
            err
          );
        });

      requestAnimationFrame(
        () => {
          loadStatPanel()
            .catch(() => {});
        }
      );
    })
    .catch(err => {
      console.error(
        "HUD inject failed:",
        err
      );
    });
}

function renderBuffs(buffs) {
  const activeBuffs =
    Array.isArray(buffs)
      ? buffs
      : [];

  publishGuildforgeBuffState(
    activeBuffs
  );

  const tooltip =
    document.getElementById(
      "buff-tooltip"
    );

  if (!tooltip) return;

  tooltip.innerHTML = "";

  if (!activeBuffs.length) {
    tooltip.innerHTML =
      `<div class="buff-row">No active buffs</div>`;

    return;
  }

  activeBuffs.forEach(buff => {
    const row =
      document.createElement("div");

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
  const timers =
    document.querySelectorAll(
      ".buff-timer"
    );

  let buffStateChanged =
    false;

  timers.forEach(t => {
    const exp =
      new Date(
        t.dataset.exp
      ).getTime();

    const now =
      Date.now();

    const diff =
      Math.max(
        0,
        Math.floor(
          (exp - now) / 1000
        )
      );

    if (diff <= 0) {
      const row =
        t.closest(
          ".buff-row"
        );

      if (row) {
        row.remove();
      }

      if (
        statPanelPlayer &&
        Array.isArray(
          statPanelPlayer.buffs
        )
      ) {
        const nowMs =
          Date.now();

        const previousLength =
          statPanelPlayer.buffs.length;

        statPanelPlayer.buffs =
          statPanelPlayer.buffs
            .filter(buff => {
              const expiresAt =
                new Date(
                  buff.expires_at
                ).getTime();

              return (
                Number.isFinite(
                  expiresAt
                ) &&
                expiresAt > nowMs
              );
            });

        if (
          statPanelPlayer.buffs.length !==
          previousLength
        ) {
          buffStateChanged =
            true;
        }
      }

      const tooltip =
        document.getElementById(
          "buff-tooltip"
        );

      if (
        tooltip &&
        !tooltip.querySelector(
          ".buff-row"
        )
      ) {
        tooltip.innerHTML =
          `<div class="buff-row">No active buffs</div>`;
      }
    } else if (diff < 60) {
      t.textContent =
        `${diff}s`;
    } else {
      const m =
        Math.floor(
          diff / 60
        );

      const s =
        diff % 60;

      t.textContent =
        `${m}:${s
          .toString()
          .padStart(
            2,
            "0"
          )}`;
    }
  });

  if (
    buffStateChanged &&
    statPanelPlayer &&
    Array.isArray(
      statPanelPlayer.buffs
    )
  ) {
    publishGuildforgeBuffState(
      statPanelPlayer.buffs
    );
  }
}

setInterval(
  updateBuffTimers,
  1000
);

window.addEventListener(
  "guildforge:player-updated",
  () => {
    loadStatPanel()
      .catch(err => {
        console.error(
          "Failed to refresh stat panel:",
          err
        );
      });
  }
);

window.loadStatPanel =
  loadStatPanel;

window.applyStatPanelPatch =
  applyStatPanelPatch;

window.addEventListener(
  "DOMContentLoaded",
  loadHUD
);
