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

  function buildEquipmentType(dataset) {
    const slot = String(dataset.slot || "").toLowerCase();
    const armorWeight = dataset.armorWeight || "";
    const weaponClass = dataset.weaponClass || "";
    const itemType = dataset.itemType || dataset.category || "";

    if ((slot === "weapon" || slot === "offhand") && weaponClass) {
      return formatLabel(weaponClass);
    }

    if (armorWeight) return formatLabel(armorWeight);
    if (weaponClass) return formatLabel(weaponClass);
    if (itemType) return formatLabel(itemType);
    return "";
  }

  function buildEquipmentStats(dataset) {
    const baseAttack = optionalNumber(dataset.baseAttack);
    const baseDefense = optionalNumber(dataset.baseDefense);
    const attack = optionalNumber(dataset.attack);
    const defense = optionalNumber(dataset.defense);
    const rollJson = safeParseJson(dataset.rollJson);
    const hasRolls = Array.isArray(rollJson) && rollJson.length > 0;
    const lines = [];

    const shownAttack = baseAttack != null && baseAttack !== 0 ? baseAttack : attack;
    const shownDefense = baseDefense != null && baseDefense !== 0 ? baseDefense : defense;

    if (shownAttack != null && shownAttack !== 0) {
      lines.push(`<div class="t-equip-primary">${esc(shownAttack)} Attack</div>`);
    }

    if (shownDefense != null && shownDefense !== 0) {
      lines.push(`<div class="t-equip-primary">${esc(shownDefense)} Defense</div>`);
    }

    // Generated equipment gets its bonus stats from roll_json so they are not duplicated.
    if (hasRolls) {
      rollJson.forEach(affix => {
        if (!affix) return;

        const value = Number(affix.value || 0);
        if (!Number.isFinite(value) || value === 0) return;

        const label = affix.label || formatLabel(affix.stat || "Stat");
        const isPercent = Boolean(affix.isPercent);
        const resonant = Boolean(affix.resonant);

        lines.push(`
          <div class="t-equip-stat${resonant ? " t-affix-resonant" : ""}">
            <span class="t-equip-stat-text">+${esc(value)}${isPercent ? "%" : ""} ${esc(label)}</span>
            ${resonant ? `<span class="t-resonant-tag">Resonant</span>` : ""}
          </div>
        `);
      });
    } else {
      [
        ["Agility", optionalNumber(dataset.agility), ""],
        ["Vitality", optionalNumber(dataset.vitality), ""],
        ["Intellect", optionalNumber(dataset.intellect), ""],
        ["Critical Chance", optionalNumber(dataset.crit), "%"]
      ].forEach(([label, value, suffix]) => {
        if (value == null || value === 0) return;
        lines.push(`<div class="t-equip-stat"><span class="t-equip-stat-text">+${esc(value)}${esc(suffix)} ${esc(label)}</span></div>`);
      });
    }

    return lines.join("");
  }

  function buildItem(element) {
    const d = element.dataset;
    const name = d.name || "Unknown Item";
    const rarity = d.rarity || "base";
    const itemLevel = optionalNumber(d.itemLevel);
    const slot = String(d.slot || "").toLowerCase().trim();
    const equipmentSlots = new Set(["weapon", "offhand", "head", "chest", "legs", "feet", "hands"]);
    const isEquipment = equipmentSlots.has(slot);
    const equipmentType = isEquipment ? buildEquipmentType(d) : "";
    const equipmentStats = isEquipment ? buildEquipmentStats(d) : "";
    const value = optionalNumber(d.value);
    const sell = optionalNumber(d.sell);
    const price = optionalNumber(d.price);
    const quantity = optionalNumber(d.qty);
    const durability = optionalNumber(d.durability);
    const unique = d.unique === "true" || d.unique === "1";
    const utilityRows = [];

    if (quantity != null && quantity > 1) utilityRows.push(row("Quantity", quantity));
    if (durability != null) utilityRows.push(row("Durability", durability));
    if (sell != null) utilityRows.push(row("Sell Value", `${sell}g`));
    else if (value != null && value > 0) utilityRows.push(row("Value", `${value}g`));
    if (price != null) utilityRows.push(row("Cost", `${price}g`));
    if (unique) utilityRows.push(row("Property", "Unique"));

    if (isEquipment) {
      tooltip.innerHTML = `
        <div class="t-wow-item">
          <div class="t-name ${rarityClass(rarity)}">${esc(name)}</div>
          ${itemLevel != null && itemLevel > 0 ? `<div class="t-item-level">Item Level ${esc(itemLevel)}</div>` : ""}
          ${(slot || equipmentType) ? `
            <div class="t-equip-type-row">
              <span>${esc(formatLabel(slot))}</span>
              <span>${esc(equipmentType)}</span>
            </div>
          ` : ""}
          ${equipmentStats ? `<div class="t-equip-stats">${equipmentStats}</div>` : ""}
          ${d.desc ? `<div class="t-flavor-divider"></div><div class="t-item-flavor">${esc(d.desc)}</div>` : ""}
          ${utilityRows.length ? `<div class="t-item-utility">${utilityRows.join("")}</div>` : ""}
        </div>
      `;
      return;
    }

    const rarityLabel = formatLabel(rarity === "base" ? "Common" : rarity);
    const nonEquipmentType = formatLabel(d.type || d.category || "Item");
    const nonEquipmentItemType = formatLabel(d.itemType || "");

    tooltip.innerHTML = `
      <div class="t-wow-item">
        <div class="t-name ${rarityClass(rarity)}">${esc(name)}</div>
        <div class="t-item-level">${esc(rarityLabel)}</div>
        ${(nonEquipmentType || nonEquipmentItemType) ? `
          <div class="t-equip-type-row">
            <span>${esc(nonEquipmentType)}</span>
            <span>${esc(nonEquipmentItemType)}</span>
          </div>
        ` : ""}
        ${d.desc ? `<div class="t-flavor-divider"></div><div class="t-item-flavor">${esc(d.desc)}</div>` : ""}
        ${utilityRows.length ? `<div class="t-item-utility">${utilityRows.join("")}</div>` : ""}
      </div>
    `;
  }

  function buildSpell(element) {
    const d = element.dataset;
    const name = d.name || "Unknown Skill";
    const manaCost = optionalNumber(d.manaCost) ?? 0;
    const cooldown = optionalNumber(d.cooldown) ?? 0;
    const desc = d.desc || "";

    const manaText =
      manaCost > 0
        ? `${manaCost} Mana`
        : "No Mana Cost";

    const cooldownText =
      cooldown > 0
        ? `${cooldown} sec cooldown`
        : "No cooldown";

    tooltip.innerHTML = `
      <div class="t-wow-spell">
        <div class="t-name gf-skill">${esc(name)}</div>

        <div class="t-spell-meta-row">
          <span class="t-spell-mana">${esc(manaText)}</span>
          <span class="t-spell-cooldown">${esc(cooldownText)}</span>
        </div>

        ${desc ? `<div class="t-spell-description">${esc(desc)}</div>` : ""}
      </div>
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