//src/trainer.routes.ts
import express from "express";
import { db } from "./db";
import {
  learnSpellTalent,
  SpellProgressionError,
  trainNextSpellRank
} from "./services/spellProgressionService";

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
  const trainerSuccess = String(req.query?.success || "").trim();
  const trainerError = String(req.query?.error || "").trim();

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
    `
      SELECT spell_id, skill_level
      FROM player_spells
      WHERE player_id = ?
    `,
    [pid]
  );

  const knownRanks = new Map<number, number>();

  for (const row of knownRows) {
    knownRanks.set(
      Number(row.spell_id),
      Math.max(1, Number(row.skill_level) || 1)
    );
  }

  const [rankRows]: any = await db.query(
    `
      SELECT
        sr.spell_id,
        sr.spell_rank,
        sr.required_level,
        sr.skill_point_cost
      FROM players p
      JOIN disciplines d
        ON d.class_id = p.class_id
       AND d.is_active = 1
      JOIN spells s
        ON s.discipline_id = d.id
      JOIN spell_ranks sr
        ON sr.spell_id = s.id
      WHERE p.id = ?
    `,
    [pid]
  );

  const rankDefinitions = new Map<string, any>();

  for (const row of rankRows) {
    rankDefinitions.set(
      `${Number(row.spell_id)}:${Number(row.spell_rank)}`,
      row
    );
  }

  const [talentRows]: any = await db.query(
    `
      SELECT
        st.id,
        st.spell_id,
        st.name,
        st.description,
        st.required_level,
        st.required_spell_rank,
        st.skill_point_cost,
        st.tier,
        st.position,
        st.choice_group,
        st.prerequisite_talent_id,
        CASE
          WHEN pst.talent_id IS NULL THEN 0
          ELSE 1
        END AS selected
      FROM players p
      JOIN disciplines d
        ON d.class_id = p.class_id
       AND d.is_active = 1
      JOIN spells s
        ON s.discipline_id = d.id
      JOIN spell_talents st
        ON st.spell_id = s.id
       AND st.is_active = 1
      LEFT JOIN player_spell_talents pst
        ON pst.player_id = p.id
       AND pst.talent_id = st.id
      WHERE p.id = ?
      ORDER BY
        st.spell_id,
        st.tier,
        st.position,
        st.id
    `,
    [pid]
  );

  const selectedTalentIds = new Set<number>();
  const selectedChoiceGroups = new Map<string, number>();
  const talentsBySpell = new Map<number, any[]>();

  for (const talent of talentRows) {
    const talentId = Number(talent.id);
    const spellId = Number(talent.spell_id);

    if (!talentsBySpell.has(spellId)) {
      talentsBySpell.set(spellId, []);
    }

    talentsBySpell.get(spellId)!.push(talent);

    if (Number(talent.selected) === 1) {
      selectedTalentIds.add(talentId);

      if (talent.choice_group) {
        selectedChoiceGroups.set(
          `${spellId}:${String(talent.choice_group)}`,
          talentId
        );
      }
    }
  }

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
    const currentRank = knownRanks.get(sid) ?? 0;
    const nextRank = Math.min(3, currentRank + 1);
    const mastered = currentRank >= 3;
    const nextRankDefinition = rankDefinitions.get(`${sid}:${nextRank}`);
    const reqLevel = Number(
      nextRankDefinition?.required_level ?? s.level ?? 1
    );
    const skillPointCost = Number(
      nextRankDefinition?.skill_point_cost ?? s.skill_point_cost ?? 1
    );
    const meetsLevel = playerLevel >= reqLevel;
    const canAfford = playerSkillPoints >= skillPointCost;

    const state = mastered
      ? "learned"
      : !meetsLevel
        ? "locked"
        : !canAfford
          ? "cantafford"
          : "available";
    const name = titleCaseName(s.name);
    const desc = s.description || "A mysterious spell known by class trainers.";
    const icon = resolveIcon(s.icon);
    const type = prettyType(s.type);
    const meta = buildSpellMeta(s);
    const rows = buildSpellRows(s);

    const actionHtml = mastered
      ? `<div class="status learned"><span class="dot"></span>Rank 3 Mastered</div>`
      : !meetsLevel
        ? `<div class="status locked"><span class="dot"></span>Rank ${nextRank} requires Lv ${reqLevel}</div>`
        : !canAfford
          ? `<div class="status locked"><span class="dot"></span>Need ${skillPointCost} Skill Point${skillPointCost === 1 ? "" : "s"}</div>`
          : `<a class="btn train-btn" href="/trainer/learn/${sid}">${currentRank === 0 ? "Learn Skill" : `Upgrade to Rank ${nextRank}`}</a>`;

    return `
      <article
        class="spell-card ${index === 0 ? "is-selected" : ""}"
        tabindex="0"
        data-spell-card="1"
        data-spell-id="${sid}"
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
              <span class="pillMini">Rank ${currentRank}/3</span>
              <span class="pillMini">${skillPointCost} SPt</span>
              <span class="pillMini">${esc(String(s.type || "skill"))}</span>
            </div>
          </div>
        </div>
        <div class="spell-right">${actionHtml}</div>
      </article>`;
  }).join("");

  return `
    <section
      class="discipline-section frame-host"
      data-discipline="${esc(group.slug)}"
    >
      <span class="frame-border sub" aria-hidden="true"></span>

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

  function getTalentState(talent: any) {
    const talentId = Number(talent.id);
    const spellId = Number(talent.spell_id);
    const currentSpellRank = knownRanks.get(spellId) ?? 0;
    const selected = selectedTalentIds.has(talentId);
    const requiredLevel = Number(talent.required_level || 1);
    const requiredRank = Number(talent.required_spell_rank || 1);
    const cost = Number(talent.skill_point_cost || 1);

    const selectedInGroup = talent.choice_group
      ? selectedChoiceGroups.get(
          `${spellId}:${String(talent.choice_group)}`
        )
      : undefined;

    if (selected) {
      return { state: "selected", reason: "Selected", cost };
    }

    if (currentSpellRank === 0) {
      return { state: "locked", reason: "Learn the spell first", cost };
    }

    if (playerLevel < requiredLevel) {
      return { state: "locked", reason: `Requires Level ${requiredLevel}`, cost };
    }

    if (currentSpellRank < requiredRank) {
      return { state: "locked", reason: `Requires Rank ${requiredRank}`, cost };
    }

    if (
      talent.prerequisite_talent_id !== null &&
      !selectedTalentIds.has(Number(talent.prerequisite_talent_id))
    ) {
      return { state: "locked", reason: "Previous talent required", cost };
    }

    if (selectedInGroup && selectedInGroup !== talentId) {
      return { state: "conflict", reason: "Alternate choice selected", cost };
    }

    if (playerSkillPoints < cost) {
      return { state: "locked", reason: `Requires ${cost} skill point${cost === 1 ? "" : "s"}`, cost };
    }

    return { state: "available", reason: "Available", cost };
  }

  function renderTalentNode(talent: any, major = false) {
    if (!talent) {
      return `<div class="talent-node talent-node-empty locked" aria-hidden="true">—</div>`;
    }

    const status = getTalentState(talent);
    const label = `${talent.name}: ${talent.description} — ${status.reason}`;
    const symbol = status.state === "selected"
      ? "✓"
      : status.state === "available"
        ? "+"
        : "🔒";

    return `
      <button
        type="button"
        class="talent-node ${esc(status.state)} ${major ? "major" : ""}"
        data-talent-node="1"
        data-talent-id="${Number(talent.id)}"
        data-talent-name="${attr(talent.name)}"
        data-talent-description="${attr(talent.description)}"
        data-talent-state="${esc(status.state)}"
        data-talent-reason="${attr(status.reason)}"
        data-talent-level="${Number(talent.required_level)}"
        data-talent-rank="${Number(talent.required_spell_rank)}"
        data-talent-cost="${Number(talent.skill_point_cost)}"
        title="${attr(label)}"
        aria-label="${attr(label)}"
      >${symbol}</button>
    `;
  }

  function renderTalentPanel(spell: any, initial: boolean) {
    const spellId = Number(spell.id);
    const talents = talentsBySpell.get(spellId) ?? [];
    const tierOne = talents
      .filter(talent => Number(talent.tier) === 1)
      .sort((a, b) => Number(a.position) - Number(b.position));

    const rootLeft = tierOne[0] ?? null;
    const rootRight = tierOne[1] ?? null;

    const childrenFor = (parent: any) => talents
      .filter(
        talent =>
          Number(talent.tier) > 1 &&
          parent &&
          Number(talent.prerequisite_talent_id) === Number(parent.id)
      )
      .sort((a, b) => Number(a.position) - Number(b.position))
      .slice(0, 2);

    const leftChildren = childrenFor(rootLeft);
    const rightChildren = childrenFor(rootRight);

    return `
      <div
        class="spell-talent-panel"
        data-talent-panel="${spellId}"
        ${initial ? "" : "hidden"}
      >
        <div class="talent-selected-spell">
          <strong>${esc(titleCaseName(spell.name))}</strong>
          <span>Rank ${knownRanks.get(spellId) ?? 0}/3</span>
        </div>

        ${talents.length === 0
          ? `<div class="empty">No talents have been configured for this spell yet.</div>`
          : `
            <div class="talent-preview talent-branch-tree">
              <div class="talent-tier talent-tier-one">
                <div class="talent-path path-left">
                  ${renderTalentNode(rootLeft, true)}
                </div>
                <div class="talent-path path-right">
                  ${renderTalentNode(rootRight, true)}
                </div>
              </div>

              <div class="talent-connector left-child-one"></div>
              <div class="talent-connector left-child-two"></div>
              <div class="talent-connector right-child-one"></div>
              <div class="talent-connector right-child-two"></div>

              <div class="talent-tier talent-tier-two">
                <div class="talent-child-group left-children">
                  ${renderTalentNode(leftChildren[0])}
                  ${renderTalentNode(leftChildren[1])}
                </div>
                <div class="talent-child-group right-children">
                  ${renderTalentNode(rightChildren[0])}
                  ${renderTalentNode(rightChildren[1])}
                </div>
              </div>
            </div>

            <section class="talent-inspector" data-talent-inspector>
              <div class="talent-inspector-copy">
                <span class="talent-inspector-kicker">Select a talent node</span>
                <h3 data-talent-detail-name>Talent Details</h3>
                <p data-talent-detail-description>
                  Choose a node above to review its effect and requirements.
                </p>
                <div class="talent-inspector-meta" data-talent-detail-meta></div>
                <div class="talent-inspector-status" data-talent-detail-status></div>
              </div>

              <form
                class="talent-apply-form"
                data-talent-apply-form
                method="post"
                action=""
                hidden
              >
                <button class="btn train-btn" type="submit" data-talent-apply-button>
                  Apply Skill Point
                </button>
              </form>
            </section>

          `}
      </div>
    `;
  }

  const talentPanels = spells
    .map((spell: any, index: number) =>
      renderTalentPanel(spell, index === 0)
    )
    .join("");

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
    <section class="trainer-shell frame-host">
  <span class="frame-border main" aria-hidden="true"></span>
      <header class="trainer-hero">
        <div class="hero-title">
          <div class="hero-icon">📖</div>
          <div>
            <h1>Class Trainer</h1>
            <p>Skills available to the ${esc(pclass)} • Level ${playerLevel} • ${playerSkillPoints} Skill Point${playerSkillPoints === 1 ? "" : "s"}</p>
          </div>
        </div>
        <span class="hero-divider-center" aria-hidden="true"></span>
        <div class="hero-actions">
          <span class="pill">Class: <strong>${esc(pclass)}</strong></span>
          <span class="pill">Skill Points: <strong>${playerSkillPoints}</strong></span>
          <a class="btn danger" href="/town">Return to Town</a>
        </div>
      </header>

      ${trainerSuccess
        ? `<div class="trainer-message success">${esc(trainerSuccess)}</div>`
        : ""}
      ${trainerError
        ? `<div class="trainer-message error">${esc(trainerError)}</div>`
        : ""}

      <div class="trainer-grid">
        <section class="card spellbook-card frame-host">
        <span class="frame-border panel" aria-hidden="true"></span>
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
          <section class="card details-card frame-host">
          <span class="frame-border panel" aria-hidden="true"></span>
            <div class="cardHeader compact">
              <div class="cardTitle"><h2>Spell Details</h2></div>
            </div>
            <div class="cardBody">
              <div class="spell-detail-box frame-host">
              <span class="frame-border sub" aria-hidden="true"></span>
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

          <section class="card talent-card frame-host">
          <span class="frame-border panel" aria-hidden="true"></span>
            <div class="cardHeader compact">
              <div class="cardTitle">
                <h2>Talent Tree</h2>
                <p>Customize this spell using your shared Skill Points.</p>
              </div>
              <span class="badge good">Active</span>
            </div>
            <div class="cardBody">
              ${talentPanels}
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

  try {
    const result = await trainNextSpellRank(pid, spellId);

    return res.redirect(
      `/trainer?success=${encodeURIComponent(`Spell advanced to Rank ${result.newRank}.`)}`
    );
  } catch (err) {
    if (err instanceof SpellProgressionError) {
      return res.redirect(
        `/trainer?error=${encodeURIComponent(err.message)}`
      );
    }

    console.error("Failed to train spell rank:", err);
    return res.redirect(
      `/trainer?error=${encodeURIComponent("Unable to train that spell right now.")}`
    );
  }
});

router.post(
  "/talents/learn/:id",
  requireLogin,
  async (req: any, res: any) => {
    const pid = Number(req.session.playerId);
    const talentId = Number(req.params.id);

    if (!Number.isInteger(talentId) || talentId <= 0) {
      return res.redirect("/trainer");
    }

    try {
      await learnSpellTalent(pid, talentId);

      return res.redirect(
        `/trainer?success=${encodeURIComponent("Talent learned.")}`
      );
    } catch (err) {
      if (err instanceof SpellProgressionError) {
        return res.redirect(
          `/trainer?error=${encodeURIComponent(err.message)}`
        );
      }

      console.error("Failed to learn spell talent:", err);
      return res.redirect(
        `/trainer?error=${encodeURIComponent("Unable to learn that talent right now.")}`
      );
    }
  }
);

export default router;
