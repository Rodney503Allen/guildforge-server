// Guildforge Item Tooltip - shared (single tooltip instance)
//public/ui/itemTooltip.js
(function () {
  const SEL = '[data-tooltip="item"]';
  const tooltip = document.createElement("div");
  tooltip.className = "gf-tooltip";
  document.body.appendChild(tooltip);

  let activeEl = null;
  let hideTimer = null;

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function rarityClass(rarity) {
    const r = String(rarity || "").toLowerCase().trim();
    if (!r) return "gf-dormant";
    return "gf-" + r;
  }

  function safeParseJson(v) {
    if (v == null || v === "") return null;
    if (typeof v === "object") return v;
    try {
      return JSON.parse(String(v));
    } catch {
      return null;
    }
  }

  function formatLabel(value) {
    return String(value || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function buildAutoStatsHtml(d) {
  const sections = [];

  const itemLevel = d.itemLevel ? Number(d.itemLevel) : null;
  const slot = d.slot || "";
  const itemType = d.itemType || "";
  const armorWeight = d.armorWeight || "";

  const baseAttack = d.baseAttack != null && d.baseAttack !== "" ? Number(d.baseAttack) : null;
  const baseDefense = d.baseDefense != null && d.baseDefense !== "" ? Number(d.baseDefense) : null;

  const rollJson = safeParseJson(d.rollJson);

  const metaParts = [];
  if (slot) metaParts.push(formatLabel(slot));
  if (itemLevel != null && Number.isFinite(itemLevel)) metaParts.push(`Lv. ${itemLevel}`);

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
  if (baseAttack != null && Number.isFinite(baseAttack) && baseAttack !== 0) {
    baseLines.push(`<div>Attack: +${baseAttack}</div>`);
  }
  if (baseDefense != null && Number.isFinite(baseDefense) && baseDefense !== 0) {
    baseLines.push(`<div>Defense: +${baseDefense}</div>`);
  }

  if (baseLines.length) {
    sections.push(`<div class="t-base">${baseLines.join("")}</div>`);
  }

  const bonusLines = [];
  if (Array.isArray(rollJson)) {
    for (const affix of rollJson) {
      if (!affix) continue;

      const label = affix.label || formatLabel(affix.stat || "Stat");
      const value = Number(affix.value || 0);
      const isPercent = !!affix.isPercent;
      const resonant = !!affix.resonant;

      if (!Number.isFinite(value) || value === 0) continue;

      const valueText = `+${value}${isPercent ? "%" : ""}`;
      const resonanceTag = resonant
        ? ` <span class="t-resonant-tag">(Resonant)</span>`
        : "";

      bonusLines.push(
        `<div class="t-affix${resonant ? " t-affix-resonant" : ""}">${esc(label)}: ${valueText}${resonanceTag}</div>`
      );
    }
  }
  if (bonusLines.length) {
    sections.push(`<div class="t-divider"></div>`);
    sections.push(`<div class="t-bonus">${bonusLines.join("")}</div>`);
  }

  return sections.join("");
}

  function build(el) {
    const d = el.dataset;

    const name = d.name || "Unknown Item";
    const rarity = d.rarity || "dormant";
    const value = d.value != null && d.value !== "" ? Number(d.value) : null;
    const rate = d.rate ? Number(d.rate) : null;
    const sell = d.sell ? Number(d.sell) : null;
    const price = d.price ? Number(d.price) : null;
    const qty = d.qty ? Number(d.qty) : null;
    const desc = d.desc ? d.desc : "";

    const statsHtml = buildAutoStatsHtml(d);

    const subParts = [];
    if (value != null && Number.isFinite(value)) subParts.push(`Value: ${value}g`);
    if (rate != null && Number.isFinite(rate)) subParts.push(`Rate: ${rate}%`);

    const rows = [];
    if (sell != null && Number.isFinite(sell)) {
      rows.push(`<div class="t-row"><span class="t-k">Sell</span><span class="t-v">${sell}g</span></div>`);
    }
    if (price != null && Number.isFinite(price)) {
      rows.push(`<div class="t-row"><span class="t-k">Cost</span><span class="t-v">${price}g</span></div>`);
    }
    if (qty != null && Number.isFinite(qty) && qty > 1) {
      rows.push(`<div class="t-row"><span class="t-k">Stack</span><span class="t-v">${qty}</span></div>`);
    }

    tooltip.innerHTML = `
      <div class="t-name ${rarityClass(rarity)}">${esc(name)}</div>
      ${subParts.length ? `<div class="t-sub">${esc(subParts.join(" • "))}</div>` : ""}
      ${rows.join("")}
      ${statsHtml ? `<div class="t-stats">${statsHtml}</div>` : ""}
      ${desc ? `<div class="t-desc">${esc(desc)}</div>` : ""}
    `;
  }

  function positionNearEl(el) {
    const pad = 12;
    const gap = 10;

    const r = el.getBoundingClientRect();

    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    tooltip.classList.add("show");

    const tr = tooltip.getBoundingClientRect();

    let x = r.left + (r.width / 2) - (tr.width / 2);
    let y = r.bottom + gap;

    if (y + tr.height + pad > window.innerHeight) {
      y = r.top - tr.height - gap;
    }

    x = Math.max(pad, Math.min(window.innerWidth - tr.width - pad, x));
    y = Math.max(pad, Math.min(window.innerHeight - tr.height - pad, y));

    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function show(el) {
    if (!el) return;
    clearTimeout(hideTimer);

    activeEl = el;
    build(el);
    positionNearEl(el);
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      tooltip.classList.remove("show");
      activeEl = null;
    }, 40);
  }

  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest(SEL);
    if (!el) return;
    show(el);
  });

  document.addEventListener("mouseout", (e) => {
    const leaving = e.target.closest(SEL);
    if (!leaving) return;

    const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest(SEL) : null;
    if (to) return;

    hideSoon();
  });

  document.addEventListener("click", (e) => {
    const el = e.target.closest(SEL);
    if (el) {
      if (activeEl === el) {
        tooltip.classList.remove("show");
        activeEl = null;
        return;
      }
      show(el);
      return;
    }
    if (activeEl) {
      tooltip.classList.remove("show");
      activeEl = null;
    }
  });
})();