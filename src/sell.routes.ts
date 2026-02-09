// sell.routes.ts
import express from "express";
import { db } from "./db";

const router = express.Router();

/**
 * Sell rate: payout = floor(items.value * SELL_RATE) * qtySold
 * Change this anytime.
 */
const SELL_RATE = 0.35;

function resolveIcon(icon: any) {
  const raw = (icon ?? "").toString().trim();
  if (!raw) return "";
  if (raw.startsWith("http")) return raw;
  // ensure it starts with exactly one leading slash
  return "/" + raw.replace(/^\/+/, "");
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

  // ✅ format gold with commas
  const goldFmt = new Intl.NumberFormat("en-US").format(Number(player.gold ?? 0));
  // Sellable inventory: NOT equipped. (Keep it simple/safe)
  const [items]: any = await db.query(
    `
    SELECT
      inv.inventory_id AS instance_id,
      inv.quantity,
      inv.equipped,
      i.id AS item_id,
      i.name,
      i.icon,
      i.rarity,
      i.value,
      i.category,
      i.item_type,
      i.slot,
      i.attack, i.defense, i.agility, i.vitality, i.intellect, i.crit,
      i.description
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.player_id = ?
      AND inv.equipped = 0
    ORDER BY
      FIELD(i.rarity,'legendary','epic','rare','uncommon','common') DESC,
      i.slot IS NULL, i.slot ASC,
      i.name ASC
    `,
    [pid]
  );

  // Render grid
  const cards = (items || [])
    .map((it: any) => {
      const unit = Math.max(0, Math.floor((Number(it.value) || 0) * SELL_RATE));

      const stats = [
        it.attack ? `⚔ Attack +${it.attack}` : null,
        it.defense ? `🛡 Defense +${it.defense}` : null,
        it.agility ? `🏃 Agility +${it.agility}` : null,
        it.vitality ? `❤️ Vitality +${it.vitality}` : null,
        it.intellect ? `🧠 Intellect +${it.intellect}` : null,
        it.crit ? `🎯 Crit +${it.crit}%` : null,
      ]
        .filter(Boolean)
        .join("<br>");

      const qtyBadge =
        it.quantity > 1 ? `<div class="stack-count">${it.quantity}</div>` : "";

      return `
        <div class="item-card tooltip-parent"
             data-id="${it.instance_id}"
             data-name="${escapeHtml(it.name)}"
             data-rarity="${it.rarity}"
             data-value="${Number(it.value) || 0}"
             data-unit="${unit}"
             data-qty="${Number(it.quantity) || 1}"
             data-icon="${escapeHtml(it.icon || "")}"
             data-stats="${escapeHtml(stats || "")}"
             data-desc="${escapeHtml(it.description || "")}">
          <div class="icon-wrap">
            <div class="icon">${
              it.icon
                ? `<img src="${escapeHtml(resolveIcon(it.icon))}" alt="" onerror="this.replaceWith(document.createTextNode('📦'))">`
                : "📦"
            }</div>

            ${qtyBadge}
          </div>

          <div class="info">
            <div class="name ${it.rarity}">${it.name}</div>
            <div class="sub">
              ${it.slot ? it.slot.toUpperCase() : (it.category || "ITEM").toUpperCase()}
              <span class="dot">•</span>
              Value: ${Number(it.value) || 0}g
            </div>
          </div>

          <div class="chip">Sell: ${unit}g</div>

          <div class="tooltip">
            <div class="t-name ${it.rarity}">${it.name}</div>
            <div class="t-sub">Value: ${Number(it.value) || 0}g • Rate: ${Math.round(
        SELL_RATE * 100
      )}%</div>
            ${stats ? `<div class="t-stats">${stats}</div>` : ""}
            ${it.description ? `<div class="t-desc">${escapeHtml(it.description)}</div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

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
      margin:0; padding:0;
      color: var(--ink);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background:
        radial-gradient(1100px 600px at 18% 0%, rgba(182,75,46,.12), transparent 60%),
        radial-gradient(900px 500px at 82% 10%, rgba(122,30,30,.08), transparent 55%),
        linear-gradient(180deg, var(--bg1), var(--bg0));
    }
    body::before{
      content:"";
      position:fixed; inset:0;
      pointer-events:none;
      opacity:.10;
      background:
        repeating-linear-gradient(0deg, rgba(255,255,255,.04) 0 1px, transparent 1px 3px),
        repeating-linear-gradient(90deg, rgba(0,0,0,.25) 0 2px, transparent 2px 7px);
      mix-blend-mode: overlay;
    }

    .wrap{
      width: min(1100px, 94vw);
      margin: 0 auto;
      padding-top: 120px; /* room for statpanel */
      padding-bottom: 28px;
      position: relative;
      z-index: 1;
    }

    .panel{
      position:relative;
      border-radius: 12px;
      border: 1px solid rgba(43,52,64,.95);
      background:
        radial-gradient(900px 260px at 18% 0%, rgba(182,75,46,.10), transparent 60%),
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.20)),
        linear-gradient(180deg, var(--panel), var(--panel2));
      box-shadow: 0 18px 40px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.06);
      padding: 14px;
      overflow: visible;
    }
    .panel::before{
      content:"";
      position:absolute; inset:10px;
      pointer-events:none;
      border: 0;
      border-radius: 10px;
    }

    .head{
      position:relative; z-index:1;
      display:flex;
      align-items:flex-end;
      justify-content:space-between;
      gap: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(43,52,64,.85);
      margin-bottom: 12px;
    }
    .title h2{
      margin:0;
      font-family: Cinzel, ui-serif, Georgia, "Times New Roman", serif;
      letter-spacing: 2.2px;
      text-transform: uppercase;
      color: var(--bone);
      font-size: 22px;
      text-shadow: 0 0 10px rgba(182,75,46,.20), 0 10px 18px rgba(0,0,0,.85);
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

    .grid{
      position:relative; z-index:1;
      display:grid;
      grid-template-columns: 1fr 360px;
      gap: 14px;
      align-items:start;
    }

    /* Left: cards */
    .items{
      display:grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      overflow: visible;
    }

    .item-card{
      position:relative;
      display:flex;
      gap: 10px;
      align-items:center;

      padding: 12px;
      border-radius: 12px;
      border: 1px solid rgba(43,52,64,.95);
      background:
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.22)),
        linear-gradient(180deg, var(--panel), var(--panel2));
      box-shadow: 0 16px 34px rgba(0,0,0,.60), inset 0 1px 0 rgba(255,255,255,.06);

      cursor:pointer;
      user-select:none;
      overflow: visible;
      z-index: 1;
    }
    .item-card:hover{
      border-color: rgba(182,75,46,.45);
    }
    .item-card.selected{
      border-color: rgba(182,75,46,.75);
      box-shadow:
        0 0 0 1px rgba(182,75,46,.12),
        0 18px 40px rgba(0,0,0,.70),
        inset 0 1px 0 rgba(255,255,255,.06);
    }

    .icon-wrap{
      position:relative;
      width: 56px;
      height: 56px;
      flex: 0 0 auto;
    }
    .icon{
      width: 56px;
      height: 56px;
      border-radius: 12px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.22);
      box-shadow: inset 0 0 14px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.05);
      display:grid;
      place-items:center;
      overflow:hidden;
    }
    .icon img{
      width:100%;
      height:100%;
      object-fit: contain;
      display:block;
    }
    .stack-count{
      position:absolute;
      bottom: 2px;
      right: 2px;
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 900;
      background: rgba(0,0,0,.60);
      border: 1px solid rgba(43,52,64,.95);
      color: #f3e7db;
      text-shadow: 0 2px 6px rgba(0,0,0,.9);
    }

    .info{ min-width: 0; flex: 1; text-align:left; }
    .name{
      font-weight: 900;
      letter-spacing: .3px;
      color: var(--bone);
      font-size: 14px;
      line-height: 1.15;
      text-transform: uppercase;
    }
    .sub{
      color: var(--muted);
      font-size: 12px;
      letter-spacing: .4px;
      margin-top: 4px;
      white-space: nowrap;
      overflow:hidden;
      text-overflow: ellipsis;
    }
    .dot{ opacity:.6; padding: 0 6px; }

    .chip{
      flex: 0 0 auto;
      padding: 6px 8px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      color: rgba(215,219,226,.92);
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .6px;
      text-transform: uppercase;
      white-space: nowrap;
    }

    /* Right: sell details */
    .sellbox{
      position: sticky;
      top: 120px;
      border-radius: 12px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
      padding: 12px;
      overflow: visible;
    }

    .sellbox h3{
      margin:0 0 10px;
      font-family: Cinzel, ui-serif, Georgia, "Times New Roman", serif;
      letter-spacing: 1.8px;
      text-transform: uppercase;
      color: var(--bone);
      font-size: 14px;
    }

    .line{
      display:flex;
      justify-content:space-between;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(43,52,64,.55);
      color: rgba(215,219,226,.92);
      font-size: 13px;
    }
    .line:last-child{ border-bottom:none; }
    .k{ color: var(--muted); letter-spacing:.5px; text-transform: uppercase; font-size: 12px; }
    .v{ font-weight: 900; }

    .qty{
      display:flex;
      gap: 8px;
      align-items:center;
      margin-top: 12px;
    }
    .qty button{
      width: 38px;
      height: 38px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      color:#f3e7db;
      cursor:pointer;
      font-weight: 900;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
    }
    .qty button:hover{ border-color: rgba(182,75,46,.45); }
    .qty input{
      width: 80px;
      height: 38px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.22);
      color: var(--ink);
      text-align:center;
      font-weight: 900;
      outline:none;
    }

    .primary{
      width:100%;
      margin-top: 12px;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid rgba(182,75,46,.55);
      background: linear-gradient(180deg, rgba(182,75,46,.92), rgba(122,30,30,.88));
      color:#f3e7db;
      font-weight: 900;
      letter-spacing: .7px;
      text-transform: uppercase;
      cursor:pointer;
      box-shadow: 0 14px 28px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.12);
    }
    .primary:disabled{
      opacity:.55;
      cursor:not-allowed;
      filter:none;
    }

    .secondary{
      width:100%;
      margin-top: 10px;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      color:#f3e7db;
      font-weight: 900;
      letter-spacing: .7px;
      text-transform: uppercase;
      cursor:pointer;
      box-shadow: 0 12px 24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
    }
    .secondary:hover{ border-color: rgba(182,75,46,.45); }

    .empty{
      color: var(--muted);
      font-style: italic;
      padding: 10px 0;
    }

    /* TOOLTIP must float above all */
    .tooltip-parent{ position:relative; z-index:1; }
    .tooltip-parent:hover{ z-index: 9999; }
    .tooltip{
      position:absolute;
      left: 10px;
      top: calc(100% + 10px);
      width: 300px;

      background: rgba(9,12,16,.96);
      border: 1px solid rgba(43,52,64,.95);
      border-radius: 12px;
      padding: 10px;
      box-shadow: 0 22px 60px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.06);
      z-index: 10000;

      opacity: 0;
      pointer-events:none;
      transform: translateY(-5px);
      transition: .15s ease;
    }
    .tooltip::before{
      content:"";
      position:absolute;
      inset:10px;
      pointer-events:none;
      border: 0;
      border-radius: 10px;
      opacity:.85;
    }
    .tooltip-parent:hover .tooltip{
      opacity: 1;
      transform: translateY(0);
    }
    .t-name{
      font-weight: 900;
      letter-spacing: .4px;
      text-transform: uppercase;
      margin-bottom: 6px;
      position:relative; z-index:1;
    }
    .t-sub{
      color: var(--muted);
      font-size: 11px;
      letter-spacing: .6px;
      text-transform: uppercase;
      margin-bottom: 8px;
      position:relative; z-index:1;
    }
    .t-stats{
      line-height: 1.4;
      margin-bottom: 8px;
      color: rgba(215,219,226,.92);
      position:relative; z-index:1;
    }
    .t-desc{
      color: var(--muted);
      font-style: italic;
      position:relative; z-index:1;
    }

    /* rarity colors */
    .common{ color: #c9cfd9; }
    .uncommon{ color: #77f29a; }
    .rare{ color: #78c8ff; }
    .epic{ color: #d38cff; }
    .legendary{ color: #ffb84a; }

    @media (max-width: 980px){
      .grid{ grid-template-columns: 1fr; }
      .sellbox{ position: relative; top: 0; }
      .items{ grid-template-columns: 1fr; }
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
          <h2>Sell Items</h2>
          <div class="sub">Rate: ${Math.round(SELL_RATE * 100)}%</div>
        </div>
        <div class="pill">🪙 ${goldFmt}</div>
      </div>

      <div class="grid">
        <div>
          ${cards ? `<div class="items" id="items">${cards}</div>` : `<div class="empty">No sellable items.</div>`}
        </div>

        <div class="sellbox" id="sellbox">
          <h3>Selected Item</h3>
          <div class="empty" id="emptyState">Click an item to preview sale.</div>

          <div id="details" style="display:none">
            <div class="line"><span class="k">Name</span><span class="v" id="dName">—</span></div>
            <div class="line"><span class="k">Value</span><span class="v" id="dValue">0g</span></div>
            <div class="line"><span class="k">Rate</span><span class="v">${Math.round(SELL_RATE * 100)}%</span></div>
            <div class="line"><span class="k">Per Item</span><span class="v" id="dUnit">0g</span></div>
            <div class="line"><span class="k">You Gain</span><span class="v" id="dTotal">0g</span></div>

            <div class="qty" id="qtyRow" style="display:none">
              <button type="button" id="minus">−</button>
              <input id="qty" type="number" min="1" value="1" />
              <button type="button" id="plus">+</button>
            </div>

            <button class="primary" id="sellBtn" disabled>Sell</button>
            <button class="secondary" onclick="location.href='/town'">Return to Town</button>
          </div>
        </div>
      </div>

      <!-- Always-visible footer button -->
      <div style="position:relative; z-index:1; margin-top:12px;">
        <button class="secondary" onclick="location.href='/town'">Return to Town</button>
      </div>

    </div>
  </div>

  <script>
    let selectedId = null;
    let selectedQty = 1;
    let maxQty = 1;
    let unitGold = 0;

    function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

    const TOAST_VISIBLE_MS = 3800;

    function setSelected(card){
      document.querySelectorAll(".item-card").forEach(c => c.classList.remove("selected"));
      card.classList.add("selected");

      selectedId = Number(card.dataset.id);
      maxQty = Number(card.dataset.qty) || 1;
      unitGold = Number(card.dataset.unit) || 0;
      selectedQty = 1;

      document.getElementById("emptyState").style.display = "none";
      document.getElementById("details").style.display = "block";

      document.getElementById("dName").innerText = card.dataset.name || "—";
      document.getElementById("dValue").innerText = (Number(card.dataset.value)||0) + "g";
      document.getElementById("dUnit").innerText = unitGold + "g";

      const qtyRow = document.getElementById("qtyRow");
      const qtyInput = document.getElementById("qty");
      qtyInput.value = "1";
      qtyInput.max = String(maxQty);

      qtyRow.style.display = maxQty > 1 ? "flex" : "none";

      updateTotal();

      document.getElementById("sellBtn").disabled = false;
    }

    function updateTotal(){
      selectedQty = clamp(Number(document.getElementById("qty")?.value || 1), 1, maxQty);
      if (document.getElementById("qty")) document.getElementById("qty").value = String(selectedQty);
      document.getElementById("dTotal").innerText = (unitGold * selectedQty) + "g";
    }

    document.addEventListener("click", (e) => {
      const card = e.target.closest(".item-card");
      if (card) setSelected(card);
    });

    document.getElementById("minus")?.addEventListener("click", () => {
      const q = document.getElementById("qty");
      q.value = String(Math.max(1, Number(q.value) - 1));
      updateTotal();
    });

    document.getElementById("plus")?.addEventListener("click", () => {
      const q = document.getElementById("qty");
      q.value = String(Math.min(maxQty, Number(q.value) + 1));
      updateTotal();
    });

    document.getElementById("qty")?.addEventListener("input", updateTotal);

    document.getElementById("sellBtn")?.addEventListener("click", async () => {
      if (!selectedId) return;

      const res = await fetch("/api/sell", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ inventoryId: selectedId, qty: selectedQty })
      });

      const data = await res.json();
if (data.error) {
  if (window.GFToast?.show) {
    GFToast.show("Sale Failed", data.error, { type: "error", durationMs: TOAST_VISIBLE_MS });
  }
  return;
}

if (window.GFToast?.show) {
  GFToast.show("Item Sold", "You gained " + data.goldGained + "g.", { type: "success", durationMs: TOAST_VISIBLE_MS });
}

      // sync reload to toast visibility so it's never "too fast"
      setTimeout(() => location.reload(), TOAST_VISIBLE_MS + 250);
    });
  </script>

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
  let qty = Number(req.body.qty || 1);

  if (!inventoryId || inventoryId <= 0) {
    return res.json({ error: "Invalid inventory item." });
  }

  // Load the inventory instance + item value (safe validation)
  const [[row]]: any = await db.query(
    `
    SELECT
      inv.inventory_id,
      inv.player_id,
      inv.quantity,
      inv.equipped,
      i.value
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ?
      AND inv.player_id = ?
    LIMIT 1
    `,
    [inventoryId, pid]
  );

  if (!row) return res.json({ error: "Item not found." });
  if (Number(row.equipped) === 1) return res.json({ error: "Unequip that item first." });

  const available = Math.max(1, Number(row.quantity) || 1);
  qty = Math.max(1, Math.min(available, qty));

  const value = Math.max(0, Number(row.value) || 0);
  const unit = Math.max(0, Math.floor(value * SELL_RATE));
  const total = unit * qty;

  // --- Get a dedicated connection (supports promise OR callback pools) ---
  const conn = await getDbConnection(db);

  try {
    await connBegin(conn);

    // decrement stack or delete row
    if (available > qty) {
      const [r]: any = await connQuery(
        conn,
        "UPDATE inventory SET quantity = quantity - ? WHERE inventory_id = ? AND player_id = ?",
        [qty, inventoryId, pid]
      );
      if (r?.affectedRows === 0) throw new Error("Inventory update affected 0 rows");
    } else {
      const [r]: any = await connQuery(
        conn,
        "DELETE FROM inventory WHERE inventory_id = ? AND player_id = ?",
        [inventoryId, pid]
      );
      if (r?.affectedRows === 0) throw new Error("Inventory delete affected 0 rows");
    }

    // add gold
    const [g]: any = await connQuery(
      conn,
      "UPDATE players SET gold = gold + ? WHERE id = ?",
      [total, pid]
    );
    if (g?.affectedRows === 0) throw new Error("Gold update affected 0 rows");

    await connCommit(conn);
    return res.json({ success: true, goldGained: total });
  } catch (e: any) {
    console.error("❌ Sell transaction failed:", e?.message || e, e);
    try { await connRollback(conn); } catch {}
    return res.json({ error: "Sell failed. Try again." });
  } finally {
    try { connRelease(conn); } catch {}
  }
});

// -------------------------
// mysql2 pool compatibility helpers
// -------------------------

async function getDbConnection(pool: any) {
  if (!pool?.getConnection) throw new Error("db.getConnection() not available on db pool");

  // promise pool: getConnection() returns a Promise
  if (pool.getConnection.length === 0) {
    return await pool.getConnection();
  }

  // callback pool: getConnection(cb)
  return await new Promise((resolve, reject) => {
    pool.getConnection((err: any, connection: any) => {
      if (err) reject(err);
      else resolve(connection);
    });
  });
}

function connRelease(conn: any) {
  if (conn?.release) return conn.release();
  if (conn?.end) return conn.end();
}

async function connBegin(conn: any) {
  if (conn?.beginTransaction?.length === 0) return await conn.beginTransaction();
  return await new Promise((resolve, reject) => {
    conn.beginTransaction((err: any) => (err ? reject(err) : resolve(true)));
  });
}

async function connCommit(conn: any) {
  if (conn?.commit?.length === 0) return await conn.commit();
  return await new Promise((resolve, reject) => {
    conn.commit((err: any) => (err ? reject(err) : resolve(true)));
  });
}

async function connRollback(conn: any) {
  if (conn?.rollback?.length === 0) return await conn.rollback();
  return await new Promise((resolve) => {
    conn.rollback(() => resolve(true));
  });
}

async function connQuery(conn: any, sql: string, params: any[]) {
  // promise connection: conn.query returns a Promise
  if (conn?.query?.length <= 2) {
    return await conn.query(sql, params);
  }
  // callback connection: conn.query(sql, params, cb)
  return await new Promise((resolve, reject) => {
    conn.query(sql, params, (err: any, results: any) => {
      if (err) reject(err);
      else resolve([results]);
    });
  });
}

export default router;

// simple HTML escape for safety in attributes/tooltips
function escapeHtml(input: string) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
