// public/trainer.js

(function initTrainerSearch() {
  const list = document.getElementById("spellList");
  const input = document.getElementById("spellSearch");
  const filter = document.getElementById("spellFilter");
  if (!list || !input || !filter) return;

  const cards = Array.from(list.querySelectorAll(".spell-card"));

  function apply() {
    const q = (input.value || "").trim().toLowerCase();
    const f = (filter.value || "all").toLowerCase();

    for (const el of cards) {
      const name = (el.getAttribute("data-nameplain") || el.getAttribute("data-name") || "").toLowerCase();
      const state = (el.getAttribute("data-state") || "").toLowerCase();

      const matchName = !q || name.includes(q);
      const matchFilter = (f === "all") || (state === f);

      el.style.display = (matchName && matchFilter) ? "" : "none";
    }
  }

  input.addEventListener("input", apply);
  filter.addEventListener("change", apply);

  apply();
})();
