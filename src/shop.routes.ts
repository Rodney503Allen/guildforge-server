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
    "SELECT pclass, gold FROM players WHERE id = ? LIMIT 1",
    [pid]
  );

if (!player) return res.redirect("/login.html");

const loadout = CLASS_LOADOUTS[player.pclass];
const goldFmt = new Intl.NumberFormat("en-US").format(Number(player.gold ?? 0));
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

  // Icon handling (image path/url OR emoji fallback)
  const rawIcon = (i.icon ?? "").toString().trim();
  const isImage = /\.(png|jpe?g|webp|gif|svg)$/i.test(rawIcon);
  
  const iconSrc =
    isImage && rawIcon && !rawIcon.startsWith("http") && !rawIcon.startsWith("/")
      ? `/${rawIcon}`
      : rawIcon;

  const thumbHtml = isImage
    ? `<img class="item-thumb" src="${iconSrc}" alt="${i.name}" loading="lazy"
         onerror="this.replaceWith(document.createTextNode('📦'));">`
    : `<div class="item-emoji" aria-label="${i.name}">${rawIcon || "📦"}</div>`;

  // Tooltip info (ALL item info lives here)
  const infoLines = [
    `<div class="t-line"><span class="t-k">Price</span><span class="t-v">💰 ${i.price}</span></div>`,
    `<div class="t-line"><span class="t-k">Stock</span><span class="t-v">${i.stock}</span></div>`,
    i.category ? `<div class="t-line"><span class="t-k">Category</span><span class="t-v">${i.category}</span></div>` : "",
    i.item_type ? `<div class="t-line"><span class="t-k">Type</span><span class="t-v">${i.item_type}</span></div>` : "",
    i.value ? `<div class="t-line"><span class="t-k">Value</span><span class="t-v">${i.value}</span></div>` : ""
  ].filter(Boolean).join("");

  const canBuy = i.stock > 0;

  return `
    <div class="item tooltip-parent" tabindex="0" aria-label="${i.name}">
      <div class="thumb">
        ${thumbHtml}
      </div>

      <button ${canBuy ? "" : "disabled"} onclick="buy(${i.shopItemId})">
        ${canBuy ? "Buy" : "Sold Out"}
      </button>

      <div class="tooltip">
        <div class="t-name ${i.rarity || "common"}">${i.name}</div>
        ${infoLines ? `<div class="t-info">${infoLines}</div>` : ""}
        ${stats ? `<div class="t-stats">${stats}</div>` : ""}
        ${i.description ? `<div class="t-desc">${i.description}</div>` : ""}
      </div>
    </div>
  `;
}).join("");




res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Guildforge | ${shop.name}</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/ui/toast.css">
  <script src="/ui/toast.js"></script>
  <style>
    :root{
      --bg0:#07090c;
      --bg1:#0b0f14;
      --panel:#0e131a;
      --panel2:#0a0f15;

      --ink:#d7dbe2;
      --muted:#9aa3af;

      --iron:#2b3440;
      --ember:#b64b2e;
      --blood:#7a1e1e;
      --bone:#c9b89a;

      --shadow: rgba(0,0,0,.60);
      --frame: rgba(255,255,255,.04);
      --glass: rgba(0,0,0,.18);
    }

    *{ box-sizing:border-box; }

    html, body{
      margin:0;
      padding:0;
      color: var(--ink);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;

      background:
        radial-gradient(1100px 600px at 18% 0%, rgba(182,75,46,.12), transparent 60%),
        radial-gradient(900px 500px at 82% 10%, rgba(122,30,30,.08), transparent 55%),
        linear-gradient(180deg, var(--bg1), var(--bg0));
    }

    /* grit overlay */
    body::before{
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      opacity:.10;
      background:
        repeating-linear-gradient(0deg, rgba(255,255,255,.04) 0 1px, transparent 1px 3px),
        repeating-linear-gradient(90deg, rgba(0,0,0,.25) 0 2px, transparent 2px 7px);
      mix-blend-mode: overlay;
    }

    .wrap{
      width: min(980px, 94vw);
      margin: 0 auto;
      padding: 18px 0 28px;
    }

    .panel{
      position:relative;
      margin: 80px auto 0;
      padding: 18px;
      border-radius: 12px;

      border: 1px solid rgba(43,52,64,.95);
      background:
        radial-gradient(900px 260px at 18% 0%, rgba(182,75,46,.12), transparent 60%),
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.20)),
        linear-gradient(180deg, var(--panel), var(--panel2));

      box-shadow: 0 18px 40px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.06);
    }

    .panel::before{
      content:"";
      position:absolute;
      inset:10px;
      pointer-events:none;
      border: 0;
      border-radius: 10px;
    }

    .head{
      display:flex;
      align-items:flex-end;
      justify-content:space-between;
      gap: 14px;
      position:relative;
      z-index:1;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(43,52,64,.85);
      margin-bottom: 12px;
    }

    .title{
      text-align:left;
    }

    .title h2{
      margin:0;
      font-family: Cinzel, ui-serif, Georgia, "Times New Roman", serif;
      letter-spacing: 2.2px;
      text-transform: uppercase;
      color: var(--bone);
      font-size: 22px;
      text-shadow:
        0 0 10px rgba(182,75,46,.20),
        0 10px 18px rgba(0,0,0,.85);
    }

    .sub{
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: .6px;
      text-transform: uppercase;
    }

    .pill{
      display:inline-flex;
      align-items:center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      color: var(--ink);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .6px;
      text-transform: uppercase;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
      white-space: nowrap;
    }

    .rule{
      height:1px;
      border:none;
      margin: 14px 0;
      background: linear-gradient(90deg, transparent, rgba(182,75,46,.65), transparent);
      opacity:.85;
      position:relative;
      z-index:1;
    }

/* ITEM GRID (thumbnail cards) */
.items{
  display:grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 12px;
  position:relative;
  z-index:1;
  margin-top: 6px;
}
.item{
  position:relative;
  border-radius: 12px;
  border: 1px solid rgba(43,52,64,.95);
  background:
    linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.22)),
    linear-gradient(180deg, var(--panel), var(--panel2));
  box-shadow: 0 16px 34px rgba(0,0,0,.60), inset 0 1px 0 rgba(255,255,255,.06);

  padding: 12px;
  display:flex;
  flex-direction:column;
  gap: 10px;
  align-items:center;
  justify-content:space-between;
  min-height: 164px;

  transition: transform .12s ease, border-color .12s ease, filter .12s ease;
  outline: none;
}

    .item:hover{
      border-color: rgba(182,75,46,.55);
      filter: brightness(1.03);
      box-shadow:
        0 0 0 1px rgba(182,75,46,.10),
        0 20px 44px rgba(0,0,0,.75),
        inset 0 1px 0 rgba(255,255,255,.06);
    }
.item:hover,
.item:focus{
  border-color: rgba(182,75,46,.55);
  filter: brightness(1.03);
  box-shadow:
    0 0 0 1px rgba(182,75,46,.10),
    0 20px 44px rgba(0,0,0,.75),
    inset 0 1px 0 rgba(255,255,255,.06);
}

    .name{
      text-align:left;
      font-weight: 900;
      letter-spacing: .3px;
      color: var(--bone);
      font-size: 14px;
      display:flex;
      align-items:center;
      gap: 8px;
      line-height: 1.2;
    }

    .meta{
      margin-top: 8px;
      text-align:left;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      font-weight: 600;
    }

    .buycol{
      display:flex;
      flex-direction:column;
      align-items:flex-end;
      justify-content:space-between;
      gap: 10px;
    }

    .price{
      font-size: 12px;
      color: var(--ink);
      letter-spacing: .6px;
      font-weight: 900;
      text-transform: uppercase;
      padding: 6px 8px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
      white-space: nowrap;
    }

    button{
      border-radius: 10px;
      border: 1px solid rgba(182,75,46,.55);
      background: linear-gradient(180deg, rgba(182,75,46,.92), rgba(122,30,30,.88));
      color: #f3e7db;

      padding: 10px 12px;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .7px;
      text-transform: uppercase;

      cursor:pointer;
      box-shadow: 0 14px 28px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.12);
      transition: transform .12s ease, filter .12s ease, border-color .12s ease;
      min-width: 96px;
    }

    button:hover{
      filter: brightness(1.06);
      transform: translateY(-1px);
    }

    button:active{ transform: translateY(0) scale(.99); }

    button:disabled{
      opacity:.55;
      cursor:not-allowed;
      transform:none;
      filter:none;
    }

    .returnBtn{
      width:100%;
      margin-top: 12px;
    }

    .empty{
      color: var(--muted);
      font-style: italic;
      padding: 8px 0;
      position:relative;
      z-index:1;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    }
.thumb{
  width: 92px;
  height: 92px;
  display:flex;
  align-items:center;
  justify-content:center;
  border-radius: 12px;
  border: 1px solid rgba(43,52,64,.85);
  background: rgba(0,0,0,.18);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
}

.item-thumb{
  width: 76px;
  height: 76px;
  object-fit: contain;
  image-rendering: pixelated; /* remove if not pixel art */
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.65));
}

.item-emoji{
  font-size: 44px;
  line-height: 1;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.65));
}

.item-emoji{
  font-size: 44px;
  line-height: 1;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.65));
}

/* Button stays, but make it full width inside card */
.item > button{
  width: 100%;
  min-width: 0;
}

/* TOOLTIP SYSTEM (make it work on hover AND keyboard focus) */
.tooltip-parent{ position:relative; z-index:1; }
.tooltip-parent:hover{ z-index:9999; }
.tooltip-parent:focus{ z-index:9999; }

.tooltip{
  position:absolute;
  left: 50%;
  top: calc(100% + 10px);
  transform: translate(-50%, -5px);
  width: 310px;

  background: rgba(9,12,16,.96);
  border: 1px solid rgba(43,52,64,.95);
  border-radius: 12px;
  padding: 10px;

  color: var(--ink);
  font-size: 12px;
  box-shadow: 0 18px 40px rgba(0,0,0,.75), inset 0 1px 0 rgba(255,255,255,.06);
  z-index: 10000;

  opacity: 0;
  pointer-events:none;
  transition: .15s ease;
}

.tooltip::before{
  content:"";
  position:absolute;
  inset:10px;
  pointer-events:none;
  border: 1px solid rgba(255,255,255,.04);
  border-radius: 10px;
  opacity: .8;
}


.tooltip-parent:hover .tooltip,
.tooltip-parent:focus .tooltip{
  opacity: 1;
  transform: translate(-50%, 0);
}

.t-name{
  font-weight: 900;
  margin-bottom: 8px;
  letter-spacing: .4px;
  position:relative;
  z-index:1;
}
.t-info{
  margin-bottom: 8px;
  position:relative;
  z-index:1;
}
  .t-line{
  display:flex;
  justify-content:space-between;
  gap: 10px;
  padding: 3px 0;
  border-bottom: 1px dashed rgba(255,255,255,.06);
}

.t-line:last-child{ border-bottom: 0; }

.t-k{
  color: var(--muted);
  font-weight: 800;
  letter-spacing: .4px;
  text-transform: uppercase;
  font-size: 11px;
}

.t-v{
  color: rgba(215,219,226,.95);
  font-weight: 800;
}
.t-stats{
  margin-bottom: 8px;
  line-height: 1.4;
  color: rgba(215,219,226,.92);
  position:relative;
  z-index:1;
}

.t-desc{
  font-style: italic;
  color: var(--muted);
  position:relative;
  z-index:1;
}

    /* Rarity colors (same classes you already output) */
    .common{ color: #c9cfd9; }
    .uncommon{ color: #77f29a; }
    .rare{ color: #78c8ff; }
    .epic{ color: #d38cff; }
    .legendary{ color: #ffb84a; }

    /* Responsive */
    @media (max-width: 820px){
      .items{ grid-template-columns: 1fr; }
      .panel{ margin-top: 76px; }
    }
/* --- TOOLTIP MUST FLOAT ABOVE ALL SHOP ITEMS --- */
    .tooltip-parent{
      position: relative;
      z-index: 1;
    }

    .tooltip-parent:hover{
      z-index: 9999;
    }

    .tooltip{
      z-index: 10000;
    }
    .item-icon{
    width: 22px;
    height: 22px;
    object-fit: contain;
    flex: 0 0 22px;
    image-rendering: pixelated; /* remove if not pixel art */
    filter: drop-shadow(0 2px 3px rgba(0,0,0,.65));
  }


  </style>
</head>

<body>
  <div id="statpanel-root"></div>
  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>

  <div class="wrap">
    <div class="panel">
      <div class="head">
        <div class="title">
          <h2>${shop.name}</h2>
          <div class="sub">${shop.town}</div>
        </div>
        <div class="pill">🪙 ${goldFmt}</div>
      </div>

      <div class="items">
        ${rows || "<div class='empty'>No items for sale.</div>"}
      </div>

      <hr class="rule">

      <button class="returnBtn" onclick="location.href='/town'">Return to Town</button>
    </div>
  </div>
<div class="toast-wrap" id="toastWrap"></div>

<script>
  const TOAST_VISIBLE_MS = 3800;

  async function buy(id) {
    const res = await fetch("/api/shop/buy", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ shopItemId:id })
    });

    const data = await res.json();

    if (data.error) {
      // shared toast
      if (window.GFToast?.show) {
        GFToast.show("Purchase Failed", data.error, { type: "error", durationMs: TOAST_VISIBLE_MS });
      }
      return;
    }

    if (window.GFToast?.show) {
      GFToast.show("Purchased", "Item added to your inventory.", { type: "success", durationMs: TOAST_VISIBLE_MS });
    }

    setTimeout(() => location.reload(), TOAST_VISIBLE_MS + 250);
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
const [[player]]: any = await db.query(
  `SELECT gold FROM players WHERE id = ? LIMIT 1`,
  [pid]
);

if (!player) return res.json({ error: "Player not found" });
if (Number(player.gold) < Number(item.price)) return res.json({ error: "Not enough gold" });


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
