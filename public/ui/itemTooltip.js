// Guildforge Item Tooltip - shared
// public/ui/itemTooltip.js
(function () {
  const SEL = '[data-tooltip="item"]';

  const tooltip = document.createElement("div");
  tooltip.className = "gf-tooltip";
  document.body.appendChild(tooltip);

  let activeEl = null;
  let hideTimer = null;

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function rarityClass(rarity) {
    const normalized = String(rarity || "")
      .toLowerCase()
      .trim();

    if (!normalized) return "gf-dormant";
    return `gf-${normalized}`;
  }

  function safeParseJson(value) {
    if (value == null || value === "") return null;
    if (typeof value === "object") return value;

    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  }

  function formatLabel(value) {
    return String(value || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, character =>
        character.toUpperCase()
      );
  }

  function optionalNumber(value) {
    if (value == null || value === "") return null;

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function addStatLine(lines, label, value, suffix = "") {
    if (
      value == null ||
      !Number.isFinite(value) ||
      value === 0
    ) {
      return;
    }

    lines.push(
      `<div>${esc(label)}: +${esc(value)}${esc(suffix)}</div>`
    );
  }

  function buildAutoStatsHtml(dataset) {
    const sections = [];

    const itemLevel = optionalNumber(dataset.itemLevel);
    const slot = dataset.slot || "";
    const itemType = dataset.itemType || "";
    const armorWeight = dataset.armorWeight || "";

    const baseAttack = optionalNumber(dataset.baseAttack);
    const baseDefense = optionalNumber(dataset.baseDefense);
    const agility = optionalNumber(dataset.agility);
    const vitality = optionalNumber(dataset.vitality);
    const intellect = optionalNumber(dataset.intellect);
    const crit = optionalNumber(dataset.crit);

    const rollJson = safeParseJson(dataset.rollJson);

    const metaParts = [];

    if (slot) {
      metaParts.push(formatLabel(slot));
    }

    if (itemLevel != null) {
      metaParts.push(`Lv. ${itemLevel}`);
    }

    if (metaParts.length) {
      sections.push(
        `<div class="t-meta">${
          metaParts.map(esc).join(" | ")
        }</div>`
      );
    }

    if (armorWeight || itemType) {
      const typeParts = [];

      if (armorWeight) {
        typeParts.push(formatLabel(armorWeight));
      }

      if (itemType) {
        typeParts.push(formatLabel(itemType));
      }

      sections.push(
        `<div class="t-type">${
          typeParts.map(esc).join(" ")
        }</div>`
      );
    }

    const baseLines = [];

    addStatLine(baseLines, "Attack", baseAttack);
    addStatLine(baseLines, "Defense", baseDefense);
    addStatLine(baseLines, "Agility", agility);
    addStatLine(baseLines, "Vitality", vitality);
    addStatLine(baseLines, "Intellect", intellect);
    addStatLine(baseLines, "Crit", crit, "%");

    if (baseLines.length) {
      sections.push(
        `<div class="t-base">${baseLines.join("")}</div>`
      );
    }

    const bonusLines = [];

    if (Array.isArray(rollJson)) {
      for (const affix of rollJson) {
        if (!affix) continue;

        const label =
          affix.label ||
          formatLabel(affix.stat || "Stat");

        const value = Number(affix.value || 0);
        const isPercent = Boolean(affix.isPercent);
        const resonant = Boolean(affix.resonant);

        if (!Number.isFinite(value) || value === 0) {
          continue;
        }

        const valueText =
          `+${value}${isPercent ? "%" : ""}`;

        const resonanceTag = resonant
          ? ` <span class="t-resonant-tag">(Resonant)</span>`
          : "";

        bonusLines.push(`
          <div class="t-affix${
            resonant ? " t-affix-resonant" : ""
          }">
            ${esc(label)}: ${esc(valueText)}${resonanceTag}
          </div>
        `);
      }
    }

    if (bonusLines.length) {
      sections.push('<div class="t-divider"></div>');
      sections.push(
        `<div class="t-bonus">${bonusLines.join("")}</div>`
      );
    }

    return sections.join("");
  }

  function build(element) {
    const dataset = element.dataset;

    const name = dataset.name || "Unknown Item";
    const rarity = dataset.rarity || "dormant";
    const value = optionalNumber(dataset.value);
    const rate = optionalNumber(dataset.rate);
    const sell = optionalNumber(dataset.sell);
    const price = optionalNumber(dataset.price);
    const quantity = optionalNumber(dataset.qty);
    const durability = optionalNumber(dataset.durability);

    const unique =
      dataset.unique === "true" ||
      dataset.unique === "1";

    const description = dataset.desc || "";
    const statsHtml = buildAutoStatsHtml(dataset);

    const subParts = [];

    if (value != null) {
      subParts.push(`Value: ${value}g`);
    }

    if (rate != null) {
      subParts.push(`Rate: ${rate}%`);
    }

    const rows = [];

    if (sell != null) {
      rows.push(`
        <div class="t-row">
          <span class="t-k">Sell</span>
          <span class="t-v">${sell}g</span>
        </div>
      `);
    }

    if (price != null) {
      rows.push(`
        <div class="t-row">
          <span class="t-k">Cost</span>
          <span class="t-v">${price}g</span>
        </div>
      `);
    }

    if (quantity != null && quantity > 1) {
      rows.push(`
        <div class="t-row">
          <span class="t-k">Stack</span>
          <span class="t-v">${quantity}</span>
        </div>
      `);
    }

    if (durability != null) {
      rows.push(`
        <div class="t-row">
          <span class="t-k">Durability</span>
          <span class="t-v">${durability}</span>
        </div>
      `);
    }

    if (unique) {
      rows.push(`
        <div class="t-row">
          <span class="t-k">Type</span>
          <span class="t-v">Unique</span>
        </div>
      `);
    }

    tooltip.innerHTML = `
      <div class="t-name ${rarityClass(rarity)}">
        ${esc(name)}
      </div>

      ${
        subParts.length
          ? `<div class="t-sub">${
              esc(subParts.join(" • "))
            }</div>`
          : ""
      }

      ${rows.join("")}

      ${
        statsHtml
          ? `<div class="t-stats">${statsHtml}</div>`
          : ""
      }

      ${
        description
          ? `<div class="t-desc">${esc(description)}</div>`
          : ""
      }
    `;
  }

  function positionNearElement(element) {
    const padding = 12;
    const gap = 10;
    const elementRect = element.getBoundingClientRect();

    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    tooltip.classList.add("show");

    const tooltipRect = tooltip.getBoundingClientRect();

    let x =
      elementRect.left +
      elementRect.width / 2 -
      tooltipRect.width / 2;

    let y = elementRect.bottom + gap;

    if (
      y + tooltipRect.height + padding >
      window.innerHeight
    ) {
      y =
        elementRect.top -
        tooltipRect.height -
        gap;
    }

    x = Math.max(
      padding,
      Math.min(
        window.innerWidth -
          tooltipRect.width -
          padding,
        x
      )
    );

    y = Math.max(
      padding,
      Math.min(
        window.innerHeight -
          tooltipRect.height -
          padding,
        y
      )
    );

    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function show(element) {
    if (!element) return;

    clearTimeout(hideTimer);
    activeEl = element;

    build(element);
    positionNearElement(element);
  }

  function hideSoon() {
    clearTimeout(hideTimer);

    hideTimer = setTimeout(() => {
      tooltip.classList.remove("show");
      activeEl = null;
    }, 40);
  }

  document.addEventListener("mouseover", event => {
    const element = event.target.closest(SEL);
    if (!element) return;

    show(element);
  });

  document.addEventListener("mouseout", event => {
    const leaving = event.target.closest(SEL);
    if (!leaving) return;

    const destination =
      event.relatedTarget?.closest?.(SEL);

    if (destination) return;
    hideSoon();
  });

  document.addEventListener("click", event => {
    const element = event.target.closest(SEL);

    if (element) {
      if (activeEl === element) {
        tooltip.classList.remove("show");
        activeEl = null;
        return;
      }

      show(element);
      return;
    }

    if (activeEl) {
      tooltip.classList.remove("show");
      activeEl = null;
    }
  });
})();