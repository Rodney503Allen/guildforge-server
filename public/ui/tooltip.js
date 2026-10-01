// Guildforge Global Tooltip System
// public/ui/tooltip.js
(function () {
  const SEL = "[data-tooltip]";

  const tooltip = document.createElement("div");
  tooltip.className = "gf-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
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

  function optionalNumber(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
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
      .replace(/\b\w/g, character => character.toUpperCase());
  }

  function rarityClass(rarity) {
    const normalized = String(rarity || "").toLowerCase().trim();
    if (!normalized) return "gf-dormant";
    return `gf-${normalized}`;
  }

  function row(label, value, valueClass = "") {
    if (value == null || value === "") return "";
    return `
      <div class="t-row">
        <span class="t-k">${esc(label)}</span>
        <span class="t-v ${esc(valueClass)}">${esc(value)}</span>
      </div>
    `;
  }

  function description(text) {
    return text ? `<div class="t-desc">${esc(text)}</div>` : "";
  }

  function addStatLine(lines, label, value, suffix = "") {
    if (value == null || !Number.isFinite(value) || value === 0) return;
    lines.push(`<div>${esc(label)}: +${esc(value)}${esc(suffix)}</div>`);
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
    if (slot) metaParts.push(formatLabel(slot));
    if (itemLevel != null) metaParts.push(`Lv. ${itemLevel}`);

    if (metaParts.length) {
      sections.push(`<div class="t-meta">${metaParts.map(esc).join(" | ")}</div>`);
    }

    if (armorWeight || itemType) {
      const typeParts = [];
      if (armorWeight) typeParts.push(formatLabel(armorWeight));
      if (itemType) typeParts.push(formatLabel(itemType));
      sections.push(`<div class="t-type">${typeParts.map(esc).join(" ")}</div>`);
    }

    const baseLines = [];
    addStatLine(baseLines, "Attack", baseAttack);
    addStatLine(baseLines, "Defense", baseDefense);
    addStatLine(baseLines, "Agility", agility);
    addStatLine(baseLines, "Vitality", vitality);
    addStatLine(baseLines, "Intellect", intellect);
    addStatLine(baseLines, "Crit", crit, "%");

    if (baseLines.length) {
      sections.push(`<div class="t-base">${baseLines.join("")}</div>`);
    }

    const bonusLines = [];
    if (Array.isArray(rollJson)) {
      for (const affix of rollJson) {
        if (!affix) continue;

        const label = affix.label || formatLabel(affix.stat || "Stat");
        const value = Number(affix.value || 0);
        const isPercent = Boolean(affix.isPercent);
        const resonant = Boolean(affix.resonant);

        if (!Number.isFinite(value) || value === 0) continue;

        const valueText = `+${value}${isPercent ? "%" : ""}`;
        const resonanceTag = resonant
          ? ` <span class="t-resonant-tag">(Resonant)</span>`
          : "";

        bonusLines.push(`
          <div class="t-affix${resonant ? " t-affix-resonant" : ""}">
            ${esc(label)}: ${esc(valueText)}${resonanceTag}
          </div>
        `);
      }
    }

    if (bonusLines.length) {
      sections.push('<div class="t-divider"></div>');
      sections.push(`<div class="t-bonus">${bonusLines.join("")}</div>`);
    }

    return sections.join("");
  }

  function buildItem(element) {
    const d = element.dataset;
    const name = d.name || "Unknown Item";
    const rarity = d.rarity || "dormant";
    const value = optionalNumber(d.value);
    const rate = optionalNumber(d.rate);
    const sell = optionalNumber(d.sell);
    const price = optionalNumber(d.price);
    const quantity = optionalNumber(d.qty);
    const durability = optionalNumber(d.durability);
    const unique = d.unique === "true" || d.unique === "1";
    const statsHtml = buildAutoStatsHtml(d);

    const subParts = [];
    if (value != null) subParts.push(`Value: ${value}g`);
    if (rate != null) subParts.push(`Rate: ${rate}%`);

    tooltip.innerHTML = `
      <div class="t-name ${rarityClass(rarity)}">${esc(name)}</div>
      ${subParts.length ? `<div class="t-sub">${esc(subParts.join(" • "))}</div>` : ""}
      ${sell != null ? row("Sell", `${sell}g`) : ""}
      ${price != null ? row("Cost", `${price}g`) : ""}
      ${quantity != null && quantity > 1 ? row("Stack", quantity) : ""}
      ${durability != null ? row("Durability", durability) : ""}
      ${unique ? row("Type", "Unique") : ""}
      ${statsHtml ? `<div class="t-stats">${statsHtml}</div>` : ""}
      ${description(d.desc || "")}
    `;
  }

  function buildSpell(element) {
    const d = element.dataset;
    const name = d.name || "Unknown Skill";
    const discipline = d.discipline || "";
    const spellType = formatLabel(d.spellType || "");
    const level = optionalNumber(d.level);
    const manaCost = optionalNumber(d.manaCost);
    const cooldown = optionalNumber(d.cooldown);
    const damage = optionalNumber(d.damage);
    const heal = optionalNumber(d.heal);
    const dotDamage = optionalNumber(d.dotDamage);
    const dotDuration = optionalNumber(d.dotDuration);
    const dotTickRate = optionalNumber(d.dotTickRate);
    const buffStat = d.buffStat || "";
    const buffValue = optionalNumber(d.buffValue);
    const buffDuration = optionalNumber(d.buffDuration);
    const debuffStat = d.debuffStat || "";
    const debuffValue = optionalNumber(d.debuffValue);
    const debuffDuration = optionalNumber(d.debuffDuration);

    const meta = [discipline, spellType, level != null ? `Level ${level}` : ""]
      .filter(Boolean)
      .join(" • ");

    const mechanics = [];
    if (damage != null && damage !== 0) mechanics.push(row("Damage", damage, "t-damage"));
    if (heal != null && heal !== 0) mechanics.push(row("Healing", heal, "t-heal"));
    if (dotDamage != null && dotDamage !== 0) mechanics.push(row("DoT Damage", dotDamage, "t-damage"));
    if (dotDuration != null && dotDuration > 0) mechanics.push(row("DoT Duration", `${dotDuration} sec`));
    if (dotTickRate != null && dotTickRate > 0) mechanics.push(row("Tick Rate", `${dotTickRate} sec`));

    if (buffStat && buffValue != null && buffValue !== 0) {
      mechanics.push(row(formatLabel(buffStat), `+${buffValue}`, "t-positive"));
    }
    if (buffDuration != null && buffDuration > 0) {
      mechanics.push(row("Buff Duration", `${buffDuration} sec`));
    }

    if (debuffStat && debuffValue != null && debuffValue !== 0) {
      mechanics.push(row(formatLabel(debuffStat), `${debuffValue}`, "t-negative"));
    }
    if (debuffDuration != null && debuffDuration > 0) {
      mechanics.push(row("Debuff Duration", `${debuffDuration} sec`));
    }

    const costs = [];
    if (manaCost != null && manaCost > 0) costs.push(row("Mana", manaCost, "t-mana"));
    if (cooldown != null) costs.push(row("Cooldown", cooldown > 0 ? `${cooldown} sec` : "None"));

    tooltip.innerHTML = `
      <div class="t-name gf-skill">${esc(name)}</div>
      ${meta ? `<div class="t-sub">${esc(meta)}</div>` : ""}
      ${description(d.desc || "")}
      ${mechanics.length ? `<div class="t-section">${mechanics.join("")}</div>` : ""}
      ${costs.length ? `<div class="t-section t-cost-section">${costs.join("")}</div>` : ""}
    `;
  }

  function buildStat(element) {
    const d = element.dataset;
    const name = d.name || "Stat";
    const base = optionalNumber(d.base);
    const gear = optionalNumber(d.gear);
    const buffs = optionalNumber(d.buffs);
    const total = optionalNumber(d.total);

    tooltip.innerHTML = `
      <div class="t-name gf-system">${esc(name)}</div>
      ${description(d.desc || "")}
      ${base != null ? row("Base", base) : ""}
      ${gear != null ? row("Gear", gear >= 0 ? `+${gear}` : gear) : ""}
      ${buffs != null ? row("Buffs", buffs >= 0 ? `+${buffs}` : buffs) : ""}
      ${total != null ? `<div class="t-divider"></div>${row("Total", total, "t-total")}` : ""}
    `;
  }

  function buildSimple(element, fallbackType) {
    const d = element.dataset;
    const name = d.name || fallbackType;
    const sub = d.sub || "";
    const slot = d.slot || "";

    tooltip.innerHTML = `
      <div class="t-name gf-system">${esc(name)}</div>
      ${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}
      ${slot ? row("Slot", formatLabel(slot)) : ""}
      ${description(d.desc || "")}
    `;
  }

  function build(element) {
    tooltip.className = `gf-tooltip gf-tooltip-${String(element.dataset.tooltip || "item").toLowerCase()}`;

    switch (String(element.dataset.tooltip || "item").toLowerCase()) {
      case "spell":
        buildSpell(element);
        break;
      case "stat":
        buildStat(element);
        break;
      case "potion":
        buildSimple(element, "Potion");
        break;
      case "tool":
        buildSimple(element, "Tool");
        break;
      case "info":
        buildSimple(element, "Information");
        break;
      case "item":
      default:
        buildItem(element);
        break;
    }
  }

  function positionNearElement(element) {
    const padding = 12;
    const gap = 10;
    const elementRect = element.getBoundingClientRect();

    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    tooltip.classList.add("show");
    tooltip.setAttribute("aria-hidden", "false");

    const tooltipRect = tooltip.getBoundingClientRect();

    let x = elementRect.left + elementRect.width / 2 - tooltipRect.width / 2;
    let y = elementRect.bottom + gap;

    if (y + tooltipRect.height + padding > window.innerHeight) {
      y = elementRect.top - tooltipRect.height - gap;
    }

    x = Math.max(
      padding,
      Math.min(window.innerWidth - tooltipRect.width - padding, x)
    );

    y = Math.max(
      padding,
      Math.min(window.innerHeight - tooltipRect.height - padding, y)
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

  function hide() {
    tooltip.classList.remove("show");
    tooltip.setAttribute("aria-hidden", "true");
    activeEl = null;
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 40);
  }

  document.addEventListener("mouseover", event => {
    const element = event.target.closest?.(SEL);
    if (!element) return;
    show(element);
  });

  document.addEventListener("mouseout", event => {
    const leaving = event.target.closest?.(SEL);
    if (!leaving) return;

    const destination = event.relatedTarget?.closest?.(SEL);
    if (destination === leaving) return;
    hideSoon();
  });

  document.addEventListener("focusin", event => {
    const element = event.target.closest?.(SEL);
    if (element) show(element);
  });

  document.addEventListener("focusout", event => {
    const element = event.target.closest?.(SEL);
    if (element) hideSoon();
  });

  document.addEventListener("click", event => {
    const element = event.target.closest?.(SEL);

    if (element) {
      if (activeEl === element && tooltip.classList.contains("show")) {
        hide();
      } else {
        show(element);
      }
      return;
    }

    if (activeEl) hide();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && activeEl) hide();
  });

  window.addEventListener("resize", () => {
    if (activeEl) positionNearElement(activeEl);
  });

  window.addEventListener("scroll", () => {
    if (activeEl) positionNearElement(activeEl);
  }, true);

  window.GFTooltip = {
    show,
    hide,
    refresh() {
      if (activeEl) show(activeEl);
    }
  };
})();
