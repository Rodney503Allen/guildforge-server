import express from "express";
import { db } from "./db";

const router = express.Router();

// ========================
// VIEW SHOP
// ========================
router.get("/shop/:id", async (req, res) => {

  const pid = (req.session as any).playerId;
  const shopId = req.params.id;

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
  const [items]: any = await db.query(`
    SELECT
      si.id AS shopItemId,
      i.name,
      i.icon,
      i.rarity,
      i.value,
      si.price,
      si.stock
    FROM shop_items si
    JOIN items i ON i.id = si.item_id
    WHERE si.shop_id = ?
  `, [shopId]);

  // HTML Rendering
  const rows = items.map((i: any) => `
    <div class="item">
      <div class="name">${i.icon || "📦"} ${i.name}</div>
      <div class="price">💰 ${i.price}</div>
      <button onclick="buy(${i.shopItemId})">Buy</button>
    </div>
  `).join("");

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
</style>

</head>
<body>

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
