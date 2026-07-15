//character.js
async function addStat(stat) {
  const res = await fetch("/character/stat", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ stat })
  });
  const data = await res.json();
  if (data.error) return showErrorToast(data.error);

  const el = document.getElementById(stat);
  if (el) el.childNodes[0].nodeValue = data.value; // keep tooltip intact
  document.getElementById("statPoints").innerText = data.stat_points;

  if (data.stat_points <= 0) {
    document.querySelectorAll(".stat-row button").forEach(b => b.remove());
  }
}

function goBack() {
  history.length > 1 ? history.back() : location.href="/town";
}

const TOAST_VISIBLE_MS = 2200;

function showErrorToast(message, title = "Action Failed") {
  window.GFToast.show(title, message, {
    type: "error",
    durationMs: TOAST_VISIBLE_MS
  });
}

let draggedId = null;

document.addEventListener("dragstart", e => {
  const el = e.target.closest("[data-id]");
  if (el) draggedId = el.dataset.id;
});

async function equipItem(id) {
  const res = await fetch("/character/equip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId: id })
  });

  const data = await res.json();
  if (data.error) return showErrorToast(data.error);

  location.reload();
}

async function unequipItem(id) {
  const res = await fetch("/character/unequip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId: id })
  });

  const data = await res.json();
  if (data.error) return showErrorToast(data.error);

  location.reload();
}
async function equipPotion(inventoryId, slot) {
  const res = await fetch("/character/equip-potion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId, slot })
  });

  const data = await res.json();
  if (data.error) return showErrorToast(data.error);

  location.reload();
}

async function unequipPotion(slot) {
  const res = await fetch("/character/unequip-potion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot })
  });

  const data = await res.json();

if (data.error) {
  showErrorToast(data.error, "Inventory Full");
  return;
}

  location.reload();
}

async function equipTool(inventoryId, slot) {
  const res = await fetch("/character/equip-tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId, slot })
  });

  const data = await res.json();
  if (data.error) return showErrorToast(data.error);

  location.reload();
}

async function unequipTool(slot) {
  const res = await fetch("/character/unequip-tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot })
  });

  const data = await res.json();
  if (data.error) return showErrorToast(data.error);

  location.reload();
}

function dropTool(e, expectedToolSlot) {
  e.preventDefault();
  if (!draggedId) return;

  const el = document.querySelector(`[data-id="${draggedId}"]`);
  const itemType = String(el?.dataset.itemType || "").toLowerCase();

  const expectedType =
    expectedToolSlot === "mining" ? "mining_tool" :
    expectedToolSlot === "herbalism" ? "herbalism_tool" :
    expectedToolSlot === "woodcutting" ? "woodcutting_tool" :
    "";

  if (itemType !== expectedType) {
    showErrorToast("That tool does not belong in this slot.");
    return;
  }

  equipTool(draggedId, expectedToolSlot);
}

function dropEquip(e, expectedSlot) {
  e.preventDefault();
  if (!draggedId) return;

  fetch("/api/inventory/slot-check/" + draggedId)
    .then(res => res.json())
    .then(data => {
      if (data.error) {
        showErrorToast(data.error);
        return;
      }

      const actualSlot = String(data.slot || "").toLowerCase();
      const targetSlot = String(expectedSlot || "").toLowerCase();

      if (actualSlot !== targetSlot) {
        showErrorToast("That item does not belong in this slot.");
        return;
      }

      equipItem(draggedId);
    });
}

function dropUnequip() {
  if (draggedId) unequipItem(draggedId);
}


  const searchEl = document.getElementById("invSearch");
  if (searchEl) {
    searchEl.addEventListener("input", () => {
      const q = searchEl.value.trim().toLowerCase();
      document.querySelectorAll(".inv-item").forEach(el => {
        const name = (el.getAttribute("data-search") || "");
        el.style.display = (!q || name.includes(q)) ? "" : "none";
      });
    });
  }

  // =========================
// COMBAT SKILL LOADOUT
// =========================

let learnedCombatSkills = [];
let equippedSkillSlots = [];
let selectedSkillId = null;
let draggedSkillId = null;
let draggedSkillSlot = null;
let skillLoadoutBusy = false;

function resolveSkillIcon(icon) {
  const raw = String(icon || "").trim();

  if (!raw || raw === "default.png") {
    return "/icons/spells/default.png";
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (raw.startsWith("/icons/spells/")) {
    return raw;
  }

  if (raw.startsWith("/images/spells/")) {
    return raw;
  }

  /*
   * Database path:
   * /knight/shield_bash.webp
   *
   * Public file path:
   * /icons/spells/knight/shield_bash.webp
   */
  return `/icons/spells/${raw.replace(/^\/+/, "")}`;
}

function getSkillDisciplineName(skill) {
  return String(
    skill.disciplineName ||
    skill.discipline_name ||
    skill.discipline ||
    `Discipline ${skill.disciplineId || skill.discipline_id || ""}`
  ).trim();
}

function escapeSkillHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readJsonResponse(response) {
  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    console.error("Non-JSON server response:", {
      url: response.url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: rawText
    });

    throw new Error(
      `Invalid server response from ${response.url} (${response.status})`
    );
  }

  if (!response.ok || data?.error) {
    const message =
      data?.message ||
      data?.error ||
      "The requested action failed.";

    throw new Error(message);
  }

  return data;
}

async function loadSkillSelectionUI() {
  const learnedGrid = document.getElementById(
    "disciplineSkillLibrary"
  );
  const hotbar = document.getElementById("skillHotbar");

  if (!learnedGrid || !hotbar) {
    return;
  }

  try {
    const [learnedResponse, equippedResponse] = await Promise.all([
      fetch("/spells/learned"),
      fetch("/spells/equipped")
    ]);

    const learnedData = await readJsonResponse(learnedResponse);
    const equippedData = await readJsonResponse(equippedResponse);

    learnedCombatSkills = Array.isArray(learnedData.spells)
      ? learnedData.spells
      : [];

    equippedSkillSlots = normalizeEquippedSlots(
      equippedData.slots
    );

    renderSkillSelectionUI();
  } catch (err) {
    console.error("Failed to load skill selection:", err);

    learnedGrid.innerHTML = `
      <div class="skills-empty">
        Could not load your combat skills.
      </div>
    `;

    renderSkillHotbar();

    showErrorToast(
      err?.message || "Could not load combat skills."
    );
  }
}

function normalizeEquippedSlots(slots) {
  const supplied = Array.isArray(slots) ? slots : [];
  const bySlot = new Map();

  supplied.forEach(entry => {
    const slot = Number(entry?.slot);

    if (Number.isInteger(slot) && slot >= 1 && slot <= 6) {
      bySlot.set(slot, {
        slot,
        spell: entry?.spell || null
      });
    }
  });

  return Array.from({ length: 6 }, (_, index) => {
    const slot = index + 1;

    return bySlot.get(slot) || {
      slot,
      spell: null
    };
  });
}

function getEquippedSkillIds() {
  return new Set(
    equippedSkillSlots
      .filter(entry => entry?.spell)
      .map(entry => Number(entry.spell.id))
  );
}

function renderSkillSelectionUI() {
  renderLearnedSkills();
  renderSkillHotbar();
  updateEquippedSkillCount();
}

function renderLearnedSkills() {
  const library = document.getElementById(
    "disciplineSkillLibrary"
  );

  if (!library) {
    return;
  }

  if (!learnedCombatSkills.length) {
    library.innerHTML = `
      <div class="skills-empty">
        You have not learned any combat skills yet.
      </div>
    `;

    return;
  }

  const equippedIds = getEquippedSkillIds();
  const disciplineGroups = new Map();

  learnedCombatSkills.forEach(skill => {
    const disciplineName =
      getSkillDisciplineName(skill);

    if (!disciplineGroups.has(disciplineName)) {
      disciplineGroups.set(
        disciplineName,
        []
      );
    }

    disciplineGroups
      .get(disciplineName)
      .push(skill);
  });

  const disciplines =
    Array.from(disciplineGroups.entries());

  library.innerHTML = `
    <div
      class="discipline-tabs"
      role="tablist"
      aria-label="Skill disciplines"
    >
      ${disciplines
        .map(([disciplineName], index) => `
          <button
            type="button"
            class="discipline-tab ${
              index === 0 ? "active" : ""
            }"
            data-discipline-tab="${index}"
            role="tab"
            aria-selected="${
              index === 0 ? "true" : "false"
            }"
          >
            ${escapeSkillHtml(disciplineName)}
          </button>
        `)
        .join("")}
    </div>

    <div class="discipline-panels">
      ${disciplines
        .map(
          (
            [disciplineName, skills],
            index
          ) => `
            <section
              class="discipline-panel ${
                index === 0 ? "active" : ""
              }"
              data-discipline-panel="${index}"
              role="tabpanel"
            >
              <div class="discipline-panel-title">
                ${escapeSkillHtml(disciplineName)}
              </div>

              <div class="learned-skills-grid">
                ${skills
                  .map(skill =>
                    renderLearnedSkillCard(
                      skill,
                      equippedIds
                    )
                  )
                  .join("")}
              </div>
            </section>
          `
        )
        .join("")}
    </div>
  `;

  bindDisciplineTabs();
  bindLearnedSkillCards();
}

function bindDisciplineTabs() {
  const tabs = document.querySelectorAll(
    ".discipline-tab"
  );

  const panels = document.querySelectorAll(
    ".discipline-panel"
  );

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const index = String(
        tab.dataset.disciplineTab
      );

      tabs.forEach(otherTab => {
        const isActive =
          otherTab === tab;

        otherTab.classList.toggle(
          "active",
          isActive
        );

        otherTab.setAttribute(
          "aria-selected",
          isActive ? "true" : "false"
        );
      });

      panels.forEach(panel => {
        panel.classList.toggle(
          "active",
          String(
            panel.dataset.disciplinePanel
          ) === index
        );
      });
    });
  });
}

function renderLearnedSkillCard(
  skill,
  equippedIds
) {
  const skillId =
    Number(skill.id);

  const isSelected =
    selectedSkillId === skillId;

  const isEquipped =
    equippedIds.has(skillId);

  const icon =
    resolveSkillIcon(skill.icon);

  return `
    <div
      class="
        learned-skill-card
        tooltip-parent
        ${isSelected ? "selected" : ""}
        ${isEquipped ? "equipped" : ""}
      "
      data-skill-id="${skillId}"
      data-tooltip="item"
      data-rarity="skill"
      data-name="${escapeSkillHtml(
        skill.name
      )}"
      data-desc="${escapeSkillHtml(
        skill.description || ""
      )}"
      draggable="true"
      tabindex="0"
      role="button"
      aria-label="${escapeSkillHtml(
        skill.name
      )}"
    >
      <div class="learned-skill-icon-wrap">
        <img
          class="learned-skill-icon"
          src="${escapeSkillHtml(icon)}"
          alt="${escapeSkillHtml(skill.name)}"
          loading="lazy"
          onerror="
            this.onerror = null;
            this.src = '/icons/spells/default.png';
          "
        >

        ${
          isEquipped
            ? `
              <span class="skill-equipped-indicator">
                ✓
              </span>
            `
            : ""
        }
      </div>

      <div class="learned-skill-name">
        ${escapeSkillHtml(skill.name)}
      </div>
    </div>
  `;
}

function bindLearnedSkillCards() {
  document
    .querySelectorAll(".learned-skill-card")
    .forEach(card => {
      const selectCard = () => {
        const skillId =
          Number(card.dataset.skillId);

        selectedSkillId =
          selectedSkillId === skillId
            ? null
            : skillId;

        renderSkillSelectionUI();
      };

      card.addEventListener(
        "click",
        selectCard
      );

      card.addEventListener(
        "keydown",
        event => {
          if (
            event.key === "Enter" ||
            event.key === " "
          ) {
            event.preventDefault();
            selectCard();
          }
        }
      );

      card.addEventListener(
        "dragstart",
        event => {
          draggedSkillId =
            Number(card.dataset.skillId);

          draggedSkillSlot = null;

          event.dataTransfer.effectAllowed =
            "move";

          event.dataTransfer.setData(
            "text/plain",
            `skill:${draggedSkillId}`
          );
        }
      );

      card.addEventListener(
        "dragend",
        clearSkillDragState
      );
    });
}

function renderSkillHotbar() {
  const hotbar = document.getElementById("skillHotbar");

  if (!hotbar) {
    return;
  }

  equippedSkillSlots = normalizeEquippedSlots(
    equippedSkillSlots
  );

  hotbar.innerHTML = equippedSkillSlots
    .map(entry => {
      const slot = Number(entry.slot);
      const spell = entry.spell;
      const icon = spell
        ? resolveSkillIcon(spell.icon)
        : "";

      return `
        <div
          class="skill-hotbar-slot
            ${selectedSkillId ? "has-selection" : ""}"
          data-skill-slot="${slot}"
          draggable="${spell ? "true" : "false"}"
          title="${
            spell
              ? escapeSkillHtml(
                  `${spell.name} — double-click to unequip`
                )
              : `Empty hotbar slot ${slot}`
          }"
        >
          <span class="skill-slot-number">${slot}</span>

          ${
            spell
              ? `
                  <div
                    class="skill-slot-content tooltip-parent"
                    data-tooltip="item"
                    data-rarity="skill"
                    data-name="${escapeSkillHtml(spell.name)}"
                    data-desc="${escapeSkillHtml(
                      spell.description || ""
                    )}"
                  >
                    ${
                      icon
                        ? `
                          <img
                            class="skill-slot-icon"
                            src="${escapeSkillHtml(icon)}"
                            alt="${escapeSkillHtml(spell.name)}"
                            onerror="
                              this.onerror = null;
                              this.src = '/icons/spells/default.png';
                            "
                          >
                        `
                        : `<span>✨</span>`
                    }

                    <span class="skill-slot-name">
                      ${escapeSkillHtml(spell.name)}
                    </span>
                  </div>
                `
              : `
                  <span class="skill-slot-empty">
                    Empty
                  </span>
                `
          }
        </div>
      `;
    })
    .join("");

  hotbar
    .querySelectorAll(".skill-hotbar-slot")
    .forEach(slotElement => {
      const targetSlot = Number(
        slotElement.dataset.skillSlot
      );

      slotElement.addEventListener("click", async () => {
        if (
          skillLoadoutBusy ||
          !selectedSkillId
        ) {
          return;
        }

        await equipSelectedSkill(
          selectedSkillId,
          targetSlot
        );
      });

      slotElement.addEventListener(
        "dblclick",
        async event => {
          event.preventDefault();

          const currentEntry =
            equippedSkillSlots.find(
              entry => Number(entry.slot) === targetSlot
            );

          if (!currentEntry?.spell) {
            return;
          }

          await unequipSkillSlot(targetSlot);
        }
      );

      slotElement.addEventListener(
        "dragstart",
        event => {
          const currentEntry =
            equippedSkillSlots.find(
              entry => Number(entry.slot) === targetSlot
            );

          if (!currentEntry?.spell) {
            event.preventDefault();
            return;
          }

          draggedSkillId = Number(
            currentEntry.spell.id
          );

          draggedSkillSlot = targetSlot;

          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            "text/plain",
            `slot:${targetSlot}`
          );
        }
      );

      slotElement.addEventListener(
        "dragover",
        event => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";

          slotElement.classList.add(
            "drop-target"
          );
        }
      );

      slotElement.addEventListener(
        "dragleave",
        () => {
          slotElement.classList.remove(
            "drop-target"
          );
        }
      );

      slotElement.addEventListener(
        "drop",
        async event => {
          event.preventDefault();

          slotElement.classList.remove(
            "drop-target"
          );

          if (skillLoadoutBusy) {
            clearSkillDragState();
            return;
          }

          if (
            draggedSkillSlot &&
            draggedSkillSlot !== targetSlot
          ) {
            await swapSkillSlots(
              draggedSkillSlot,
              targetSlot
            );

            clearSkillDragState();
            return;
          }

          if (draggedSkillId) {
            await equipSelectedSkill(
              draggedSkillId,
              targetSlot
            );
          }

          clearSkillDragState();
        }
      );

      slotElement.addEventListener(
        "dragend",
        clearSkillDragState
      );
    });
}

function updateEquippedSkillCount() {
  const countElement = document.getElementById(
    "equippedSkillCount"
  );

  if (!countElement) {
    return;
  }

  const count = equippedSkillSlots.filter(
    entry => Boolean(entry?.spell)
  ).length;

  countElement.textContent = String(count);
}

async function equipSelectedSkill(spellId, slot) {
  if (skillLoadoutBusy) {
    return;
  }

  skillLoadoutBusy = true;

  try {
    const response = await fetch("/spells/equip", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        spellId,
        slot
      })
    });

    const data = await readJsonResponse(response);

    equippedSkillSlots = normalizeEquippedSlots(
      data.slots
    );

    selectedSkillId = null;
    renderSkillSelectionUI();
  } catch (err) {
    console.error("Failed to equip skill:", err);

    showErrorToast(
      err?.message || "Could not equip that skill."
    );
  } finally {
    skillLoadoutBusy = false;
  }
}

async function unequipSkillSlot(slot) {
  if (skillLoadoutBusy) {
    return;
  }

  skillLoadoutBusy = true;

  try {
    const response = await fetch("/spells/unequip", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        slot
      })
    });

    const data = await readJsonResponse(response);

    equippedSkillSlots = normalizeEquippedSlots(
      data.slots
    );

    renderSkillSelectionUI();
  } catch (err) {
    console.error("Failed to unequip skill:", err);

    showErrorToast(
      err?.message || "Could not unequip that skill."
    );
  } finally {
    skillLoadoutBusy = false;
  }
}

async function swapSkillSlots(fromSlot, toSlot) {
  if (
    skillLoadoutBusy ||
    fromSlot === toSlot
  ) {
    return;
  }

  skillLoadoutBusy = true;

  try {
    const response = await fetch("/spells/swap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fromSlot,
        toSlot
      })
    });

    const data = await readJsonResponse(response);

    equippedSkillSlots = normalizeEquippedSlots(
      data.slots
    );

    renderSkillSelectionUI();
  } catch (err) {
    console.error("Failed to swap skills:", err);

    showErrorToast(
      err?.message || "Could not reorder those skills."
    );
  } finally {
    skillLoadoutBusy = false;
  }
}

function clearSkillDragState() {
  draggedSkillId = null;
  draggedSkillSlot = null;

  document
    .querySelectorAll(".skill-hotbar-slot")
    .forEach(element => {
      element.classList.remove("drop-target");
    });
}

document.addEventListener(
  "DOMContentLoaded",
  loadSkillSelectionUI
);
