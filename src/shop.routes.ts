//shop.routes.ts
import express from "express";
import { db } from "./db";
import { addItemAtomic } from "./services/inventoryService";
import { generateLootFromBaseItem } from "./services/lootGenerator";
import { hasInventorySpace } from "./services/inventoryCapacityService";

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

const SHOP_ROTATION_HOURS = [0, 6, 12, 18];

function getPacificParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find(p => p.type === type)?.value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour")
  };
}

function getShopRotationKey(date = new Date()) {
  const p = getPacificParts(date);
  const rotationHour = Math.floor(p.hour / 6) * 6;

  return Number(
    `${p.year}${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}${String(rotationHour).padStart(2, "0")}`
  );
}

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
      `SELECT id, type FROM shops WHERE location_id=?`,
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




    const rotationKey = getShopRotationKey();

    const weaponShop = shops.find((s: any) => String(s.type) === "weapon");
    const armorShop = shops.find((s: any) => String(s.type) === "armor");
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
        ORDER BY
          ABS(ib.required_level - ?) ASC,
          MOD(
            (ib.id * 7919)
            + (? * 193)
            + (? * 389)
            + (? * 997),
            100000
          )
        LIMIT ?
        `,
        [
          loadout.weaponSlots.length ? loadout.weaponSlots : ["__none__"],
          loadout.offhandSlots.length ? loadout.offhandSlots : ["__none__"],
          townLevel,
          townLevel,
          townLevel,
          rotationKey,
          Number(town.id),
          Number(weaponShop?.id ?? 0),
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
        ORDER BY
          ABS(ib.required_level - ?) ASC,
          MOD(
            (ib.id * 7919)
            + (? * 193)
            + (? * 389)
            + (? * 997),
            100000
          )
        LIMIT ?
        `,
        [
          loadout.armorWeights,
          townLevel,
          townLevel,
          townLevel,
          rotationKey,
          Number(town.id),
          Number(armorShop?.id ?? 0),
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
          <button ${canBuy ? "" : "disabled"} onclick="buyBase(${Number(i.id)}, '${escapeHtml(i.category)}', this)">
            ${canBuy ? "Buy" : "Sold Out"}
          </button>
        `;
      } else {
        buyButton = `
          <button ${canBuy ? "" : "disabled"} onclick="buy(${Number(i.shopItemId)}, this)">
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

          <div class="item-info">
            <strong>${escapeHtml(i.name)}</strong>
            <span>${Number(i.price || 0).toLocaleString("en-US")} gold</span>
          </div>

          ${buyButton}
        </div>
      `;
    }

    function renderCards(arr: any[], label = "items") {
      return (arr || []).map(renderItemCard).join("") || `
        <div class="empty-market">
          <div class="empty-icon">⛺</div>
          <strong>No ${escapeHtml(label)} available</strong>
          <span>This stall has nothing suitable for you right now. Check another stall or return later.</span>
        </div>
      `;
    }

res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Guildforge | Market</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800;900&display=swap" rel="stylesheet">

  <link rel="stylesheet" href="/statpanel.css">
  <script defer src="/statpanel.js"></script>

  <link rel="stylesheet" href="/ui/toast.css">
  <script defer src="/ui/toast.js"></script>

  <link rel="stylesheet" href="/ui/itemTooltip.css">
  <script defer src="/ui/itemTooltip.js"></script>

  <link rel="stylesheet" href="/shop.css">
  <script defer src="/shop.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <main class="shop-page">
    <div class="shop-shell">

      <section class="shop-hero">
        <div class="hero-title">
          <div class="hero-icon">⚖️</div>
          <div>
            <div class="eyebrow">Market</div>
            <h1>Market of ${escapeHtml(town.name)}</h1>
            <p>Lanternlight, loud deals, guarded coin, and wares for the wilds.</p>
          </div>
        </div>

        <div class="hero-actions">
          <span class="pill">Gold <strong>${goldFmt}</strong></span>
          <button class="btn danger" type="button" onclick="location.href='/town'">Return to Town</button>
        </div>
      </section>

      <section class="shop-grid">

        <div class="card shop-card">
          <div class="cardHeader">
            <div class="cardTitle">
              <h2>Market Stalls</h2>
              <p>Choose a stall and browse available wares.</p>
            </div>
            <span class="badge good">Open</span>
          </div>

          <div class="cardBody">

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
                  <div>
                    <div class="panelName">Apothecary Stall</div>
                    <div class="panelNote">Restock before you step outside the walls.</div>
                  </div>
                  <span class="badge">Potions</span>
                </div>
                <div class="items">${renderCards(groups.consumable)}</div>
              </section>

              <section class="marketPanel" role="tabpanel" data-panel="weapon">
                <div class="panelHead">
                  <div>
                    <div class="panelName">Steel & Edge</div>
                    <div class="panelNote">A few practical weapons and offhands suited to your class.</div>
                  </div>
                  <span class="badge">Weapons</span>
                </div>
                <div class="items">${renderCards(groups.weapon)}</div>
              </section>

              <section class="marketPanel" role="tabpanel" data-panel="armor">
                <div class="panelHead">
                  <div>
                    <div class="panelName">Armorer’s Row</div>
                    <div class="panelNote">Region-appropriate armor matched to your training.</div>
                  </div>
                  <span class="badge">Armor</span>
                </div>
                <div class="items">${renderCards(groups.armor)}</div>
              </section>
            </div>

          </div>
        </div>

        <aside class="right-stack">

          <div class="card">
            <div class="cardHeader compact">
              <div class="cardTitle">
                <h2>Merchant Notice</h2>
                <p>Supplies are meant to keep you alive.</p>
              </div>
            </div>

            <div class="cardBody">
              <div class="noticeBox">
                <strong>Before you leave town</strong>
                <p>Carry healing and spirit supplies before heading into dangerous regions. A cheap potion is better than a costly revival.</p>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="cardHeader compact">
              <div class="cardTitle">
                <h2>Market Rumors</h2>
                <p>Talk around the stalls.</p>
              </div>
              <span class="badge warn">Coming Soon</span>
            </div>

            <div class="cardBody">
              <div class="marketFutureList">
                <div class="futureRow">
                  <strong>Trusted Buyers</strong>
                  <span>Some merchants favor repeat customers with better rates.</span>
                </div>
                <div class="futureRow">
                  <strong>Rotating Stock</strong>
                  <span>Caravans bring different wares depending on the region.</span>
                </div>
                <div class="futureRow">
                  <strong>Trade Contracts</strong>
                <span>Guilds may soon broker supplies and rare materials.</span>
                </div>
              </div>
            </div>
          </div>

        </aside>

      </section>
    </div>
  </main>

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

    const [[updatedPlayer]]: any = await db.query(
      `SELECT gold FROM players WHERE id=? LIMIT 1`,
      [pid]
    );

    res.json({
      success: true,
      gold: Number(updatedPlayer?.gold ?? 0)
    });
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



const inventory = await hasInventorySpace(pid);

if (!inventory.hasSpace) {
  await conn.rollback();
  conn.release();

  return res.json({
    error: `Your inventory is full (${inventory.used}/${inventory.capacity}).`
  });
}

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

const generatedItem = await generateLootFromBaseItem({
  playerId: Number(pid),
  baseItemId: Number(base.id),
  itemLevel: Number(base.required_level ?? townLevel),
  sourceType: "shop",
  sourceId: Number(town.id),
  isClaimed: true
});

if (!generatedItem) {
  await conn.rollback();
  conn.release();
  return res.json({ error: "Could not generate item" });
}

const playerItemId = Number(generatedItem.playerItemId);

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

    const [[freshPlayer]]: any = await db.query(
  `SELECT gold FROM players WHERE id = ? LIMIT 1`,
  [pid]
);

res.json({
  success: true,
  gold: freshPlayer?.gold ?? null,
  item: {
    id: generatedItem.playerItemId,
    name: generatedItem.name,
    rarity: generatedItem.rarity,
    itemLevel: generatedItem.itemLevel,
    affixes: generatedItem.affixes
  }
});
  } catch (err) {
    try { await conn.rollback(); } catch {}
    conn.release();
    console.error("POST /api/shop/buy-base failed:", err);
    res.json({ error: "Purchase failed" });
  }
});
export default router;