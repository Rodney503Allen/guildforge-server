//character.routes.ts
import { Router } from "express";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";
import {
  getInventoryCapacity,
  getUsedInventorySlots,
  hasInventorySpace
} from "./services/inventoryCapacityService";

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
// EQUIPPED TOOL API
// =======================
async function loadTool(pid: number, invId: number | null, expectedType: string) {
  if (!invId) return null;

  const [[row]]: any = await db.query(
    `
    SELECT
      inv.inventory_id AS inventoryId,
      inv.quantity AS qty,
      i.name,
      i.icon,
      i.type,
      i.item_type,
      i.description
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ?
      AND inv.player_id = ?
    LIMIT 1
    `,
    [invId, pid]
  );

  if (!row || Number(row.qty) <= 0) return null;
  if (String(row.type) !== "tool") return null;
  if (String(row.item_type) !== expectedType) return null;

  return row;
}

const renderToolSlot = (label: string, tool: any, slot: string) => `
  <div class="tool-slot tooltip-container">
    <div class="tool-title">${label}</div>

    ${
      tool
        ? `
          <div class="tool-inner" ondblclick="unequipTool('${slot}')">
            <img class="tool-img" src="${resolveIcon(tool.icon)}" onerror="this.style.display='none'">
            <div class="tooltip">
              <strong>${escapeHtml(tool.name)}</strong>
              <div class="rarity">EQUIPPED TOOL</div>
              <div>${escapeHtml(tool.description || "")}</div>
            </div>
          </div>
        `
        : `<div class="tool-empty">Empty</div>`
    }
  </div>
`;

// =======================
// AVATAR API
// =======================
router.get("/character/avatars", requireLogin, async (req, res) => {
  try {
    const pid = Number(req.session.playerId);

    const [avatars]: any = await db.query(
      `
      SELECT
        a.id,
        a.name,
        a.image_url,
        a.rarity,
        a.source,
        a.description,
        a.display_order,

      CASE
        WHEN a.source = 'Default' THEN 1
        WHEN pa.avatar_id IS NOT NULL THEN 1
        ELSE 0
      END AS unlocked

        CASE
          WHEN p.equipped_avatar_id = a.id THEN 1
          ELSE 0
        END AS equipped

      FROM avatars a

      JOIN players p
        ON p.id = ?

      LEFT JOIN player_avatars pa
        ON pa.avatar_id = a.id
        AND pa.player_id = p.id

      WHERE a.is_active = 1

      ORDER BY
        a.display_order ASC,
        a.id ASC
      `,
      [pid]
    );

    res.json({
      avatars: (avatars || []).map((avatar: any) => ({
        id: Number(avatar.id),
        name: avatar.name,
        image_url: avatar.image_url,
        rarity: avatar.rarity || "common",
        source: avatar.source || "",
        description: avatar.description || "",
        unlocked: Number(avatar.unlocked) === 1,
        equipped: Number(avatar.equipped) === 1
      }))
    });
  } catch (err) {
    console.error("LOAD AVATARS FAILED:", err);

    res.status(500).json({
      error: "Could not load avatars."
    });
  }
});

router.post("/character/avatar/equip", requireLogin, async (req, res) => {
  try {
    const pid = Number(req.session.playerId);
    const avatarId = Number(req.body.avatarId);

    if (!Number.isInteger(avatarId) || avatarId <= 0) {
      return res.status(400).json({
        error: "Invalid avatar."
      });
    }

    const [[avatar]]: any = await db.query(
      `
      SELECT
        a.id,
        a.name,
        a.image_url,
        a.rarity,
        a.source,
        a.description
      FROM avatars a

      LEFT JOIN player_avatars pa 
        ON pa.avatar_id = a.id
        AND pa.player_id = ?

      WHERE a.id = ?
        AND a.is_active = 1
        AND (
          a.source = 'Default'
          OR pa.avatar_id IS NOT NULL
        )

      LIMIT 1
      `,
      [pid, avatarId]
    );

    if (!avatar) {
      return res.status(403).json({
        error: "You have not unlocked that avatar."
      });
    }

    await db.query(
      `
      UPDATE players
      SET equipped_avatar_id = ?
      WHERE id = ?
      `,
      [avatarId, pid]
    );

    res.json({
      success: true,
      avatar: {
        id: Number(avatar.id),
        name: avatar.name,
        image_url: avatar.image_url,
        rarity: avatar.rarity || "common",
        source: avatar.source || "",
        description: avatar.description || ""
      }
    });
  } catch (err) {
    console.error("EQUIP AVATAR FAILED:", err);

    res.status(500).json({
      error: "Could not equip that avatar."
    });
  }
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

  const [[equippedAvatar]]: any = await db.query(
    `
    SELECT
      a.id,
      a.name,
      a.image_url,
      a.rarity,
      a.source,
      a.description
    FROM players p

    LEFT JOIN avatars a
      ON a.id = p.equipped_avatar_id
      AND a.is_active = 1

    WHERE p.id = ?

    LIMIT 1
    `,
    [pid]
  );

  const equippedAvatarUrl =
    equippedAvatar?.image_url
      ? resolveIcon(equippedAvatar.image_url)
      : "/images/avatars/default_adventurer.webp";

  const equippedAvatarName =
    equippedAvatar?.name || "Adventurer";

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

      i.id AS static_item_id,
      i.name AS static_name,
      i.slot AS static_slot,
      i.icon AS static_icon,
      i.rarity AS static_rarity,
      i.description AS static_description,
      i.category AS static_category,
      i.type AS static_type,
      i.item_type AS static_item_type,
      i.value AS static_value,
      i.effect_target AS static_effect_target,
      i.attack AS static_attack,
      i.defense AS static_defense,
      i.agility AS static_agility,
      i.vitality AS static_vitality,
      i.intellect AS static_intellect,
      i.crit AS static_crit,

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
      AND inv.equipped = 0
    ORDER BY COALESCE(pi.name, i.name, ib.name) ASC
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
      item_type: isRolled
        ? g.base_item_type
        : g.static_item_type,
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

  const [[toolCols]]: any = await db.query(
    `
    SELECT
      equip_tool_mining_inventory_id AS miningInv,
      equip_tool_herbalism_inventory_id AS herbalismInv,
      equip_tool_woodcutting_inventory_id AS woodcuttingInv
    FROM players
    WHERE id = ?
    `,
    [pid]
  );

  const miningTool = await loadTool(pid, toolCols?.miningInv ?? null, "mining_tool");
  const herbalismTool = await loadTool(pid, toolCols?.herbalismInv ?? null, "herbalism_tool");
  const woodcuttingTool = await loadTool(pid, toolCols?.woodcuttingInv ?? null, "woodcutting_tool");

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

  const inventoryUsed = await getUsedInventorySlots(pid);
  const inventoryCapacity = await getInventoryCapacity(pid);

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Guildforge | ${p.name} — Character</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/statpanel.css">
  <link rel="stylesheet" href="/ui/toast.css">
  <link rel="stylesheet" href="/ui/itemTooltip.css">
  <link rel="stylesheet" href="/character.css">

  <script src="/ui/toast.js"></script>
  <script defer src="/ui/itemTooltip.js"></script>
  <script defer src="/statpanel.js"></script>
  <script defer src="/character.js?v=6"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <main class="character-page">
    <section class="page-wrap frame-host">
      <span class="frame-border main" aria-hidden="true"></span>

      <header class="character-hero">
        <div class="character-hero-title">
          <div class="character-hero-icon">⚔️</div>

          <div>
            <h1>Character</h1>
            <p>${p.name} • ${p.class_name} • Level ${p.level}</p>
          </div>
        </div>

        <div class="character-hero-actions">
          <span class="character-gold-pill">
            Gold: <strong>${Number(p.gold || 0)}g</strong>
          </span>

          <button
            type="button"
            class="character-return-btn"
            onclick="goBack()"
          >
            Return
          </button>
        </div>

        <span class="character-hero-divider" aria-hidden="true"></span>
      </header>

      <div class="left-panel">
        <section class="char-box frame-host">
          <span class="frame-border panel" aria-hidden="true"></span>

          <h2>${p.name}</h2>

          <div class="character-avatar-section">
            <div class="character-avatar-frame">
              <img
                id="characterAvatarImage"
                class="character-avatar-image"
                src="${equippedAvatarUrl}"
                alt="${escapeHtml(equippedAvatarName)}"
                onerror="
                  this.onerror = null;
                  this.src = '/images/avatars/default_adventurer.webp';
                "
              >

              <div class="character-avatar-shade"></div>
            </div>

            <div class="character-avatar-meta">
              <div
                id="characterAvatarName"
                class="character-avatar-name"
              >
                ${escapeHtml(equippedAvatarName)}
              </div>

              <button
                type="button"
                class="change-avatar-btn"
                onclick="openAvatarSelector()"
              >
                Choose Avatar
              </button>
            </div>
          </div>

          <div class="character-summary">
            <div class="summary-row">
              <span>Class</span>
              <strong>${p.class_name}</strong>
            </div>

            <div class="summary-row">
              <span>Level</span>
              <strong>${p.level}</strong>
            </div>

            <div class="summary-row">
              <span>Experience</span>
              <strong>${p.exper} / ${expToNext}</strong>
            </div>

            <div class="experience-bar">
              <div
                class="experience-bar-fill"
                style="width:${expPercent}%"
              ></div>
            </div>

            <p class="experience-caption">
              ${expPercent}% to next level
            </p>

            <div class="summary-divider"></div>

            <div class="summary-row">
              <span>Health</span>

              <strong class="tooltip-container">
                ${p.hpoints} / ${p.maxhp}

                <span class="tooltip">
                  <strong>Maximum Health</strong>
                  Base + Gear + Buffs
                </span>
              </strong>
            </div>

            <div class="summary-row">
              <span>Skill Points</span>
              <strong>${p.spoints} / ${p.maxspoints}</strong>
            </div>

            <div class="summary-row">
              <span>Critical Chance</span>
              <strong>${(p.crit * 100).toFixed(1)}%</strong>
            </div>

            <div class="summary-row">
              <span>Dodge Chance</span>

              <strong class="tooltip-container">
                ${(p.dodgeChance * 100).toFixed(1)}%

                <span class="tooltip">
                  <strong>Dodge Chance</strong>
                  Chance to completely avoid an incoming attack.
                </span>
              </strong>
            </div>
          </div>
        </section>

        <section class="char-box frame-host">
          <span class="frame-border panel" aria-hidden="true"></span>

          <div class="character-card-header">
            <h3>Attributes</h3>

            <span class="stat-points-pill">
              <span id="statPoints">${p.stat_points}</span> Available
            </span>
          </div>

          <div class="stats-list">
            ${(STAT_KEYS.filter(
              (s) => s !== "crit"
            ) as Exclude<StatKey, "crit">[])
              .map(
                (stat) => `
                  <div class="stat-row">
                    <span class="stat-label">
                      ${stat.charAt(0).toUpperCase() + stat.slice(1)}
                    </span>

                    <span
                      class="stat-value tooltip-container"
                      id="${stat}"
                    >
                      ${(p as any)[stat]}

                      <span class="tooltip">
                        <strong>${stat.toUpperCase()}</strong>
                        <div>Base: ${statBreakdown[stat].base}</div>
                        <div>Gear: +${statBreakdown[stat].gear}</div>
                        <div>Buffs: +${statBreakdown[stat].buff}</div>
                        <hr>
                        <div>
                          <b>Total: ${statBreakdown[stat].total}</b>
                        </div>
                      </span>
                    </span>

                    ${
                      p.stat_points > 0
                        ? `
                          <button
                            type="button"
                            class="stat-add-btn"
                            aria-label="Add one point to ${stat}"
                            onclick="addStat('${stat}')"
                          >
                            +
                          </button>
                        `
                        : `<span class="stat-button-placeholder"></span>`
                    }
                  </div>
                `
              )
              .join("")}
          </div>
        </section>
      </div>

      <div class="center-panel">
        <section class="char-box equipment-card frame-host">
          <span class="frame-border panel" aria-hidden="true"></span>

          <div class="character-card-header">
            <div>
              <h3>Equipped Gear</h3>
              <p>Your currently equipped combat equipment.</p>
            </div>
          </div>

          <div class="paperdoll frame-host">
            <span class="frame-border sub" aria-hidden="true"></span>

            ${renderEquipSlot("head", "Head")}
            ${renderEquipSlot("chest", "Chest")}
            ${renderEquipSlot("weapon", "Weapon")}
            ${renderEquipSlot("offhand", "Offhand")}
            ${renderEquipSlot("legs", "Legs")}
            ${renderEquipSlot("feet", "Feet")}
            ${renderEquipSlot("hands", "Hands")}
          </div>

          <div class="quickbelt">
            <div class="potion-slot tooltip-container">
              <div class="potion-title">Health</div>

              ${
                hpPotion
                  ? `
                    <div
                      class="potion-inner"
                      ondblclick="unequipPotion('health')"
                    >
                      <img
                        class="potion-img"
                        src="${resolveIcon(hpPotion.icon)}"
                        alt="${escapeHtml(hpPotion.name || "Health potion")}"
                        onerror="this.style.display='none'"
                      >

                      <div class="stack-count">${hpPotion.qty}</div>

                      <div class="tooltip">
                        <strong>${hpPotion.name}</strong>
                        <div class="rarity">Equipped</div>
                        <div>Slot: Health</div>
                      </div>
                    </div>
                  `
                  : `<div class="potion-empty">Empty</div>`
              }
            </div>

            ${renderToolSlot("Mining", miningTool, "mining")}
            ${renderToolSlot("Herbalism", herbalismTool, "herbalism")}
            ${renderToolSlot("Woodcutting", woodcuttingTool, "woodcutting")}

            <div class="potion-slot tooltip-container">
              <div class="potion-title">Mana</div>

              ${
                spPotion
                  ? `
                    <div
                      class="potion-inner"
                      ondblclick="unequipPotion('mana')"
                    >
                      <img
                        class="potion-img"
                        src="${resolveIcon(spPotion.icon)}"
                        alt="${escapeHtml(spPotion.name || "Mana potion")}"
                        onerror="this.style.display='none'"
                      >

                      <div class="stack-count">${spPotion.qty}</div>

                      <div class="tooltip">
                        <strong>${spPotion.name}</strong>
                        <div class="rarity">Equipped</div>
                        <div>Slot: Mana</div>
                      </div>
                    </div>
                  `
                  : `<div class="potion-empty">Empty</div>`
              }
            </div>
          </div>
        </section>
      </div>

      <div class="right-panel">
        <section class="char-box inventory-card frame-host">
          <span class="frame-border panel" aria-hidden="true"></span>

          <div class="inventory-header">
            <div>
              <h3>Inventory</h3>
              <p>Double-click an item to equip it.</p>
            </div>

            <span class="inventory-space">
              ${inventoryUsed} / ${inventoryCapacity}
            </span>
          </div>

          <input
            id="invSearch"
            class="inv-search"
            type="search"
            placeholder="Search items..."
            autocomplete="off"
            aria-label="Search inventory"
          >

          <div
            class="inv-grid"
            ondragover="event.preventDefault()"
            ondrop="dropUnequip(event)"
          >
            ${normalizedInv
              .filter((g: any) => !g.equipped)
              .map((g: any) => {
                const baseAttrs = buildTooltipAttrs({
                  ...g,
                  quantity: g.quantity
                });

                const doubleClickAction =
                  [
                    "weapon",
                    "offhand",
                    "head",
                    "chest",
                    "legs",
                    "feet",
                    "hands"
                  ].includes(g.slot)
                    ? `equipItem(${g.instance_id})`
                    : String(g.type) === "potion" &&
                        String(g.effect_target).toLowerCase() === "hp"
                      ? `equipPotion(${g.instance_id}, 'health')`
                      : String(g.type) === "potion" &&
                          String(g.effect_target).toLowerCase() === "sp"
                        ? `equipPotion(${g.instance_id}, 'mana')`
                        : String(g.type) === "tool" &&
                            String(g.item_type) === "mining_tool"
                          ? `equipTool(${g.instance_id}, 'mining')`
                          : String(g.type) === "tool" &&
                              String(g.item_type) === "herbalism_tool"
                            ? `equipTool(${g.instance_id}, 'herbalism')`
                            : String(g.type) === "tool" &&
                                String(g.item_type) === "woodcutting_tool"
                              ? `equipTool(${g.instance_id}, 'woodcutting')`
                              : "";

                return `
                  <div
                    class="inv-item"
                    ${baseAttrs}
                    data-id="${g.instance_id}"
                    data-slot="${g.slot || ""}"
                    data-item-type="${g.item_type || ""}"
                    data-search="${escapeHtml(
                      (g.name || "").toLowerCase()
                    )}"
                    data-qty="${Number(g.quantity || 1)}"
                    draggable="true"
                    ${
                      doubleClickAction
                        ? `ondblclick="${doubleClickAction}"`
                        : ""
                    }
                  >
                    <img
                      src="${resolveIcon(g.icon)}"
                      alt="${escapeHtml(g.name || "")}"
                      onerror="this.style.display='none'"
                    >

                    ${
                      g.quantity > 1
                        ? `<div class="stack-count">${g.quantity}</div>`
                        : ""
                    }
                  </div>
                `;
              })
              .join("")}
          </div>
        </section>
      </div>

      <section class="char-box skill-loadout-panel frame-host">
        <span class="frame-border panel" aria-hidden="true"></span>

        <div class="skill-panel-header">
          <div>
            <h3>Combat Skills</h3>
            <p>
              Choose up to six learned skills for your combat hotbar.
              Select a skill and then choose a slot.
            </p>
          </div>

          <div class="skill-loadout-count">
            <span id="equippedSkillCount">0</span> / 6 Equipped
          </div>
        </div>

        <div class="skill-loadout-layout">
          <div class="skill-library-section frame-host">
            <span class="frame-border sub" aria-hidden="true"></span>

            <div class="skill-section-title">Learned Skills</div>

            <div
              id="disciplineSkillLibrary"
              class="discipline-skill-library"
            >
              <div class="skills-loading">
                Loading learned skills...
              </div>
            </div>
          </div>

          <div class="skill-hotbar-section frame-host">
            <span class="frame-border sub" aria-hidden="true"></span>

            <div class="skill-section-title">Combat Hotbar</div>

            <div
              id="skillHotbar"
              class="skill-hotbar"
            ></div>

            <p class="skill-help">
              Drag slots to reorder. Double-click an equipped skill to remove it.
            </p>
          </div>
        </div>
      </section>
    </section>
  </main>

  <div
    id="avatarSelectorModal"
    class="avatar-selector-modal"
    aria-hidden="true"
  >
    <div
      class="avatar-selector-backdrop"
      onclick="closeAvatarSelector()"
    ></div>

    <section
      class="avatar-selector-window frame-host"
      role="dialog"
      aria-modal="true"
      aria-labelledby="avatarSelectorTitle"
    >
      <span
        class="frame-border main"
        aria-hidden="true"
      ></span>

      <header class="avatar-selector-header">
        <div>
          <h2 id="avatarSelectorTitle">
            Avatar Collection
          </h2>

          <p>
            Choose from the avatars you have unlocked.
          </p>
        </div>

        <button
          type="button"
          class="avatar-selector-close"
          onclick="closeAvatarSelector()"
          aria-label="Close avatar selector"
        >
          ×
        </button>
      </header>

      <div
        id="avatarCollectionGrid"
        class="avatar-collection-grid"
      >
        <div class="avatars-loading">
          Loading avatars...
        </div>
      </div>
    </section>
  </div>
</body></html>
`);
});

// =======================
// STAT SPEND API
// =======================
router.post("/character/stat", requireLogin, async (req, res) => {
  const pid = Number(req.session.playerId);

  if (!Number.isFinite(pid)) {
    return res.json({ error: "Not logged in" });
  }

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

  const finalStats = await getFinalPlayerStats(pid);

  if (!finalStats) {
    return res.json({ error: "Could not recalculate player stats" });
  }

  res.json({
    value: (finalStats as any)[stat],
    stat_points: finalStats.stat_points
  });
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

  const col =
    slot === "health" ? "equip_potion_hp_inventory_id" :
    slot === "mana" ? "equip_potion_sp_inventory_id" :
    null;

  if (!expectedTarget || !col || !Number.isFinite(inventoryId)) {
    return res.json({ error: "Invalid slot or inventoryId" });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [[player]]: any = await conn.query(
      `
      SELECT
        equip_potion_hp_inventory_id,
        equip_potion_sp_inventory_id
      FROM players
      WHERE id = ?
      LIMIT 1
      `,
      [pid]
    );

    if (!player) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Player not found" });
    }

    const oldInventoryId = Number(player[col] || 0);

    const [[row]]: any = await conn.query(
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

    if (!row) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Potion not found" });
    }

    if (Number(row.quantity) <= 0) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "No quantity remaining" });
    }

    if (String(row.type) !== "potion") {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Item is not a potion" });
    }

    if (Number(row.is_combat) !== 1) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Potion is not usable in combat" });
    }

    if (String(row.effect_target || "").toLowerCase() !== expectedTarget) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Potion doesn't match that slot" });
    }

    if (oldInventoryId && oldInventoryId !== inventoryId) {
      await conn.query(
        `
        UPDATE inventory
        SET equipped = 0
        WHERE inventory_id = ?
          AND player_id = ?
        `,
        [oldInventoryId, pid]
      );
    }

    await conn.query(
      `
      UPDATE inventory
      SET equipped = 1
      WHERE inventory_id = ?
        AND player_id = ?
      `,
      [inventoryId, pid]
    );

    await conn.query(
      `UPDATE players SET ${col} = ? WHERE id = ?`,
      [inventoryId, pid]
    );

    await conn.commit();
    conn.release();

    res.json({ success: true });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    conn.release();
    console.error("equip potion failed:", err);
    res.json({ error: "Failed to equip potion" });
  }
});

router.post("/character/unequip-potion", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;
  const slot = String(req.body.slot || "");

  const col =
    slot === "health" ? "equip_potion_hp_inventory_id" :
    slot === "mana" ? "equip_potion_sp_inventory_id" :
    null;

  if (!col) return res.json({ error: "Invalid slot" });

  const space = await hasInventorySpace(pid, 1);

  if (!space.hasSpace) {
    return res.json({
      error: `Inventory full (${space.used}/${space.capacity}). Sell, use, or equip something first.`
    });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [[player]]: any = await conn.query(
      `SELECT ${col} AS inventoryId FROM players WHERE id = ? LIMIT 1`,
      [pid]
    );

    const oldInventoryId = Number(player?.inventoryId || 0);

    if (oldInventoryId) {
      await conn.query(
        `
        UPDATE inventory
        SET equipped = 0
        WHERE inventory_id = ?
          AND player_id = ?
        `,
        [oldInventoryId, pid]
      );
    }

    await conn.query(
      `UPDATE players SET ${col} = NULL WHERE id = ?`,
      [pid]
    );

    await conn.commit();
    conn.release();

    res.json({ success: true });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    conn.release();
    console.error("unequip potion failed:", err);
    res.json({ error: "Failed to unequip potion" });
  }
});

// =======================
// EQUIP TOOLS
// =======================
router.post("/character/equip-tool", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;
  const slot = String(req.body.slot || "");
  const inventoryId = Number(req.body.inventoryId);

  const expectedType =
    slot === "mining" ? "mining_tool" :
    slot === "herbalism" ? "herbalism_tool" :
    slot === "woodcutting" ? "woodcutting_tool" :
    null;

  const col =
    slot === "mining" ? "equip_tool_mining_inventory_id" :
    slot === "herbalism" ? "equip_tool_herbalism_inventory_id" :
    slot === "woodcutting" ? "equip_tool_woodcutting_inventory_id" :
    null;

  if (!expectedType || !col || !Number.isFinite(inventoryId)) {
    return res.json({ error: "Invalid tool slot or inventoryId" });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [[player]]: any = await conn.query(
      `SELECT ${col} AS oldInventoryId FROM players WHERE id = ? LIMIT 1`,
      [pid]
    );

    if (!player) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Player not found" });
    }

    const oldInventoryId = Number(player.oldInventoryId || 0);

    const [[row]]: any = await conn.query(
      `
      SELECT
        inv.inventory_id,
        inv.player_id,
        inv.quantity,
        inv.equipped,
        i.type,
        i.item_type
      FROM inventory inv
      JOIN items i ON i.id = inv.item_id
      WHERE inv.inventory_id = ?
        AND inv.player_id = ?
      LIMIT 1
      `,
      [inventoryId, pid]
    );

    if (!row) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Tool not found" });
    }

    if (Number(row.quantity) <= 0) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "No quantity remaining" });
    }

    if (String(row.type) !== "tool") {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Item is not a tool" });
    }

    if (String(row.item_type) !== expectedType) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Tool does not match that slot" });
    }

    if (oldInventoryId && oldInventoryId !== inventoryId) {
      await conn.query(
        `UPDATE inventory SET equipped = 0 WHERE inventory_id = ? AND player_id = ?`,
        [oldInventoryId, pid]
      );
    }

    await conn.query(
      `UPDATE inventory SET equipped = 1 WHERE inventory_id = ? AND player_id = ?`,
      [inventoryId, pid]
    );

    await conn.query(
      `UPDATE players SET ${col} = ? WHERE id = ?`,
      [inventoryId, pid]
    );

    await conn.commit();
    conn.release();

    res.json({ success: true });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    conn.release();
    console.error("equip tool failed:", err);
    res.json({ error: "Failed to equip tool" });
  }
});

router.post("/character/unequip-tool", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;
  const slot = String(req.body.slot || "");

  const col =
    slot === "mining" ? "equip_tool_mining_inventory_id" :
    slot === "herbalism" ? "equip_tool_herbalism_inventory_id" :
    slot === "woodcutting" ? "equip_tool_woodcutting_inventory_id" :
    null;

  if (!col) return res.json({ error: "Invalid tool slot" });

  const space = await hasInventorySpace(pid, 1);

  if (!space.hasSpace) {
    return res.json({
      error: `Inventory full (${space.used}/${space.capacity}). Sell, use, or equip something first.`
    });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [[player]]: any = await conn.query(
      `SELECT ${col} AS inventoryId FROM players WHERE id = ? LIMIT 1`,
      [pid]
    );

    const oldInventoryId = Number(player?.inventoryId || 0);

    if (oldInventoryId) {
      await conn.query(
        `UPDATE inventory SET equipped = 0 WHERE inventory_id = ? AND player_id = ?`,
        [oldInventoryId, pid]
      );
    }

    await conn.query(
      `UPDATE players SET ${col} = NULL WHERE id = ?`,
      [pid]
    );

    await conn.commit();
    conn.release();

    res.json({ success: true });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    conn.release();
    console.error("unequip tool failed:", err);
    res.json({ error: "Failed to unequip tool" });
  }
});

// =======================
// UNEQUIP ITEMS
// =======================
router.post("/character/unequip", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;
  const { inventoryId } = req.body;

  if (!inventoryId) return res.json({ error: "Missing inventoryId" });

  const [[row]]: any = await db.query(`
    SELECT inventory_id, item_id, player_item_id, quantity
    FROM inventory
    WHERE inventory_id = ? AND player_id = ? AND equipped = 1
  `, [inventoryId, pid]);

  if (!row) return res.json({ error: "Item not found or not equipped" });

  const space = await hasInventorySpace(pid, 1);

  if (!space.hasSpace) {
    return res.json({
      error: `Inventory full (${space.used}/${space.capacity}). Sell, use, or equip something first.`
    });
  }

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
