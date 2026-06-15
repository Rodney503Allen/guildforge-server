// public/codex.js

let codexCreatures = [];
let activeFilter = "all";
let selectedCreatureId = null;
let creaturesPerPage = 7;
let codexPage = 0;

document.addEventListener("DOMContentLoaded", () => {
  initCodex();
});

async function initCodex() {
  bindCodexFilters();

  try {
    const res = await fetch("/api/codex", {
      credentials: "include"
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to load codex");
    }

    codexCreatures = Array.isArray(data.creatures) ? data.creatures : [];

    document.getElementById("codex-status")?.setAttribute("hidden", "true");
    document.getElementById("codex-book")?.removeAttribute("hidden");

    renderCreatureList();

    if (codexCreatures.length > 0) {
      selectCreature(codexCreatures[0].id);
    }
  } catch (err) {
    console.error("Codex load failed:", err);
    const status = document.getElementById("codex-status");
    if (status) status.textContent = "Failed to load creature records.";
  }
}

function bindCodexFilters() {
  const filters = document.querySelectorAll("#codex-filters .gf-chip");

  filters.forEach((btn) => {
    btn.addEventListener("click", () => {
      filters.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");

      activeFilter = btn.dataset.filter || "all";
        codexPage = 0;
        renderCreatureList();
    });
  });
}

function calculateCreaturesPerPage() {
  const list = document.getElementById("codex-creature-list");
  if (!list) return 7;

  const availableHeight = list.clientHeight;
  const estimatedRowHeight = 82;

  return Math.max(1, Math.floor(availableHeight / estimatedRowHeight));
}

function getFilteredCreatures() {
  if (activeFilter === "all") return codexCreatures;

  return codexCreatures.filter((c) => {
    if (activeFilter === "unknown") return c.state === "unknown";
    if (activeFilter === "seen") return c.state === "seen";
    if (activeFilter === "killed") return c.progress?.killCount > 0;
    if (activeFilter === "studied") return c.state === "studied" || c.state === "mastered";
    if (activeFilter === "mastered") return c.state === "mastered";
    return true;
  });
}

function renderCreatureList() {
  const list = document.getElementById("codex-creature-list");
  if (!list) return;

  const creatures = getFilteredCreatures();
  creaturesPerPage = calculateCreaturesPerPage();

const totalPages = Math.max(1, Math.ceil(creatures.length / creaturesPerPage));

  if (codexPage >= totalPages) codexPage = totalPages - 1;
  if (codexPage < 0) codexPage = 0;

  if (!creatures.length) {
    list.innerHTML = `<div class="gf-empty">No creature records found.</div>`;
    renderCodexPager(0, 0);
    renderEmptyDetail();
    return;
  }

  const start = codexPage * creaturesPerPage;
  const pageCreatures = creatures.slice(start, start + creaturesPerPage);

  list.innerHTML = pageCreatures.map((c) => creatureRowTemplate(c)).join("");

  list.querySelectorAll(".gf-creature-row").forEach((row) => {
    row.addEventListener("click", () => {
      selectCreature(Number(row.dataset.creatureId));
    });
  });

  renderCodexPager(codexPage + 1, totalPages);

  if (!pageCreatures.some((c) => c.id === selectedCreatureId)) {
    selectCreature(pageCreatures[0].id);
  } else {
    markActiveRow(selectedCreatureId);
  }
}

function renderCodexPager(currentPage, totalPages) {
  const pager = document.getElementById("codex-pager");
  if (!pager) return;

  if (!totalPages) {
    pager.innerHTML = "";
    return;
  }

  pager.innerHTML = `
    <button class="gf-btn gf-btn--return" type="button" id="codex-prev-page" ${codexPage <= 0 ? "disabled" : ""}>
      ← Previous
    </button>

    <div class="gf-codex-page-count">
      Page ${currentPage} / ${totalPages}
    </div>

    <button class="gf-btn gf-btn--return" type="button" id="codex-next-page" ${codexPage >= totalPages - 1 ? "disabled" : ""}>
      Next →
    </button>
  `;

  document.getElementById("codex-prev-page")?.addEventListener("click", () => {
    codexPage--;
    renderCreatureList();
  });

  document.getElementById("codex-next-page")?.addEventListener("click", () => {
    codexPage++;
    renderCreatureList();
  });
}

function creatureRowTemplate(creature) {
  const state = creature.state || "unknown";
  const killCount = creature.progress?.killCount ?? 0;
  const family = creature.archetype?.name || "Unknown";
  const img = creature.image || "";
  const isUnknown = state === "unknown";

  const thumb = isUnknown
    ? `<div class="gf-creature-thumb locked"><span>?</span></div>`
    : `<div class="gf-creature-thumb"><img src="${escapeHtml(img)}" alt="" onerror="this.src='/images/default_creature.png'"></div>`;

  return `
    <button
      class="gf-row gf-creature-row ${escapeHtml(state)}"
      type="button"
      data-creature-id="${creature.id}"
    >
      ${thumb}

      <div class="gf-creature-row__info">
        <div class="gf-row__top">
          <div class="gf-row__title">${escapeHtml(creature.name)}</div>
          <div class="gf-row__badge">${stateLabel(state)}</div>
        </div>

        <div class="gf-row__sub">
          <span>${escapeHtml(family)}</span>
          <span>${killCount} kills</span>
        </div>
      </div>
    </button>
  `;
}

function selectCreature(creatureId) {
  selectedCreatureId = creatureId;
  markActiveRow(creatureId);

  const creature = codexCreatures.find((c) => Number(c.id) === Number(creatureId));
  if (!creature) {
    renderEmptyDetail();
    return;
  }

  renderCreatureDetail(creature);
}

function markActiveRow(creatureId) {
  document.querySelectorAll(".gf-creature-row").forEach((row) => {
    row.classList.toggle(
      "is-active",
      Number(row.dataset.creatureId) === Number(creatureId)
    );
  });
}

function renderEmptyDetail() {
  const detail = document.getElementById("codex-detail");
  if (!detail) return;

  detail.innerHTML = `
    <div class="gf-detail__empty">
      <div class="gf-detail__sigil">☉</div>
      <div class="gf-detail__msg">Choose a creature from the left page.</div>
    </div>
  `;
}

function renderCreatureDetail(creature) {
  const detail = document.getElementById("codex-detail");
  if (!detail) return;

  const state = creature.state || "unknown";
  const isUnknown = state === "unknown";
  const hasStats = !!creature.stats;
  const image = creature.image || "/images/default_creature.png";
  const family = creature.archetype?.name || "Unknown";
  const kills = creature.progress?.killCount ?? 0;
  const seen = creature.progress?.seenCount ?? 0;

  detail.innerHTML = `
    <article class="gf-card gf-codex-card">
      <div class="gf-card__head">
        <div>
          <div class="gf-title__kicker">${escapeHtml(family)}</div>
          <h2 class="gf-card__title">${escapeHtml(creature.name)}</h2>
        </div>
        <span class="gf-pill">${stateLabel(state)}</span>
      </div>

      <div class="gf-card__body">
        <div class="gf-codex-hero">
          ${
            isUnknown
              ? `<div class="gf-codex-portrait locked"><span>?</span></div>`
              : `
                <div class="gf-codex-portrait ${escapeHtml(state)}">
                  <img src="${escapeHtml(image)}" alt="" onerror="this.src='/images/default_creature.png'">
                </div>
              `
          }

          <div class="gf-codex-facts">
            <div class="gf-inline">
              <span class="gf-inline__label">Level</span>
              <span class="gf-inline__value">${creature.level ?? "Unknown"}</span>
            </div>

            <div class="gf-inline">
              <span class="gf-inline__label">Terrain</span>
              <span class="gf-inline__value">${creature.terrain ? escapeHtml(creature.terrain) : "Unknown"}</span>
            </div>

            <div class="gf-inline">
              <span class="gf-inline__label">Seen</span>
              <span class="gf-inline__value">${seen}</span>
            </div>

            <div class="gf-inline">
              <span class="gf-inline__label">Kills</span>
              <span class="gf-inline__value">${kills}</span>
            </div>
          </div>
        </div>

        <div class="gf-divider"></div>

        <div>
          <div class="gf-section-title">Codex Entry</div>
          <p class="gf-card__desc">${escapeHtml(creature.description)}</p>
        </div>

        <div class="gf-divider"></div>

        <div>
          <div class="gf-section-title">Creature Stats</div>
          ${
            hasStats
              ? renderStats(creature.stats)
              : `<p class="gf-card__desc">Defeat this creature to unlock combat records.</p>`
          }
        </div>

        <div class="gf-divider"></div>

        <div>
          <div class="gf-section-title">Kill Milestones</div>
          ${renderMilestones(creature.milestones || [])}
        </div>

        <div class="gf-divider"></div>

        <div>
            <div class="gf-section-title">Variants Encountered</div>
            ${renderVariants(creature)}
        </div>
      </div>
    </article>
  `;
}

function renderStats(stats) {
  return `
    <div class="gf-codex-facts">
      <div class="gf-inline">
        <span class="gf-inline__label">HP</span>
        <span class="gf-inline__value">${stats.maxhp ?? 0}</span>
      </div>
      <div class="gf-inline">
        <span class="gf-inline__label">Attack</span>
        <span class="gf-inline__value">${stats.attack ?? 0}</span>
      </div>
      <div class="gf-inline">
        <span class="gf-inline__label">Defense</span>
        <span class="gf-inline__value">${stats.defense ?? 0}</span>
      </div>
      <div class="gf-inline">
        <span class="gf-inline__label">Agility</span>
        <span class="gf-inline__value">${stats.agility ?? 0}</span>
      </div>
    </div>
  `;
}

function renderMilestones(milestones) {
  if (!milestones.length) {
    return `<div class="gf-empty">No milestones available.</div>`;
  }

  return milestones.map((m) => {
    const current = Math.min(Number(m.current || 0), Number(m.required || 1));
    const required = Number(m.required || 1);
    const complete = !!m.complete;

    return `
      <div class="gf-milestone ${complete ? "is-complete" : current > 0 ? "is-active" : ""}">
        <div>
          <strong>${escapeHtml(m.label)}</strong>
          <span>${escapeHtml(m.reward || "")}</span>
        </div>
        <span>${current} / ${required}</span>
      </div>
    `;
  }).join("");
}

function renderVariants(creature) {
  const variants = Array.isArray(creature.variants) ? creature.variants : [];

  if (creature.state === "unknown") {
    return `
      <div class="gf-variant-grid">
        <div class="gf-variant unseen">Unknown <span>?</span></div>
      </div>
    `;
  }

  if (!variants.length) {
    return `
      <div class="gf-variant-grid">
        <div class="gf-variant unseen">No variants encountered <span>0</span></div>
      </div>
    `;
  }

  return `
    <div class="gf-variant-grid">
      ${variants.map((v) => {
        const rarity = String(v.rarity || "common").toLowerCase();
        const seen = Number(v.seenCount || 0);
        const killed = Number(v.killCount || 0);

        return `
          <div class="gf-variant seen ${escapeHtml(rarity)}">
            <div>
              <strong>${escapeHtml(v.name)}</strong>
              <small>${escapeHtml(rarity)}</small>
            </div>
            <span>${seen} seen / ${killed} killed</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function stateLabel(state) {
  switch (state) {
    case "unknown": return "Locked";
    case "seen": return "Seen";
    case "killed": return "Killed";
    case "studied": return "Studied";
    case "mastered": return "Mastered";
    default: return "Unknown";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let codexResizeTimer = null;

window.addEventListener("resize", () => {
  clearTimeout(codexResizeTimer);

  codexResizeTimer = setTimeout(() => {
    codexPage = 0;
    renderCreatureList();
  }, 150);
});