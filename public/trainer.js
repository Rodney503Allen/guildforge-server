// public/trainer.js

(function initTrainerPage() {
  const list = document.getElementById("spellList");
  const input = document.getElementById("spellSearch");
  const filter = document.getElementById("spellFilter");

  const detailIcon = document.getElementById("detailIcon");
  const detailName = document.getElementById("detailName");
  const detailMeta = document.getElementById("detailMeta");
  const detailDesc = document.getElementById("detailDesc");
  const detailStats = document.getElementById("detailStats");
  const detailState = document.getElementById("detailState");

  if (!list) return;

  const cards = Array.from(list.querySelectorAll(".spell-card"));

  function statRow(label, value) {
    if (!value || value === "0") return "";
    return `
      <div class="detailStatRow">
        <span>${label}</span>
        <strong>${value}</strong>
      </div>
    `;
  }

  function selectSpell(card) {
    cards.forEach(c => c.classList.remove("selected"));
    card.classList.add("selected");

    const name = card.dataset.name || "Unknown";
    const type = card.dataset.type || "Spell";
    const state = card.dataset.state || "unknown";
    const icon = card.dataset.icon || "/icons/default.png";
    const desc = card.dataset.desc || "No description.";

    detailIcon.src = icon;
    detailName.textContent = name;
    detailMeta.textContent = `Level ${card.dataset.level || "?"} • ${type}`;
    detailDesc.textContent = desc;

    detailState.textContent = state;
    detailState.className = `badge ${state === "learned" ? "good" : "warn"}`;

    const stats = [
      statRow("SP Cost", card.dataset.scost),
      statRow("Cooldown", card.dataset.cooldown ? card.dataset.cooldown + "s" : ""),
      statRow("Damage", card.dataset.damage),
      statRow("Healing", card.dataset.heal),
      statRow("DoT", card.dataset.dotdamage),
      statRow("Duration", card.dataset.dotduration ? card.dataset.dotduration + "s" : ""),
      card.dataset.buffstat
        ? statRow("Buff", `+${card.dataset.buffvalue} ${card.dataset.buffstat}`)
        : ""
    ].join("");

    detailStats.innerHTML = stats || `<div class="empty">No stats</div>`;
  }

  function applySearch() {
    const q = (input?.value || "").toLowerCase();
    const f = (filter?.value || "all").toLowerCase();

    cards.forEach(el => {
      const name = (el.dataset.name || "").toLowerCase();
      const state = (el.dataset.state || "").toLowerCase();

      const show =
        (!q || name.includes(q)) &&
        (f === "all" || state === f);

      el.style.display = show ? "" : "none";
    });
  }

  cards.forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest("button")) return;
      selectSpell(card);
    });
  });

  input?.addEventListener("input", applySearch);
  filter?.addEventListener("change", applySearch);

  applySearch();

  const first = cards.find(c => c.style.display !== "none");
  if (first) selectSpell(first);
})();