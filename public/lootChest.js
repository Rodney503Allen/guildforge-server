//public/lootChest.js
const LootChestModal = (() => {
  let currentChestId = null;
  let pendingChestId = null;
  let pendingChestRarity = "base";

  const modal = document.getElementById("lootChestModal");
  const sealed = document.getElementById("lootChestSealed");
  const opened = document.getElementById("lootChestOpened");
  const icon = document.getElementById("lootChestIcon");
  const itemsDiv = document.getElementById("lootItems");
  const claimBtn = document.getElementById("lootClaimBtn");
  const pendingBtn = document.getElementById("pendingChestBtn");

  const chestOpenSound = new Audio("/sounds/chestOpening.mp3");
  chestOpenSound.preload = "auto";
  chestOpenSound.volume = 0.5;

  const lootClaimSound = new Audio("/sounds/itemCollect.mp3");
  lootClaimSound.preload = "auto";
  lootClaimSound.volume = 0.5;

  const CHEST_RARITY_CLASSES = [
    "chest-rarity-base",
    "chest-rarity-dormant",
    "chest-rarity-awakened",
    "chest-rarity-empowered",
    "chest-rarity-transcendent"
  ];

  function normalizeRarity(rarity) {
    const r = String(rarity || "base").toLowerCase().trim();
    if (
      r === "base" ||
      r === "dormant" ||
      r === "awakened" ||
      r === "empowered" ||
      r === "transcendent"
    ) {
      return r;
    }
    return "base";
  }

  function applyChestRarityClass(rarity) {
    const finalRarity = normalizeRarity(rarity);
    modal.classList.remove(...CHEST_RARITY_CLASSES);
    modal.classList.add(`chest-rarity-${finalRarity}`);

    if (pendingBtn) {
      pendingBtn.classList.remove(...CHEST_RARITY_CLASSES);
      pendingBtn.classList.add(`chest-rarity-${finalRarity}`);
    }
  }

  function clearChestRarityClass() {
    modal.classList.remove(...CHEST_RARITY_CLASSES);
    if (pendingBtn) pendingBtn.classList.remove(...CHEST_RARITY_CLASSES);
  }

  function show(chestId, rarity = pendingChestRarity) {
    currentChestId = chestId;
    modal.classList.remove("hidden");
    modal.classList.remove("loot-opened-state");
    sealed.classList.remove("hidden");
    opened.classList.add("hidden");

    applyChestRarityClass(rarity);
  }

  async function open() {
    const res = await fetch(`/api/chests/${currentChestId}/open`, {
      method: "POST",
      credentials: "include"
    });
    const data = await res.json();
    if (!data.ok) return alert(data.error || "Failed to open");

    // if backend returns chest rarity here too, keep it synced
    if (data.chest?.rarity) {
      pendingChestRarity = normalizeRarity(data.chest.rarity);
      applyChestRarityClass(pendingChestRarity);
    }

    try {
      chestOpenSound.currentTime = 0;
      chestOpenSound.play();
    } catch {}

    renderItems(data.items);

    modal.classList.add("loot-opened-state");
    sealed.classList.add("hidden");
    opened.classList.remove("hidden");
  }

  async function claim() {
    const res = await fetch(`/api/chests/${currentChestId}/claim`, {
      method: "POST",
      credentials: "include"
    });
    const data = await res.json();
    if (!data.ok) return alert(data.error || "Failed to claim");

    try {
      lootClaimSound.currentTime = 0;
      lootClaimSound.play();
    } catch {}

    await refreshPendingChest();
    close();
  }

  function escapeHtml(s){
    return String(s ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function resolveItemIcon(rawIcon) {
    const raw = (rawIcon ?? "").toString().trim();
    if (!raw) return "/icons/default.png";
    if (raw.startsWith("http")) return raw;
    if (raw.startsWith("/")) return raw;
    if (raw.startsWith("icons/")) return "/" + raw;
    return "/icons/" + raw.replace(/^\/+/, "");
  }

  function renderItems(items) {
    itemsDiv.innerHTML = "";

    const grid = document.createElement("div");
    grid.className = "loot-grid";

    for (const item of (items || [])) {
      const rarity = (item.rarity || "dormant").toString().toLowerCase();
      const name = item.name ?? "Item";
      const qty = Number(item.qty ?? item.quantity ?? 1) || 1;
      const iconSrc = resolveItemIcon(item.icon);

      const desc = item.description ?? item.desc ?? "";
      const value = item.value ?? item.sell_value ?? "";
      const type = item.type ?? "";
      const itemType = item.item_type ?? "";
      const armorWeight = item.armor_weight ?? "";
      const slot = item.slot ?? "";
      const itemLevel = item.item_level ?? "";
      const baseAttack = item.base_attack ?? "";
      const baseDefense = item.base_defense ?? "";

      const rollJson = item.roll_json ? JSON.stringify(item.roll_json) : "";

      const tile = document.createElement("div");
      tile.className = `loot-tile rarity-${rarity}`;
      tile.setAttribute("data-tooltip", "item");
      tile.setAttribute("data-name", name);
      tile.setAttribute("data-rarity", rarity);
      tile.setAttribute("data-qty", String(qty));

      if (desc) tile.setAttribute("data-desc", desc);
      if (value !== "" && value != null) tile.setAttribute("data-value", String(value));
      if (slot) tile.setAttribute("data-slot", slot);
      if (itemType) tile.setAttribute("data-item-type", itemType);
      else if (type) tile.setAttribute("data-item-type", type);
      if (armorWeight) tile.setAttribute("data-armor-weight", armorWeight);
      if (itemLevel !== "" && itemLevel != null) tile.setAttribute("data-item-level", String(itemLevel));
      if (baseAttack !== "" && baseAttack != null) tile.setAttribute("data-base-attack", String(baseAttack));
      if (baseDefense !== "" && baseDefense != null) tile.setAttribute("data-base-defense", String(baseDefense));
      if (rollJson) tile.setAttribute("data-roll-json", rollJson);

      tile.innerHTML = `
        <div class="loot-iconwrap">
          <img
            class="loot-icon"
            src="${escapeHtml(iconSrc)}"
            alt="${escapeHtml(name)}"
            onerror="this.src='/icons/default.png'"
          >
          ${qty > 1 ? `<div class="loot-qty">${qty}</div>` : ``}
        </div>
      `;

      grid.appendChild(tile);
    }

    itemsDiv.appendChild(grid);
  }

  async function refreshPendingChest() {
    try {
      const r = await fetch("/api/chests/pending", { credentials: "include" });
      const d = await r.json();

      pendingChestId = d?.chest?.id ?? null;
      pendingChestRarity = normalizeRarity(d?.chest?.rarity ?? "base");

      if (pendingBtn) {
        if (pendingChestId) {
          pendingBtn.classList.remove("hidden");
          applyChestRarityClass(pendingChestRarity);
        } else {
          pendingBtn.classList.add("hidden");
          clearChestRarityClass();
        }
      }
    } catch (e) {
      console.warn("refreshPendingChest failed", e);
    }
  }

async function showIndicator(chestId, rarity = null) {
  pendingChestId = chestId;

  if (rarity) {
    pendingChestRarity = normalizeRarity(rarity);
  } else {
    pendingChestRarity = "base";
  }

  if (pendingBtn) {
    pendingBtn.classList.remove("hidden");
  }

  applyChestRarityClass(pendingChestRarity);

  // force a follow-up refresh so the real rarity replaces base
  if (!rarity) {
    setTimeout(() => {
      refreshPendingChest();
    }, 50);
  }
}

if (pendingBtn) {
  pendingBtn.addEventListener("click", () => {
    if (!pendingChestId) return;
    show(pendingChestId, pendingChestRarity);
  });
}

function close() {
  modal.classList.add("hidden");
  modal.classList.remove("loot-opened-state");
  sealed.classList.remove("hidden");
  opened.classList.add("hidden");
  currentChestId = null;
}

  icon.addEventListener("click", open);
  claimBtn.addEventListener("click", claim);
  setTimeout(refreshPendingChest, 250);

  return {
    show,
    close,
    setPending: showIndicator,
    refreshPendingChest
  };
})();