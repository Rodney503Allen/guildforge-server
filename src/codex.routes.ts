import express from "express";
import { db } from "./db";

const router = express.Router();

function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) return res.redirect("/login.html");
  next();
}

function requireLoginApi(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) {
    return res.status(401).json({ error: "not_logged_in" });
  }
  next();
}

type CodexState = "unknown" | "seen" | "killed" | "studied" | "mastered";

// =======================
// CODEX DATA API
// =======================
router.get("/api/codex", requireLoginApi, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  try {
    const [rows]: any = await db.query(
      `
      SELECT
        c.id AS creatureId,
        c.name AS creatureName,
        c.description AS creatureDescription,
        c.level,
        c.min_level,
        c.terrain,
        c.rarity,
        c.maxhp,
        c.attack,
        c.defense,
        c.agility,
        c.crit,

        ca.id AS archetypeId,
        ca.name AS archetypeName,
        ca.img AS archetypeImg,

        COALESCE(pbc.seen_count, 0) AS seenCount,
        COALESCE(pbc.kill_count, 0) AS killCount,
        COALESCE(pbmc.claimed_keys, '') AS claimedMilestones,
        pbc.first_seen_at AS firstSeenAt,
        pbc.first_killed_at AS firstKilledAt

      FROM creatures c

      LEFT JOIN creature_archetypes ca
        ON ca.id = c.archetype_id

      LEFT JOIN player_bestiary_creatures pbc
        ON pbc.creature_id = c.id
       AND pbc.player_id = ?

      LEFT JOIN (
        SELECT
          player_id,
          creature_id,
          GROUP_CONCAT(milestone_key) AS claimed_keys
        FROM player_bestiary_milestone_claims
        WHERE player_id = ?
        GROUP BY player_id, creature_id
      ) pbmc
        ON pbmc.creature_id = c.id
       AND pbmc.player_id = ?

      ORDER BY c.id ASC
      `,
      [pid, pid, pid]
    );

    const [affixRows]: any = await db.query(
      `
      SELECT
        pba.creature_id AS creatureId,
        pba.affix_id AS affixId,
        ca.name,
        ca.rarity,
        pba.seen_count AS seenCount,
        pba.kill_count AS killCount,
        pba.first_seen_at AS firstSeenAt,
        pba.first_killed_at AS firstKilledAt
      FROM player_bestiary_affixes pba
      JOIN creature_affixes ca
        ON ca.id = pba.affix_id
      WHERE pba.player_id = ?
      ORDER BY ca.rarity ASC, ca.name ASC
      `,
      [pid]
    );

    const affixesByCreature = new Map<number, any[]>();

    for (const r of affixRows || []) {
      const creatureId = Number(r.creatureId);

      if (!affixesByCreature.has(creatureId)) {
        affixesByCreature.set(creatureId, []);
      }

      affixesByCreature.get(creatureId)!.push({
        id: Number(r.affixId),
        name: String(r.name || "Affix"),
        rarity: String(r.rarity || "common"),
        seenCount: Number(r.seenCount || 0),
        killCount: Number(r.killCount || 0),
        firstSeenAt: r.firstSeenAt,
        firstKilledAt: r.firstKilledAt
      });
    }

    const creatures = (rows || []).map((r: any) => {
      const seenCount = Number(r.seenCount || 0);
      const killCount = Number(r.killCount || 0);
      const creatureLevel = Number(r.level || r.min_level || 1);
      const creatureId = Number(r.creatureId);

      let state: CodexState = "unknown";

      if (killCount >= 100) state = "mastered";
      else if (killCount >= 25) state = "studied";
      else if (killCount >= 1) state = "killed";
      else if (seenCount >= 1) state = "seen";

      const isUnknown = state === "unknown";
      const hasKilled = killCount > 0;

      const claimedMilestones = String(r.claimedMilestones || "")
        .split(",")
        .filter(Boolean);

      function milestoneReward(key: string) {
        if (key === "studied") return creatureLevel * 25;
        if (key === "mastered") return creatureLevel * 100;
        return 0;
      }

      function buildMilestone(
        key: string,
        label: string,
        required: number,
        current: number,
        reward: string
      ) {
        const complete = current >= required;
        const claimed = claimedMilestones.includes(key);
        const rewardAmount = milestoneReward(key);

        return {
          key,
          label,
          required,
          current,
          complete,
          claimed,
          claimable: complete && rewardAmount > 0 && !claimed,
          rewardType: rewardAmount > 0 ? "xp" : null,
          rewardAmount,
          reward
        };
      }

      return {
        id: creatureId,
        state,

        name: isUnknown
          ? "Unknown Creature"
          : String(r.creatureName || "Creature"),

        description: hasKilled
          ? String(r.creatureDescription || "No codex entry has been recorded.")
          : isUnknown
            ? "This creature has not yet been discovered."
            : "This creature has been sighted, but not yet studied.",

        level: isUnknown ? null : creatureLevel,
        minLevel: isUnknown ? null : Number(r.min_level || r.level || 1),
        terrain: isUnknown ? null : String(r.terrain || "unknown"),
        rarity: isUnknown ? null : String(r.rarity || "common"),

        stats: hasKilled
          ? {
              maxhp: Number(r.maxhp || 0),
              attack: Number(r.attack || 0),
              defense: Number(r.defense || 0),
              agility: Number(r.agility || 0),
              crit: Number(r.crit || 0)
            }
          : null,

        archetype: isUnknown
          ? {
              id: null,
              name: "Unknown",
              img: null
            }
          : {
              id: r.archetypeId ? Number(r.archetypeId) : null,
              name: String(r.archetypeName || "Unknown Family"),
              img: r.archetypeImg || null
            },

        image: isUnknown
          ? null
          : r.archetypeImg || "/images/default_creature.png",

        progress: {
          seenCount,
          killCount,
          firstSeenAt: r.firstSeenAt,
          firstKilledAt: r.firstKilledAt
        },

        variants: isUnknown
          ? []
          : affixesByCreature.get(creatureId) || [],

        milestones: [
          buildMilestone(
            "discovered",
            "Discovered",
            1,
            seenCount,
            "Name and portrait revealed"
          ),
          buildMilestone(
            "first_kill",
            "First Kill",
            1,
            killCount,
            "Codex entry unlocked"
          ),
          buildMilestone(
            "studied",
            "Studied",
            25,
            killCount,
            `${creatureLevel * 25} EXP`
          ),
          buildMilestone(
            "mastered",
            "Mastered",
            100,
            killCount,
            `${creatureLevel * 100} EXP`
          )
        ]
      };
    });

    res.json({ creatures });
  } catch (err: any) {
    console.error("codex api failed:", err);
    console.error("code:", err?.code);
    console.error("message:", err?.message);
    console.error("sql:", err?.sql);
    res.status(500).json({ error: "server_error" });
  }
});

// =======================
// CODEX PAGE
// =======================
router.get("/codex", requireLogin, async (req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Guildforge | Codex</title>
  <link rel="stylesheet" href="/statpanel.css" />
  <link rel="stylesheet" href="/codex.css" />
</head>

<body>
<div id="statpanel-root"></div>

<main class="gf-wrap">
  <section class="gf-panel">
    <header class="gf-panel__header">
      <div class="gf-title">
        <div class="gf-journalbar">
          <button id="btn-return" class="gf-btn gf-btn--return" type="button">← Return</button>
        </div>

        <div class="gf-title__kicker">Bestiary Codex</div>
        <h1 class="gf-title__h1">The Creature Codex</h1>
        <div class="gf-title__sub">A record of beasts discovered, studied, and mastered.</div>
      </div>
    </header>

    <div class="gf-panel__body">
      <div id="codex-status" class="gf-status">Loading creature records…</div>

      <div id="codex-book" class="gf-book gf-codex-book" hidden>

        <!-- LEFT PAGE -->
        <aside class="gf-page gf-page--left">
          <div class="gf-page__head">
            <h2 class="gf-page__title">Creatures</h2>
            <div class="gf-page__hint">Track kills, discoveries, and variant encounters.</div>
          </div>

          <div id="codex-filters" class="gf-filter">
            <button class="gf-chip is-active" type="button" data-filter="all">All</button>
            <button class="gf-chip" type="button" data-filter="seen">Seen</button>
            <button class="gf-chip" type="button" data-filter="killed">Killed</button>
            <button class="gf-chip" type="button" data-filter="studied">Studied</button>
            <button class="gf-chip" type="button" data-filter="mastered">Mastered</button>
            <button class="gf-chip" type="button" data-filter="unknown">Unknown</button>
          </div>

          <div id="codex-creature-list" class="gf-list gf-creature-list"></div>
          <div id="codex-pager" class="gf-codex-pager"></div>
        </aside>

        <!-- RIGHT PAGE -->
        <section class="gf-page gf-page--right">
          <div id="codex-detail" class="gf-detail">
            <div class="gf-detail__empty">
              <div class="gf-detail__sigil">☉</div>
              <div class="gf-detail__msg">Choose a creature from the left page.</div>
            </div>
          </div>
        </section>

      </div>
    </div>

  </section>
</main>

<script src="/statpanel.js" defer></script>
<script src="/codex.js" defer></script>
<script>
  document.getElementById("btn-return")?.addEventListener("click", () => {
    window.location.href = "/world";
  });
</script>
</body>
</html>`);
});

export default router;