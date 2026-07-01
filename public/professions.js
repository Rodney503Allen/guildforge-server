(() => {
  const elStatus = document.getElementById("professions-status");
  const elBook = document.getElementById("professions-book");
  const elList = document.getElementById("profession-list");
  const elDetail = document.getElementById("profession-detail");
  const chips = Array.from(document.querySelectorAll(".gf-chip"));

  const state = {
    payload: null,
    professions: [],
    filter: "all",
    selectedId: null,
  };

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function profIcon(name) {
    const n = String(name || "").toLowerCase();
    if (n === "mining") return "⛏️";
    if (n === "herbalism") return "🌿";
    if (n === "woodcutting") return "🪓";
    return "⚒";
  }

  function iconPath(icon) {
    if (!icon) return "/images/default_item.png";
    if (String(icon).startsWith("/")) return icon;
    return `/images/items/${icon}`;
  }

  function xpNeeded(level) {
    level = Number(level || 1);
    return Math.floor(50 + level * level * 25);
  }

  function visibleProfessions() {
    if (state.filter === "all") return state.professions;
    return state.professions.filter(p => String(p.type || "").toLowerCase() === state.filter);
  }

  function setStatus(msg) {
    if (!msg) {
      elStatus.hidden = true;
      return;
    }

    elStatus.hidden = false;
    elStatus.textContent = msg;
  }

  function renderList() {
    const items = visibleProfessions();

    if (!items.length) {
      elList.innerHTML = `<div class="gf-empty">No professions found.</div>`;
      return;
    }

    elList.innerHTML = items.map(p => {
      const isSelected = Number(state.selectedId) === Number(p.id);
      const level = Number(p.level || 1);
      const experience = Number(p.experience || 0);
      const needed = Number(p.xpNeeded || xpNeeded(level));
      const pct = Math.max(0, Math.min(100, Math.round((experience / needed) * 100)));

      return `
        <button class="gf-row ${isSelected ? "is-active" : ""}" type="button" data-id="${Number(p.id)}">
          <div class="gf-row__top">
            <div class="gf-row__title">
              <span class="gf-prof-icon">${profIcon(p.name)}</span>${esc(p.name)}
            </div>
            <div class="gf-row__badge">Lv ${esc(level)}</div>
          </div>

          <div class="gf-row__sub">
            ${esc(p.type || "Profession")}
            ${p.isSpecialized ? `<span>Specialized</span>` : `<span>Unspecialized</span>`}
          </div>

          <div class="gf-row__meta">${esc(experience)} / ${esc(needed)} XP</div>
          <div class="gf-xpbar">
            <div class="gf-xpbar__fill" style="width:${pct}%"></div>
          </div>
        </button>
      `;
    }).join("");

    Array.from(elList.querySelectorAll(".gf-row")).forEach(btn => {
      btn.addEventListener("click", () => {
        state.selectedId = Number(btn.getAttribute("data-id"));
        renderList();
        renderDetail();
      });
    });
  }

  function renderDetail() {
    const selected =
      state.professions.find(p => Number(p.id) === Number(state.selectedId)) ||
      visibleProfessions()[0];

    if (!selected) {
      elDetail.innerHTML = `
        <div class="gf-detail__empty">
          <div class="gf-detail__sigil">⚒</div>
          <div class="gf-detail__msg">Choose a profession from the left page.</div>
        </div>
      `;
      return;
    }

    state.selectedId = Number(selected.id);

    const level = Number(selected.level || 1);
    const experience = Number(selected.experience || 0);
    const needed = Number(selected.xpNeeded || xpNeeded(level));
    const pct = Math.max(0, Math.min(100, Math.round((experience / needed) * 100)));
    const tool = selected.tool || null;
    const nodes = selected.nodes || [];

    elDetail.innerHTML = `
      <article class="gf-card">
        <header class="gf-card__head">
          <div>
            <div class="gf-card__kicker">${esc(selected.type || "Profession")}</div>
            <h3 class="gf-card__title">
              ${profIcon(selected.name)} ${esc(selected.name)}
            </h3>
          </div>
          <div class="gf-pill">Level ${esc(level)}</div>
        </header>

        <div class="gf-card__body gf-detail-body">
          <section class="gf-section">
            <h4 class="gf-section__title">Progress</h4>

            <div class="gf-inline">
              <div class="gf-inline__label">Experience</div>
              <div class="gf-inline__value">${esc(experience)} / ${esc(needed)}</div>
            </div>

            <div class="gf-xpbar">
              <div class="gf-xpbar__fill" style="width:${pct}%"></div>
            </div>
          </section>

          <div class="gf-divider"></div>

          <section class="gf-section">
            <h4 class="gf-section__title">Equipped Tool</h4>

            ${tool ? `
              <div class="gf-tool">
                <img class="gf-tool__icon" src="${esc(iconPath(tool.icon))}" alt="">
                <div>
                  <div class="gf-tool__name">${esc(tool.name)}</div>
                  <div class="gf-card__desc">${esc(tool.item_type || "Tool")}</div>
                </div>
              </div>
            ` : `
              <div class="gf-empty">No tool equipped.</div>
            `}
          </section>

          <div class="gf-divider"></div>

          <section class="gf-section">
            <h4 class="gf-section__title">Known Nodes</h4>

            <div class="gf-node-list">
              ${nodes.length ? nodes.map(n => `
                <div class="gf-node">
                  <div class="gf-node__top">
                    <div class="gf-node__name">${esc(n.name)}</div>
                    <div class="gf-row__badge">${esc(n.rarity || "common")}</div>
                  </div>
                  <div class="gf-node__meta">
                    Required Level: ${esc(n.requiredLevel ?? n.required_level ?? 1)}
                    ${n.baseXp || n.base_xp ? ` • ${esc(n.baseXp ?? n.base_xp)} XP` : ""}
                  </div>
                </div>
              `).join("") : `<div class="gf-empty">No known nodes yet.</div>`}
            </div>
          </section>

          <div class="gf-divider"></div>

          <section class="gf-section">
            <h4 class="gf-section__title">Specialization</h4>
            <div class="gf-hint">
              <div class="gf-hint__text">
                ${selected.isSpecialized
                  ? `You are specialized in ${esc(selected.name)}.`
                  : `Specialization is not selected yet.`}
              </div>
            </div>
          </section>
        </div>
      </article>
    `;
  }

  function wireReturn() {
    const btn = document.getElementById("btn-return");
    if (!btn) return;

    btn.addEventListener("click", () => {
      const prev = sessionStorage.getItem("gf_prev_screen");
      if (prev) {
        window.location.href = prev + (prev.includes("?") ? "&" : "?") + "r=" + Date.now();
        return;
      }

      window.location.href = "/world?r=" + Date.now();
    });
  }

  function wireChips() {
    chips.forEach(chip => {
      chip.addEventListener("click", () => {
        chips.forEach(c => c.classList.remove("is-active"));
        chip.classList.add("is-active");

        state.filter = chip.getAttribute("data-filter") || "all";
        renderList();
        renderDetail();
      });
    });
  }

  async function load() {
    const res = await fetch("/api/professions/summary", {
      credentials: "include"
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const payload = JSON.parse(text);

    state.payload = payload;
    state.professions = payload.professions || [];

    if (!state.selectedId && state.professions.length) {
      state.selectedId = Number(state.professions[0].id);
    }
  }

  async function init() {
    try {
      setStatus("Loading…");
      wireReturn();
      wireChips();

      await load();

      elBook.hidden = false;
      setStatus("");
      renderList();
      renderDetail();
    } catch (err) {
      console.error(err);
      setStatus(String(err.message || err));
    }
  }

  init();
})();