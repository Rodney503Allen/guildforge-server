// trainer.routes.ts
import express from "express";
import { db } from "./db";

const router = express.Router();

// =======================
// Helpers
// =======================
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

function resolveIcon(icon: any) {
  const raw = (icon ?? "").toString().trim();
  if (!raw) return "/icons/default.png"; // change if you want
  if (raw.startsWith("http") || raw.startsWith("/")) return raw;
  return "/" + raw.replace(/^\/+/, "");
}

// Clean title-case-ish (fixes ALL CAPS names)
function titleCaseName(name: any) {
  const s = String(name ?? "").trim();
  if (!s) return "Unknown Spell";
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// Build a HTML chunk for stats/effects (kept simple and safe)
function buildSpellDetails(s: any) {
  const lines: string[] = [];

  // core
  if (s.type) lines.push(`<div class="t-row"><span class="t-k">Type</span><span class="t-v">${esc(String(s.type))}</span></div>`);
  if (Number.isFinite(Number(s.level)))
    lines.push(`<div class="t-row"><span class="t-k">Required</span><span class="t-v">Level ${Number(s.level)}</span></div>`);
  if (Number.isFinite(Number(s.price)))
    lines.push(`<div class="t-row"><span class="t-k">Cost</span><span class="t-v">${Number(s.price)}g</span></div>`);

  // combat values (your schema varies; keep it defensive)
  if (s.damage != null && Number(s.damage) > 0)
    lines.push(`<div class="t-row"><span class="t-k">Damage</span><span class="t-v">${Number(s.damage)}</span></div>`);

  if (s.heal != null && Number(s.heal) > 0)
    lines.push(`<div class="t-row"><span class="t-k">Heal</span><span class="t-v">${Number(s.heal)}</span></div>`);

  if (s.dot_damage != null && Number(s.dot_damage) > 0) {
    const dur = s.dot_duration != null ? ` / ${Number(s.dot_duration)}s` : "";
    lines.push(`<div class="t-row"><span class="t-k">DoT</span><span class="t-v">${Number(s.dot_damage)}${dur}</span></div>`);
  }

  if (s.scost != null && Number(s.scost) > 0)
    lines.push(`<div class="t-row"><span class="t-k">SP Cost</span><span class="t-v">${Number(s.scost)}</span></div>`);

  if (s.cooldown != null && Number(s.cooldown) > 0)
    lines.push(`<div class="t-row"><span class="t-k">Cooldown</span><span class="t-v">${Number(s.cooldown)}s</span></div>`);

  // Buff/debuff
  if (s.buff_stat && s.buff_value) {
    const dur = s.buff_duration ? ` (${Number(s.buff_duration)}s)` : "";
    lines.push(`<div class="t-row"><span class="t-k">Buff</span><span class="t-v">+${Number(s.buff_value)} ${esc(s.buff_stat)}${dur}</span></div>`);
  }
  if (s.debuff_stat && s.debuff_value) {
    const dur = s.debuff_duration ? ` (${Number(s.debuff_duration)}s)` : "";
    lines.push(`<div class="t-row"><span class="t-k">Debuff</span><span class="t-v">-${Number(s.debuff_value)} ${esc(s.debuff_stat)}${dur}</span></div>`);
  }

  return lines.join("");
}

// =======================
// TRAINER PAGE
// =======================
router.get("/", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;

  const [[player]]: any = await db.query(
    `SELECT pclass, gold, level
     FROM players
     WHERE id=?
     LIMIT 1`,
    [pid]
  );
  if (!player) return res.redirect("/login.html");

  // NOTE: add skill_points later when you implement it (placeholder UI below)
  const pclass = String(player.pclass || "Unknown");
  const playerGold = Number(player.gold || 0);
  const playerLevel = Number(player.level || 1);

  // spells you can potentially train
  const [spells]: any = await db.query(
    `SELECT *
     FROM spells
     WHERE sclass = ? OR sclass = 'any'
     ORDER BY level ASC, name ASC`,
    [pclass]
  );

  const [knownRows]: any = await db.query(
    `SELECT spell_id
     FROM player_spells
     WHERE player_id=?`,
    [pid]
  );

  const known = new Set<number>(knownRows.map((r: any) => Number(r.spell_id)));

  // Build cards
  const cards = spells
    .map((s: any) => {
      const sid = Number(s.id);
      const learned = known.has(sid);

      const reqLevel = Number(s.level || 1);
      const price = Number(s.price || 0);

      const meetsLevel = playerLevel >= reqLevel;
      const canAfford = playerGold >= price;

      const state =
        learned ? "learned" :
        !meetsLevel ? "locked" :
        !canAfford ? "cantafford" :
        "available";

      const actionHtml =
        learned
          ? `<div class="status learned"><span class="dot"></span>Learned</div>`
          : !meetsLevel
            ? `<div class="status locked"><span class="dot"></span>Requires Lv ${reqLevel}</div>`
            : !canAfford
              ? `<div class="status locked"><span class="dot"></span>Need ${price}g</div>`
              : `<a class="btn" href="/trainer/learn/${sid}">Learn</a>`;

      // tooltip details
      const detailRows = buildSpellDetails(s);
      const desc = s.description ? esc(s.description) : "A mysterious spell...";

      // For tooltip dataset: keep HTML minimal and safe
      const tooltipStats = detailRows || "";
      const tooltipDesc = desc;

      return `
        <div class="spell-card"
          data-tooltip="item"
          tabindex="0"
          data-state="${esc(state)}"
          data-type="${esc(String(s.type || ""))}"
          data-nameplain="${esc(titleCaseName(s.name))}"

          data-name="${esc(titleCaseName(s.name))}"
          data-rarity="${esc(state)}"
          data-value="0"
          data-price="${price}"
          data-qty="1"
          data-stats="${esc(tooltipStats)}"
          data-desc="${esc(tooltipDesc)}"
        >
          <div class="spell-left">
            <div class="icon-wrap">
              <img class="spell-icon" src="${resolveIcon(s.icon)}" alt=""
                   loading="lazy"
                   onerror="this.style.display='none'; this.parentElement.classList.add('fallback');">
              <div class="fallback-ico">✦</div>
            </div>

            <div class="spell-main">
              <div class="spell-name ${state}">${esc(titleCaseName(s.name))}</div>
              <div class="spell-sub">
                <span class="pillMini">Lv ${reqLevel}</span>
                <span class="pillMini">💰 ${price}g</span>
                <span class="pill muted">${esc(String(s.type || "spell"))}</span>
              </div>
            </div>
          </div>

          <div class="spell-right">
            ${actionHtml}
          </div>
        </div>
      `;
    })
    .join("");

// inside router.get("/", requireLogin, async (req, res) => { ... })

res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <title>Guildforge | Trainer</title>

  <!-- Statpanel -->
  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>

  <!-- Shared tooltip -->
  <link rel="stylesheet" href="/ui/itemTooltip.css">
  <script defer src="/ui/itemTooltip.js"></script>

  <!-- Trainer page -->
  <link rel="stylesheet" href="/trainer.css">
  <script defer src="/trainer.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> Class Trainer</div>
        <div class="sub">Spells available to the ${esc(pclass)} • Level ${playerLevel} • ${playerGold}g</div>
      </div>

      <div class="nav">
        <span class="pill">Class: <strong>${esc(pclass)}</strong></span>
        <span class="pill">Gold: <strong>${playerGold}g</strong></span>
        <a class="btn danger" href="/town">Return to Town</a>
      </div>
    </div>

    <div class="grid">
      <!-- LEFT: Spellbook -->
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Spellbook</h2>
            <p>Hover or focus a spell to view details. Learn new spells with gold.</p>
          </div>

          <div class="headerRight">
            <span class="badge good">Trainer</span>
          </div>
        </div>

        <div class="cardBody">
          <div class="trainerTools">
            <div class="noteBox">
              Skill Points and Spell Rank upgrades will be added here later. For now, learning is gold + level gated.
            </div>

            <div class="searchRow">
              <input id="spellSearch" class="input" placeholder="Search spells…" autocomplete="off" />
              <select id="spellFilter" class="select">
                <option value="all">All</option>
                <option value="available">Available</option>
                <option value="locked">Locked</option>
                <option value="cantafford">Need Gold</option>
                <option value="learned">Learned</option>
              </select>
            </div>
          </div>

          <div class="spellList" id="spellList">
            ${cards || `<div class="empty"><i>No spells available.</i></div>`}
          </div>
        </div>
      </section>

      <!-- RIGHT: Trainer Notes -->
      <aside class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Trainer’s Notes</h2>
            <p>Reminders before you spend coin.</p>
          </div>
          <span class="badge">Info</span>
        </div>

        <div class="cardBody">
          <div class="infoBox">
            <div class="infoTitle">
              <strong>How to learn</strong>
              <span class="badge good">Simple</span>
            </div>
            <p class="infoText">
• Meet the required level
• Pay the gold cost
• Spell becomes available in combat
            </p>
          </div>

          <div class="divider"></div>

          <div class="infoBox">
            <div class="infoTitle">
              <strong>Tip</strong>
              <span class="badge warn">Smart Spend</span>
            </div>
            <p class="infoText">
Learn 1–2 core spells first, then branch into utility.
            </p>
          </div>

          <div class="divider"></div>

          <a class="btn primary" href="/shop">🛒 Market</a>
          <a class="btn" href="/tavern">🍺 Tavern</a>
        </div>
      </aside>
    </div>
  </div>
</body>
</html>
`);

});

// =======================
// LEARN SPELL
// (kept same behavior, but hardens checks + class restriction)
// =======================
router.get("/learn/:id", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;
  const sid = Number(req.params.id);
  if (!Number.isFinite(sid)) return res.redirect("/trainer");

  const [[player]]: any = await db.query(
    "SELECT pclass, gold, level FROM players WHERE id=? LIMIT 1",
    [pid]
  );
  if (!player) return res.redirect("/login.html");

  const [[spell]]: any = await db.query(
    "SELECT * FROM spells WHERE id=? LIMIT 1",
    [sid]
  );
  if (!spell) return res.redirect("/trainer");

  // class restriction (allow 'any')
  const sclass = String(spell.sclass || "any");
  if (sclass !== "any" && sclass !== String(player.pclass)) {
    return res.send("You cannot learn this spell.");
  }

  const [[exists]]: any = await db.query(
    "SELECT id FROM player_spells WHERE player_id=? AND spell_id=? LIMIT 1",
    [pid, sid]
  );
  if (exists) return res.redirect("/trainer");

  // Level check
  if (Number(player.level) < Number(spell.level)) {
    return res.send(`You must be level ${Number(spell.level)} to learn this spell.`);
  }

  // Gold check
  if (Number(player.gold) < Number(spell.price)) {
    return res.send("Not enough gold.");
  }

  // Pay + Learn (atomic-ish: do spend only if enough gold)
  const [r]: any = await db.query(
    `UPDATE players
     SET gold = gold - ?
     WHERE id = ? AND gold >= ?`,
    [Number(spell.price), pid, Number(spell.price)]
  );

  if (!r?.affectedRows) return res.send("Not enough gold.");

  await db.query(
    "INSERT INTO player_spells (player_id, spell_id) VALUES (?, ?)",
    [pid, sid]
  );

  res.redirect("/trainer");
});

export default router;
