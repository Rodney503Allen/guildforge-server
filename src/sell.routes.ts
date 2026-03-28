// sell.routes.ts
import express from "express";
import { db } from "./db";
import { SELL_RATE, sellInventoryEntryAtomic } from "./services/inventoryService";

const router = express.Router();

function resolveIcon(icon: any) {
  const raw = (icon ?? "").toString().trim();
  if (!raw) return "";
  if (raw.startsWith("http")) return raw;
  return "/" + raw.replace(/^\/+/, "");
}

function escapeHtml(input: string) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function getRarityMultiplier(rarity: string | null | undefined): number {
  switch (String(rarity || "").toLowerCase()) {
    case "awakened":
      return 1.15;
    case "empowered":
      return 1.35;
    case "transcendent":
      return 1.75;
    case "dormant":
    default:
      return 1;
  }
}

// =======================
// SELL PAGE
// =======================
router.get("/sell", async (req, res) => {
  const pid = (req.session as any).playerId as number;
  if (!pid) return res.redirect("/login.html");

  const [[player]]: any = await db.query(
    "SELECT gold, name FROM players WHERE id=?",
    [pid]
  );
  if (!player) return res.redirect("/login.html");

  const goldFmt = new Intl.NumberFormat("en-US").format(Number(player.gold ?? 0));

  const [rows]: any = await db.query(
    `
    SELECT
      inv.inventory_id AS instance_id,
      inv.item_id,
      inv.player_item_id,
      inv.quantity,
      inv.equipped,

      -- static item path
      i.name AS static_name,
      i.icon AS static_icon,
      i.rarity AS static_rarity,
      i.value AS static_value,
      i.category AS static_category,
      i.type AS static_item_type,
      i.slot AS static_slot,
      i.attack AS static_attack,
      i.defense AS static_defense,
      i.agility AS static_agility,
      i.vitality AS static_vitality,
      i.intellect AS static_intellect,
      i.crit AS static_crit,
      i.description AS static_description,

      -- rolled item path
      pi.rarity AS rolled_rarity,
      pi.item_level AS rolled_item_level,
      pi.roll_json AS rolled_roll_json,

      ib.name AS base_name,
      ib.icon AS base_icon,
      ib.sell_value AS base_sell_value,
      ib.item_type AS base_item_type,
      ib.slot AS base_slot,
      ib.armor_weight AS base_armor_weight,
      ib.base_attack AS base_attack,
      ib.base_defense AS base_defense,
      ib.description AS base_description

    FROM inventory inv
    LEFT JOIN items i
      ON i.id = inv.item_id
    LEFT JOIN player_items pi
      ON pi.id = inv.player_item_id
    LEFT JOIN item_bases ib
      ON ib.id = pi.item_base_id
    WHERE inv.player_id = ?
      AND inv.equipped = 0
    ORDER BY COALESCE(i.name, ib.name) ASC
    `,
    [pid]
  );

  const items = (rows || []).map((it: any) => {
    const isRolled = it.player_item_id != null;
    const rolls = isRolled ? parseRollJson(it.rolled_roll_json) : [];

    const rarity = isRolled ? it.rolled_rarity : it.static_rarity;
    const baseValue = isRolled
      ? Number(it.base_sell_value || 0) * getRarityMultiplier(it.rolled_rarity)
      : Number(it.static_value || 0);

    const unit = Math.max(0, Math.floor(baseValue * SELL_RATE));

    const qty = isRolled ? 1 : Number(it.quantity || 1);

    const name = isRolled ? it.base_name : it.static_name;
    const icon = isRolled ? it.base_icon : it.static_icon;
    const slotOrType = isRolled
      ? (it.base_slot || it.base_item_type || "equipment")
      : (it.static_slot || it.static_category || "item");
    const desc = isRolled ? it.base_description : it.static_description;

        return {
          instance_id: Number(it.instance_id),
          item_id: it.item_id != null ? Number(it.item_id) : null,
          player_item_id: it.player_item_id != null ? Number(it.player_item_id) : null,
          quantity: qty,
          rarity: rarity || "dormant",
          name: name || "Unknown Item",
          icon: icon || "",
          value: baseValue,
          unit,

          desc: desc || "",
          isRolled,

          // universal tooltip fields
          itemType: isRolled ? (it.base_item_type || "") : (it.static_item_type || ""),
          slot: isRolled ? (it.base_slot || "") : (it.static_slot || ""),
          armorWeight: isRolled ? (it.base_armor_weight || "") : "",
          itemLevel: isRolled ? Number(it.rolled_item_level || 0) : "",
          baseAttack: isRolled ? Number(it.base_attack || 0) : Number(it.static_attack || 0),
          baseDefense: isRolled ? Number(it.base_defense || 0) : Number(it.static_defense || 0),
          rollJson: isRolled ? rolls : null,

          // only for card subtitle
          slotOrType: isRolled
            ? (it.base_slot || it.base_item_type || "equipment")
            : (it.static_slot || it.static_category || "item")
        };
      });

  const cards = items.map((it: any) => {
    return `
      <div class="item-card" data-tooltip="item" data-sell="${it.unit}" data-rate="${Math.round(SELL_RATE * 100)}"
           data-id="${it.instance_id}"
           data-itemid="${it.item_id ?? ""}"
           data-playeritemid="${it.player_item_id ?? ""}"
           data-source="${it.isRolled ? "player_item" : "item"}"
           data-name="${escapeHtml(it.name)}"
           data-rarity="${it.rarity}"
           data-value="${Number(it.value) || 0}"
           data-unit="${it.unit}"
           data-qty="${Number(it.quantity) || 1}"
           data-icon="${escapeHtml(it.icon || "")}"
           data-desc="${escapeHtml(it.desc || "")}"
           data-item-type="${escapeHtml(it.itemType || "")}"
           data-slot="${escapeHtml(it.slot || "")}"
           data-armor-weight="${escapeHtml(it.armorWeight || "")}"
           data-item-level="${it.itemLevel !== "" ? escapeHtml(String(it.itemLevel)) : ""}"
           data-base-attack="${escapeHtml(String(it.baseAttack ?? ""))}"
           data-base-defense="${escapeHtml(String(it.baseDefense ?? ""))}"
           data-roll-json='${escapeHtml(JSON.stringify(it.rollJson || []))}'>
        <div class="icon-wrap">
          <div class="icon">${
            it.icon
              ? `<img src="${escapeHtml(resolveIcon(it.icon))}" alt="" onerror="this.replaceWith(document.createTextNode('📦'))">`
              : "📦"
          }</div>

          ${Number(it.quantity) > 1 ? `<div class="stack-count">${it.quantity}</div>` : ""}
        </div>

        <div class="info">
          <div class="name ${it.rarity}">${it.name}</div>
          <div class="sub">
            ${String(it.slotOrType || "ITEM").toUpperCase()}
            <span class="dot">•</span>
            Value: ${Number(it.value) || 0}g
          </div>
        </div>

        <div class="chip">Sell: ${it.unit}g</div>
      </div>
    `;
  }).join("");

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Guildforge | Collector</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">

  <link rel="stylesheet" href="/statpanel.css">
  <script defer src="/statpanel.js"></script>

  <link rel="stylesheet" href="/ui/toast.css">
  <script defer src="/ui/toast.js"></script>

  <link rel="stylesheet" href="/ui/itemTooltip.css">
  <script defer src="/ui/itemTooltip.js"></script>

  <link rel="stylesheet" href="/sell.css">
  <script defer src="/sell.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <div class="wrap">

    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> Collector</div>
        <div class="sub">Trade off what you don’t need. Sell rate: ${Math.round(SELL_RATE * 100)}%</div>
      </div>

      <div class="nav">
        <span class="pill">Gold: <strong>${goldFmt}g</strong></span>
        <a class="btn danger" href="/town">Return to Town</a>
      </div>
    </div>

    <div class="grid">

      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Sellable Items</h2>
            <p>Not equipped. Click an item to preview.</p>
          </div>
          <span class="badge">Inventory</span>
        </div>

        <div class="cardBody">
          ${
            cards
              ? `<div class="items" id="items">${cards}</div>`
              : `<div class="empty">No sellable items.</div>`
          }
        </div>
      </section>

      <aside class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Sell Panel</h2>
            <p>Confirm the sale and choose quantity.</p>
          </div>
          <span class="badge good">Safe</span>
        </div>

        <div class="cardBody">
          <div class="sellbox" id="sellbox">
            <div class="empty" id="emptyState">Select an item to begin.</div>

            <div id="details" style="display:none">
              <div class="line"><span class="k">Name</span><span class="v" id="dName">—</span></div>
              <div class="line"><span class="k">Value</span><span class="v" id="dValue">0g</span></div>
              <div class="line"><span class="k">Rate</span><span class="v">${Math.round(SELL_RATE * 100)}%</span></div>
              <div class="line"><span class="k">Per Item</span><span class="v" id="dUnit">0g</span></div>
              <div class="line"><span class="k">You Gain</span><span class="v" id="dTotal">0g</span></div>

              <div class="qty" id="qtyRow" style="display:none">
                <button type="button" class="qtyBtn" id="minus">−</button>
                <input id="qty" type="number" min="1" value="1" />
                <button type="button" class="qtyBtn" id="plus">+</button>
              </div>

              <button class="btn primary full" id="sellBtn" disabled>Sell</button>
            </div>
          </div>

          <div class="note">
            Tip: Hover an item for stats. Stacks can be sold partially.
          </div>
        </div>
      </aside>

    </div>
  </div>

  <div class="toast-wrap" id="toastWrap"></div>
</body>
</html>
`);
});

// =======================
// SELL API
// =======================
router.post("/api/sell", async (req, res) => {
  const pid = (req.session as any).playerId as number;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const inventoryId = Number(req.body.inventoryId);
  const qty = Number(req.body.qty || 1);

  if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
    return res.json({ error: "Invalid inventory item." });
  }

  try {
    const { removed, goldGained } = await sellInventoryEntryAtomic(pid, inventoryId, qty);

    if (removed <= 0) {
      return res.json({ error: "Item not found." });
    }

    return res.json({ success: true, goldGained, removed });
  } catch (e: any) {
    console.error("❌ Sell failed:", e?.message || e);
    return res.json({ error: "Sell failed. Try again." });
  }
});

export default router;