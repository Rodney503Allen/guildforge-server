//services/killService.ts
import { db } from "../db";
import { grantExperience } from "./experienceService";
import { rollCreatureLoot } from "./lootService";
import { createChestFromDrops } from "./chestService";
import { advanceQuestObjectives } from "./questService";
import { generateLootForCreature } from "./lootGenerator";
import { recordCreatureKill } from "./bestiaryService";
import { advanceHuntObjective } from "../huntService";
import { recordWorldEventProgress } from "./worldEventProgressService";


/**
 * Marks a physical event creature spawn as consumed by THIS player only.
 *
 * The global active_world_event_spawns row remains ACTIVE so other players
 * can still encounter the same event creature location.
 *
 * Returns true only when this player consumed this spawn for the first time.
 */
async function consumeWorldEventCreatureSpawnForPlayer(
  activeEventId: number,
  playerId: number,
  spawnId: number
): Promise<boolean> {
  const [result]: any = await db.query(
    `
      INSERT IGNORE INTO player_world_event_spawn_interactions (
        active_event_id,
        player_id,
        spawn_id,
        interacted_at
      )
      VALUES (?, ?, ?, NOW())
    `,
    [activeEventId, playerId, spawnId]
  );

  return Number(result?.affectedRows || 0) > 0;
}


async function getGuildRewardMultipliers(playerId: number) {
  const [rows]: any = await db.query(`
    SELECT pd.effect_type, pd.effect_value, gp.level
    FROM guild_members gm
    JOIN guild_perks gp ON gp.guild_id = gm.guild_id
    JOIN perk_definitions pd ON pd.id = gp.perk_id
    WHERE gm.player_id = ?
  `, [playerId]);

  let goldPct = 0;
  let expPct = 0;

  for (const r of rows || []) {
    const perLevel = Number(r.effect_value) || 0;
    const lvl = Number(r.level) || 0;
    const totalPct = perLevel * lvl;

    switch (r.effect_type) {
      case "gold_pct":
        goldPct += totalPct;
        break;
      case "exp_pct":
        expPct += totalPct;
        break;
    }
  }

  return {
    goldMult: 1 + goldPct / 100,
    expMult: 1 + expPct / 100
  };
}

async function hydrateCompletedQuests(playerId: number, playerQuestIds: number[]) {
  const ids = (playerQuestIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return [];

  const [rows]: any = await db.query(
    `
    SELECT
      pq.id AS playerQuestId,
      pq.quest_id AS questId,
      q.title
    FROM player_quests pq
    JOIN quests q ON q.id = pq.quest_id
    WHERE pq.player_id = ?
      AND pq.id IN (${ids.map(() => "?").join(",")})
    `,
    [playerId, ...ids]
  );

  return (rows || []).map((r: any) => ({
    playerQuestId: Number(r.playerQuestId),
    questId: Number(r.questId),
    title: String(r.title || "Quest")
  }));
}

export async function handleCreatureKill(
  playerId: number,
  playerCreatureId: number
) {
// Load creature data + current mapped region BEFORE deletion
const [[row]]: any = await db.query(`
  SELECT
    pc.creature_id,
    pc.affix_id,
    pc.map_x AS encounter_map_x,
    pc.map_y AS encounter_map_y,

    c.name,
    c.exper,
    c.level,
    c.rarity,

    ca.name AS affix_name,
    ca.rarity AS affix_rarity,
    ca.xp_mult,
    ca.gold_mult,
    ca.loot_mult,

    COALESCE(wm.region_name, r.name) AS region_name
  FROM player_creatures pc
  JOIN creatures c
    ON c.id = pc.creature_id
  LEFT JOIN creature_affixes ca
    ON ca.id = pc.affix_id
  JOIN players p
    ON p.id = pc.player_id
  LEFT JOIN world_map wm
    ON wm.x = p.map_x
   AND wm.y = p.map_y
  LEFT JOIN regions r
    ON r.id = wm.region_id
  WHERE pc.id = ?
    AND pc.player_id = ?
  LIMIT 1
`, [playerCreatureId, playerId]);

if (!row) return null;

const creatureId = Number(row.creature_id);
const creatureName = String(row.name || "Creature");
const creatureLevel = Number(row.level) || 1;
const creatureRarity = String(row.rarity || "common");
const baseExp = Number(row.exper) || 0;
const affixName = row.affix_name ? String(row.affix_name) : null;
const affixXpMult = Number(row.xp_mult ?? 1);
const affixGoldMult = Number(row.gold_mult ?? 1);
const affixLootMult = Number(row.loot_mult ?? 1);
const regionName = row.region_name ? String(row.region_name).trim() : null;
const encounterMapX = row.encounter_map_x == null ? null : Number(row.encounter_map_x);
const encounterMapY = row.encounter_map_y == null ? null : Number(row.encounter_map_y);

// Resolve the numeric region ID while the creature/player location is still available.
// World events use region_id rather than the display region name.
const [[regionRow]]: any = await db.query(
  `
    SELECT wm.region_id
    FROM players p
    LEFT JOIN world_map wm
      ON wm.x = p.map_x
     AND wm.y = p.map_y
    WHERE p.id = ?
    LIMIT 1
  `,
  [playerId]
);

const regionId =
  regionRow?.region_id == null
    ? null
    : Number(regionRow.region_id);

await recordCreatureKill(playerId, creatureId, Number(row.affix_id) || null);
  // BASE RANGE
  const base = (2 + (creatureLevel * 3)) * 2;
  const min = Math.floor(base * 0.85);
  const max = Math.floor(base * 1.15);

  let rolledGold = Math.floor(
    Math.random() * (max - min + 1)
  ) + min;

  // RARITY MULTIPLIER
  const rarityMult =
    creatureRarity === "uncommon" ? 1.15 :
    creatureRarity === "rare" ? 1.35 :
    creatureRarity === "elite" ? 1.75 :
    creatureRarity === "boss" ? 2.5 :
    1;

  rolledGold = Math.floor(rolledGold * rarityMult);

  // Apply guild EXP/GOLD multipliers
  const mults = await getGuildRewardMultipliers(playerId);

  const expGained = Math.max(
  0,
  Math.floor(baseExp * affixXpMult * (mults.expMult || 1))
);

const goldGained = Math.max(
  0,
  Math.floor(rolledGold * affixGoldMult * (mults.goldMult || 1))
);

  const { levelUp } = await grantExperience(playerId, expGained);

  if (goldGained > 0) {
    await db.query(
      `UPDATE players
      SET gold = gold + ?
      WHERE id = ?`,
      [goldGained, playerId]
    );
  }

  const drops = await rollCreatureLoot(playerId, creatureId, affixLootMult);

  const rolledGear = await generateLootForCreature(
    {
      id: creatureId,
      name: creatureName,
      level: creatureLevel,
      rarity: creatureRarity
    },
    {
      id: playerId
    },
    affixLootMult
  );

  const killProg = await advanceQuestObjectives(playerId, {
    type: "CREATURE_KILLED",
    creatureId,
    regionName,
    amount: 1
  });
  const completedQuests = await hydrateCompletedQuests(
    playerId,
    killProg?.completedPlayerQuestIds ?? []
  );

  /*
   * World-event progress is intentionally isolated from normal combat
   * rewards. A world-event failure must never invalidate a legitimate kill.
   */
  let worldEventProgress = null;
  let worldEventResolution = null;
  let worldEventSpawnConsumed = false;
  let worldEventSpawnId: number | null = null;
  let worldEventSpawnActiveEventId: number | null = null;

  // Find the physical event combat spawn that produced this encounter.
  if (encounterMapX != null && encounterMapY != null) {
    try {
      const [[eventSpawnRow]]: any = await db.query(
        `
          SELECT
            aws.id,
            aws.active_event_id
          FROM active_world_event_spawns aws
          JOIN active_world_events awe
            ON awe.id = aws.active_event_id
          WHERE aws.x = ?
            AND aws.y = ?
            AND aws.target_id = ?
            AND aws.spawn_type IN ('CREATURE', 'BOSS')
            AND aws.state = 'ACTIVE'
            AND aws.removed_at IS NULL
            AND awe.status = 'ACTIVE'
          ORDER BY aws.id DESC
          LIMIT 1
        `,
        [encounterMapX, encounterMapY, creatureId]
      );

      if (eventSpawnRow?.id) {
        worldEventSpawnId = Number(eventSpawnRow.id);
        worldEventSpawnActiveEventId =
          Number(eventSpawnRow.active_event_id);
      }
    } catch (err) {
      console.warn("World event spawn lookup failed", err);
    }
  }

  /*
   * Only a creature that came from a physical ACTIVE world-event spawn may
   * advance an event KILL track.
   *
   * The per-player spawn interaction row is inserted BEFORE progress is
   * awarded. That makes each physical event creature location worth at most
   * one kill to this player, while leaving the global spawn ACTIVE for
   * everybody else.
   *
   * Phase 1 no longer resolves here. Completing a personal track only adds
   * influence. The event timer will choose the highest-influence outcome.
   */
  if (
    regionId &&
    worldEventSpawnId != null &&
    worldEventSpawnActiveEventId != null
  ) {
    try {
      worldEventSpawnConsumed =
        await consumeWorldEventCreatureSpawnForPlayer(
          worldEventSpawnActiveEventId,
          playerId,
          worldEventSpawnId
        );

      if (worldEventSpawnConsumed) {
        worldEventProgress =
          await recordWorldEventProgress({
            playerId,
            regionId,
            type: "KILL",
            targetId: creatureId,
            amount: 1
          });
      }
    } catch (err) {
      console.warn(
        "World event KILL progress failed",
        err
      );
    }
  }

  let huntProgress = null;

try {
  huntProgress =
    await advanceHuntObjective(
      playerId,
      {
        type: "KILL",
        creatureId
      }
    );
} catch (err) {
  console.warn(
    "Hunt KILL progress failed",
    err
  );
}

  const chestDrops = [
    ...(drops ?? []).map((d: any) => ({
      item_id: d.itemId,
      qty: d.qty
    })),
    ...(rolledGear ?? []).map((g: any) => ({
      player_item_id: g.playerItemId,
      qty: 1,
      roll_json: g.affixes
    }))
  ];

  let chest = null;
  if (chestDrops.length > 0) {
    chest = await createChestFromDrops({
      playerId,
      sourceType: "combat",
      sourceId: creatureId,
      drops: chestDrops
    });
  }

await db.query(
  `DELETE FROM player_creatures WHERE id = ? AND player_id = ?`,
  [playerCreatureId, playerId]
);

return {
  expGained,
  goldGained,
  levelUp,

  enemyDead: true,

  affix: affixName
    ? {
        id: Number(row.affix_id),
        name: affixName,
        xpMult: affixXpMult,
        goldMult: affixGoldMult,
        lootMult: affixLootMult
      }
    : null,

  chest:
    chest
      ? {
          id: chest.chestId
        }
      : null,

  quest: {
    ...(killProg ?? {
      updatedObjectives: [],
      completedPlayerQuestIds: []
    }),

    completedQuests
  },

  huntProgress,

  worldEventProgress,

  worldEventSpawn: {
    id: worldEventSpawnId,
    consumedByPlayer: worldEventSpawnConsumed
  }
};
}