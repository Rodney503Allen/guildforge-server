// trainer.routes.ts
import express from "express";
import { db } from "./db";

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

function attr(input: any) {
  return esc(input).replace(/\n/g, "&#10;");
}

// Uses the spells.icon column as the image source.
// Examples supported:
//   /mage/arcane_spark.webp
//   /images/spells/mage/arcane_spark.webp
//   mage/arcane_spark.webp
//   https://example.com/icon.webp
function resolveIcon(icon: any) {
  const raw = String(icon ?? "").trim();

  if (!raw || raw === "default.png") {
    return "/icons/spells/default.png";
  }

  // already correct
  if (raw.startsWith("/icons/")) return raw;

  // external URL
  if (raw.startsWith("http")) return raw;

  // DB format: /warlock/shadow_bolt.webp
  if (raw.startsWith("/")) {
    return `/icons/spells${raw}`;
  }

  // DB format: warlock/shadow_bolt.webp
  return `/icons/spells/${raw}`;
}

function titleCaseName(name: any) {
  const s = String(name ?? "").trim();
  if (!s) return "Unknown Spell";
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function prettyType(type: any) {
  const raw = String(type ?? "spell").replace(/_/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function buildSpellMeta(s: any) {
  const parts: string[] = [];

  if (s.damage != null && Number(s.damage) > 0) parts.push(`Damage: ${Number(s.damage)}`);
  if (s.heal != null && Number(s.heal) > 0) parts.push(`Heal: ${Number(s.heal)}`);

  if (s.dot_damage != null && Number(s.dot_damage) > 0) {
    const dur = s.dot_duration != null ? ` over ${Number(s.dot_duration)}s` : "";
    const tickRate = s.dot_tick_rate != null ? `, every ${Number(s.dot_tick_rate)}s` : "";
    parts.push(`DoT: ${Number(s.dot_damage)}${dur}${tickRate}`);
  }

  if (s.buff_stat && s.buff_value) {
    const dur = s.buff_duration ? ` for ${Number(s.buff_duration)}s` : "";
    parts.push(`Buff: +${Number(s.buff_value)} ${String(s.buff_stat)}${dur}`);
  }

  if (s.debuff_stat && s.debuff_value) {
    const dur = s.debuff_duration ? ` for ${Number(s.debuff_duration)}s` : "";
    parts.push(`Debuff: -${Number(s.debuff_value)} ${String(s.debuff_stat)}${dur}`);
  }

  return parts.length ? parts.join(" • ") : "Spell effect details unavailable.";
}

function buildSpellRows(s: any) {
  const rows: string[] = [];

  rows.push(`<div class="detail-row"><span>Cost</span><strong>${Number(s.scost || 0)} SP</strong></div>`);
  rows.push(`<div class="detail-row"><span>Cooldown</span><strong>${Number(s.cooldown || 0)}s</strong></div>`);
  rows.push(`<div class="detail-row"><span>Training Price</span><strong>${Number(s.price || 0)}g</strong></div>`);
  rows.push(`<div class="detail-row"><span>Required Level</span><strong>${Number(s.level || 1)}</strong></div>`);

  if (s.damage != null && Number(s.damage) > 0) {
    rows.push(`<div class="detail-row"><span>Damage</span><strong>${Number(s.damage)}</strong></div>`);
  }

  if (s.heal != null && Number(s.heal) > 0) {
    rows.push(`<div class="detail-row"><span>Heal</span><strong>${Number(s.heal)}</strong></div>`);
  }

  if (s.dot_damage != null && Number(s.dot_damage) > 0) {
    rows.push(`<div class="detail-row"><span>Damage Over Time</span><strong>${Number(s.dot_damage)} × ${Number(s.dot_duration || 1)}s</strong></div>`);
  }

  if (s.dot_tick_rate != null && Number(s.dot_tick_rate) > 0) {
    rows.push(`<div class="detail-row"><span>Tick Rate</span><strong>${Number(s.dot_tick_rate)}s</strong></div>`);
  }

  if (s.buff_stat && s.buff_value) {
    const duration = s.buff_duration ? ` (${Number(s.buff_duration)}s)` : "";
    rows.push(`<div class="detail-row"><span>Buff</span><strong>+${Number(s.buff_value)} ${esc(s.buff_stat)}${duration}</strong></div>`);
  }

  if (s.debuff_stat && s.debuff_value) {
    const duration = s.debuff_duration ? ` (${Number(s.debuff_duration)}s)` : "";
    rows.push(`<div class="detail-row"><span>Debuff</span><strong>-${Number(s.debuff_value)} ${esc(s.debuff_stat)}${duration}</strong></div>`);
  }

  return rows.join("");
}

router.get("/", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;

  const [[player]]: any = await db.query(
    `SELECT pclass, gold, level FROM players WHERE id=? LIMIT 1`,
    [pid]
  );

  if (!player) return res.redirect("/login.html");

  const pclass = String(player.pclass || "Unknown");
  const playerGold = Number(player.gold || 0);
  const playerLevel = Number(player.level || 1);

  const [spells]: any = await db.query(
    `SELECT * FROM spells WHERE sclass = ? OR sclass = 'any' ORDER BY level ASC, name ASC`,
    [pclass]
  );

  const [knownRows]: any = await db.query(
    `SELECT spell_id FROM player_spells WHERE player_id=?`,
    [pid]
  );

  const known = new Set<number>(knownRows.map((r: any) => Number(r.spell_id)));

  const spellCards = spells.map((s: any, index: number) => {
    const sid = Number(s.id);
    const reqLevel = Number(s.level || 1);
    const price = Number(s.price || 0);
    const learned = known.has(sid);
    const meetsLevel = playerLevel >= reqLevel;
    const canAfford = playerGold >= price;

    const state = learned ? "learned" : !meetsLevel ? "locked" : !canAfford ? "cantafford" : "available";
    const name = titleCaseName(s.name);
    const desc = s.description || "A mysterious spell known by class trainers.";
    const icon = resolveIcon(s.icon);
    const type = prettyType(s.type);
    const meta = buildSpellMeta(s);
    const rows = buildSpellRows(s);

    const actionHtml = learned
      ? `<div class="status learned"><span class="dot"></span>Learned</div>`
      : !meetsLevel
        ? `<div class="status locked"><span class="dot"></span>Requires Lv ${reqLevel}</div>`
        : !canAfford
          ? `<div class="status locked"><span class="dot"></span>Need ${price}g</div>`
          : `<a class="btn train-btn" href="/trainer/learn/${sid}">Learn Spell</a>`;

    return `
      <article
        class="spell-card ${index === 0 ? "is-selected" : ""}"
        tabindex="0"
        data-spell-card="1"
        data-state="${esc(state)}"
        data-type="${esc(String(s.type || ""))}"
        data-icon="${attr(icon)}"
        data-name="${attr(name)}"
        data-desc="${attr(desc)}"
        data-school="${attr(type)}"
        data-meta="${attr(meta)}"
        data-rows="${attr(rows)}"
      >
        <div class="spell-left">
          <div class="icon-wrap">
            <img
              class="spell-icon"
              src="${esc(icon)}"
              alt="${esc(name)} icon"
              loading="lazy"
              onerror="this.src='/icons/default.png'; this.onerror=null;"
            >
            <span class="fallback-ico">✦</span>
          </div>
          <div class="spell-main">
            <div class="spell-name ${esc(state)}">${esc(name)}</div>
            <div class="spell-desc-mini">${esc(type)}${s.damage ? " • Damage" : s.heal ? " • Healing" : s.dot_damage ? " • Damage over Time" : ""}</div>
            <div class="spell-sub">
              <span class="pillMini">Lv ${reqLevel}</span>
              <span class="pillMini">${price}g</span>
              <span class="pillMini">${esc(String(s.type || "spell"))}</span>
            </div>
          </div>
        </div>
        <div class="spell-right">${actionHtml}</div>
      </article>`;
  }).join("");

  const firstSpell = spells[0];
  const firstName = firstSpell ? titleCaseName(firstSpell.name) : "Select a Spell";
  const firstIcon = firstSpell ? resolveIcon(firstSpell.icon) : "/icons/default.png";
  const firstDesc = firstSpell?.description || "Hover or focus a spell to view its details.";
  const firstType = firstSpell ? prettyType(firstSpell.type) : "Spell";
  const firstMeta = firstSpell ? buildSpellMeta(firstSpell) : "";
  const firstRows = firstSpell ? buildSpellRows(firstSpell) : "";

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800&display=swap" rel="stylesheet">
  <title>Guildforge | Trainer</title>
  <link rel="stylesheet" href="/statpanel.css">
  <link rel="stylesheet" href="/trainer.css">
  <script defer src="/statpanel.js"></script>
  <script defer src="/trainer.js"></script>
</head>
<body>
  <div id="statpanel-root"></div>

  <main class="trainer-page">
    <section class="trainer-shell">
      <header class="trainer-hero">
        <div class="hero-title">
          <div class="hero-icon">📖</div>
          <div>
            <h1>Class Trainer</h1>
            <p>Spells available to the ${esc(pclass)} • Level ${playerLevel} • ${playerGold}g</p>
          </div>
        </div>
        <div class="hero-actions">
          <span class="pill">Class: <strong>${esc(pclass)}</strong></span>
          <span class="pill">Gold: <strong>${playerGold}g</strong></span>
          <a class="btn danger" href="/town">Return to Town</a>
        </div>
      </header>

      <div class="trainer-grid">
        <section class="card spellbook-card">
          <div class="cardHeader">
            <div class="cardTitle">
              <h2>📖 Spellbook</h2>
              <p>Click a spell to view details. Learn new spells with gold.</p>
            </div>
            <span class="badge good">Trainer</span>
          </div>

          <div class="cardBody">
            <div class="trainerTools">
              <div class="searchRow">
                <input class="input" id="spellSearch" placeholder="Search spells..." />
                <select class="select" id="spellFilter">
                  <option value="all">All Classes</option>
                  <option value="damage">Damage</option>
                  <option value="dot">DoT</option>
                  <option value="damage_dot">Damage + DoT</option>
                  <option value="heal">Heal</option>
                  <option value="buff">Buff</option>
                  <option value="debuff">Debuff</option>
                </select>
              </div>
            </div>

            <div class="spellList" id="spellList">
              ${spellCards || `<div class="empty">No spells found for this class.</div>`}
            </div>
          </div>
        </section>

        <aside class="right-stack">
          <section class="card details-card">
            <div class="cardHeader compact">
              <div class="cardTitle"><h2>Spell Details</h2></div>
            </div>
            <div class="cardBody">
              <div class="spell-detail-box">
                <div class="detail-icon-wrap">
                  <img id="detailIcon" src="${esc(firstIcon)}" alt="${esc(firstName)} icon" onerror="this.src='/icons/default.png'; this.onerror=null;">
                </div>
                <div class="detail-copy">
                  <h3 id="detailName">${esc(firstName)}</h3>
                  <div class="detail-tags"><span id="detailSchool">${esc(firstType)}</span></div>
                  <p id="detailDesc">${esc(firstDesc)}</p>
                  <p class="detail-meta" id="detailMeta">${esc(firstMeta)}</p>
                </div>
              </div>
              <div class="detail-rows" id="detailRows">${firstRows}</div>
            </div>
          </section>

          <section class="card talent-card">
            <div class="cardHeader compact">
              <div class="cardTitle">
                <h2>Talent Tree</h2>
                <p>Unlock passive class power through future Talent Points.</p>
              </div>
              <span class="badge warn">Coming Soon</span>
            </div>
            <div class="cardBody">
              <div class="talent-preview">
                <div class="talent-root">✦</div>
                <div class="talent-line one"></div>
                <div class="talent-row row-1">
                  <div class="talent-node locked">🔒</div>
                  <div class="talent-node locked">🔒</div>
                  <div class="talent-node locked">🔒</div>
                  <div class="talent-node locked">🔒</div>
                </div>
                <div class="talent-row row-2">
                  <div class="talent-node locked">🔒</div>
                  <div class="talent-node locked">🔒</div>
                  <div class="talent-node locked">🔒</div>
                </div>
              </div>

              <div class="talent-note">
                <strong>Passive Skill Tree</strong>
                <p>Talents will let each class specialize through passive bonuses, spell modifiers, and build-defining effects.</p>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  </main>
</body>
</html>`);
});

router.get("/learn/:id", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;
  const spellId = Number(req.params.id);
  if (!Number.isFinite(spellId)) return res.redirect("/trainer");

  const [[player]]: any = await db.query(
    `SELECT pclass, gold, level FROM players WHERE id=? LIMIT 1`,
    [pid]
  );
  if (!player) return res.redirect("/login.html");

  const [[spell]]: any = await db.query(
    `SELECT * FROM spells WHERE id=? AND (sclass=? OR sclass='any') LIMIT 1`,
    [spellId, player.pclass]
  );
  if (!spell) return res.redirect("/trainer");

  const [[known]]: any = await db.query(
    `SELECT id FROM player_spells WHERE player_id=? AND spell_id=? LIMIT 1`,
    [pid, spellId]
  );
  if (known) return res.redirect("/trainer");

  const price = Number(spell.price || 0);
  const reqLevel = Number(spell.level || 1);
  const gold = Number(player.gold || 0);
  const level = Number(player.level || 1);

  if (level < reqLevel || gold < price) return res.redirect("/trainer");

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`UPDATE players SET gold = gold - ? WHERE id=? AND gold >= ?`, [price, pid, price]);
    await conn.query(`INSERT IGNORE INTO player_spells (player_id, spell_id) VALUES (?, ?)`, [pid, spellId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error("Failed to learn spell", err);
  } finally {
    conn.release();
  }

  res.redirect("/trainer");
});

export default router;
