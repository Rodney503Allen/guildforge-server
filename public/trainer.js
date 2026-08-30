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
  const talentPanels = Array.from(
    document.querySelectorAll("[data-talent-panel]")
  );

  if (!list) return;

  const cards = Array.from(list.querySelectorAll(".spell-card"));

  function inspectTalent(panel, node) {
    if (!panel || !node) return;

    panel.querySelectorAll("[data-talent-node]").forEach(item => {
      item.classList.toggle("is-inspected", item === node);
    });

    const talentId = node.dataset.talentId || "";

    const name = panel.querySelector("[data-talent-detail-name]");
    const description = panel.querySelector("[data-talent-detail-description]");
    const meta = panel.querySelector("[data-talent-detail-meta]");
    const status = panel.querySelector("[data-talent-detail-status]");
    const form = panel.querySelector("[data-talent-apply-form]");
    const applyButton = panel.querySelector("[data-talent-apply-button]");

    const talentState = node.dataset.talentState || "locked";
    const talentCost = Number(node.dataset.talentCost || 1);

    if (name) {
      name.textContent = node.dataset.talentName || "Talent";
    }

    if (description) {
      description.textContent =
        node.dataset.talentDescription || "No description available.";
    }

    if (meta) {
      meta.textContent =
        `Level ${node.dataset.talentLevel || 1} • ` +
        `Spell Rank ${node.dataset.talentRank || 1} • ` +
        `${talentCost} Skill Point${talentCost === 1 ? "" : "s"}`;
    }

    if (status) {
      status.textContent = node.dataset.talentReason || "Locked";
      status.dataset.state = talentState;
    }

    if (form) {
      const canApply = talentState === "available" && Boolean(talentId);
      form.hidden = !canApply;
      form.action = canApply
        ? `/trainer/talents/learn/${talentId}`
        : "";
    }

    if (applyButton) {
      applyButton.textContent =
        `Apply ${talentCost} Skill Point${talentCost === 1 ? "" : "s"}`;
    }
  }

  function initializeTalentPanel(panel) {
    const inspected = panel?.querySelector(
      "[data-talent-node].is-inspected"
    );
    const firstNode = panel?.querySelector("[data-talent-node]");

    if (panel && !inspected && firstNode) {
      inspectTalent(panel, firstNode);
    }
  }

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

    const selectedSpellId = card.dataset.spellId || "";

    talentPanels.forEach(panel => {
      const isSelected =
        panel.dataset.talentPanel === selectedSpellId;

      panel.hidden = !isSelected;

      if (isSelected) {
        initializeTalentPanel(panel);
      }
    });
  }

  talentPanels.forEach(panel => {
    panel.querySelectorAll("[data-talent-node]").forEach(node => {
      node.addEventListener("click", () => {
        inspectTalent(panel, node);
      });
    });
  });

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
