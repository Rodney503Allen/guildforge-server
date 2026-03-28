//src/town.routes.ts
import express from "express";
import { db } from "./db";
import { getJournalQuests } from "./services/questService";

const router = express.Router();
console.log("✅ TOWN ROUTES FILE LOADED");
router.get("/town/current", async (req, res) => {
  const pid = (req.session as any)?.playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const [[player]]: any = await db.query(
    `SELECT map_x, map_y FROM players WHERE id=?`,
    [pid]
  );

  const [[town]]: any = await db.query(
    `SELECT id, name FROM locations WHERE map_x=? AND map_y=? LIMIT 1`,
    [player.map_x, player.map_y]
  );

  if (!town) return res.json({ id: null, name: "Unknown" });

  res.json({ id: town.id, name: town.name });
});
// =======================
// GOSSIP (random unaccepted quest hint)
// =======================
router.get("/api/town/:townId/gossip", async (req, res) => {
  const pid = Number((req.session as any)?.playerId);
  if (!pid) return res.status(401).json({ error: "not_logged_in" });

  const townId = Number(req.params.townId);

  try {
    const payload = await getJournalQuests(pid);

    // payload.rumors already excludes accepted quests (by design of your journal)
    const rumors = (payload?.rumors || [])
      .filter((r: any) => {
        const hint = String(r?.rumor_hint || "").trim();
        if (!hint) return false;

        // Prefer town-specific gossip; allow null town rumors as fallback
        const rTown = r?.town_id != null ? Number(r.town_id) : null;
        return rTown === townId || rTown === null;
      });

    if (!rumors.length) {
      return res.json({
        hasGossip: false,
        text: "The ledger is quiet. No fresh whispers tonight."
      });
    }

    const pick = rumors[Math.floor(Math.random() * rumors.length)];

    return res.json({
      hasGossip: true,
      questId: Number(pick.questId),
      title: pick.title,
      text: pick.rumor_hint
    });
  } catch (err: any) {
    console.error("gossip failed:", err?.message);
    res.status(500).json({ error: "server_error" });
  }
});
// =======================
// TOWN UI
// =======================
router.get("/town", async (req, res) => {

  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  // =======================
  // LOAD PLAYER POSITION
  // =======================
  const [[player]]: any = await db.query(`
    SELECT map_x, map_y
    FROM players
    WHERE id = ?
  `, [pid]);

  // =======================
  // FIND LOCATION AT TILE
  // =======================
  const [[town]]: any = await db.query(`
    SELECT *
    FROM locations
    WHERE map_x = ? AND map_y = ?
    LIMIT 1
  `, [player.map_x, player.map_y]);

if (!town) {
  return res.redirect("/world");
}
// =======================
// LOAD TOWN SERVICES
// =======================
const [servicesRaw]: any = await db.query(`
  SELECT *
  FROM location_services
  WHERE location_id = ?
  ORDER BY display_order ASC, name ASC
`, [town.id]);

// Remove the old 3 shop entries (either by name OR route pattern)
const services = (servicesRaw || []).filter((s: any) => {
  const name = String(s.name || "").toLowerCase();
  const route = String(s.route || "").toLowerCase();

  const isLegacyShopByName =
    name.includes("general store") ||
    name.includes("blacksmith") ||
    name.includes("armorer");

  const isLegacyShopByRoute = route.startsWith("/shop/"); // old /shop/:id

  return !(isLegacyShopByName || isLegacyShopByRoute);
});

// Inject unified Market button near the top (after display_order 0 usually)
services.splice(1, 0, {
  name: "Market",
  route: "/shop",
  icon: "/icons/ui/market.png",
  display_order: 1
});
function renderServiceIcon(icon: any) {
  const v = String(icon || "").trim();
  if (!v) return `<span class="iconText">🏛</span>`;

  // treat as image if it looks like a path or file
  const isImg =
    v.startsWith("/") ||
    v.startsWith("http") ||
    v.includes("/") ||
    /\.(png|jpg|jpeg|webp|svg)$/i.test(v);

  if (isImg) {
    // if DB stores "public/..." strip it for browser paths
    const src = v.startsWith("/public/") ? v.replace("/public/", "/") : v;
    return `<img class="iconImg" src="${src}" alt="">`;
  }

  // otherwise assume emoji/text
  return `<span class="iconText">${v}</span>`;
}

function serviceSubtitle(s: any) {
  const name = String(s?.name || "").toLowerCase();
  const route = String(s?.route || "").toLowerCase();

  // route-first (most reliable)
  if (route === "/shop") return "Market stalls & merchants";
  if (route === "/tavern") return "Rumors, quests, and company";
  if (route === "/trainer") return "Learn spells & techniques";
  if (route === "/church") return "Revive and recover safely";
  if (route === "/sell") return "Offload loot for coin";
  if (route === "/guild") return "Perks, roles, and progress";
  if (route === "/inventory") return "Manage gear & items";
  if (route === "/quests") return "Track your active work";
  if (route === "/world") return "Leave the safety of the walls";

  // name-based fallback (in case routes vary later)
  if (name.includes("market")) return "Market stalls & merchants";
  if (name.includes("tavern")) return "Rumors, quests, and company";
  if (name.includes("trainer")) return "Learn spells & techniques";
  if (name.includes("church") || name.includes("sanctuary")) return "Revive and recover safely";
  if (name.includes("sell")) return "Offload loot for coin";
  if (name.includes("guild")) return "Perks, roles, and progress";
  if (name.includes("quest")) return "Track your active work";
  if (name.includes("inventory") || name.includes("backpack")) return "Manage gear & items";

  return "Open service";
}

  // =======================
  // RENDER LINKS
  // =======================
  const buttons = services.map((s: any) => `
    <a class="service" href="${s.route}">
      <span class="icon">${renderServiceIcon(s.icon)}</span>
      <span class="label">${s.name}</span>
    </a>
  `).join("");

  // =======================
  // PAGE OUTPUT
  // =======================
res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <title>Guildforge | ${town.name}</title>

  <link rel="stylesheet" href="/town.css">
  <script defer src="/town.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <div class="wrap">

    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> ${town.name}</div>
        <div class="sub">${town.description || "A place of faith, shelter, and guarded coin."}</div>
      </div>

      <div class="nav">
        <span class="pill">Haven: <strong>${town.name}</strong></span>
        <a class="btn danger" href="/world">⚔ Step Into the Wilderness</a>
      </div>
    </div>

    <div class="grid">

      <!-- LEFT: SERVICES -->
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Town Services</h2>
            <p>Trade, train, heal, and prepare.</p>
          </div>
          <span class="badge good">Safe Zone</span>
        </div>

        <div class="cardBody">
          <div class="servicesGrid">
            ${services.map((s: any) => `
              <a class="serviceTile ${s.route === "/shop" ? "featured" : ""}" href="${s.route}">
                <div class="serviceIcon">${renderServiceIcon(s.icon)}</div>
                <div class="serviceLabel">
                  <strong>${s.name}</strong>
                  <span>${serviceSubtitle(s)}</span>
                </div>
              </a>
            `).join("")}
          </div>


          <div class="note">Some services may be expanded later (parties, bulletin board, trade offers).</div>
        </div>
      </section>

      <!-- RIGHT: INFO / UPDATES / DANGER CTA -->
      <aside class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Town Ledger</h2>
            <p>Notes, updates, and warnings.</p>
          </div>
          <div style="display:flex; gap:10px; align-items:center;">
            <button class="btn journal" id="btn-journal" type="button">
              📖 Journal
            </button>

          </div>
        </div>

        <div class="cardBody">

        <div class="infoBox" aria-label="Gossip">
          <div class="infoTitle">
            <strong>Gossip</strong>
            <span class="badge">Whispers</span>
          </div>

          <p class="infoText" id="town-gossip">
            Listening for whispers…
          </p>

          <div class="infoText" id="town-gossip-meta" style="color: var(--muted); font-size: 12px; margin-top: 8px;"></div>
        </div>

          <div class="divider"></div>

          <!-- Optional: reuse your “Latest Updates” concept -->
          <div class="infoBox" aria-label="Latest Updates">
            <div class="infoTitle">
              <strong>Latest Updates</strong>
              <span class="badge">What’s new</span>
            </div>

            <p class="infoText" style="color: var(--muted); font-size:12px;">
• Loot drops now appear as a chest you open after combat.  
• Rumor quests can be found in the tavern and accepted.  
• Quest turn-ins can be claimed when objectives are complete.
            </p>
          </div>

          <div class="divider"></div>

          <div class="wilderness">
            <div>
              <div style="font-weight:800; letter-spacing:.3px; color:#fff; font-size:13px; margin-bottom:4px;">
                ⚔ Venture Out
              </div>
              <p>Supplies, gear, and luck — that’s what survives the wild.</p>
            </div>
            <a class="btn danger" href="/world">Leave Haven</a>
          </div>

        </div>
      </aside>

    </div>
  </div>

  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>
  <script>window.GF_TOWN_ID = ${town.id};</script>
</body>
</html>
`);



});

export default router;
