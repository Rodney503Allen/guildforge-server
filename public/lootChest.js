//public/lootChest.js
const LootChestModal = (() => {
  let currentChestId = null;
  let pendingChestId = null;
  let pendingChestRarity = "base";
  let chestMode = "world";
  let dungeonChest = null;
  let dungeonBusy = false;

  const modal = document.getElementById("lootChestModal");
  const sealed = document.getElementById("lootChestSealed");
  const opened = document.getElementById("lootChestOpened");
  const icon = document.getElementById("lootChestIcon");
  const itemsDiv = document.getElementById("lootItems");
  const claimBtn = document.getElementById("lootClaimBtn");
  const closeBtn = document.getElementById("lootCloseBtn");
  const pendingBtn = document.getElementById("pendingChestBtn");
  

  // Register loot chest sounds with the shared audio manager.
  async function playChestSfx(key) {
    const audio = window.GFAudio || await window.GFAudioReady;
    if (!audio?.playSfx || !audio?.registerTrack) return;
    audio.registerTrack("sfx", "loot_chest_open", "/sounds/chestOpening.mp3");
    audio.registerTrack("sfx", "loot_chest_claim", "/sounds/itemCollect.ogg");
    await audio.playSfx(key, { volume: 0.5 });
  }

  const TOAST_VISIBLE_MS = 2200;

function showLootToast(title, message, type = "error") {
  if (window.GFToast?.show) {
    window.GFToast.show(title, message, {
      type,
      durationMs: TOAST_VISIBLE_MS
    });
    return;
  }

  console.warn(title, message);
}

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
    chestMode = "world";
    currentChestId = chestId;
    modal.classList.remove("dungeon-chest-mode");
    icon.src = "/images/chest.png";
    icon.alt = "Sealed loot chest";
    modal.classList.remove("hidden");
    modal.classList.remove("loot-opened-state");
    sealed.classList.remove("hidden");
    opened.classList.add("hidden");

    applyChestRarityClass(rarity);
  }

  async function open() {
    if (chestMode === "dungeon") {
      if (dungeonBusy || !dungeonChest) return;
      void playChestSfx("loot_chest_open");
      renderItems((dungeonChest.rewards || []).map(reward => ({
        ...reward,
        qty: reward.quantity,
        item_type: reward.itemType,
        item_level: reward.itemLevel
      })));
      modal.classList.add("loot-opened-state");
      sealed.classList.add("hidden");
      opened.classList.remove("hidden");
      return;
    }
    const res = await fetch(`/api/chests/${currentChestId}/open`, {
      method: "POST",
      credentials: "include"
    });
    const data = await res.json();
    if (!data.ok) {
      return showLootToast("Chest Error", data.error || "Failed to open");
    }

    // if backend returns chest rarity here too, keep it synced
    if (data.chest?.rarity) {
      pendingChestRarity = normalizeRarity(data.chest.rarity);
      applyChestRarityClass(pendingChestRarity);
    }

    void playChestSfx("loot_chest_open");

    renderItems(data.items);

    modal.classList.add("loot-opened-state");
    sealed.classList.add("hidden");
    opened.classList.remove("hidden");
  }

  async function claim() {
    if (chestMode === "dungeon") {
      if (dungeonBusy || !dungeonChest) return;
      dungeonBusy = true;
      claimBtn.disabled = true;
      try {
        const res = await fetch(`/api/dungeons/completion-chest/${dungeonChest.id}/claim`, {
          method: "POST", credentials: "include"
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(data.error || "Unable to claim dungeon rewards");
        void playChestSfx("loot_chest_claim");
        close();
        await refreshDungeonChest();
        showLootToast("Dungeon Rewards", "Your rewards have been collected.", "success");
      } catch (error) {
        showLootToast("Dungeon Chest", error.message || "Unable to claim rewards");
      } finally {
        dungeonBusy = false;
        claimBtn.disabled = false;
      }
      return;
    }
    const res = await fetch(`/api/chests/${currentChestId}/claim`, {
      method: "POST",
      credentials: "include"
    });
    const data = await res.json();
    if (!data.ok) {
      return showLootToast("Inventory Full", data.error || "Failed to claim");
    }

    void playChestSfx("loot_chest_claim");

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
      const weaponClass = item.weapon_class ?? "";
      const slot = item.slot ?? "";
      const itemLevel = item.item_level ?? "";
      const baseAttack = item.base_attack ?? "";
      const baseDefense = item.base_defense ?? "";

      const staticStats = [
        item.attack ? `Attack +${item.attack}` : null,
        item.defense ? `Defense +${item.defense}` : null,
        item.agility ? `Agility +${item.agility}` : null,
        item.vitality ? `Vitality +${item.vitality}` : null,
        item.intellect ? `Intellect +${item.intellect}` : null,
        item.crit ? `Crit +${item.crit}%` : null
      ].filter(Boolean).join("<br>");

      const rollJson = item.roll_json ? JSON.stringify(item.roll_json) : "";

      const tile = document.createElement("div");
      tile.className = `loot-tile rarity-${rarity}`;
      tile.setAttribute("data-tooltip", "item");
      tile.setAttribute("data-name", name);
      tile.setAttribute("data-rarity", rarity);
      tile.setAttribute("data-qty", String(qty));
      tile.setAttribute("data-type", type);

      if (desc) tile.setAttribute("data-desc", desc);
      if (value !== "" && value != null) tile.setAttribute("data-value", String(value));
      if (slot) tile.setAttribute("data-slot", slot);
      if (itemType) tile.setAttribute("data-item-type", itemType);
      if (armorWeight) tile.setAttribute("data-armor-weight", armorWeight);
      if (weaponClass) tile.setAttribute("data-weapon-class", weaponClass);
      if (itemLevel !== "" && itemLevel != null) tile.setAttribute("data-item-level", String(itemLevel));
      if (baseAttack !== "" && baseAttack != null) tile.setAttribute("data-base-attack", String(baseAttack));
      if (baseDefense !== "" && baseDefense != null) tile.setAttribute("data-base-defense", String(baseDefense));
      if (staticStats) tile.setAttribute("data-stats", staticStats);
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
  chestMode = "world";
  modal.classList.remove("dungeon-chest-mode");
  modal.setAttribute("aria-label", "Loot chest");
  icon.src = "/images/chest.png";
  icon.alt = "Sealed loot chest";
}

  icon.addEventListener("click", open);
  claimBtn.addEventListener("click", claim);
  closeBtn.addEventListener("click", close);
  setTimeout(refreshPendingChest, 250);



  // Dungeon completion chests use the SAME modal and item renderer as world combat.
  // Only the chest image and claim endpoint differ.
  const dungeonButton = document.createElement("button");
  dungeonButton.id = "pendingDungeonChestBtn";
  dungeonButton.type = "button";
  dungeonButton.className = pendingBtn?.className || "pending-chest pending-chest--rail world-rail-card frame-host";
  dungeonButton.classList.add("hidden", "pending-dungeon-chest");
  dungeonButton.innerHTML = '<span class="pending-dungeon-chest__icon" aria-hidden="true"><img src="/images/dungeon_chest.png" alt=""></span><span class="pending-chest__copy"><strong>Dungeon Reward Chest</strong><small>Your expedition rewards are ready</small></span>';
  dungeonButton.setAttribute("aria-label", "Open dungeon reward chest");
  if (pendingBtn?.parentElement) pendingBtn.insertAdjacentElement("afterend", dungeonButton);
  else document.body.appendChild(dungeonButton);

  const dungeonStyle = document.createElement("style");
  dungeonStyle.textContent = `
    .pending-dungeon-chest__icon {display:flex;align-items:center;justify-content:center;min-width:46px;filter:drop-shadow(0 0 8px #a87d37)}
    .pending-dungeon-chest__icon img {width:44px;height:44px;object-fit:contain}
    .pending-dungeon-chest {border-color:#b28a46!important}
    #lootChestModal.dungeon-chest-mode .loot-panel {border-color:#b28a46}
    #lootChestModal.dungeon-chest-mode #lootChestIcon {object-fit:contain}
  `;
  document.head.appendChild(dungeonStyle);

  async function refreshDungeonChest() {
    try {
      const response = await fetch("/api/dungeons/completion-chest", {
        credentials: "include", cache: "no-store"
      });
      if (!response.ok) throw new Error("Unable to load dungeon chest");
      const data = await response.json();
      dungeonChest = data?.chest?.status === "unclaimed" ? data.chest : null;
      dungeonButton.classList.toggle("hidden", !dungeonChest);
      return dungeonChest;
    } catch (error) {
      console.warn("Dungeon chest refresh failed", error);
      return null;
    }
  }

  async function openDungeonChestModal() {
    if (dungeonBusy) return;
    const chest = await refreshDungeonChest();
    if (!chest) return;
    // Use the world combat chest's original sealed/opened states, audio,
    // tooltip-enabled loot grid and Collect button.
    close();
    chestMode = "dungeon";
    currentChestId = chest.id;
    modal.classList.add("dungeon-chest-mode");
    modal.setAttribute("aria-label", "Dungeon reward chest");
    icon.src = "/images/dungeon_chest.png";
    icon.alt = "Sealed dungeon reward chest";
    itemsDiv.innerHTML = "";
    modal.classList.remove("hidden", "loot-opened-state");
    sealed.classList.remove("hidden");
    opened.classList.add("hidden");
  }

  dungeonButton.addEventListener("click", openDungeonChestModal);
  setTimeout(async () => {
    const chest = await refreshDungeonChest();
    if (chest && sessionStorage.getItem("gfDungeonChestAutoOpen") === "1") {
      sessionStorage.removeItem("gfDungeonChestAutoOpen");
      await openDungeonChestModal();
    }
  }, 350);

  return {
    show,
    close,
    setPending: showIndicator,
    refreshPendingChest,
    refreshDungeonChest,
    openDungeonChest: openDungeonChestModal
  };
})();

window.LootChestModal =
  LootChestModal;