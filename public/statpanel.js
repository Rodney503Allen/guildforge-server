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
// QUEST COMPLETE GLOBAL NOTIFY (statpanel.js)
// =======================
(function installQuestCompleteNotifier() {
  if (window.__questNotifyInstalled) return;
  window.__questNotifyInstalled = true;

  let questCompleteAudio = null;

  function playQuestCompleteSound() {
    try {
      if (!questCompleteAudio) {
        questCompleteAudio = new Audio("/sounds/questComplete.mp3");
        questCompleteAudio.volume = 0.5;
      }
      questCompleteAudio.currentTime = 0;
      questCompleteAudio.play().catch(() => {});
    } catch (e) {
      console.warn("Quest sound failed:", e);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  let bannerTimer = null;

  function showQuestCompleteBanner(titleText) {
    const title = (titleText ?? "Quest Completed").toString();

    const existing = document.getElementById("questCompleteBanner");
    if (existing) existing.remove();
    if (bannerTimer) clearTimeout(bannerTimer);

    const el = document.createElement("div");
    el.id = "questCompleteBanner";
    el.className = "quest-complete-banner";
    el.innerHTML = `
      <div class="qcb-inner">
        <div class="qcb-glow"></div>
        <div class="qcb-badge">✅</div>
        <div class="qcb-text">
          <div class="qcb-title">Quest Completed</div>
          <div class="qcb-name">${escapeHtml(title)}</div>
          <div class="qcb-sub">Journal updated</div>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    playQuestCompleteSound();
    requestAnimationFrame(() => el.classList.add("show"));

    bannerTimer = setTimeout(() => {
      el.classList.add("hide");
      setTimeout(() => el.remove(), 500);
    }, 2600);
  }

  // prevent duplicates across multiple API calls + reloads
  const KEY = "gf_notified_completed_pqids";
  function getSeen() {
    try { return new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); }
    catch { return new Set(); }
  }
  function saveSeen(set) {
    try { localStorage.setItem(KEY, JSON.stringify([...set].slice(-200))); }
    catch {}
  }

    // =======================
  // TURN-IN READY NOTIFY (amount owned == amount required)
  // =======================

  // ✅ IMPORTANT: set this to your actual journal endpoint.
  // Common ones in your project: "/api/journal" or "/journal"
  const JOURNAL_URL = "/api/journal/quests";

  // prevent duplicates
  const READY_KEY = "gf_notified_turnin_ready_pqids";
  function getReadySeen() {
    try { return new Set(JSON.parse(localStorage.getItem(READY_KEY) || "[]")); }
    catch { return new Set(); }
  }
  function saveReadySeen(set) {
    try { localStorage.setItem(READY_KEY, JSON.stringify([...set].slice(-200))); }
    catch {}
  }

  function extractTurnInReadyFromJournal(journal) {
    // expects: { active: QuestLogRow[], completed: [], claimed: [], rumors: [] }
    const active = journal?.active;
    if (!Array.isArray(active)) return [];

    // If a quest has TURN_IN objective complete (progress >= required), notify once.
    // (Still "active" until turn-in action, depending on your design.)
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
      const res = await _fetch(JOURNAL_URL, { credentials: "include" });
      if (!res.ok) return;

      const data = await res.json();
      const ready = extractTurnInReadyFromJournal(data);
      if (!ready.length) return;

      const seen = getReadySeen();
      const newlyReady = [];

      for (const row of ready) {
        const pqid = Number(row?.playerQuestId);
        if (!Number.isFinite(pqid)) continue;
        if (seen.has(pqid)) continue;

        seen.add(pqid);
        newlyReady.push(row);
      }

      if (newlyReady.length) {
        saveReadySeen(seen);

        // Use your existing banner + sound (requested)
        newlyReady.forEach((r, idx) => {
          const title = r?.title || "Quest";
          setTimeout(() => showQuestCompleteBanner(`Turn-In Ready: ${title}`), idx * 450);
        });
      }
    } catch {
      // ignore
    }
  }

  // Poll every 8s (lightweight). You can raise this to 15–30s if you want.
  setInterval(pollTurnInReady, 8000);

  // Run once shortly after load
  setTimeout(pollTurnInReady, 1200);



  function extractCompletedQuests(payload) {
    // supports: { quest: { completedQuests: [...] } } OR { completedQuests: [...] }
    const a = payload?.quest?.completedQuests;
    if (Array.isArray(a)) return a;
    const b = payload?.completedQuests;
    if (Array.isArray(b)) return b;
    return [];
  }

  const _fetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await _fetch(...args);

    // Only inspect JSON responses (safe + cheap)
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return res;

    // Clone so callers can still read the response body
    const clone = res.clone();

    clone.json().then((data) => {
      const completed = extractCompletedQuests(data);
      if (!completed.length) return;

      const seen = getSeen();
      const newlyCompleted = [];

      for (const q of completed) {
        const pqid = Number(q?.playerQuestId);
        if (!Number.isFinite(pqid)) continue;
        if (seen.has(pqid)) continue;
        seen.add(pqid);
        newlyCompleted.push(q);
      }

      if (newlyCompleted.length) {
        saveSeen(seen);

        // stagger banners if multiple complete at once
        newlyCompleted.forEach((q, idx) => {
          setTimeout(() => showQuestCompleteBanner(q?.title || "Quest"), idx * 450);
        });
      }
    }).catch(() => {});

    return res;
  };
})();



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
