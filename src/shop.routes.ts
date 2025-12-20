import express from "express";
import { db } from "./db";

const router = express.Router();

const CLASS_LOADOUTS: Record<string, {
  armor: string[];
  weapons: string[];
}> = {
  Mage: {
    armor: ["cloth", "orb"],
    weapons: ["staff", "wand",]
  },
  Warlock: {
    armor: ["cloth", "orb"],
    weapons: ["staff", "wand"]
  },
  Warrior: {
    armor: ["plate", "shield"],
    weapons: ["sword", "axe"]
  },
  Berserker: {
    armor: ["plate"],
    weapons: ["axe", "sword"]
  },
  Ranger: {
    armor: ["leather"],
    weapons: ["bow", "dagger"]
  },
  Marksman: {
    armor: ["leather"],
    weapons: ["bow", "crossbow"]
  },
  Cleric: {
    armor: ["blessed", "tome", "shield"],
    weapons: ["mace"]
  },
  Druid: {
    armor: ["blessed", "totem"],
    weapons: ["staff"]
  }
};

// ========================
// VIEW SHOP
// ========================
router.get("/shop/:id", async (req, res) => {

  const pid = (req.session as any).playerId;
  const shopId = req.params.id;
  const [[player]]: any = await db.query(
    "SELECT pclass FROM players WHERE id = ?",
    [pid]
  );

if (!player) return res.redirect("/login.html");

const loadout = CLASS_LOADOUTS[player.pclass];

  if (!pid) return res.redirect("/login.html");

  // Load shop info
  const [[shop]]: any = await db.query(`
    SELECT s.*, l.name AS town
    FROM shops s
    JOIN locations l ON l.id = s.location_id
    WHERE s.id = ?
  `, [shopId]);

  if (!shop) return res.send("Shop not found.");

  // Load shop items
let itemQuery = `
  SELECT
    si.id AS shopItemId,
    i.name,
    i.icon,
    i.rarity,
    i.value,
    si.price,
    si.stock,
    i.category,
    i.item_type,

    i.attack,
    i.defense,
    i.agility,
    i.vitality,
    i.intellect,
    i.crit,

    i.description
  FROM shop_items si
  JOIN items i ON i.id = si.item_id
  WHERE si.shop_id = ?
`;

const params: any[] = [shopId];

// Armor filtering
if (shop.type === "armor") {
  itemQuery += ` AND i.category = 'armor' AND i.item_type IN (?)`;
  params.push(loadout.armor);
}

// Weapon filtering
if (shop.type === "weapon") {
  itemQuery += ` AND i.category = 'weapon' AND i.item_type IN (?)`;
  params.push(loadout.weapons);
}

// General store = potions only (for now)
if (shop.type === "general") {
  itemQuery += ` AND i.category = 'consumable'`;
}

const [items]: any = await db.query(itemQuery, params);



  // HTML Rendering
const rows = items.map((i: any) => {

  const stats = [
    i.attack ? `⚔ Attack +${i.attack}` : null,
    i.defense ? `🛡 Defense +${i.defense}` : null,
    i.agility ? `🏃 Agility +${i.agility}` : null,
    i.vitality ? `❤️ Vitality +${i.vitality}` : null,
    i.intellect ? `🧠 Intellect +${i.intellect}` : null,
    i.crit ? `🎯 Crit +${i.crit}%` : null,
    i.effect_type === "heal"
      ? `✨ Heals ${i.effect_value} ${i.effect_target === "hp" ? "HP" : "SP"}`
      : null
  ].filter(Boolean).join("<br>");

  return `
    <div class="item tooltip-parent">
      <div class="name">
        ${i.icon || "📦"} ${i.name}
        <div class="tooltip">
          <div class="t-name ${i.rarity}">${i.name}</div>
          ${stats ? `<div class="t-stats">${stats}</div>` : ""}
          ${i.description ? `<div class="t-desc">${i.description}</div>` : ""}
        </div>
      </div>

      <div class="price">💰 ${i.price}</div>
      <button onclick="buy(${i.shopItemId})">Buy</button>
    </div>
  `;
}).join("");


  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>${shop.name}</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
<style>
/* =============================
   GLOBAL
============================= */
html, body {
  margin: 0;
  padding: 0;
  background: radial-gradient(circle at top, #120b06, #030202);
  color: gold;
  font-family: Cinzel, serif;
}

/* =============================
   SHOP WINDOW PANEL
============================= */
.panel {
  width: 440px;
  margin: 80px auto;
  padding: 22px;
  background: linear-gradient(#100700, #040200);
  border: 2px solid gold;
  border-radius: 14px;
  box-shadow: 0 0 20px rgba(255,215,0,.4);
}

/* =============================
   SHOP HEADER
============================= */
.panel h2 {
  margin-top: 0;
  margin-bottom: 4px;
  font-size: 26px;
}

.panel > div {
  font-size: 14px;
  color: #c9b57e;
}

/* =============================
   ITEM LIST
============================= */
.item {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  padding: 10px;
  margin: 8px 0;
  border-bottom: 1px solid rgba(255,215,0,.2);
}

/* Name + Icon */
.item .name {
  font-size: 15px;
  text-align: left;
}

/* Price */
.item .price {
  font-size: 14px;
  margin-right: 10px;
}

/* =============================
   BUTTONS
============================= */
button {
  background: linear-gradient(#6b4226, #332010);
  border: 2px solid gold;
  color: #f5d27d;
  font-family: Cinzel, serif;
  font-weight: bold;
  cursor: pointer;
  border-radius: 6px;
  padding: 6px 12px;
  transition: 0.15s;
}

/* Hover */
button:hover:not(:disabled) {
  background: gold;
  color: black;
  box-shadow: 0 0 10px gold;
  transform: scale(1.05);
}

/* Disabled */
button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* =============================
   FOOTER BUTTON
============================= */
.returnBtn {
  margin-top: 12px;
  width: 100%;
  padding: 8px;
  font-size: 15px;
}

/* =============================
   EMPTY STORE
============================= */
.empty {
  color: #888;
  font-style: italic;
}
  /* =============================
   TOOLTIP SYSTEM
============================= */
.tooltip-parent {
  position: relative;
}

.tooltip {
  position: absolute;
  left: 0;
  top: 110%;
  width: 260px;
  background: linear-gradient(#120b06, #050302);
  border: 2px solid gold;
  border-radius: 10px;
  padding: 10px;
  color: #f5e1a4;
  font-size: 13px;
  box-shadow: 0 0 18px rgba(255,215,0,.6);
  z-index: 999;

  opacity: 0;
  pointer-events: none;
  transform: translateY(-5px);
  transition: 0.15s ease;
}

.tooltip-parent:hover .tooltip {
  opacity: 1;
  transform: translateY(0);
}

/* Tooltip text sections */
.t-name {
  font-weight: bold;
  margin-bottom: 6px;
}

.t-stats {
  margin-bottom: 6px;
  line-height: 1.4;
}

.t-desc {
  font-style: italic;
  color: #cbb98a;
}

/* Rarity colors */
.common { color: #bbb; }
.uncommon { color: #4cff4c; }
.rare { color: #4cc3ff; }
.epic { color: #c96cff; }
.legendary { color: #ffae00; }

</style>

</head>
<body>
<div id="statpanel-root"></div>
<link rel="stylesheet" href="/statpanel.css">
<script src="/statpanel.js"></script>

<div class="panel">
<h2>${shop.name}</h2>
<div>${shop.town}</div>

<hr>
${rows || "<div class='empty'>No items for sale.</div>"}
<hr>
<button class="returnBtn" onclick="location.href='/town'">Return to Town</button>
</div>

<script>
async function buy(id) {

  const res = await fetch("/api/shop/buy", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ shopItemId:id })
  });

  const data = await res.json();

  if (data.error) {
    alert(data.error);
    return;
  }

  alert("✅ Purchased!");
  location.reload();
}
</script>

</body>
</html>
  `);

});

// ========================
// BUY ITEM API
// ========================
router.post("/api/shop/buy", async (req, res) => {

  const pid = (req.session as any).playerId;
  const { shopItemId } = req.body;

  if (!pid) return res.json({ error: "Not logged in" });

  // Load item
  const [[item]]: any = await db.query(`
    SELECT
      si.id,
      si.price,
      si.stock,
      si.item_id,
      i.name
    FROM shop_items si
    JOIN items i ON i.id = si.item_id
    WHERE si.id = ?
  `, [shopItemId]);

  if (!item) return res.json({ error: "Item not found" });
  if (item.stock <= 0) return res.json({ error: "Out of stock" });

  // Load player gold
  const [[player]]: any = await db.query(`
    SELECT gold FROM players WHERE id=?
  `, [pid]);

  if (player.gold < item.price) return res.json({ error: "Not enough gold" });

  // Deduct gold
  await db.query(`
    UPDATE players
    SET gold = gold - ?
    WHERE id=?
  `, [item.price, pid]);

  // Reduce stock
  await db.query(`
    UPDATE shop_items
    SET stock = stock - 1
    WHERE id=?
  `, [shopItemId]);

  // Add item to inventory (stack-safe)
  const [[existing]]: any = await db.query(`
    SELECT inventory_id, quantity
    FROM inventory
    WHERE player_id = ? AND item_id = ?
  `, [pid, item.item_id]);

  if (existing) {
    await db.query(`
      UPDATE inventory
      SET quantity = quantity + 1
      WHERE inventory_id = ?
    `, [existing.inventory_id]);
  } else {
    await db.query(`
      INSERT INTO inventory (player_id, item_id, quantity)
      VALUES (?, ?, 1)
    `, [pid, item.item_id]);
  }

  res.json({ success: true });
});

export default router;
