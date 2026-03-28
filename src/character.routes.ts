//character.routes.ts
import { Router } from "express";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";

const router = Router();

// =======================
// LOGIN GUARD
// =======================
function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) {
    return res.redirect("/login.html");
  }
  next();
}

function resolveIcon(icon: any) {
  const raw = (icon ?? "").toString().trim();
  if (!raw) return "";
  if (raw.startsWith("http")) return raw;
  return "/" + raw.replace(/^\/+/, "");
}

function parseRollJson(v: any) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return [];
  }
}

function statFromRolls(rolls: any[], statKey: string) {
  return rolls
    .filter((r: any) => String(r?.stat) === statKey && !r?.isPercent)
    .reduce((sum: number, r: any) => sum + (Number(r?.value) || 0), 0);
}

function escapeHtml(input: any) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildTooltipAttrs(item: any) {
  const attrs: string[] = [
    `data-tooltip="item"`,
    `data-name="${escapeHtml(item?.name || "Unknown Item")}"`,
    `data-rarity="${escapeHtml(item?.rarity || "base")}"`,
    `data-desc="${escapeHtml(item?.description || "")}"`,
  ];

  const hasGearSlot = ["weapon", "offhand", "head", "chest", "legs", "feet", "hands"].includes(
    String(item?.slot || "")
  );

  if (item?.is_rolled || hasGearSlot) {
    attrs.push(`data-slot="${escapeHtml(item?.slot || "")}"`);
    attrs.push(`data-item-level="${item?.item_level ?? ""}"`);
    attrs.push(`data-item-type="${escapeHtml(item?.item_type || item?.type || "")}"`);
    attrs.push(`data-armor-weight="${escapeHtml(item?.armor_weight || "")}"`);
    attrs.push(`data-base-attack="${Number(item?.base_attack || 0)}"`);
    attrs.push(`data-base-defense="${Number(item?.base_defense || 0)}"`);
    attrs.push(`data-roll-json='${escapeHtml(JSON.stringify(item?.roll_json || []))}'`);
  } else {
    const stats = [
      item?.attack ? `Attack +${item.attack}` : null,
      item?.defense ? `Defense +${item.defense}` : null,
      item?.agility ? `Agility +${item.agility}` : null,
      item?.vitality ? `Vitality +${item.vitality}` : null,
      item?.intellect ? `Intellect +${item.intellect}` : null,
      item?.crit ? `Crit +${item.crit}%` : null,
    ].filter(Boolean).join("<br>");

    attrs.push(`data-value="${Number(item?.value || 0)}"`);
    attrs.push(`data-qty="${Number(item?.quantity || 1)}"`);
    attrs.push(`data-stats="${escapeHtml(stats)}"`);
  }

  return attrs.join("\n");
}

// =======================
// EQUIPPED POTIONS API
// =======================
router.get("/api/potions/equipped", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;

  const [[cols]]: any = await db.query(
    `SELECT equip_potion_hp_inventory_id AS hpInv,
            equip_potion_sp_inventory_id AS spInv
     FROM players WHERE id=?`,
    [pid]
  );

  async function loadPotion(invId: number | null, expectedTarget: "hp" | "sp") {
    if (!invId) return null;

    const [[row]]: any = await db.query(
      `
      SELECT
        inv.inventory_id AS inventoryId,
        inv.quantity AS qty,
        i.name,
        i.icon,
        i.type,
        i.effect_target,
        i.is_combat
      FROM inventory inv
      JOIN items i ON i.id = inv.item_id
      WHERE inv.inventory_id = ?
        AND inv.player_id = ?
      LIMIT 1
      `,
      [invId, pid]
    );

    if (!row || Number(row.qty) <= 0) return null;
    if (String(row.type) !== "potion") return null;
    if (Number(row.is_combat) !== 1) return null;
    if (String(row.effect_target).toLowerCase() !== expectedTarget) return null;

    return {
      inventoryId: Number(row.inventoryId),
      qty: Number(row.qty),
      name: row.name,
      icon: row.icon
    };
  }

  const hp = await loadPotion(cols?.hpInv ?? null, "hp");
  const sp = await loadPotion(cols?.spInv ?? null, "sp");

  res.json({ hp, sp });
});

// =======================
// CHARACTER PAGE
// =======================
router.get("/character", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;

  const [[basePlayer]]: any = await db.query(`
    SELECT
      attack,
      defense,
      agility,
      vitality,
      intellect,
      crit
    FROM players
    WHERE id = ?
  `, [pid]);

  const p = await getFinalPlayerStats(pid);
  if (!p) return res.redirect("/login.html");

  const expToNext = p.level * 50 + p.level * p.level * 50;
  const expPercent = Math.min(100, Math.floor((p.exper / expToNext) * 100));

  type StatKey = "attack" | "defense" | "agility" | "vitality" | "intellect" | "crit";
  const STAT_KEYS: StatKey[] = ["attack", "defense", "agility", "vitality", "intellect", "crit"];

  const statBreakdown: Record<
    StatKey,
    { base: number; gear: number; buff: number; total: number }
  > = {} as any;

  const [[potionCols]]: any = await db.query(
    `SELECT equip_potion_hp_inventory_id AS hpInv,
            equip_potion_sp_inventory_id AS spInv
     FROM players WHERE id=?`,
    [pid]
  );

  async function loadPotion(invId: number | null, expectedTarget: "hp" | "sp") {
    if (!invId) return null;

    const [[row]]: any = await db.query(
      `
      SELECT
        inv.inventory_id AS inventoryId,
        inv.quantity AS qty,
        i.name,
        i.icon,
        i.type,
        i.effect_target,
        i.is_combat
      FROM inventory inv
      JOIN items i ON i.id = inv.item_id
      WHERE inv.inventory_id = ?
        AND inv.player_id = ?
      LIMIT 1
      `,
      [invId, pid]
    );

    if (!row || Number(row.qty) <= 0) return null;
    if (String(row.type) !== "potion") return null;
    if (Number(row.is_combat) !== 1) return null;
    if (String(row.effect_target).toLowerCase() !== expectedTarget) return null;

    return row;
  }

  const hpPotion = await loadPotion(potionCols?.hpInv ?? null, "hp");
  const spPotion = await loadPotion(potionCols?.spInv ?? null, "sp");

  // ============================
  // EQUIPPED GEAR
  // ============================
  const [gear]: any = await db.query(`
    SELECT
      inv.inventory_id AS instance_id,
      inv.item_id,
      inv.player_item_id,
      inv.equipped,

      -- static item path
      i.id AS static_item_id,
      i.name AS static_name,
      i.slot AS static_slot,
      i.icon AS static_icon,
      i.rarity AS static_rarity,
      i.description AS static_description,
      i.attack AS static_attack,
      i.defense AS static_defense,
      i.agility AS static_agility,
      i.vitality AS static_vitality,
      i.intellect AS static_intellect,
      i.crit AS static_crit,

      -- rolled item path
      pi.id AS rolled_player_item_id,
      pi.name AS rolled_name,
      pi.item_level AS rolled_item_level,
      pi.rarity AS rolled_rarity,
      pi.roll_json AS rolled_roll_json,

      ib.id AS base_id,
      ib.name AS base_name,
      ib.slot AS base_slot,
      ib.icon AS base_icon,
      ib.description AS base_description,
      ib.item_type AS base_item_type,
      ib.armor_weight AS base_armor_weight,
      ib.base_attack AS base_attack,
      ib.base_defense AS base_defense

    FROM inventory inv
    LEFT JOIN items i
      ON i.id = inv.item_id
    LEFT JOIN player_items pi
      ON pi.id = inv.player_item_id
    LEFT JOIN item_bases ib
      ON ib.id = pi.item_base_id
    WHERE inv.player_id = ?
      AND inv.equipped = 1
      AND (
        i.slot IS NOT NULL
        OR ib.slot IS NOT NULL
      )
  `, [pid]);

  const normalizedGear = (gear || []).map((g: any) => {
    const isRolled = !!g.player_item_id;
    const rolls = isRolled ? parseRollJson(g.rolled_roll_json) : [];

    return {
      instance_id: Number(g.instance_id),
      inventory_id: Number(g.instance_id),
      item_id: g.item_id != null ? Number(g.item_id) : null,
      player_item_id: g.player_item_id != null ? Number(g.player_item_id) : null,

      name: isRolled ? g.rolled_name : g.static_name,
      slot: isRolled ? g.base_slot : g.static_slot,
      icon: isRolled ? g.base_icon : g.static_icon,
      rarity: isRolled ? g.rolled_rarity : g.static_rarity,
      description: isRolled ? g.base_description : g.static_description,

      item_level: isRolled ? Number(g.rolled_item_level || 0) : null,
      item_type: isRolled ? g.base_item_type : null,
      armor_weight: isRolled ? g.base_armor_weight : null,
      base_attack: isRolled ? (Number(g.base_attack) || 0) : (Number(g.static_attack) || 0),
      base_defense: isRolled ? (Number(g.base_defense) || 0) : (Number(g.static_defense) || 0),

      attack: isRolled
        ? (Number(g.base_attack) || 0)
          + statFromRolls(rolls, "attack")
          + statFromRolls(rolls, "attack_power")
        : (Number(g.static_attack) || 0),

      defense: isRolled
        ? (Number(g.base_defense) || 0)
          + statFromRolls(rolls, "defense")
        : (Number(g.static_defense) || 0),

      agility: isRolled ? statFromRolls(rolls, "agility") : (Number(g.static_agility) || 0),
      vitality: isRolled ? statFromRolls(rolls, "vitality") : (Number(g.static_vitality) || 0),
      intellect: isRolled ? statFromRolls(rolls, "intellect") : (Number(g.static_intellect) || 0),
      crit: isRolled ? statFromRolls(rolls, "crit") : (Number(g.static_crit) || 0),

      roll_json: rolls,
      is_rolled: isRolled
    };
  });

  const equipped: any = {};
  normalizedGear.forEach((g: any) => {
    if (g.slot) equipped[g.slot] = g;
  });

  const gearBonus: Record<StatKey, number> = {
    attack: 0,
    defense: 0,
    agility: 0,
    vitality: 0,
    intellect: 0,
    crit: 0
  };

  normalizedGear.forEach((g: any) => {
    STAT_KEYS.forEach(stat => {
      if (g[stat]) gearBonus[stat] += Number(g[stat]) || 0;
    });
  });

  // ============================
  // BUFFS
  // ============================
  const [buffs]: any = await db.query(`
    SELECT stat, value
    FROM player_buffs
    WHERE player_id = ?
      AND expires_at > NOW()
  `, [pid]);

  const buffBonus: Record<StatKey, number> = {
    attack: 0,
    defense: 0,
    agility: 0,
    vitality: 0,
    intellect: 0,
    crit: 0
  };

  buffs.forEach((b: any) => {
    if (STAT_KEYS.includes(b.stat as StatKey)) {
      buffBonus[b.stat as StatKey] += Number(b.value) || 0;
    }
  });

  STAT_KEYS.forEach((stat) => {
    const base = Number(basePlayer?.[stat]) || 0;
    const gear = gearBonus[stat] || 0;
    const buff = buffBonus[stat] || 0;

    statBreakdown[stat] = {
      base,
      gear,
      buff,
      total: base + gear + buff
    };
  });

  // ============================
  // INVENTORY
  // ============================
  const [inv]: any = await db.query(`
    SELECT
      inv.inventory_id AS instance_id,
      inv.item_id,
      inv.player_item_id,
      inv.quantity,
      inv.equipped,

      -- static item path
      i.id AS static_item_id,
      i.name AS static_name,
      i.slot AS static_slot,
      i.icon AS static_icon,
      i.rarity AS static_rarity,
      i.description AS static_description,
      i.category AS static_category,
      i.type AS static_type,
      i.value AS static_value,
      i.effect_target AS static_effect_target,
      i.attack AS static_attack,
      i.defense AS static_defense,
      i.agility AS static_agility,
      i.vitality AS static_vitality,
      i.intellect AS static_intellect,
      i.crit AS static_crit,

      -- rolled item path
      pi.id AS rolled_player_item_id,
      pi.name AS rolled_name,
      pi.item_level AS rolled_item_level,
      pi.rarity AS rolled_rarity,
      pi.roll_json AS rolled_roll_json,

      ib.id AS base_id,
      ib.name AS base_name,
      ib.slot AS base_slot,
      ib.icon AS base_icon,
      ib.description AS base_description,
      ib.item_type AS base_item_type,
      ib.armor_weight AS base_armor_weight,
      ib.base_attack AS base_attack,
      ib.base_defense AS base_defense,
      ib.sell_value AS base_sell_value

    FROM inventory inv
    LEFT JOIN items i
      ON i.id = inv.item_id
    LEFT JOIN player_items pi
      ON pi.id = inv.player_item_id
    LEFT JOIN item_bases ib
      ON ib.id = pi.item_base_id
    WHERE inv.player_id = ?
    ORDER BY inv.equipped DESC, COALESCE(pi.name, i.name, ib.name) ASC
  `, [pid]);

  const normalizedInv = (inv || []).map((g: any) => {
    const isRolled = !!g.player_item_id;
    const rolls = isRolled ? parseRollJson(g.rolled_roll_json) : [];

    return {
      instance_id: Number(g.instance_id),
      item_id: g.item_id != null ? Number(g.item_id) : null,
      player_item_id: g.player_item_id != null ? Number(g.player_item_id) : null,
      quantity: Number(g.quantity || 1),
      equipped: Number(g.equipped || 0),

      name: isRolled ? g.rolled_name : g.static_name,
      slot: isRolled ? g.base_slot : g.static_slot,
      icon: isRolled ? g.base_icon : g.static_icon,
      rarity: isRolled ? g.rolled_rarity : g.static_rarity,
      description: isRolled ? g.base_description : g.static_description,

      category: isRolled ? "equipment" : g.static_category,
      type: isRolled ? "equipment" : g.static_type,
      effect_target: isRolled ? null : g.static_effect_target,
      value: isRolled ? Number(g.base_sell_value || 0) : Number(g.static_value || 0),

      item_level: isRolled ? Number(g.rolled_item_level || 0) : null,
      item_type: isRolled ? g.base_item_type : null,
      armor_weight: isRolled ? g.base_armor_weight : null,
      base_attack: isRolled ? (Number(g.base_attack) || 0) : (Number(g.static_attack) || 0),
      base_defense: isRolled ? (Number(g.base_defense) || 0) : (Number(g.static_defense) || 0),

      attack: isRolled
        ? (Number(g.base_attack) || 0)
          + statFromRolls(rolls, "attack")
          + statFromRolls(rolls, "attack_power")
        : (Number(g.static_attack) || 0),

      defense: isRolled
        ? (Number(g.base_defense) || 0)
          + statFromRolls(rolls, "defense")
        : (Number(g.static_defense) || 0),

      agility: isRolled ? statFromRolls(rolls, "agility") : (Number(g.static_agility) || 0),
      vitality: isRolled ? statFromRolls(rolls, "vitality") : (Number(g.static_vitality) || 0),
      intellect: isRolled ? statFromRolls(rolls, "intellect") : (Number(g.static_intellect) || 0),
      crit: isRolled ? statFromRolls(rolls, "crit") : (Number(g.static_crit) || 0),

      roll_json: rolls,
      is_rolled: isRolled
    };
  });

  const renderEquipSlot = (slotName: string, alt: string) => {
    const item = equipped[slotName];
    if (!item) {
      return `<div class="pd-slot ${slotName}" ondragover="event.preventDefault()" ondrop="dropEquip(event, '${slotName}')"><div class="pd-empty"></div></div>`;
    }

    return `
      <div class="pd-slot ${slotName}"
           ondragover="event.preventDefault()"
           ondrop="dropEquip(event, '${slotName}')">
        <div class="tooltip-parent"
             ${buildTooltipAttrs(item)}
             draggable="true"
             data-id="${item.instance_id}"
             ondblclick="unequipItem(${item.instance_id})">
          <img class="pd-img" src="${resolveIcon(item.icon)}" alt="${escapeHtml(alt)}"
               onerror="this.replaceWith(document.createTextNode('📦'))">
        </div>
      </div>
    `;
  };

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Guildforge | ${p.name} — Character</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/statpanel.css">
  <link rel="stylesheet" href="/ui/itemTooltip.css">
  <link rel="stylesheet" href="/character.css">
  <script defer src="/ui/itemTooltip.js"></script>
  <script defer src="/statpanel.js"></script>
  <script defer src="/character.js"></script>
</head>

<body>

<div id="statpanel-root"></div>

<div class="page-wrap">

  <div class="left-panel">

    <div class="char-box">
      <h2>${p.name}</h2>
      <p>Class: ${p.pclass}</p>
      <p>Level: ${p.level}</p>
      <p>XP: ${p.exper} / ${expToNext}</p>

      <div style="background:#222;border:1px solid gold;height:14px;border-radius:6px;overflow:hidden">
        <div style="width:${expPercent}%;height:100%;background:linear-gradient(to right,#d4af37,#aa8c3c)"></div>
      </div>

      <p style="font-size:12px">${expPercent}% to next level</p>

      <p>Gold: ${p.gold}</p>
      <p class="tooltip-container">
        HP: ${p.hpoints} / ${p.maxhp}
        <span class="tooltip">
          <strong>Max HP</strong>
          Base + Gear + Buffs
        </span>
      </p>

      <p>SP: ${p.spoints} / ${p.maxspoints}</p>
      <p>Crit Chance: ${(p.crit * 100).toFixed(1)}%</p>
    </div>

    <div class="char-box">
      <h3>Stats</h3>
      <p>Unspent Points: <span id="statPoints">${p.stat_points}</span></p>

      ${(STAT_KEYS.filter(s => s !== "crit") as Exclude<StatKey, "crit">[])
        .map((stat) => `
          <div class="stat-row">
            <span>${stat.charAt(0).toUpperCase() + stat.slice(1)}:</span>

            <span class="stat-value tooltip-container" id="${stat}">
              ${(p as any)[stat]}
              <div class="tooltip">
                <strong>${stat.toUpperCase()}</strong>
                <div>Base: ${statBreakdown[stat].base}</div>
                <div>Gear: +${statBreakdown[stat].gear}</div>
                <div>Buffs: +${statBreakdown[stat].buff}</div>
                <hr>
                <div><b>Total: ${statBreakdown[stat].total}</b></div>
              </div>
            </span>

            ${p.stat_points > 0 ? `<button onclick="addStat('${stat}')">+</button>` : ``}
          </div>
        `).join("")}

      <div style="text-align:center">
        <button class="return-btn" onclick="goBack()">⬅ Return</button>
      </div>
    </div>

  </div>

  <div class="center-panel">
    <div class="char-box">
      <h3>Equipped Gear</h3>

      <div class="paperdoll">
        ${renderEquipSlot("head", "Head")}
        ${renderEquipSlot("chest", "Chest")}
        ${renderEquipSlot("weapon", "Weapon")}
        ${renderEquipSlot("offhand", "Offhand")}
        ${renderEquipSlot("legs", "Legs")}
        ${renderEquipSlot("feet", "Feet")}
        ${renderEquipSlot("hands", "Hands")}
      </div>

      <div class="potionbar">
        <div class="potion-slot tooltip-container">
          <div class="potion-title">Health Potion</div>

          ${
            hpPotion
              ? `
                <div class="potion-inner" ondblclick="unequipPotion('health')">
                  <img class="potion-img" src="${resolveIcon(hpPotion.icon)}" onerror="this.style.display='none'">
                  <div class="stack-count">${hpPotion.qty}</div>

                  <div class="tooltip">
                    <strong>${hpPotion.name}</strong>
                    <div class="rarity">EQUIPPED</div>
                    <div>Slot: Health</div>
                  </div>
                </div>
              `
              : `<div class="potion-empty">Empty</div>`
          }
        </div>

        <div class="potion-slot tooltip-container">
          <div class="potion-title">Mana Potion</div>

          ${
            spPotion
              ? `
                <div class="potion-inner" ondblclick="unequipPotion('mana')">
                  <img class="potion-img" src="${resolveIcon(spPotion.icon)}" onerror="this.style.display='none'">
                  <div class="stack-count">${spPotion.qty}</div>

                  <div class="tooltip">
                    <strong>${spPotion.name}</strong>
                    <div class="rarity">EQUIPPED</div>
                    <div>Slot: Mana</div>
                  </div>
                </div>
              `
              : `<div class="potion-empty">Empty</div>`
          }
        </div>
      </div>
    </div>
  </div>

  <div class="right-panel">
    <div class="char-box">
      <div class="inv-panel-head">
        <h3 style="margin:0">Inventory</h3>
      </div>

      <input id="invSearch" class="inv-search" placeholder="Search items..." autocomplete="off" />

      <div class="inv-grid"
           ondragover="event.preventDefault()"
           ondrop="dropUnequip(event)">

      ${normalizedInv
        .filter((g: any) => !g.equipped)
        .map((g: any) => {
          const baseAttrs = buildTooltipAttrs({
            ...g,
            quantity: g.quantity
          });

          return `
            <div class="inv-item"
              ${baseAttrs}
              data-id="${g.instance_id}"
              data-slot="${g.slot || ""}"
              data-search="${escapeHtml((g.name || "").toLowerCase())}"
              data-qty="${Number(g.quantity || 1)}"

              draggable="true"
              ondblclick="${
                ["weapon","offhand","head","chest","legs","feet","hands"].includes(g.slot)
                  ? `equipItem(${g.instance_id})`
                  : (String(g.type) === "potion" && String(g.effect_target).toLowerCase() === "hp")
                      ? `equipPotion(${g.instance_id}, 'health')`
                      : (String(g.type) === "potion" && String(g.effect_target).toLowerCase() === "sp")
                          ? `equipPotion(${g.instance_id}, 'mana')`
                          : ``
              }"
            >
              <img src="${resolveIcon(g.icon)}" alt=""
                   onerror="this.style.display='none'">

              ${g.quantity > 1 ? `<div class="stack-count">${g.quantity}</div>` : ``}
            </div>
          `;
        }).join("")}
      </div>
    </div>
  </div>

</div>

</body>
</html>
`);
});

// =======================
// STAT SPEND API
// =======================
router.post("/character/stat", requireLogin, async (req, res) => {
  const pid = req.session.playerId;
  const { stat } = req.body;

  const allowed = ["attack", "defense", "agility", "vitality", "intellect"];
  if (!allowed.includes(stat)) {
    return res.json({ error: "Invalid stat" });
  }

  const [[player]]: any = await db.query(
    "SELECT stat_points FROM players WHERE id=?",
    [pid]
  );

  if (!player || player.stat_points <= 0) {
    return res.json({ error: "No stat points available" });
  }

  await db.query(`
    UPDATE players
    SET ${stat} = ${stat} + 1,
        stat_points = stat_points - 1
    WHERE id=?
  `, [pid]);

  const [[updated]]: any = await db.query(`
    SELECT ${stat} AS value, stat_points
    FROM players WHERE id=?
  `, [pid]);

  res.json(updated);
});

// =======================
// EQUIP ITEMS
// =======================
router.post("/character/equip", requireLogin, async (req, res) => {
  const pid = req.session.playerId;
  const { inventoryId } = req.body;

  if (!inventoryId) {
    return res.json({ error: "Missing inventoryId" });
  }

  const [[row]]: any = await db.query(`
    SELECT
      inv.inventory_id,
      inv.item_id,
      inv.player_item_id,
      inv.quantity,
      i.slot AS static_slot,
      ib.slot AS rolled_slot
    FROM inventory inv
    LEFT JOIN items i
      ON i.id = inv.item_id
    LEFT JOIN player_items pi
      ON pi.id = inv.player_item_id
    LEFT JOIN item_bases ib
      ON ib.id = pi.item_base_id
    WHERE inv.inventory_id = ?
      AND inv.player_id = ?
    LIMIT 1
  `, [inventoryId, pid]);

  const slot = row?.rolled_slot || row?.static_slot;

  if (!row || !slot) {
    return res.json({ error: "Invalid item" });
  }

  const ALLOWED_SLOTS = new Set([
    "weapon",
    "offhand",
    "head",
    "chest",
    "legs",
    "feet",
    "hands"
  ]);

  if (!ALLOWED_SLOTS.has(slot)) {
    return res.json({ error: "That item cannot be equipped." });
  }

  const [equippedRows]: any = await db.query(`
    SELECT
      inv.inventory_id,
      inv.player_item_id
    FROM inventory inv
    LEFT JOIN items i
      ON i.id = inv.item_id
    LEFT JOIN player_items pi
      ON pi.id = inv.player_item_id
    LEFT JOIN item_bases ib
      ON ib.id = pi.item_base_id
    WHERE inv.player_id = ?
      AND inv.equipped = 1
      AND (
        i.slot = ?
        OR ib.slot = ?
      )
  `, [pid, slot, slot]);

  for (const eq of equippedRows || []) {
    await db.query(
      `UPDATE inventory SET equipped = 0 WHERE inventory_id = ? AND player_id = ?`,
      [eq.inventory_id, pid]
    );

    if (eq.player_item_id) {
      await db.query(
        `UPDATE player_items SET is_equipped = 0 WHERE id = ? AND player_id = ?`,
        [eq.player_item_id, pid]
      );
    }
  }

  if (row.player_item_id) {
    await db.query(
      `UPDATE inventory SET equipped = 1 WHERE inventory_id = ? AND player_id = ?`,
      [row.inventory_id, pid]
    );

    await db.query(
      `UPDATE player_items SET is_equipped = 1 WHERE id = ? AND player_id = ?`,
      [row.player_item_id, pid]
    );

    return res.json({ success: true });
  }

  if (Number(row.quantity) > 1) {
    await db.query(
      `UPDATE inventory SET quantity = quantity - 1 WHERE inventory_id = ?`,
      [row.inventory_id]
    );

    await db.query(
      `INSERT INTO inventory (player_id, item_id, player_item_id, quantity, equipped) VALUES (?, ?, NULL, 1, 1)`,
      [pid, row.item_id]
    );
  } else {
    await db.query(
      `UPDATE inventory SET equipped = 1 WHERE inventory_id = ?`,
      [row.inventory_id]
    );
  }

  res.json({ success: true });
});

// =======================
// EQUIP POTIONS
// =======================
router.post("/character/equip-potion", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;
  const slot = String(req.body.slot || "");
  const inventoryId = Number(req.body.inventoryId);

  const expectedTarget =
    slot === "health" ? "hp" :
    slot === "mana" ? "sp" :
    null;

  if (!expectedTarget || !Number.isFinite(inventoryId)) {
    return res.json({ error: "Invalid slot or inventoryId" });
  }

  const [[row]]: any = await db.query(
    `
    SELECT
      inv.inventory_id,
      inv.player_id,
      inv.quantity,
      inv.equipped,
      i.type,
      i.effect_target,
      i.is_combat
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ?
      AND inv.player_id = ?
    LIMIT 1
    `,
    [inventoryId, pid]
  );

  if (!row) return res.json({ error: "Potion not found" });
  if (Number(row.quantity) <= 0) return res.json({ error: "No quantity remaining" });
  if (String(row.type) !== "potion") return res.json({ error: "Item is not a potion" });
  if (Number(row.is_combat) !== 1) return res.json({ error: "Potion is not usable in combat" });
  if (String(row.effect_target || "").toLowerCase() !== expectedTarget) {
    return res.json({ error: "Potion doesn't match that slot" });
  }

  if (slot === "health") {
    await db.query(
      `UPDATE players SET equip_potion_hp_inventory_id=? WHERE id=?`,
      [inventoryId, pid]
    );
  } else {
    await db.query(
      `UPDATE players SET equip_potion_sp_inventory_id=? WHERE id=?`,
      [inventoryId, pid]
    );
  }

  res.json({ success: true });
});

router.post("/character/unequip-potion", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;
  const slot = String(req.body.slot || "");

  const col =
    slot === "health" ? "equip_potion_hp_inventory_id" :
    slot === "mana" ? "equip_potion_sp_inventory_id" :
    null;

  if (!col) return res.json({ error: "Invalid slot" });

  await db.query(`UPDATE players SET ${col} = NULL WHERE id=?`, [pid]);
  res.json({ success: true });
});

// =======================
// UNEQUIP ITEMS
// =======================
router.post("/character/unequip", requireLogin, async (req, res) => {
  const pid = req.session.playerId;
  const { inventoryId } = req.body;
  if (!inventoryId) return res.json({ error: "Missing inventoryId" });

  const [[row]]: any = await db.query(`
    SELECT inventory_id, item_id, player_item_id, quantity
    FROM inventory
    WHERE inventory_id = ? AND player_id = ? AND equipped = 1
  `, [inventoryId, pid]);

  if (!row) return res.json({ error: "Item not found or not equipped" });

  if (row.player_item_id) {
    await db.query(
      `UPDATE inventory SET equipped = 0 WHERE inventory_id = ? AND player_id = ?`,
      [row.inventory_id, pid]
    );

    await db.query(
      `UPDATE player_items SET is_equipped = 0 WHERE id = ? AND player_id = ?`,
      [row.player_item_id, pid]
    );

    return res.json({ success: true });
  }

  const [[stack]]: any = await db.query(`
    SELECT inventory_id, quantity
    FROM inventory
    WHERE player_id = ? AND item_id = ? AND equipped = 0
    LIMIT 1
  `, [pid, row.item_id]);

  if (stack) {
    await db.query(
      `UPDATE inventory SET quantity = quantity + ? WHERE inventory_id = ?`,
      [row.quantity, stack.inventory_id]
    );

    await db.query(
      `DELETE FROM inventory WHERE inventory_id = ?`,
      [row.inventory_id]
    );
  } else {
    await db.query(
      `UPDATE inventory SET equipped = 0 WHERE inventory_id = ? AND player_id = ?`,
      [row.inventory_id, pid]
    );
  }

  res.json({ success: true });
});

export default router;