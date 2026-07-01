import express from "express";
import { db } from "./db";
import { addItemWithConn } from "./services/inventoryService";
import { hasInventorySpace } from "./services/inventoryCapacityService";

const router = express.Router();

function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) return res.redirect("/login.html");
  next();
}

function esc(input: any) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

router.get("/", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;

  const [[player]]: any = await db.query(
    `
    SELECT name, gold
    FROM players
    WHERE id = ?
    LIMIT 1
    `,
    [pid]
  );

  if (!player) return res.redirect("/login.html");

  const [tools]: any = await db.query(
  `
  SELECT
    wsi.id AS supplierItemId,
    wsi.price,
    wsi.stock,
    i.id AS itemId,
    i.name,
    i.description,
    i.icon,
    i.item_type
  FROM workshop_supplier_items wsi
  JOIN items i ON i.id = wsi.item_id
  JOIN players p ON p.id = ?
  JOIN locations l
    ON l.map_x = p.map_x
   AND l.map_y = p.map_y
  WHERE wsi.location_id = l.id
  ORDER BY wsi.display_order ASC, i.name ASC
  `,
  [pid]
);

const toolCards = tools.map((t: any) => {
  const price = Number(t.price || 0);
  const canAfford = Number(player.gold || 0) >= price;

  return `
    <article class="supplier-item">
      <div class="supplier-icon">
        <img src="${esc(t.icon || "/icons/items/default.png")}" onerror="this.style.display='none'">
      </div>

      <div class="supplier-main">
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.description || "A useful gathering tool.")}</p>
        <div class="supplier-meta">
          <span>${esc(t.item_type || "tool")}</span>
          <span>${price}g</span>
        </div>
      </div>

      <div class="supplier-action">
        ${
          canAfford
            ? `<a class="btn primary" href="/workshop/buy/${Number(t.itemId)}">Buy</a>`
            : `<span class="status locked">Need ${price}g</span>`
        }
      </div>
    </article>
  `;
}).join("");

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800&display=swap" rel="stylesheet">

  <title>Guildforge | Workshop</title>

  <link rel="stylesheet" href="/statpanel.css">
  <link rel="stylesheet" href="/workshop.css">

  <script defer src="/statpanel.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <main class="workshop-page">
    <section class="workshop-shell">

      <header class="workshop-hero">
        <div class="hero-title">
          <div class="hero-icon">⚒️</div>
          <div>
            <h1>Workshop</h1>
            <p>Tools, commissions, and profession services for working adventurers.</p>
          </div>
        </div>

        <div class="hero-actions">
          <span class="pill">Gold: <strong>${Number(player.gold || 0)}g</strong></span>
          <a class="btn danger" href="/town">Return to Town</a>
        </div>
      </header>

      <div class="workshop-grid">

        <section class="card service-card">
          <div class="cardHeader">
            <div class="cardTitle">
              <h2>🛒 Artisan Supplier</h2>
              <p>Purchase gathering tools and profession supplies.</p>
            </div>
            <span class="badge good">Available</span>
          </div>

          <div class="cardBody">
            <div class="supplier-list">
                ${toolCards || `<div class="empty">No gathering tools are available in this town.</div>`}
            </div>
            </div>
            </section>

        <section class="card service-card">
          <div class="cardHeader">
            <div class="cardTitle">
              <h2>📜 Commission Board</h2>
              <p>Accept daily profession contracts and earn rewards.</p>
            </div>
            <span class="badge warn">Coming Soon</span>
          </div>

          <div class="cardBody">
            <div class="service-preview">
              <div class="service-icon">📋</div>
              <div>
                <h3>Guild Commissions</h3>
                <p>Complete gathering contracts for profession XP, gold, and future profession tokens.</p>
              </div>
            </div>

            <button class="btn disabled" disabled>Contracts Coming Soon</button>
          </div>
        </section>

        <section class="card service-card wide">
          <div class="cardHeader">
            <div class="cardTitle">
              <h2>Future Workshop Services</h2>
              <p>This hall will grow as professions expand.</p>
            </div>
          </div>

          <div class="cardBody future-grid">
            <div class="future-box">
              <strong>Salvage Bench</strong>
              <p>Break down items into crafting materials.</p>
            </div>

            <div class="future-box">
              <strong>Profession Talents</strong>
              <p>Unlock passive bonuses for gathering and crafting.</p>
            </div>

            <div class="future-box">
              <strong>Crafting Stations</strong>
              <p>Forge, alchemy table, workbench, and more.</p>
            </div>
          </div>
        </section>

      </div>
    </section>
  </main>
</body>
</html>`);
});


router.get("/buy/:itemId", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;
  const itemId = Number(req.params.itemId);

  if (!Number.isFinite(itemId)) return res.redirect("/workshop");

    const [[tool]]: any = await db.query(
    `
    SELECT
        wsi.item_id AS itemId,
        wsi.price
    FROM workshop_supplier_items wsi
    JOIN players p ON p.id = ?
    JOIN locations l
        ON l.map_x = p.map_x
    AND l.map_y = p.map_y
    JOIN items i ON i.id = wsi.item_id
    WHERE wsi.item_id = ?
        AND wsi.location_id = l.id
        AND (
        i.type = 'tool'
        OR i.item_type IN ('mining_tool', 'herbalism_tool', 'woodcutting_tool')
        )
    LIMIT 1
    `,
    [pid, itemId]
    );
    
  if (!tool) return res.redirect("/workshop");

  const price = Number(tool.price || 0);

  const space = await hasInventorySpace(pid, 1);
  if (!space.hasSpace) return res.redirect("/workshop");

  const conn = await db.getConnection();

  try {
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
      return res.redirect("/workshop");
    }

    await addItemWithConn(conn, pid, itemId, 1);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error("Workshop supplier purchase failed:", err);
  } finally {
    conn.release();
  }

  res.redirect("/workshop");
});
export default router;