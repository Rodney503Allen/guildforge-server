// public/trainer.js

(function initTrainerPage() {
  const list = document.getElementById("spellList");
  const input = document.getElementById("spellSearch");
  const filter = document.getElementById("spellFilter");

  const detailIcon = document.getElementById("detailIcon");
  const detailName = document.getElementById("detailName");
  const detailSchool = document.getElementById("detailSchool");
  const detailMeta = document.getElementById("detailMeta");
  const detailDesc = document.getElementById("detailDesc");
  const detailRows = document.getElementById("detailRows");

  if (!list) return;

  const cards = Array.from(list.querySelectorAll(".spell-card"));

  function selectSpell(card) {
    cards.forEach(c => {
      c.classList.remove("selected");
      c.classList.remove("is-selected");
    });

    card.classList.add("selected");
    card.classList.add("is-selected");

    detailIcon.src = card.dataset.icon || "/icons/default.png";
    detailName.textContent = card.dataset.name || "Unknown Spell";
    detailSchool.textContent = card.dataset.school || "Spell";
    detailDesc.textContent = card.dataset.desc || "No description.";
    detailMeta.textContent = card.dataset.meta || "";
    detailRows.innerHTML = card.dataset.rows || `<div class="empty">No spell stats available.</div>`;
  }

  function applySearch() {
    const q = (input?.value || "").toLowerCase();
    const f = (filter?.value || "all").toLowerCase();

    cards.forEach(card => {
      const name = (card.dataset.name || "").toLowerCase();
      const type = (card.dataset.type || "").toLowerCase();

      const show =
        (!q || name.includes(q)) &&
        (f === "all" || type === f);

      card.hidden = !show;
    });

    const selected = cards.find(c => c.classList.contains("is-selected") && !c.hidden);
    const firstVisible = cards.find(c => !c.hidden);

    if (!selected && firstVisible) {
      selectSpell(firstVisible);
    }
  }

  cards.forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest("a, button")) return;
      selectSpell(card);
    });

    card.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectSpell(card);
      }
    });
  });

  input?.addEventListener("input", applySearch);
  filter?.addEventListener("change", applySearch);

  applySearch();

  const first = cards.find(c => !c.hidden);
  if (first) selectSpell(first);
})();