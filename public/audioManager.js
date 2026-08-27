// public/audioManager.js
(() => {
  "use strict";

  if (window.GFAudio) return;

  const STORAGE_KEY = "guildforge:audio-settings";
  const PLAYBACK_KEY = "guildforge:audio-playback";
  const DEFAULT_CROSSFADE_MS = 1800;

  const TRACKS = {
    music: {
      valewynn: "/music/valewynn.ogg",
      tavern: "/music/tavern.ogg",
      // combat: "/music/combat.ogg",
    },
    ambience: {
      // Region ambience is registered automatically by playRegionMusic().
      // tavern: "/ambience/tavern.ogg",
    },
    sfx: {
      // ui_click: "/audio/sfx/ui/click.wav",
      // coin: "/audio/sfx/items/coin.wav",
    }
  };

  const settings = {
    masterVolume: 1,
    musicVolume: 0.55,
    ambienceVolume: 0.45,
    sfxVolume: 0.7,
    muted: false,
    ...loadJson(STORAGE_KEY, {})
  };

  function clamp01(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  settings.masterVolume = clamp01(settings.masterVolume);
  settings.musicVolume = clamp01(settings.musicVolume);
  settings.ambienceVolume = clamp01(settings.ambienceVolume);
  settings.sfxVolume = clamp01(settings.sfxVolume);
  settings.muted = Boolean(settings.muted);

  function makeChannel() {
    const audio = new Audio();
    audio.preload = "auto";
    audio.loop = true;

    return {
      audio,
      key: null,
      requestedVolume: 1,
      fadeToken: 0
    };
  }

  const musicChannels = [makeChannel(), makeChannel()];
  const ambienceChannels = [makeChannel(), makeChannel()];

  let activeMusicIndex = 0;
  let activeAmbienceIndex = 0;

  const pending = {
    music: null,
    ambience: null
  };

  /*
   * Crossfade requests can arrive very close together
   * (for example, page/bootstrap audio plus a live world update).
   *
   * Each group gets a monotonically increasing request id so an
   * older async play() completion cannot overwrite a newer request.
   */
  const crossfadeRequestId = {
    music: 0,
    ambience: 0
  };

  const sfxPools = new Map();
  let unlocked = false;
  let unlocking = false;
  let currentRegionMusicKey = null;
  let currentTerrainAmbienceKey = null;
  let worldRegionHookInstalled = false;

  function categoryVolume(kind) {
    if (kind === "music") return settings.musicVolume;
    if (kind === "ambience") return settings.ambienceVolume;
    return settings.sfxVolume;
  }

  function targetVolume(kind, requested = 1) {
    if (settings.muted) return 0;

    return clamp01(
      settings.masterVolume *
      categoryVolume(kind) *
      clamp01(requested)
    );
  }

  function getPath(kind, key) {
    const path = TRACKS[kind]?.[key];

    if (!path) {
      console.warn(
        `[GFAudio] Unknown ${kind} track "${key}". Add it to TRACKS.${kind} in audioManager.js.`
      );
      return null;
    }

    return path;
  }

  function fade(channel, from, to, durationMs, done) {
    const token = ++channel.fadeToken;
    const duration = Math.max(0, Number(durationMs) || 0);

    if (duration === 0) {
      channel.audio.volume = clamp01(to);
      if (done) done();
      return;
    }

    const start = performance.now();

    function frame(now) {
      if (channel.fadeToken !== token) return;

      const t = Math.min(1, (now - start) / duration);
      const eased =
        t < 0.5
          ? 2 * t * t
          : 1 - Math.pow(-2 * t + 2, 2) / 2;

      channel.audio.volume = clamp01(
        from + (to - from) * eased
      );

      if (t < 1) {
        requestAnimationFrame(frame);
      } else if (done) {
        done();
      }
    }

    requestAnimationFrame(frame);
  }

  async function tryPlay(audio) {
    try {
      await audio.play();
      unlocked = true;
      return true;
    } catch (err) {
      /*
       * AbortError is expected when a newer crossfade request
       * intentionally pauses/reuses this channel before play()
       * finishes resolving.
       */
      if (
        err?.name !== "NotAllowedError" &&
        err?.name !== "AbortError"
      ) {
        console.warn(
          "[GFAudio] Playback failed:",
          err
        );
      }

      return false;
    }
  }

  async function crossfade(kind, key, options = {}) {
    const path = getPath(kind, key);
    if (!path) return false;

    const requestId =
      ++crossfadeRequestId[kind];

    const channels =
      kind === "music" ? musicChannels : ambienceChannels;

    let activeIndex =
      kind === "music" ? activeMusicIndex : activeAmbienceIndex;

    const active = channels[activeIndex];
    const requestedVolume = clamp01(options.volume ?? 1);
    const crossfadeMs = Math.max(
      0,
      Number(options.crossfadeMs ?? DEFAULT_CROSSFADE_MS) || 0
    );

    if (
      active.key === key &&
      active.audio.src &&
      !active.audio.paused
    ) {
      active.requestedVolume = requestedVolume;
      fade(
        active,
        active.audio.volume,
        targetVolume(kind, requestedVolume),
        Math.min(crossfadeMs, 400)
      );
      return true;
    }

    if (!unlocked) {
      const restored = pending[kind];

      pending[kind] = {
        key,
        options: {
          ...(restored?.key === key
            ? restored.options
            : {}),
          ...options
        }
      };
      return false;
    }

    const nextIndex = activeIndex === 0 ? 1 : 0;
    const next = channels[nextIndex];

    next.fadeToken++;
    next.audio.pause();
    next.audio.src = path;
    next.audio.loop = options.loop !== false;
    next.audio.volume = 0;
    next.key = key;
    next.requestedVolume = requestedVolume;

    const startAt = Math.max(0, Number(options.startAt) || 0);

    if (startAt > 0) {
      const setTime = () => {
        try {
          if (Number.isFinite(next.audio.duration) && next.audio.duration > 0) {
            next.audio.currentTime = startAt % next.audio.duration;
          } else {
            next.audio.currentTime = startAt;
          }
        } catch {}
      };

      if (next.audio.readyState >= 1) setTime();
      else next.audio.addEventListener("loadedmetadata", setTime, { once: true });
    }

    const started = await tryPlay(next.audio);

    /*
     * A newer request arrived while play() was resolving.
     * Do not let this stale request change pending state,
     * start fades, or become the active channel.
     */
    if (
      crossfadeRequestId[kind] !==
      requestId
    ) {
      return false;
    }

    if (!started) {
      pending[kind] = {
        key,
        options: { ...options }
      };

      return false;
    }

    fade(
      next,
      0,
      targetVolume(kind, requestedVolume),
      crossfadeMs
    );

    if (active.key && !active.audio.paused) {
      const oldVolume = active.audio.volume;

      fade(active, oldVolume, 0, crossfadeMs, () => {
        active.audio.pause();
        active.audio.removeAttribute("src");
        active.audio.load();
        active.key = null;
      });
    }

    if (kind === "music") activeMusicIndex = nextIndex;
    else activeAmbienceIndex = nextIndex;

    pending[kind] = null;
    persistPlaybackState();

    window.dispatchEvent(
      new CustomEvent(`guildforge:${kind}-changed`, {
        detail: { key }
      })
    );

    return true;
  }

  function stopGroup(kind, fadeMs = 600) {
    const channels =
      kind === "music" ? musicChannels : ambienceChannels;

    for (const channel of channels) {
      if (!channel.key) continue;

      fade(channel, channel.audio.volume, 0, fadeMs, () => {
        channel.audio.pause();
        channel.audio.removeAttribute("src");
        channel.audio.load();
        channel.key = null;
      });
    }

    pending[kind] = null;
    persistPlaybackState();
  }

  async function unlock() {
    if (unlocked) {
      await flushPending();
      return true;
    }

    if (unlocking) return false;
    unlocking = true;

    const silent =
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAA";

    const probe = new Audio(silent);
    probe.volume = 0;

    try {
      await probe.play();
      probe.pause();
      unlocked = true;
      document.documentElement.dataset.gfAudioUnlocked = "true";
      await flushPending();
      return true;
    } catch {
      return false;
    } finally {
      unlocking = false;
    }
  }

  async function flushPending() {
    if (!unlocked) return;

    const music = pending.music;
    const ambience = pending.ambience;

    if (music) {
      pending.music = null;
      await crossfade("music", music.key, music.options);
    }

    if (ambience) {
      pending.ambience = null;
      await crossfade("ambience", ambience.key, ambience.options);
    }
  }

  function getSfxVoice(key, path) {
    if (!sfxPools.has(key)) {
      sfxPools.set(key, {
        cursor: 0,
        voices: Array.from({ length: 5 }, () => {
          const audio = new Audio(path);
          audio.preload = "auto";
          return audio;
        })
      });
    }

    const pool = sfxPools.get(key);
    const voice = pool.voices[pool.cursor];
    pool.cursor = (pool.cursor + 1) % pool.voices.length;
    return voice;
  }

  async function playSfx(key, options = {}) {
    const path = getPath("sfx", key);
    if (!path) return false;

    if (!unlocked) await unlock();
    if (!unlocked) return false;

    const voice = getSfxVoice(key, path);

    try {
      voice.pause();
      voice.currentTime = 0;
      voice.playbackRate = Number(options.playbackRate) || 1;
      voice.volume = targetVolume("sfx", options.volume ?? 1);
      await voice.play();
      return true;
    } catch (err) {
      console.warn(`[GFAudio] SFX "${key}" failed:`, err);
      return false;
    }
  }


  function normalizeSpellSfxKey(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function resolveSpellSfxPath(value) {
    const raw = String(value || "")
      .trim()
      .replace(/\\\\/g, "/");

    if (!raw) return null;

    // spellLoadoutService returns class-qualified public URLs, such as:
    // /sounds/spells/warrior/commandingstrike.ogg
    if (raw.startsWith("/sounds/spells/")) {
      return raw;
    }

    // Preserve compact database keys for backwards compatibility.
    const key = normalizeSpellSfxKey(raw);
    return key ? `/sounds/spells/${key}.ogg` : null;
  }

  async function playSpellSfx(audioKey, options = {}) {
    const key = normalizeSpellSfxKey(audioKey);
    const path = resolveSpellSfxPath(audioKey);

    if (!key || !path) return false;

    // Spell rows store only the compact audio key, for example:
    //   sacredstrike
    //   guardiansgrace
    //   chainlightning
    //
    // Use the class-qualified URL supplied by the loadout service. Compact
    // keys still fall back to the original shared spell-sound directory.
    if (!TRACKS.sfx[key]) {
      TRACKS.sfx[key] = path;
    }

    return playSfx(
      key,
      options
    );
  }

  function handleSpellCastAudioEvent(event) {
    const detail =
      event?.detail || {};

    const audioKey =
      detail.audio ??
      detail.audioKey ??
      detail.spell?.audio ??
      null;

    if (!audioKey) return;

    playSpellSfx(
      audioKey,
      detail.options || {}
    ).catch(err => {
      console.warn(
        `[GFAudio] Spell SFX "${audioKey}" failed:`,
        err
      );
    });
  }

  window.addEventListener(
    "guildforge:spell-cast",
    handleSpellCastAudioEvent
  );

  function persistPlaybackState() {
    const music = musicChannels[activeMusicIndex];
    const ambience = ambienceChannels[activeAmbienceIndex];

    saveJson(PLAYBACK_KEY, {
      savedAt: Date.now(),
      music: music?.key
        ? {
            key: music.key,
            currentTime: Number(music.audio.currentTime) || 0,
            volume: music.requestedVolume,
            playing: !music.audio.paused
          }
        : null,
      ambience: ambience?.key
        ? {
            key: ambience.key,
            currentTime: Number(ambience.audio.currentTime) || 0,
            volume: ambience.requestedVolume,
            playing: !ambience.audio.paused
          }
        : null
    });
  }

  function restorePlaybackRequest() {
    const state = loadJson(PLAYBACK_KEY, null);
    if (!state) return;

    const savedAt = Number(state.savedAt || 0);
    const ageMs = Date.now() - savedAt;

    if (!Number.isFinite(ageMs) || ageMs > 30 * 60 * 1000) return;

    const elapsed = Math.max(0, ageMs / 1000);

    if (state.music?.playing && state.music.key) {
      pending.music = {
        key: state.music.key,
        options: {
          startAt: Number(state.music.currentTime || 0) + elapsed,
          volume: state.music.volume ?? 1,
          crossfadeMs: 100
        }
      };
    }

    if (
      state.ambience?.playing &&
      state.ambience.key
    ) {
      pending.ambience = {
        key: state.ambience.key,
        options: {
          startAt: Number(state.ambience.currentTime || 0) + elapsed,
          volume: state.ambience.volume ?? 1,
          crossfadeMs: 100
        }
      };
    }
  }

  function applyVolumes() {
    for (const channel of musicChannels) {
      if (!channel.audio.paused) {
        channel.audio.volume = targetVolume(
          "music",
          channel.requestedVolume
        );
      }
    }

    for (const channel of ambienceChannels) {
      if (!channel.audio.paused) {
        channel.audio.volume = targetVolume(
          "ambience",
          channel.requestedVolume
        );
      }
    }
  }

  function saveSettings() {
    saveJson(STORAGE_KEY, settings);
    applyVolumes();

    window.dispatchEvent(
      new CustomEvent("guildforge:audio-settings-changed", {
        detail: { ...settings }
      })
    );
  }

  function regionNameToMusicKey(regionName) {
    return String(regionName || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function playRegionMusic(regionName, options = {}) {
    const key = regionNameToMusicKey(regionName);

    if (!key) return Promise.resolve(false);

    // Region controls soundtrack only.
    if (
      currentRegionMusicKey === key &&
      musicChannels[activeMusicIndex]?.key === key
    ) {
      return Promise.resolve(true);
    }

    currentRegionMusicKey = key;

    if (!TRACKS.music[key]) {
      TRACKS.music[key] = `/music/${key}.ogg`;
    }

    return crossfade(
      "music",
      key,
      {
        crossfadeMs:
          options.crossfadeMs ??
          DEFAULT_CROSSFADE_MS,
        volume:
          options.musicVolume ??
          options.volume ??
          1
      }
    );
  }

  function terrainNameToAmbienceKey(terrain) {
    return String(terrain || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function playTerrainAmbience(terrain, options = {}) {
    const key = terrainNameToAmbienceKey(terrain);

    if (!key) return Promise.resolve(false);

    if (
      currentTerrainAmbienceKey === key &&
      ambienceChannels[activeAmbienceIndex]?.key === key
    ) {
      return Promise.resolve(true);
    }

    currentTerrainAmbienceKey = key;

    if (!TRACKS.ambience[key]) {
      TRACKS.ambience[key] =
        `/sounds/environment/${key}.ogg`;
    }

    return crossfade(
      "ambience",
      key,
      {
        crossfadeMs:
          options.crossfadeMs ??
          DEFAULT_CROSSFADE_MS,
        volume:
          options.ambienceVolume ??
          options.volume ??
          1,
        loop: true
      }
    );
  }

  function installWorldRegionHook() {
    if (worldRegionHookInstalled) return true;

    const existing = window.renderRegionHeader;

    if (typeof existing !== "function") {
      return false;
    }

    window.renderRegionHeader = function (...args) {
      const result = existing.apply(this, args);
      const data = args[0];

      if (data?.region_name) {
        playRegionMusic(data.region_name);
      }

      return result;
    };

    worldRegionHookInstalled = true;
    return true;
  }

  function waitForWorldRegionHook(attempt = 0) {
    if (installWorldRegionHook()) return;
    if (attempt >= 50) return;

    setTimeout(
      () => waitForWorldRegionHook(attempt + 1),
      100
    );
  }

  function configurePageAudio() {
    if (!document.body) return;

    const region = document.body.dataset.gfRegion;
    const terrain = document.body.dataset.gfTerrain;
    const music = document.body.dataset.gfMusic;
    const ambience = document.body.dataset.gfAmbience;

    if (region) {
      playRegionMusic(region);
      waitForWorldRegionHook();
    } else if (music) {
      crossfade("music", music);
    }

    if (terrain) {
      playTerrainAmbience(terrain);
    } else if (ambience) {
      crossfade("ambience", ambience);
    }
  }

  function registerTrack(kind, key, path) {
    if (!TRACKS[kind]) {
      throw new Error(`[GFAudio] Invalid track type "${kind}".`);
    }

    TRACKS[kind][key] = path;
  }

  window.GFAudio = {
    tracks: TRACKS,

    unlock,

    playMusic: (key, options) =>
      crossfade("music", key, options),

    playRegionMusic,
    regionNameToMusicKey,

    playTerrainAmbience,
    terrainNameToAmbienceKey,

    stopMusic: fadeMs =>
      stopGroup("music", fadeMs),

    playAmbience: (key, options) =>
      crossfade("ambience", key, options),

    stopAmbience: fadeMs =>
      stopGroup("ambience", fadeMs),

    playSfx,
    playSpellSfx,
    normalizeSpellSfxKey,

    registerTrack,

    registerTracks(kind, entries) {
      for (const [key, path] of Object.entries(entries || {})) {
        registerTrack(kind, key, path);
      }
    },

    setMasterVolume(value) {
      settings.masterVolume = clamp01(value);
      saveSettings();
    },

    setMusicVolume(value) {
      settings.musicVolume = clamp01(value);
      saveSettings();
    },

    setAmbienceVolume(value) {
      settings.ambienceVolume = clamp01(value);
      saveSettings();
    },

    setSfxVolume(value) {
      settings.sfxVolume = clamp01(value);
      saveSettings();
    },

    setMuted(value) {
      settings.muted = Boolean(value);
      saveSettings();
    },

    toggleMuted() {
      settings.muted = !settings.muted;
      saveSettings();
      return settings.muted;
    },

    configurePageAudio,

    getState() {
      return {
        unlocked,
        settings: { ...settings },
        music: musicChannels[activeMusicIndex]?.key || null,
        ambience: ambienceChannels[activeAmbienceIndex]?.key || null
      };
    }
  };

  window.GFAudioReady = Promise.resolve(window.GFAudio);

  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
  window.addEventListener("pagehide", persistPlaybackState);

  setInterval(persistPlaybackState, 1000);

  restorePlaybackRequest();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", configurePageAudio, { once: true });
  } else {
    configurePageAudio();
  }
})();