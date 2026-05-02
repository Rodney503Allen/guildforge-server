// src/town.routes.ts
import express from "express";
import { db } from "./db";
import { getJournalQuests } from "./services/questService";

const router = express.Router();

console.log("✅ TOWN ROUTES FILE LOADED");

function escapeHtml(value: any) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripPublicPath(path: string) {
  return path.startsWith("/public/") ? path.replace("/public/", "/") : path;
}

function renderServiceIcon(icon: any) {
  const v = String(icon || "").trim();
  if (!v) return `<span class="iconText">🏛</span>`;

  const isImg =
    v.startsWith("/") ||
    v.startsWith("http") ||
    v.includes("/") ||
    /\.(png|jpg|jpeg|webp|svg)$/i.test(v);

  if (isImg) {
    const src = stripPublicPath(v);
    return `<img class="iconImg" src="${escapeHtml(src)}" alt="">`;
  }

  return `<span class="iconText">${escapeHtml(v)}</span>`;
}

function serviceSubtitle(s: any) {
  const name = String(s?.name || "").toLowerCase();
  const route = String(s?.route || "").toLowerCase();

  if (route === "/shop") return "Browse wares, trade, and deal.";
  if (route === "/tavern") return "Rumors, quests, and good company.";
  if (route === "/trainer") return "Learn powerful spells and techniques.";
  if (route === "/church") return "Revive, heal, and restore your strength.";
  if (route === "/sell") return "Offload loot for coin and profit.";
  if (route === "/guild") return "Manage guild roles, perks, and progress.";
  if (route === "/inventory") return "Manage gear, items, and supplies.";
  if (route === "/quests") return "Review your active work and rumors.";
  if (route === "/world") return "Leave the safety of the walls.";

  if (name.includes("market")) return "Browse wares, trade, and deal.";
  if (name.includes("tavern")) return "Rumors, quests, and good company.";
  if (name.includes("trainer")) return "Learn powerful spells and techniques.";
  if (name.includes("church") || name.includes("sanctuary")) return "Revive, heal, and restore your strength.";
  if (name.includes("sell")) return "Offload loot for coin and profit.";
  if (name.includes("guild")) return "Manage guild roles, perks, and progress.";
  if (name.includes("quest")) return "Review your active work and rumors.";
  if (name.includes("inventory") || name.includes("backpack")) return "Manage gear, items, and supplies.";

  return "Open service.";
}

function serviceClass(s: any) {
  const route = String(s?.route || "").toLowerCase();
  const name = String(s?.name || "").toLowerCase();

  if (route === "/shop" || name.includes("market")) return "market";
  if (route === "/tavern" || name.includes("tavern")) return "tavern";
  if (route === "/trainer" || name.includes("trainer")) return "trainer";
  if (route === "/church" || name.includes("sanctuary") || name.includes("church")) return "sanctuary";
  if (route === "/sell" || name.includes("sell")) return "sell";
  if (route === "/guild" || name.includes("guild")) return "guild";
  return "default";
}

// =======================
// CURRENT TOWN JSON
// =======================
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
// GOSSIP
// =======================
router.get("/api/town/:townId/gossip", async (req, res) => {
  const pid = Number((req.session as any)?.playerId);
  if (!pid) return res.status(401).json({ error: "not_logged_in" });

  const townId = Number(req.params.townId);

  try {
    const payload = await getJournalQuests(pid);

    const rumors = (payload?.rumors || []).filter((r: any) => {
      const hint = String(r?.rumor_hint || "").trim();
      if (!hint) return false;

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

  const [[player]]: any = await db.query(`
    SELECT map_x, map_y
    FROM players
    WHERE id = ?
  `, [pid]);

  const [[town]]: any = await db.query(`
    SELECT *
    FROM locations
    WHERE map_x = ? AND map_y = ?
    LIMIT 1
  `, [player.map_x, player.map_y]);

  if (!town) return res.redirect("/world");

  const [servicesRaw]: any = await db.query(`
    SELECT *
    FROM location_services
    WHERE location_id = ?
    ORDER BY display_order ASC, name ASC
  `, [town.id]);

  const services = (servicesRaw || []).filter((s: any) => {
    const name = String(s.name || "").toLowerCase();
    const route = String(s.route || "").toLowerCase();

    const isLegacyShopByName =
      name.includes("general store") ||
      name.includes("blacksmith") ||
      name.includes("armorer");

    const isLegacyShopByRoute = route.startsWith("/shop/");

    return !(isLegacyShopByName || isLegacyShopByRoute);
  });

  if (!services.some((s: any) => String(s.route || "").toLowerCase() === "/shop")) {
    services.splice(1, 0, {
      name: "Market",
      route: "/shop",
      icon: "/icons/ui/market.png",
      display_order: 1
    });
  }

  const townName = escapeHtml(town.name || "Unknown Haven");
  const townDescription = escapeHtml(
    town.description ||
    "A guarded haven where travelers trade stories, mend wounds, and prepare for the wilds."
  );

  res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700;800&display=swap" rel="stylesheet">
  <title>Guildforge | ${townName}</title>

  <link rel="stylesheet" href="/statpanel.css">
  <link rel="stylesheet" href="/town.css">
  <script defer src="/town.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <main class="town-page">
    <section class="town-shell">

      <div class="town-layout">
        <!-- LEFT COLUMN -->
        <div class="town-main">
          <section class="town-hero">
            <div class="town-hero__shade"></div>
            <div class="town-hero__content">
              <div class="town-kicker">
                <span></span>
                Current Haven
                <span></span>
              </div>

              <h1>${townName}</h1>
              <p>${townDescription}</p>

              <div class="town-hero__actions">
                <span class="safe-chip">🛡 Safe Zone</span>
                <a class="danger-chip" href="/world">⚔ Step Into the Wilderness</a>
              </div>
            </div>
          </section>

          <section class="services-panel">
            <div class="section-heading">
              <div>
                <h2>Town Services</h2>
                <p>Trade, train, heal, and prepare.</p>
              </div>
            </div>

            <div class="services-grid">
              ${services.map((s: any) => `
                <a class="service-tile service-${serviceClass(s)} ${String(s.route || "").toLowerCase() === "/shop" ? "featured" : ""}"
                   href="${escapeHtml(s.route || "#")}"
                   tabindex="0">
                  <div class="service-icon">${renderServiceIcon(s.icon)}</div>
                  <div class="service-copy">
                    <strong>${escapeHtml(s.name)}</strong>
                    <span>${escapeHtml(serviceSubtitle(s))}</span>
                  </div>
                  <div class="service-arrow">›</div>
                </a>
              `).join("")}
            </div>

            <div class="town-note">
              ⓘ Some services may be expanded later: parties, bulletin board, trade offers, and town reputation.
            </div>
          </section>
        </div>

        <!-- RIGHT COLUMN -->
        <aside class="town-side">
          <section class="ledger-panel">
            <div class="ledger-head">
              <div>
                <h2>📖 Town Ledger</h2>
                <p>Notes, updates, and warnings.</p>
              </div>
              <button class="journal-btn" id="btn-journal" type="button">📖 Journal</button>
            </div>

            <div class="ledger-card">
              <div class="ledger-card__top">
                <h3>Gossip</h3>
                <span>Whispers</span>
              </div>
              <p id="town-gossip">Listening for whispers…</p>
              <div id="town-gossip-meta" class="ledger-meta"></div>
            </div>

            <div class="ledger-card">
              <div class="ledger-card__top">
                <h3>Latest Updates</h3>
                <span>What’s New</span>
              </div>
              <ul class="updates-list">
                <li>Loot drops now appear as a chest you open after combat.</li>
                <li>Rumor quests can be found in the tavern and accepted.</li>
                <li>Quest turn-ins can be claimed when objectives are complete.</li>
              </ul>
            </div>

            <div class="venture-card">
              <div class="venture-copy">
                <div class="venture-icon">⛰</div>
                <div>
                  <h3>Venture Out</h3>
                  <p>Supplies, gear, and luck — that's what survives the wild.</p>
                </div>
              </div>
              <a href="/world" class="leave-btn">Leave Haven <span>›</span></a>
            </div>
          </section>
        </aside>
      </div>
    </section>
  </main>

  <script>
    window.GF_TOWN_ID = ${Number(town.id)};
  </script>
  <script src="/statpanel.js"></script>
</body>
</html>
  `);
});

export default router;
