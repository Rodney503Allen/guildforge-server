//src/trainer.routes.ts
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

  const type = String(s.type || "");
  const manaCost = Number(s.mana_cost || 0);
  const cooldown = Number(s.cooldown || 0);
  const skillPointCost = Number(s.skill_point_cost || 1);
  const reqLevel = Number(s.level || 1);

  const damage = Number(s.damage || 0);
  const heal = Number(s.heal || 0);
  const dotDamage = Number(s.dot_damage || 0);
  const dotDuration = Number(s.dot_duration || 0);
  const dotTickRate = Number(s.dot_tick_rate || 1);

  rows.push(`<div class="detail-row"><span>Type</span><strong>${esc(prettyType(type))}</strong></div>`);
  rows.push(`<div class="detail-row"><span>SP Cost</span><strong>${manaCost} SP</strong></div>`);
  rows.push(`<div class="detail-row"><span>Cooldown</span><strong>${cooldown}s</strong></div>`);
  rows.push(`<div class="detail-row"><span>Skill Point Cost</span><strong>${skillPointCost}</strong></div>`);
  rows.push(`<div class="detail-row"><span>Required Level</span><strong>${reqLevel}</strong></div>`);

  if (damage > 0) {
    rows.push(`<div class="detail-row"><span>Direct Damage</span><strong>${damage}</strong></div>`);
  }

  if (heal > 0) {
    rows.push(`<div class="detail-row"><span>Healing</span><strong>${heal}</strong></div>`);
  }

  if (dotDamage > 0) {
    const ticks = dotDuration > 0 && dotTickRate > 0
      ? Math.floor(dotDuration / dotTickRate)
      : 0;

    const totalDot = ticks > 0 ? dotDamage * ticks : dotDamage;

    rows.push(`<div class="detail-row"><span>DoT Damage</span><strong>${dotDamage} / tick</strong></div>`);

    if (dotDuration > 0) {
      rows.push(`<div class="detail-row"><span>DoT Duration</span><strong>${dotDuration}s</strong></div>`);
    }

    if (dotTickRate > 0) {
      rows.push(`<div class="detail-row"><span>Tick Rate</span><strong>${dotTickRate}s</strong></div>`);
    }

    if (ticks > 0) {
      rows.push(`<div class="detail-row"><span>Total DoT</span><strong>${totalDot}</strong></div>`);
    }
  }

  if (s.buff_stat && Number(s.buff_value || 0) > 0) {
    const duration = Number(s.buff_duration || 0);
    rows.push(`<div class="detail-row"><span>Buff Stat</span><strong>${esc(s.buff_stat)}</strong></div>`);
    rows.push(`<div class="detail-row"><span>Buff Value</span><strong>+${Number(s.buff_value)}</strong></div>`);

    if (duration > 0) {
      rows.push(`<div class="detail-row"><span>Buff Duration</span><strong>${duration}s</strong></div>`);
    }
  }

  if (s.debuff_stat && Number(s.debuff_value || 0) > 0) {
    const duration = Number(s.debuff_duration || 0);
    rows.push(`<div class="detail-row"><span>Debuff Stat</span><strong>${esc(s.debuff_stat)}</strong></div>`);
    rows.push(`<div class="detail-row"><span>Debuff Value</span><strong>-${Number(s.debuff_value)}</strong></div>`);

    if (duration > 0) {
      rows.push(`<div class="detail-row"><span>Debuff Duration</span><strong>${duration}s</strong></div>`);
    }
  }

  return rows.join("");
}

router.get("/", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;

  const [[player]]: any = await db.query(
    `
      SELECT 
        p.pclass,
        p.gold,
        p.skill_points,
        p.level,
        p.class_id,
        c.name AS class_name,
        c.slug AS class_slug,
        c.class_color
      FROM players p
      LEFT JOIN classes c
        ON c.id = p.class_id
      WHERE p.id = ?
      LIMIT 1
    `,
    [pid]
  );

  if (!player) return res.redirect("/login.html");

  const pclass = String(player.class_name || player.pclass || "Unknown");
  const playerSkillPoints = Number(player.skill_points || 0);
  const playerLevel = Number(player.level || 1);
  const classColor = String(player.class_color || "#c8a34b");

  const [spells]: any = await db.query(
      `
  SELECT
    s.*,
    d.name AS discipline_name,
    d.slug AS discipline_slug
  FROM players p
  JOIN disciplines d
    ON d.class_id = p.class_id
  AND d.is_active = 1
  JOIN spells s
    ON s.discipline_id = d.id
  WHERE p.id = ?
  ORDER BY d.display_order ASC, s.level ASC, s.name ASC
  `,
  [pid]
  );

  const [knownRows]: any = await db.query(
    `SELECT spell_id FROM player_spells WHERE player_id=?`,
    [pid]
  );

  const known = new Set<number>(knownRows.map((r: any) => Number(r.spell_id)));

  const spellsByDiscipline = new Map<string, any>();

  for (const s of spells) {
    const key = String(s.discipline_slug || "unknown");

    if (!spellsByDiscipline.has(key)) {
      spellsByDiscipline.set(key, {
        name: s.discipline_name || "Unknown Discipline",
        slug: key,
        spells: []
      });
    }

    spellsByDiscipline.get(key).spells.push(s);
  }

const spellCards = Array.from(spellsByDiscipline.values()).map((group: any) => {
  const cards = group.spells.map((s: any, index: number) => {
    const sid = Number(s.id);
    const reqLevel = Number(s.level || 1);
    const skillPointCost = Number(s.skill_point_cost || 1);
    const learned = known.has(sid);
    const meetsLevel = playerLevel >= reqLevel;
    const canAfford = playerSkillPoints >= skillPointCost;

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
          ? `<div class="status locked"><span class="dot"></span>Need ${skillPointCost} Skill Point${skillPointCost === 1 ? "" : "s"}</div>`
          : `<a class="btn train-btn" href="/trainer/learn/${sid}">Learn Skill</a>`;

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
            <div class="spell-desc-mini">
              ${esc(group.name)} • ${esc(type)}
            </div>
            <div class="spell-sub">
              <span class="pillMini">Lv ${reqLevel}</span>
              <span class="pillMini">${skillPointCost} SPt</span>
              <span class="pillMini">${esc(String(s.type || "skill"))}</span>
            </div>
          </div>
        </div>
        <div class="spell-right">${actionHtml}</div>
      </article>`;
  }).join("");

  return `
    <section class="discipline-section" data-discipline="${esc(group.slug)}">
      <div class="discipline-heading">
        <h3>${esc(group.name)}</h3>
        <span>${group.spells.length}/6 Skills</span>
      </div>
      <div class="discipline-spells">
        ${cards}
      </div>
    </section>
  `;
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
<body style="--class-color:${esc(classColor)};">
  <div id="statpanel-root"></div>

  <main class="trainer-page">
    <section class="trainer-shell">
      <header class="trainer-hero">
        <div class="hero-title">
          <div class="hero-icon">📖</div>
          <div>
            <h1>Class Trainer</h1>
            <p>Skills available to the ${esc(pclass)} • Level ${playerLevel} • ${playerSkillPoints} Skill Point${playerSkillPoints === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div class="hero-actions">
          <span class="pill">Class: <strong>${esc(pclass)}</strong></span>
          <span class="pill">Skill Points: <strong>${playerSkillPoints}</strong></span>
          <a class="btn danger" href="/town">Return to Town</a>
        </div>
      </header>

      <div class="trainer-grid">
        <section class="card spellbook-card">
          <div class="cardHeader">
            <div class="cardTitle">
              <h2>📖 Spellbook</h2>
              <p>Click a skill to view details. Learn new skills with Skill Points.</p>
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
<div class="talent-preview talent-branch-tree">

  <div class="talent-root" title="Selected Skill">
    ✦
  </div>

  <div class="talent-connector root-left"></div>
  <div class="talent-connector root-right"></div>

  <div class="talent-tier talent-tier-one">

    <div class="talent-path path-left">
      <div
        class="talent-node major locked"
        data-talent-path="left"
        data-talent-tier="1"
        title="Primary Talent Path A"
      >
        🔒
      </div>
    </div>

    <div class="talent-path path-right">
      <div
        class="talent-node major locked"
        data-talent-path="right"
        data-talent-tier="1"
        title="Primary Talent Path B"
      >
        🔒
      </div>
    </div>

  </div>

  <div class="talent-connector left-child-one"></div>
  <div class="talent-connector left-child-two"></div>
  <div class="talent-connector right-child-one"></div>
  <div class="talent-connector right-child-two"></div>

  <div class="talent-tier talent-tier-two">

    <div class="talent-child-group left-children">
      <div
        class="talent-node locked"
        data-talent-path="left"
        data-talent-tier="2"
        data-talent-choice="1"
        title="Path A Upgrade 1"
      >
        🔒
      </div>

      <div
        class="talent-node locked"
        data-talent-path="left"
        data-talent-tier="2"
        data-talent-choice="2"
        title="Path A Upgrade 2"
      >
        🔒
      </div>
    </div>

    <div class="talent-child-group right-children">
      <div
        class="talent-node locked"
        data-talent-path="right"
        data-talent-tier="2"
        data-talent-choice="1"
        title="Path B Upgrade 1"
      >
        🔒
      </div>

      <div
        class="talent-node locked"
        data-talent-path="right"
        data-talent-tier="2"
        data-talent-choice="2"
        title="Path B Upgrade 2"
      >
        🔒
      </div>
    </div>

  </div>

</div>              </div>

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
  const pid = Number(req.session.playerId);
  const spellId = Number(req.params.id);

  if (!Number.isInteger(spellId) || spellId <= 0) {
    return res.redirect("/trainer");
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [[player]]: any = await conn.query(
      `
        SELECT
          class_id,
          skill_points,
          level
        FROM players
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [pid]
    );

    if (!player) {
      await conn.rollback();
      return res.redirect("/login.html");
    }

    const [[spell]]: any = await conn.query(
      `
        SELECT
          s.id,
          s.level,
          s.skill_point_cost
        FROM disciplines d
        JOIN spells s
          ON s.discipline_id = d.id
        WHERE d.class_id = ?
          AND d.is_active = 1
          AND s.id = ?
        LIMIT 1
      `,
      [player.class_id, spellId]
    );

    if (!spell) {
      await conn.rollback();
      return res.redirect("/trainer");
    }

    const [[known]]: any = await conn.query(
      `
        SELECT spell_id
        FROM player_spells
        WHERE player_id = ?
          AND spell_id = ?
        LIMIT 1
      `,
      [pid, spellId]
    );

    if (known) {
      await conn.rollback();
      return res.redirect("/trainer");
    }

    const requiredLevel = Number(spell.level || 1);
    const skillPointCost = Number(spell.skill_point_cost || 1);
    const playerLevel = Number(player.level || 1);
    const availableSkillPoints = Number(player.skill_points || 0);

    if (
      playerLevel < requiredLevel ||
      availableSkillPoints < skillPointCost
    ) {
      await conn.rollback();
      return res.redirect("/trainer");
    }

    const [spendResult]: any = await conn.query(
      `
        UPDATE players
        SET skill_points = skill_points - ?
        WHERE id = ?
          AND skill_points >= ?
      `,
      [skillPointCost, pid, skillPointCost]
    );

    if (spendResult.affectedRows !== 1) {
      throw new Error("Failed to spend skill points");
    }

    const [learnResult]: any = await conn.query(
      `
        INSERT IGNORE INTO player_spells
          (player_id, spell_id)
        VALUES
          (?, ?)
      `,
      [pid, spellId]
    );

    if (learnResult.affectedRows !== 1) {
      throw new Error("Failed to learn skill");
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error("Failed to learn skill:", err);
  } finally {
    conn.release();
  }

  return res.redirect("/trainer");
});

export default router;
