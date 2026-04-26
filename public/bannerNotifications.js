// public/bannerNotifications.js

(function installBannerNotifications() {
  if (window.GFBanners) return;

  const sounds = {};
  const timers = {};

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function playSound(key, src, volume = 0.5) {
    try {
      if (!sounds[key]) {
        sounds[key] = new Audio(src);
        sounds[key].volume = volume;
      }

      sounds[key].currentTime = 0;
      sounds[key].play().catch(() => {});
    } catch (e) {
      console.warn("Banner sound failed:", e);
    }
  }

  function showBanner({
    id = "gfBanner",
    className = "gf-banner",
    badge = "✨",
    title = "Notification",
    name = "",
    sub = "",
    soundKey = null,
    soundSrc = null,
    duration = 5000
  }) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    if (timers[id]) clearTimeout(timers[id]);

    const el = document.createElement("div");
    el.id = id;
    el.className = className;

    el.innerHTML = `
      <div class="qcb-inner">
        <div class="qcb-glow"></div>
        <div class="qcb-badge">${escapeHtml(badge)}</div>
        <div class="qcb-text">
          <div class="qcb-title">${escapeHtml(title)}</div>
          <div class="qcb-name">${escapeHtml(name)}</div>
          ${sub ? `<div class="qcb-sub">${escapeHtml(sub)}</div>` : ""}
        </div>
      </div>
    `;

    document.body.appendChild(el);

    if (soundKey && soundSrc) {
      playSound(soundKey, soundSrc);
    }

    requestAnimationFrame(() => el.classList.add("show"));

    timers[id] = setTimeout(() => {
      el.classList.add("hide");
      setTimeout(() => el.remove(), 500);
    }, duration);
  }

  function getSeen(key) {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
    } catch {
      return new Set();
    }
  }

  function saveSeen(key, set) {
    try {
      localStorage.setItem(key, JSON.stringify([...set].slice(-200)));
    } catch {}
  }

  function questComplete(titleText) {
    showBanner({
      id: "questCompleteBanner",
      className: "quest-complete-banner",
      badge: "✅",
      title: "Quest Completed",
      name: titleText || "Quest",
      sub: "Journal updated",
      soundKey: "questComplete",
      soundSrc: "/sounds/questComplete.mp3"
    });
  }

function levelUp(levelUpData) {
  if (!levelUpData) return;

  const newLevel = levelUpData.newLevel ?? levelUpData.level ?? "?";
  const levelsGained = Number(levelUpData.levelsGained || 1);

  showBanner({
    id: "levelUpBanner",
    className: "quest-complete-banner level-up-banner level-up-banner-big",
    badge: `${newLevel}`,
    title: levelsGained > 1 ? "Multiple Level Ups!" : "Level Up!",
    name: `You grow stronger, wanderer.`,
    sub: `+${levelUpData.statPoints ?? 0} stat points earned`,
    soundKey: "levelUp",
    soundSrc: "/sounds/levelUp.mp3",
    duration: 5000
  });
}

  function questTurnInReady(titleText) {
    showBanner({
      id: "questCompleteBanner",
      className: "quest-complete-banner",
      badge: "📜",
      title: "Turn-In Ready",
      name: titleText || "Quest",
      sub: "Return to the quest giver",
      soundKey: "questComplete",
      soundSrc: "/sounds/questComplete.mp3"
    });
  }

  function extractCompletedQuests(payload) {
    const a = payload?.quest?.completedQuests;
    if (Array.isArray(a)) return a;

    const b = payload?.completedQuests;
    if (Array.isArray(b)) return b;

    return [];
  }

  function extractLevelUp(payload) {
  return (
    payload?.levelUp ||
    payload?.rewards?.levelUp ||
    payload?.snapshot?.rewards?.levelUp ||
    null
  );
}

function handleLevelUpPayload(payload) {
  const data = extractLevelUp(payload);
  if (!data) return;

  const oldLevel = Number(data.oldLevel || 0);
  const newLevel = Number(data.newLevel || 0);
  const key = `gf_levelup_${newLevel}`;

  const seen = getSeen("gf_notified_levelups");
  if (seen.has(key)) return;

  seen.add(key);
  saveSeen("gf_notified_levelups", seen);

  levelUp(data);
}

  function handleQuestCompletionPayload(payload) {
    const completed = extractCompletedQuests(payload);
    if (!completed.length) return;

    const KEY = "gf_notified_completed_pqids";
    const seen = getSeen(KEY);
    const newlyCompleted = [];

    for (const q of completed) {
      const pqid = Number(q?.playerQuestId);
      if (!Number.isFinite(pqid)) continue;
      if (seen.has(pqid)) continue;

      seen.add(pqid);
      newlyCompleted.push(q);
    }

    if (!newlyCompleted.length) return;

    saveSeen(KEY, seen);

    newlyCompleted.forEach((q, idx) => {
      setTimeout(() => {
        questComplete(q?.title || "Quest");
      }, idx * 450);
    });
  }

  function extractTurnInReadyFromJournal(journal) {
    const active = journal?.active;
    if (!Array.isArray(active)) return [];

    return active.filter((r) => {
      const type = String(r?.objectiveType || "");
      if (type !== "TURN_IN") return false;

      const req = Number(r?.required_count || 0);
      const cur = Number(r?.progress_count || 0);

      return req > 0 && cur >= req;
    });
  }

  async function pollTurnInReady() {
    try {
      const res = await originalFetch("/api/journal/quests", {
        credentials: "include"
      });

      if (!res.ok) return;

      const data = await res.json();
      const ready = extractTurnInReadyFromJournal(data);
      if (!ready.length) return;

      const KEY = "gf_notified_turnin_ready_pqids";
      const seen = getSeen(KEY);
      const newlyReady = [];

      for (const row of ready) {
        const pqid = Number(row?.playerQuestId);
        if (!Number.isFinite(pqid)) continue;
        if (seen.has(pqid)) continue;

        seen.add(pqid);
        newlyReady.push(row);
      }

      if (!newlyReady.length) return;

      saveSeen(KEY, seen);

      newlyReady.forEach((r, idx) => {
        setTimeout(() => {
          questTurnInReady(r?.title || "Quest");
        }, idx * 450);
      });
    } catch {
      // ignore polling errors
    }
  }

  window.GFBanners = {
    show: showBanner,
    questComplete,
    questTurnInReady,
    levelUp,
    handleQuestCompletionPayload,
    handleLevelUpPayload
    };

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (...args) => {
    const res = await originalFetch(...args);

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return res;

    const clone = res.clone();

    clone.json()
    .then((data) => {
        handleQuestCompletionPayload(data);
        handleLevelUpPayload(data);
    })
    .catch(() => {});

    return res;
  };

  setTimeout(pollTurnInReady, 1200);
  setInterval(pollTurnInReady, 8000);
})();