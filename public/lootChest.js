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
  const closeBtn = document.getElementById("lootCloseBtn");
  const pendingBtn = document.getElementById("pendingChestBtn");
  

  const chestOpenSound = new Audio("/sounds/chestOpening.mp3");
  chestOpenSound.preload = "auto";
  chestOpenSound.volume = 0.5;

  const lootClaimSound = new Audio("/sounds/itemCollect.ogg");
  lootClaimSound.preload = "auto";
  lootClaimSound.volume = 0.5;

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
    if (!data.ok) {
      return showLootToast("Chest Error", data.error || "Failed to open");
    }

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
    if (!data.ok) {
      return showLootToast("Inventory Full", data.error || "Failed to claim");
    }

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
}

  icon.addEventListener("click", open);
  claimBtn.addEventListener("click", claim);
  closeBtn.addEventListener("click", close);
  setTimeout(refreshPendingChest, 250);



  // Personal dungeon completion rewards are separate from ordinary world chests.
  // They persist after the dungeon instance has closed.
  let dungeonChest = null;
  let dungeonBusy = false;
  const dungeonButton = document.createElement('button');
  dungeonButton.id = 'pendingDungeonChestBtn';
  dungeonButton.type = 'button';
  dungeonButton.className = pendingBtn?.className || 'pending-chest pending-chest--rail world-rail-card frame-host';
  dungeonButton.classList.add('hidden', 'pending-dungeon-chest');
  dungeonButton.innerHTML = '<span class="pending-dungeon-chest__icon" aria-hidden="true">🗝️</span><span class="pending-chest__copy"><strong>Dungeon Reward Chest</strong><small>Your expedition rewards are ready</small></span>';
  dungeonButton.setAttribute('aria-label', 'Open dungeon reward chest');
  if (pendingBtn?.parentElement) pendingBtn.insertAdjacentElement('afterend', dungeonButton);
  else document.body.appendChild(dungeonButton);

  const dungeonStyle = document.createElement('style');
  dungeonStyle.textContent = `
    .pending-dungeon-chest__icon {font-size:30px;min-width:46px;text-align:center;filter:drop-shadow(0 0 8px #a87d37)}
    .pending-dungeon-chest {border-color:#b28a46!important}
    .gf-dungeon-chest-backdrop {position:fixed;inset:0;z-index:11000;background:rgba(4,7,12,.84);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box}
    .gf-dungeon-chest-panel {width:min(540px,100%);max-height:90vh;overflow:auto;background:linear-gradient(150deg,#20242a,#101317 70%);border:2px solid #b38a45;box-shadow:0 18px 70px #000,0 0 22px #98743c55;color:#e9d9b9;padding:24px;border-radius:9px;text-align:center;box-sizing:border-box}
    .gf-dungeon-chest-panel h2 {margin:5px 0 8px;color:#e9c57c;font-size:22px}
    .gf-dungeon-chest-panel p {color:#bfb9aa;margin:7px 0 17px}
    .gf-dungeon-chest-emblem {font-size:72px;line-height:1.2;filter:drop-shadow(0 0 15px #bb8a3b)}
    .gf-dungeon-chest-items {display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:18px 0;text-align:left}
    .gf-dungeon-chest-item {background:#10151d;border:1px solid #665334;border-radius:6px;padding:12px;display:flex;align-items:center;gap:10px;min-width:0}
    .gf-dungeon-chest-item img {width:48px;height:48px;object-fit:contain;flex:none}
    .gf-dungeon-chest-item strong {font-size:12px;overflow-wrap:anywhere}
    .gf-dungeon-chest-item small {display:block;color:#b5ac9c;margin-top:4px}
    .gf-dungeon-chest-actions {display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:18px}
    .gf-dungeon-chest-actions button {background:#1e232b;border:1px solid #987744;color:#e9d6ae;padding:10px 20px;cursor:pointer;border-radius:4px}
    .gf-dungeon-chest-actions button.primary {background:#88662e;color:#fff2d4}
    .gf-dungeon-chest-actions button:disabled {opacity:.5;cursor:wait}
  `;
  document.head.appendChild(dungeonStyle);

  function dungeonEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }
  function dungeonIconPath(raw) {
    const s = String(raw || '').trim();
    if (!s) return '/icons/default.png';
    if (s.startsWith('/')) return s;
    if (s.startsWith('icons/')) return '/' + s;
    if (/^https?:\/\//i.test(s)) return s;
    return '/icons/' + s;
  }
  function closeDungeonChestModal() {
    document.getElementById('gfDungeonChestOverlay')?.remove();
  }
  async function refreshDungeonChest() {
    try {
      const response = await fetch('/api/dungeons/completion-chest', {credentials:'include',cache:'no-store'});
      if (!response.ok) throw new Error('Unable to load dungeon chest');
      const data = await response.json();
      dungeonChest = data?.chest?.status === 'unclaimed' ? data.chest : null;
      dungeonButton.classList.toggle('hidden', !dungeonChest);
      return dungeonChest;
    } catch (error) {
      console.warn('Dungeon chest refresh failed', error);
      return null;
    }
  }
  async function openDungeonChestModal() {
    if (dungeonBusy) return;
    const chest = await refreshDungeonChest();
    if (!chest) return;
    closeDungeonChestModal();
    const overlay = document.createElement('div');
    overlay.id = 'gfDungeonChestOverlay';
    overlay.className = 'gf-dungeon-chest-backdrop';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Dungeon reward chest');
    overlay.innerHTML = `
      <div class="gf-dungeon-chest-panel">
        <div class="gf-dungeon-chest-emblem" aria-hidden="true">🗝️</div>
        <h2>Dungeon Reward Chest</h2>
        <p>${dungeonEscape(chest.dungeonName || 'Dungeon Complete')}</p>
        <div class="gf-dungeon-chest-items">${(chest.rewards || []).map(reward => `
          <div class="gf-dungeon-chest-item">
            <img src="${dungeonEscape(dungeonIconPath(reward.icon))}" alt="" onerror="this.src='/icons/default.png'">
            <div><strong>${dungeonEscape(reward.name || 'Reward')}</strong><small>${reward.quantity > 1 ? '×' + Number(reward.quantity) + ' · ' : ''}${reward.itemLevel != null ? 'Level ' + Number(reward.itemLevel) : 'Dungeon reward'}</small></div>
          </div>`).join('') || '<p>No items in this chest.</p>'}</div>
        <div class="gf-dungeon-chest-actions"><button class="primary" id="gfDungeonChestClaim">Claim Rewards</button><button id="gfDungeonChestClose">Close</button></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#gfDungeonChestClose').addEventListener('click', closeDungeonChestModal);
    overlay.addEventListener('click', e => {if (e.target === overlay) closeDungeonChestModal();});
    overlay.querySelector('#gfDungeonChestClaim').addEventListener('click', async e => {
      if (dungeonBusy) return;
      dungeonBusy = true;
      e.currentTarget.disabled = true;
      try {
        const response = await fetch(`/api/dungeons/completion-chest/${chest.id}/claim`, {method:'POST',credentials:'include'});
        const data = await response.json();
        if (!response.ok || data.ok === false) throw new Error(data.error || 'Unable to claim dungeon rewards');
        try {lootClaimSound.currentTime=0; await lootClaimSound.play();} catch {}
        closeDungeonChestModal();
        await refreshDungeonChest();
        showLootToast('Dungeon Rewards', 'Your rewards have been collected.', 'success');
      } catch (error) {
        showLootToast('Dungeon Chest', error.message || 'Unable to claim rewards');
        e.currentTarget.disabled = false;
      } finally { dungeonBusy = false; }
    });
    try {chestOpenSound.currentTime=0; await chestOpenSound.play();} catch {}
  }
  dungeonButton.addEventListener('click', openDungeonChestModal);
  setTimeout(async () => {
    const chest = await refreshDungeonChest();
    if (chest && sessionStorage.getItem('gfDungeonChestAutoOpen') === '1') {
      sessionStorage.removeItem('gfDungeonChestAutoOpen');
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