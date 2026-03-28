import express from "express";
import { db } from "./db";
import { addItemAtomic } from "./services/inventoryService";

const router = express.Router();

type ClassShopLoadout = {
  armorWeights: string[];
  weaponSlots: string[];
  offhandSlots: string[];
};

const CLASS_LOADOUTS: Record<string, ClassShopLoadout> = {
  Mage: {
    armorWeights: ["light"],
    weaponSlots: ["weapon"],
    offhandSlots: ["offhand"]
  },
  Warlock: {
    armorWeights: ["light"],
    weaponSlots: ["weapon"],
    offhandSlots: ["offhand"]
  },
  Warrior: {
    armorWeights: ["heavy"],
    weaponSlots: ["weapon"],
    offhandSlots: ["offhand"]
  },
  Berserker: {
    armorWeights: ["heavy"],
    weaponSlots: ["weapon"],
    offhandSlots: []
  },
  Ranger: {
    armorWeights: ["medium"],
    weaponSlots: ["weapon"],
    offhandSlots: []
  },
  Marksman: {
    armorWeights: ["medium"],
    weaponSlots: ["weapon"],
    offhandSlots: []
  },
  Cleric: {
    armorWeights: ["light", "medium"],
    weaponSlots: ["weapon"],
    offhandSlots: ["offhand"]
  },
  Druid: {
    armorWeights: ["light", "medium"],
    weaponSlots: ["weapon"],
    offhandSlots: ["offhand"]
  }
};

function escapeHtml(input: any) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getTownLevel(town: any) {
  if (town.recommended_level != null) return Number(town.recommended_level);
  if (town.level != null) return Number(town.level);

  const min = Number(town.min_level ?? 1);
  const max = Number(town.max_level ?? min);
  return Math.floor((min + max) / 2);
}

function getTownShopChoiceCount(townLevel: number) {
  if (townLevel <= 5) return 2;
  if (townLevel <= 10) return 3;
  if (townLevel <= 20) return 4;
  if (townLevel <= 30) return 5;
  return 6;
}

function getBasePrice(base: any) {
  const sellValue = Number(base.sell_value ?? 0);
  const requiredLevel = Number(base.required_level ?? 1);
  const atk = Number(base.base_attack ?? 0);
  const def = Number(base.base_defense ?? 0);

  if (sellValue > 0) {
    return Math.max(1, sellValue * 4);
  }

  return Math.max(10, Math.floor(requiredLevel * 10 + atk * 3 + def * 3));
}

function getDisplayCategory(base: any): "weapon" | "armor" {
  return String(base.item_type) === "armor" ? "armor" : "weapon";
}

// ============================================================================
// VIEW SHOP
// ============================================================================
router.get("/shop", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.redirect("/login.html");

    const [[player]]: any = await db.query(
      `SELECT id, pclass, gold, map_x, map_y FROM players WHERE id=? LIMIT 1`,
      [pid]
    );
    if (!player) return res.redirect("/login.html");

    const loadout = CLASS_LOADOUTS[player.pclass] ?? {
      armorWeights: [],
      weaponSlots: [],
      offhandSlots: []
    };

    const goldFmt = new Intl.NumberFormat("en-US").format(Number(player.gold ?? 0));

    const [[town]]: any = await db.query(
      `SELECT * FROM locations WHERE map_x=? AND map_y=? LIMIT 1`,
      [player.map_x, player.map_y]
    );
    if (!town) return res.redirect("/world");

    const townLevel = getTownLevel(town);
    const choiceCount = getTownShopChoiceCount(townLevel);

    const [shops]: any = await db.query(
      `SELECT * FROM shops WHERE location_id=?`,
      [town.id]
    );

    if (!shops.length) {
      return res.send(`No shops exist in ${escapeHtml(town.name)} yet.`);
    }

    const shopTypeById = new Map<number, string>();
    for (const s of shops) shopTypeById.set(Number(s.id), String(s.type));

    const shopIds = shops
      .map((s: any) => Number(s.id))
      .filter((n: number) => Number.isFinite(n));

    // =========================================================================
    // CONSUMABLES
    // =========================================================================
    let consumables: any[] = [];

    if (shopIds.length) {
      const [rawConsumables]: any = await db.query(
        `
        SELECT
          si.id AS shopItemId,
          si.shop_id,
          si.price,
          si.stock,
          si.item_id,

          i.name,
          i.icon,
          i.rarity,
          i.value,
          i.category,
          i.item_type,

          i.attack,
          i.defense,
          i.agility,
          i.vitality,
          i.intellect,
          i.crit,

          i.effect_type,
          i.effect_target,
          i.effect_value,

          i.description
        FROM shop_items si
        JOIN items i ON i.id = si.item_id
        WHERE si.shop_id IN (?)
          AND i.category = 'consumable'
        `,
        [shopIds]
      );

      consumables = (rawConsumables || []).filter((row: any) => {
        const shopType = String(shopTypeById.get(Number(row.shop_id)) || "");
        return shopType === "general";
      });
    }

    // =========================================================================
    // WEAPONS / OFFHANDS FROM item_bases
    // =========================================================================
    let weaponBases: any[] = [];
    const canShowWeapons =
      shops.some((s: any) => String(s.type) === "weapon") &&
      (loadout.weaponSlots.length > 0 || loadout.offhandSlots.length > 0);

    if (canShowWeapons) {
      const [rows]: any = await db.query(
        `
        SELECT
          ib.id,
          ib.name,
          ib.slot,
          ib.item_type,
          ib.armor_weight,
          ib.required_level,
          ib.max_level,
          ib.base_attack,
          ib.base_defense,
          ib.sell_value,
          ib.icon,
          ib.description,
          ib.is_active,
          'common' AS rarity
        FROM item_bases ib
        WHERE ib.is_active = 1
          AND (
            (ib.item_type = 'weapon' AND ib.slot IN (?))
            OR
            (ib.item_type = 'offhand' AND ib.slot IN (?))
          )
          AND ib.required_level <= ?
          AND ib.required_level >= GREATEST(1, ? - 5)
        ORDER BY ABS(ib.required_level - ?) ASC, RAND()
        LIMIT ?
        `,
        [
          loadout.weaponSlots.length ? loadout.weaponSlots : ["__none__"],
          loadout.offhandSlots.length ? loadout.offhandSlots : ["__none__"],
          townLevel,
          townLevel,
          townLevel,
          choiceCount
        ]
      );

      weaponBases = (rows || []).map((b: any) => ({
        ...b,
        category: "weapon",
        price: getBasePrice(b),
        stock: 9999,
        sourceType: "base",
        attack: Number(b.base_attack ?? 0),
        defense: Number(b.base_defense ?? 0),
        agility: 0,
        vitality: 0,
        intellect: 0,
        crit: 0,
        value: Number(b.sell_value ?? 0)
      }));
    }

    // =========================================================================
    // ARMOR FROM item_bases
    // =========================================================================
    let armorBases: any[] = [];
    const canShowArmor =
      shops.some((s: any) => String(s.type) === "armor") &&
      loadout.armorWeights.length > 0;

    if (canShowArmor) {
      const [rows]: any = await db.query(
        `
        SELECT
          ib.id,
          ib.name,
          ib.slot,
          ib.item_type,
          ib.armor_weight,
          ib.required_level,
          ib.max_level,
          ib.base_attack,
          ib.base_defense,
          ib.sell_value,
          ib.icon,
          ib.description,
          ib.is_active,
          'common' AS rarity
        FROM item_bases ib
        WHERE ib.is_active = 1
          AND ib.item_type = 'armor'
          AND ib.armor_weight IN (?)
          AND ib.required_level <= ?
          AND ib.required_level >= GREATEST(1, ? - 5)
        ORDER BY ABS(ib.required_level - ?) ASC, RAND()
        LIMIT ?
        `,
        [
          loadout.armorWeights,
          townLevel,
          townLevel,
          townLevel,
          choiceCount
        ]
      );

      armorBases = (rows || []).map((b: any) => ({
        ...b,
        category: "armor",
        price: getBasePrice(b),
        stock: 9999,
        sourceType: "base",
        attack: Number(b.base_attack ?? 0),
        defense: Number(b.base_defense ?? 0),
        agility: 0,
        vitality: 0,
        intellect: 0,
        crit: 0,
        value: Number(b.sell_value ?? 0)
      }));
    }

    const groups: Record<"consumable" | "weapon" | "armor", any[]> = {
      consumable: consumables,
      weapon: weaponBases,
      armor: armorBases
    };

    function renderItemCard(i: any) {
      const stats = [
        i.attack ? `Attack +${i.attack}` : null,
        i.defense ? `Defense +${i.defense}` : null,
        i.agility ? `Agility +${i.agility}` : null,
        i.vitality ? `Vitality +${i.vitality}` : null,
        i.intellect ? `Intellect +${i.intellect}` : null,
        i.crit ? `Crit +${i.crit}%` : null,
        i.effect_type === "restore"
          ? `✨ Restores ${i.effect_value} ${i.effect_target === "hp" ? "HP" : "SP"}`
          : null,
        i.slot ? `Slot: ${i.slot}` : null,
        i.armor_weight ? `Weight: ${i.armor_weight}` : null,
        i.required_level ? `Requires Level ${i.required_level}` : null
      ]
        .filter(Boolean)
        .join("<br>");

      const rawIcon = (i.icon ?? "").toString().trim();
      const isImage = /\.(png|jpe?g|webp|gif|svg)$/i.test(rawIcon);

      const iconSrc =
        isImage && rawIcon && !rawIcon.startsWith("http") && !rawIcon.startsWith("/")
          ? `/${rawIcon}`
          : rawIcon;

      const thumbHtml = isImage
        ? `<img class="item-thumb" src="${iconSrc}" alt="${escapeHtml(i.name)}" loading="lazy"
             onerror="this.replaceWith(document.createTextNode('📦'));">`
        : `<div class="item-emoji" aria-label="${escapeHtml(i.name)}">${escapeHtml(rawIcon || "📦")}</div>`;

      const canBuy = Number(i.stock) > 0;

      let buyButton = "";

      if (i.sourceType === "base") {
        buyButton = `
          <button ${canBuy ? "" : "disabled"} onclick="buyBase(${Number(i.id)}, '${escapeHtml(i.category)}')">
            ${canBuy ? "Buy" : "Sold Out"}
          </button>
        `;
      } else {
        buyButton = `
          <button ${canBuy ? "" : "disabled"} onclick="buy(${Number(i.shopItemId)})">
            ${canBuy ? "Buy" : "Sold Out"}
          </button>
        `;
      }

      return `
        <div class="item"
          data-tooltip="item"
          tabindex="0"
          aria-label="${escapeHtml(i.name)}"
          data-name="${escapeHtml(i.name)}"
          data-rarity="${escapeHtml(i.rarity || "common")}"
          data-value="${Number(i.value || 0)}"
          data-price="${Number(i.price || 0)}"
          data-qty="1"
          data-stats="${escapeHtml(stats)}"
          data-desc="${escapeHtml(i.description || "")}"
        >
          <div class="thumb">${thumbHtml}</div>
          ${buyButton}
        </div>
      `;
    }

    function renderCards(arr: any[]) {
      return (arr || []).map(renderItemCard).join("") || `<div class="empty">No items.</div>`;
    }

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Guildforge | Shop</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">

  <link rel="stylesheet" href="/ui/toast.css">
  <script src="/ui/toast.js"></script>

  <link rel="stylesheet" href="/ui/itemTooltip.css">
  <script defer src="/ui/itemTooltip.js"></script>

  <link rel="stylesheet" href="/shop.css">
  <script defer src="/shop.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>
  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>

  <div class="wrap">
    <div class="panel market">

      <div class="marketHead">
        <div class="marketTitle">
          <h2>Market of ${escapeHtml(town.name)}</h2>
          <div class="sub">Lanternlight, loud deals, and guarded coin</div>
        </div>
        <div class="marketMeta">
          <div class="pill">🪙 ${goldFmt}</div>
          <button class="btnGhost" type="button" onclick="location.href='/town'">Return</button>
        </div>
      </div>

      <div class="marketTabs" role="tablist" aria-label="Market categories">
        <button class="tab isActive" role="tab" aria-selected="true" data-tab="consumable">
          🧪 Consumables
        </button>
        <button class="tab" role="tab" aria-selected="false" data-tab="weapon">
          ⚔ Weapons
        </button>
        <button class="tab" role="tab" aria-selected="false" data-tab="armor">
          🛡 Armor
        </button>
      </div>

      <div class="marketPanels">
        <section class="marketPanel isActive" role="tabpanel" data-panel="consumable">
          <div class="panelHead">
            <div class="panelName">Apothecary Stall</div>
            <div class="panelNote">Restock before you step outside the walls.</div>
          </div>
          <div class="items">${renderCards(groups.consumable)}</div>
        </section>

        <section class="marketPanel" role="tabpanel" data-panel="weapon">
          <div class="panelHead">
            <div class="panelName">Steel & Edge</div>
            <div class="panelNote">A few practical weapons and offhands suited to your class.</div>
          </div>
          <div class="items">${renderCards(groups.weapon)}</div>
        </section>

        <section class="marketPanel" role="tabpanel" data-panel="armor">
          <div class="panelHead">
            <div class="panelName">Armorer’s Row</div>
            <div class="panelNote">Region-appropriate armor matched to your training.</div>
          </div>
          <div class="items">${renderCards(groups.armor)}</div>
        </section>
      </div>

      <hr class="rule">
      <button class="returnBtn" onclick="location.href='/town'">Return to Town</button>
    </div>
  </div>

  <div class="toast-wrap" id="toastWrap"></div>
</body>
</html>
    `);
  } catch (err) {
    console.error("GET /shop failed:", err);
    res.status(500).send("Shop failed to load.");
  }
});

router.get("/shop/:id", (req, res) => res.redirect("/shop"));

// ============================================================================
// BUY CONSUMABLE
// ============================================================================
router.post("/api/shop/buy", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    const shopItemId = Number(req.body?.shopItemId);

    if (!pid) return res.json({ error: "Not logged in" });
    if (!Number.isFinite(shopItemId)) return res.json({ error: "Invalid item id" });

    const [r]: any = await db.query(
      `
      UPDATE players p
      JOIN shop_items si ON si.id = ?
      SET
        p.gold = p.gold - si.price,
        si.stock = si.stock - 1
      WHERE
        p.id = ?
        AND si.stock > 0
        AND p.gold >= si.price
      `,
      [shopItemId, pid]
    );

    if (!r?.affectedRows) {
      const [[si]]: any = await db.query(
        `SELECT price, stock FROM shop_items WHERE id=? LIMIT 1`,
        [shopItemId]
      );
      if (!si) return res.json({ error: "Item not found" });
      if (Number(si.stock) <= 0) return res.json({ error: "Out of stock" });

      const [[pl]]: any = await db.query(
        `SELECT gold FROM players WHERE id=? LIMIT 1`,
        [pid]
      );
      if (!pl) return res.json({ error: "Player not found" });
      if (Number(pl.gold) < Number(si.price)) return res.json({ error: "Not enough gold" });

      return res.json({ error: "Purchase failed" });
    }

    const [[row]]: any = await db.query(
      `SELECT item_id FROM shop_items WHERE id=? LIMIT 1`,
      [shopItemId]
    );
    if (!row) return res.json({ error: "Purchase succeeded but item missing." });

    await addItemAtomic(Number(pid), Number(row.item_id), 1);

    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/shop/buy failed:", err);
    res.json({ error: "Purchase failed" });
  }
});

// ============================================================================
// BUY BASE ITEM
// ============================================================================
router.post("/api/shop/buy-base", async (req, res) => {
  const conn = await db.getConnection();

  try {
    const pid = (req.session as any).playerId;
    const baseItemId = Number(req.body?.baseItemId);
    const category = String(req.body?.category || "");

    if (!pid) {
      conn.release();
      return res.json({ error: "Not logged in" });
    }

    if (!Number.isFinite(baseItemId)) {
      conn.release();
      return res.json({ error: "Invalid base item id" });
    }

    if (!["weapon", "armor"].includes(category)) {
      conn.release();
      return res.json({ error: "Invalid category" });
    }

    const [[player]]: any = await conn.query(
      `SELECT id, pclass, gold, map_x, map_y FROM players WHERE id=? LIMIT 1`,
      [pid]
    );
    if (!player) {
      conn.release();
      return res.json({ error: "Player not found" });
    }

    const loadout = CLASS_LOADOUTS[player.pclass] ?? {
      armorWeights: [],
      weaponSlots: [],
      offhandSlots: []
    };

    const [[town]]: any = await conn.query(
      `SELECT * FROM locations WHERE map_x=? AND map_y=? LIMIT 1`,
      [player.map_x, player.map_y]
    );
    if (!town) {
      conn.release();
      return res.json({ error: "Town not found" });
    }

    const townLevel = getTownLevel(town);

    const [[base]]: any = await conn.query(
      `
      SELECT
        ib.id,
        ib.name,
        ib.slot,
        ib.item_type,
        ib.armor_weight,
        ib.required_level,
        ib.max_level,
        ib.base_attack,
        ib.base_defense,
        ib.sell_value,
        ib.icon,
        ib.description,
        ib.is_active
      FROM item_bases ib
      WHERE ib.id = ?
        AND ib.is_active = 1
      LIMIT 1
      `,
      [baseItemId]
    );

    if (!base) {
      conn.release();
      return res.json({ error: "Base item not found" });
    }

    const itemDisplayCategory = getDisplayCategory(base);
    if (itemDisplayCategory !== category) {
      conn.release();
      return res.json({ error: "Invalid item category" });
    }

    if (category === "armor") {
      if (String(base.item_type) !== "armor") {
        conn.release();
        return res.json({ error: "Invalid armor item" });
      }

      if (!loadout.armorWeights.includes(String(base.armor_weight || ""))) {
        conn.release();
        return res.json({ error: "Your class cannot buy that armor type" });
      }
    } else {
      const isWeaponAllowed =
        String(base.item_type) === "weapon" &&
        loadout.weaponSlots.includes(String(base.slot));

      const isOffhandAllowed =
        String(base.item_type) === "offhand" &&
        loadout.offhandSlots.includes(String(base.slot));

      if (!isWeaponAllowed && !isOffhandAllowed) {
        conn.release();
        return res.json({ error: "Your class cannot buy that item type" });
      }
    }

    const reqLevel = Number(base.required_level ?? 1);
    if (reqLevel > townLevel || reqLevel < Math.max(1, townLevel - 5)) {
      conn.release();
      return res.json({ error: "That item is not sold in this town" });
    }

    const price = getBasePrice(base);

    await conn.beginTransaction();

    const [goldUpdate]: any = await conn.query(
      `
      UPDATE players
      SET gold = gold - ?
      WHERE id = ?
        AND gold >= ?
      `,
      [price, pid, price]
    );

    if (!goldUpdate?.affectedRows) {
      await conn.rollback();
      conn.release();
      return res.json({ error: "Not enough gold" });
    }

    const [playerItemInsert]: any = await conn.query(
      `
      INSERT INTO player_items (
        player_id,
        item_base_id,
        name,
        item_level,
        rarity,
        is_equipped,
        is_claimed,
        roll_json,
        source_type,
        source_id
      )
      VALUES (?, ?, ?, ?, 'base', 0, 1, NULL, 'shop', ?)
      `,
      [
        Number(pid),
        Number(base.id),
        String(base.name),
        Number(base.required_level ?? 1),
        Number(town.id)
      ]
    );

    const playerItemId = Number(playerItemInsert.insertId);

    await conn.query(
      `
      INSERT INTO inventory (
        player_id,
        item_id,
        player_item_id,
        quantity,
        durability,
        randid,
        equipped
      )
      VALUES (?, NULL, ?, 1, NULL, NULL, 0)
      `,
      [Number(pid), playerItemId]
    );

    await conn.commit();
    conn.release();

    res.json({ success: true });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    conn.release();
    console.error("POST /api/shop/buy-base failed:", err);
    res.json({ error: "Purchase failed" });
  }
});
export default router;