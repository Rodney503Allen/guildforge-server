// public/journal.js
(() => {
  const elStatus = document.getElementById("journal-status");
  const elBook = document.getElementById("journal-book");
  const elList = document.getElementById("quest-list");
  const elDetail = document.getElementById("quest-detail");
  const chips = Array.from(document.querySelectorAll(".gf-chip"));

  const state = {
    payload: null,
    filter: "active", // all | active | completed | claimed | rumors
    selectedKey: null, // e.g. "pq:12" or "q:99"
    entries: [], // normalized combined list
  };

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fmtObjective(o) {
    const type = o.objectiveType;
    const req = Number(o.required_count || 0) || 1;
    const prog = Number(o.progress_count || 0);
    const pct = Math.max(0, Math.min(100, Math.round((prog / req) * 100)));

    let label = "";
    if (type === "KILL") {
      const region = o.region_name ? ` in ${o.region_name}` : "";
      label = `Defeat targets${region}`;
    } else if (type === "TURN_IN") {
      label = `Deliver required items`;
    } else {
      label = `Objective`;
    }

    return `
      <div class="gf-obj">
        <div class="gf-obj__row">
          <div class="gf-obj__label">${esc(label)}</div>
          <div class="gf-obj__count">${esc(prog)} / ${esc(req)}</div>
        </div>
        <div class="gf-obj__bar"><div class="gf-obj__fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }

  // Normalize accepted rows (1 row per objective) -> 1 entry per playerQuestId
  function groupAccepted(rows, status) {
    const byPQ = new Map();

    (rows || []).forEach(r => {
      const pqId = Number(r.playerQuestId);
      if (!byPQ.has(pqId)) {
        byPQ.set(pqId, {
          key: `pq:${pqId}`,
          kind: "accepted",          // accepted | rumor
          status: status,            // active | completed | claimed
          playerQuestId: pqId,
          questId: Number(r.questId),
          type: r.type,
          title: r.title,
          description: r.description ?? null,
          dialog_intro: r.dialog_intro ?? null,
          dialog_complete: r.dialog_complete ?? null,
          turn_in_location_id: r.turn_in_location_id ?? null,
          turn_in_location_name: r.turn_in_location_name ?? null,
          reward_gold: Number(r.reward_gold || 0),
          reward_xp: Number(r.reward_xp || 0),
          objectives: [],
        });
      }

      const entry = byPQ.get(pqId);
      entry.objectives.push({
        objectiveId: Number(r.objectiveId),
        objectiveType: r.objectiveType,
        required_count: Number(r.required_count || 1),
        target_item_id: r.target_item_id != null ? Number(r.target_item_id) : null,
        target_creature_id: r.target_creature_id != null ? Number(r.target_creature_id) : null,
        region_name: r.region_name ?? null,
        progress_count: Number(r.progress_count || 0),
        is_complete: Number(r.is_complete || 0),
      });
    });

    return Array.from(byPQ.values());
  }
(function wireReturn(){
  const btn = document.getElementById("btn-return");
  if (!btn) return;

  btn.addEventListener("click", () => {
    // If we stored an explicit previous page, use it
    const prev = sessionStorage.getItem("gf_prev_screen");
    if (prev) {
      window.location.href = prev + (prev.includes("?") ? "&" : "?") + "r=" + Date.now();
      return;
    }

    // Fallback: go to a safe default with a cache-bust
    window.location.href = "/world?r=" + Date.now();
  });
})();

  function normalize(payload) {
    const active = groupAccepted(payload.active, "active");
    const completed = groupAccepted(payload.completed, "completed");
    const claimed = groupAccepted(payload.claimed, "claimed");

    const rumors = (payload.rumors || []).map(r => ({
      key: `q:${Number(r.questId)}`,
      kind: "rumor",
      status: "rumor",
      questId: Number(r.questId),
      type: r.type,
      title: r.title,
      description: r.description ?? null,
      rumor_hint: r.rumor_hint ?? null,
      min_level: Number(r.min_level || 1),
      is_locked: Number(r.is_locked || 0), // if you added it in service
      town_id: r.town_id ?? null,
      town_name: r.town_name ?? null,
      turn_in_location_id: r.turn_in_location_id ?? null,
      turn_in_location_name: r.turn_in_location_name ?? null,
    }));

    // Combined list (for "all")
    return { active, completed, claimed, rumors };
  }

  function getVisibleEntries() {
    if (!state.payload) return [];

    const { active, completed, claimed, rumors } = state.entriesByGroup;

    if (state.filter === "active") return active;
    if (state.filter === "completed") return completed;
    if (state.filter === "claimed") return claimed;
    if (state.filter === "rumors") return rumors;

    // all
    return [...active, ...completed, ...claimed, ...rumors];
  }

  function renderList() {
    const items = getVisibleEntries();

    if (!items.length) {
      elList.innerHTML = `<div class="gf-empty">No entries found.</div>`;
      return;
    }

    elList.innerHTML = items
      .map(it => {
        const isSel = state.selectedKey === it.key;
        const badge =
          it.kind === "rumor"
            ? (it.is_locked ? "Locked" : "Rumor")
            : it.status === "active"
              ? "Active"
              : it.status === "completed"
                ? "Completed"
                : "Claimed";

        const sub =
          it.kind === "rumor"
            ? (it.town_name ? `From: ${it.town_name}` : `Unassigned`)
            : (it.type === "bounty" ? "Bounty Contract" : "Quest Contract");

        // quick progress summary for accepted
        let prog = "";
        if (it.kind === "accepted" && it.objectives?.length) {
          const total = it.objectives.length;
          const done = it.objectives.reduce((a, o) => a + (Number(o.is_complete) === 1 ? 1 : 0), 0);
          prog = `<div class="gf-row__meta">${done}/${total} objectives</div>`;
        }

        return `
          <button class="gf-row ${isSel ? "is-active" : ""}" type="button" data-key="${esc(it.key)}">
            <div class="gf-row__top">
              <div class="gf-row__title">${esc(it.title)}</div>
              <div class="gf-row__badge">${esc(badge)}</div>
            </div>
            <div class="gf-row__sub">${esc(sub)}</div>
            ${prog}
          </button>
        `;
      })
      .join("");

    // click handlers
    Array.from(elList.querySelectorAll(".gf-row")).forEach(btn => {
      btn.addEventListener("click", () => {
        state.selectedKey = btn.getAttribute("data-key");
        renderList();
        renderDetail();
      });
    });
  }

  function renderDetail() {
    const items = getVisibleEntries();
    const selected =
      items.find(x => x.key === state.selectedKey) ||
      // fallback: search all groups if filter changed
      ([...state.entriesByGroup.active, ...state.entriesByGroup.completed, ...state.entriesByGroup.claimed, ...state.entriesByGroup.rumors]
        .find(x => x.key === state.selectedKey));

    if (!selected) {
      elDetail.innerHTML = `
        <div class="gf-detail__empty">
          <div class="gf-detail__sigil">☉</div>
          <div class="gf-detail__msg">Choose a quest from the left page.</div>
        </div>
      `;
      return;
    }

    // RUMOR (unaccepted)
    if (selected.kind === "rumor") {
      const locked = Number(selected.is_locked) === 1;
      const hint = selected.rumor_hint ? esc(selected.rumor_hint) : "No hint available.";
      const minLvl = Number(selected.min_level || 1);

      elDetail.innerHTML = `
        <article class="gf-card">
          <header class="gf-card__head">
            <div class="gf-card__kicker">${locked ? "Whisper (Locked)" : "Whisper"}</div>
            <h3 class="gf-card__title">${esc(selected.title)}</h3>
            <div class="gf-card__sub">
              ${selected.town_name ? `Heard in ${esc(selected.town_name)}.` : `Origin unknown.`}
              ${locked ? ` <span class="gf-warn">Requires level ${esc(minLvl)}.</span>` : ""}
            </div>
          </header>

          <div class="gf-card__body gf-detail-body">

            ${selected.description ? `
              <section class="gf-section">
                <h4 class="gf-section__title">Summary</h4>
                <p class="gf-card__desc">${esc(selected.description)}</p>
              </section>
            ` : ""}

            <section class="gf-section">
              <h4 class="gf-section__title">Hint</h4>
              <div class="gf-hint">
                <div class="gf-hint__text">${hint}</div>
              </div>
            </section>

            ${selected.turn_in_location_name ? `
              <section class="gf-section">
                <h4 class="gf-section__title">Likely Turn-In</h4>
                <div class="gf-inline">
                  <div class="gf-inline__value">${esc(selected.turn_in_location_name)}</div>
                </div>
              </section>
            ` : ""}

          </div>
        </article>
      `;

      return;
    }

    // ACCEPTED (active/completed/claimed)
    const status = selected.status;
    const rewards = `Gold: ${selected.reward_gold || 0} • XP: ${selected.reward_xp || 0}`;

    let statusBlock = "";

    if (status === "active") {
      statusBlock = `<div class="gf-pill gf-pill--active">Active</div>`;
    } else if (status === "completed") {
      statusBlock = `<div class="gf-pill gf-pill--completed">Completed</div>`;
    } else {
      statusBlock = `<div class="gf-pill gf-pill--claimed">Quest Completed</div>`;
    }


    elDetail.innerHTML = `
      <article class="gf-card">
        <header class="gf-card__head">
          <div class="gf-card__kicker">${selected.type === "bounty" ? "Bounty Contract" : "Quest Contract"}</div>
          <h3 class="gf-card__title">${esc(selected.title)}</h3>
          <div class="gf-card__sub">${statusBlock}</div>
        </header>

<div class="gf-card__body gf-detail-body">

  ${selected.description ? `
    <section class="gf-section">
      <h4 class="gf-section__title">Summary</h4>
      <p class="gf-card__desc">${esc(selected.description)}</p>
    </section>
  ` : ""}

  ${selected.dialog_intro && status === "active" ? `
    <section class="gf-section">
      <h4 class="gf-section__title">Contract</h4>
      <div class="gf-quote">
        <div class="gf-quote__text">${esc(selected.dialog_intro)}</div>
      </div>
    </section>
  ` : ""}

  <section class="gf-section gf-section--two">
    <div>
      <h4 class="gf-section__title">Rewards</h4>
      <div class="gf-inline">
        <div class="gf-inline__value">${esc(rewards)}</div>
      </div>
    </div>

    ${(status === "active" || status === "completed") ? `
      <div>
        <h4 class="gf-section__title">Turn In</h4>
        <div class="gf-inline">
          <div class="gf-inline__value">${esc(selected.turn_in_location_name || "Unknown location")}</div>
        </div>
      </div>
    ` : `<div></div>`}
  </section>

  <section class="gf-section">
    <h4 class="gf-section__title">Objectives</h4>
    <div class="gf-objwrap">
      ${(selected.objectives || []).map(fmtObjective).join("") || `<div class="gf-empty">No objectives.</div>`}
    </div>
  </section>

  ${selected.dialog_complete && status !== "active" ? `
    <section class="gf-section">
      <h4 class="gf-section__title">Completion</h4>
      <div class="gf-quote">
        <div class="gf-quote__text">${esc(selected.dialog_complete)}</div>
      </div>
    </section>
  ` : ""}

  ${status === "claimed" ? `
    <section class="gf-section">
      <h4 class="gf-section__title">Result</h4>
      <div class="gf-hint">
        <div class="gf-hint__text">Rewards claimed. This contract is complete.</div>
      </div>
    </section>
  ` : ""}

</div>
      </article>
    `;

  }

  function setStatus(msg) {
    if (!msg) {
      elStatus.hidden = true;
      return;
    }
    elStatus.hidden = false;
    elStatus.textContent = msg;
  }

  function wireChips() {
    
    chips.forEach(chip => {
      chip.addEventListener("click", () => {
        chips.forEach(c => c.classList.remove("is-active"));
        chip.classList.add("is-active");

        state.filter = chip.getAttribute("data-filter") || "all";
        // don’t blow away selection; just re-render
        renderList();
        renderDetail();
      });
    });
  }

async function load() {
  const res = await fetch("/api/journal/quests", { credentials: "include" });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got: ${text.slice(0, 200)}`);
  }

  state.payload = payload;
  state.entriesByGroup = normalize(payload);

  const all = getVisibleEntries();
  const firstActive = state.entriesByGroup.active?.[0];
  if (!state.selectedKey) state.selectedKey = firstActive?.key || all?.[0]?.key || null;
}


async function init() {
  try {
    setStatus("Loading…");
    wireChips();

    // sync UI to default filter on load
    chips.forEach(c => c.classList.toggle("is-active", (c.getAttribute("data-filter") || "") === state.filter));

    await load();

    elBook.hidden = false;
    setStatus("");
    renderList();
    renderDetail();
  } catch (e) {
    console.error(e);
    setStatus(String(e.message || e));
  }
}

  init();
})();
