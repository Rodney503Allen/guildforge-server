(() => {
  const form = document.getElementById("creatureForm");
  const out = document.getElementById("outCreature");
  const btnPrev = document.getElementById("btnCreaturePreview");

  const lootPanel = document.getElementById("lootPanel");
  const lootItemSearch = document.getElementById("lootItemSearch");
  const lootItemSelect = document.getElementById("lootItemSelect");
  const lootRows = document.getElementById("lootRows");

  const dropChance = document.getElementById("lootDropChance");
  const minQty = document.getElementById("lootMinQty");
  const maxQty = document.getElementById("lootMaxQty");
  const minLevel = document.getElementById("lootMinLevel");
  const maxLevel = document.getElementById("lootMaxLevel");
  const btnAddLoot = document.getElementById("btnAddLoot");

  let creatureId = null;
  let searchTimer = null;

  function showOut(obj) {
    out.hidden = false;
    out.textContent = JSON.stringify(obj, null, 2);
  }

  function formToJson() {
    const fd = new FormData(form);
    const get = (k) => fd.get(k);

    const num = (v, fb = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fb;
    };

    return {
      name: String(get("name") || "").trim(),
      level: num(get("level"), 1),
      attack: num(get("attack"), 0),
      defense: num(get("defense"), 0),
      maxhp: num(get("maxhp"), 1),
      agility: num(get("agility"), 0),
      crit: num(get("crit"), 0),
      exper: num(get("exper"), 0),
      attack_speed: num(get("attack_speed"), 1500),
      terrain: String(get("terrain") || "any"),
      rarity: String(get("rarity") || "common"),
      base_spawn_chance: num(get("base_spawn_chance"), 0.2),
      min_level: num(get("min_level"), 1),
      max_level: num(get("max_level"), 999),
      description: String(get("description") || "").trim(),
      creatureimage: String(get("creatureimage") || "").trim(),
      image: String(get("image") || "").trim(),
    };
  }

  async function postJson(url, body, method = "POST") {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, raw: text }; }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadItemOptions(q = "") {
    const res = await fetch(`/admin/api/items/search?q=${encodeURIComponent(q)}`, { credentials: "include" });
    const data = await res.json();

    lootItemSelect.innerHTML = (data.items || []).map(it =>
      `<option value="${it.id}">${it.name} (${it.rarity || "common"})</option>`
    ).join("");

    if (!lootItemSelect.innerHTML) {
      lootItemSelect.innerHTML = `<option value="">No items found</option>`;
    }
  }

  async function refreshLootRows() {
    if (!creatureId) return;
    const res = await fetch(`/admin/api/creatures/${creatureId}/loot`, { credentials: "include" });
    const data = await res.json();

    const rows = data.rows || [];
    if (!rows.length) {
      lootRows.innerHTML = `<div class="note">No loot rows yet.</div>`;
      return;
    }

    lootRows.innerHTML = rows.map(r => `
      <div class="infoBox" style="margin-bottom:10px;">
        <div class="infoTitle" style="display:flex; justify-content:space-between; gap:10px;">
          <strong>${r.item_name}</strong>
          <button class="btn is-ghost" data-del="${r.id}" type="button">Remove</button>
        </div>
        <p class="infoText" style="margin:6px 0 0;">
          Chance: <strong>${r.drop_chance}</strong> • Qty: <strong>${r.min_qty}-${r.max_qty}</strong>
          ${r.min_level != null || r.max_level != null ? ` • Level: <strong>${r.min_level ?? "?"}-${r.max_level ?? "?"}</strong>` : ""}
        </p>
      </div>
    `).join("");

    Array.from(lootRows.querySelectorAll("[data-del]")).forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.getAttribute("data-del"));
        await fetch(`/admin/api/creature-loot/${id}`, { method: "DELETE", credentials: "include" });
        await refreshLootRows();
      });
    });
  }

  // Preview
  btnPrev?.addEventListener("click", () => showOut(formToJson()));

  // Create creature
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = formToJson();
    showOut({ creating: true, payload });

    const data = await postJson("/admin/api/creatures", payload);
    creatureId = Number(data.id);

    showOut({ ok: true, creatureId, creature: data.creature });

    // unlock loot panel
    lootPanel.style.display = "block";
    await loadItemOptions("");
    await refreshLootRows();
  });

  // Search items
  lootItemSearch?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadItemOptions(lootItemSearch.value || ""), 250);
  });

  // Add loot row
  btnAddLoot?.addEventListener("click", async () => {
    if (!creatureId) return alert("Create the creature first.");

    const item_id = Number(lootItemSelect.value || 0);
    if (!item_id) return alert("Pick an item.");

    const body = {
      item_id,
      drop_chance: Number(dropChance.value || 0.1),
      min_qty: Number(minQty.value || 1),
      max_qty: Number(maxQty.value || 1),
      min_level: minLevel.value || null,
      max_level: maxLevel.value || null,
    };

    await postJson(`/admin/api/creatures/${creatureId}/loot`, body);
    await refreshLootRows();
  });

})();