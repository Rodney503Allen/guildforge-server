// services/spawnService.ts

import { db } from "../db";
import { recordCreatureSeen } from "./bestiaryService";

export async function trySpawnEnemy(
  playerId: number,
  mapX: number,
  mapY: number,
  terrain: string
) {
  // 1) Do not spawn another creature while the player has an active encounter.
  const [[existing]]: any = await db.query(
    `
    SELECT id
    FROM player_creatures
    WHERE player_id = ?
    LIMIT 1
    `,
    [playerId]
  );

  if (existing) return null;

  // 2) Load the region's level range from the player's current tile.
  const [[tile]]: any = await db.query(
    `
    SELECT
      COALESCE(r.level_min, 1) AS level_min,
      COALESCE(r.level_max, 1) AS level_max
    FROM world_map wm
    LEFT JOIN regions r ON r.id = wm.region_id
    WHERE wm.x = ?
      AND wm.y = ?
    LIMIT 1
    `,
    [mapX, mapY]
  );

  if (!tile) return null;

  const zoneMin = Math.max(1, Number(tile.level_min) || 1);
  const zoneMax = Math.max(zoneMin, Number(tile.level_max) || zoneMin);

  // 3) Load the player's level for soft spawn weighting.
  const [[player]]: any = await db.query(
    `
    SELECT level
    FROM players
    WHERE id = ?
    LIMIT 1
    `,
    [playerId]
  );

  const playerLevel = Math.max(1, Number(player?.level) || 1);

  // 4) Load every terrain-compatible creature within the region's level band.
  //
  // Player level does not exclude creatures. It only slightly influences
  // their final spawn weight below.
const [candidates]: any = await db.query(
  `
  SELECT
    c.*,
    ca.img AS img
  FROM creatures c
  LEFT JOIN creature_archetypes ca
    ON ca.id = c.archetype_id
  WHERE (c.terrain = ? OR c.terrain = 'any')
    AND c.level BETWEEN ? AND ?
  `,
  [terrain, zoneMin, zoneMax]
);

if (!candidates.length) return null;

// Load creature IDs required by active, unfinished kill quests.
const [questCreatureRows]: any = await db.query(
  `
  SELECT DISTINCT relevant_creatures.creature_id
  FROM (
    /* Creatures directly required by unfinished kill objectives */
    SELECT
      qo.target_creature_id AS creature_id
    FROM player_quests pq
    INNER JOIN player_quest_objectives pqo
      ON pqo.player_quest_id = pq.id
    INNER JOIN quest_objectives qo
      ON qo.id = pqo.objective_id
    WHERE pq.player_id = ?
      AND qo.type = 'KILL'
      AND qo.target_creature_id IS NOT NULL
      AND pqo.is_complete = 0

    UNION

    /* Creatures that drop items required by unfinished objectives */
    SELECT
      cl.creature_id
    FROM player_quests pq
    INNER JOIN player_quest_objectives pqo
      ON pqo.player_quest_id = pq.id
    INNER JOIN quest_objectives qo
      ON qo.id = pqo.objective_id
    INNER JOIN creature_loot cl
      ON cl.item_id = qo.target_item_id
    WHERE pq.player_id = ?
      AND qo.target_item_id IS NOT NULL
      AND pqo.is_complete = 0
  ) AS relevant_creatures
  WHERE relevant_creatures.creature_id IS NOT NULL
  `,
  [playerId, playerId]
);

const questCreatureIds = new Set<number>(
  questCreatureRows.map((row: any) => Number(row.creature_id))
);

function getLevelWeight(creatureLevel: number) {
  const diff = Math.abs(creatureLevel - playerLevel);

  if (diff === 0) return 1.25;
  if (diff === 1) return 1.15;
  if (diff === 2) return 1.0;
  if (diff === 3) return 0.85;

  return 0.7;
}

const QUEST_SPAWN_MULTIPLIER = 1.5;

const weightedCandidates = candidates.map((creature: any) => {
  const baseWeight = Math.max(
    0.01,
    Number(creature.base_spawn_chance) || 0.1
  );

  const levelWeight = getLevelWeight(Number(creature.level));

  const questWeight = questCreatureIds.has(Number(creature.id))
    ? QUEST_SPAWN_MULTIPLIER
    : 1;

  return {
    ...creature,
    finalSpawnWeight: baseWeight * levelWeight * questWeight
  };
});

  const totalWeight = weightedCandidates.reduce(
    (sum: number, creature: any) =>
      sum + Number(creature.finalSpawnWeight || 0),
    0
  );

  let chosen: any = null;

  if (totalWeight <= 0) {
    chosen =
      weightedCandidates[
        Math.floor(Math.random() * weightedCandidates.length)
      ];
  } else {
    let roll = Math.random() * totalWeight;

    for (const creature of weightedCandidates) {
      roll -= Number(creature.finalSpawnWeight || 0);

      if (roll <= 0) {
        chosen = creature;
        break;
      }
    }

    if (!chosen) {
      chosen = weightedCandidates[weightedCandidates.length - 1];
    }
  }

  // 6) Roll a creature affix.
  let affix: any = null;
  const affixSpawnChance = 0.12;

  if (Math.random() < affixSpawnChance) {
    const [affixes]: any = await db.query(
      `
      SELECT *
      FROM creature_affixes
      ORDER BY RAND() * spawn_weight DESC
      LIMIT 1
      `
    );

    affix = affixes?.[0] || null;
  }

  const hpMult = affix ? Number(affix.hp_mult || 1) : 1;
  const attackMult = affix ? Number(affix.attack_mult || 1) : 1;
  const defenseMult = affix ? Number(affix.defense_mult || 1) : 1;
  const speedMult = affix ? Number(affix.speed_mult || 1) : 1;

  const spawnedHp = Math.floor(Number(chosen.maxhp) * hpMult);
  const finalAttack = Math.floor(Number(chosen.attack) * attackMult);
  const finalDefense = Math.floor(Number(chosen.defense) * defenseMult);
  const finalAgility = Math.floor(Number(chosen.agility) * speedMult);

  // 7) Create the player's active encounter.
  await db.query(
    `
    INSERT INTO player_creatures
      (player_id, creature_id, affix_id, hp, map_x, map_y)
    VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      playerId,
      chosen.id,
      affix?.id || null,
      spawnedHp,
      mapX,
      mapY
    ]
  );

  await recordCreatureSeen(
    playerId,
    chosen.id,
    affix?.id || null
  );

  const displayName = affix
    ? `${affix.name} ${chosen.name}`
    : chosen.name;

  return {
    id: chosen.id,
    name: displayName,
    baseName: chosen.name,

    affix: affix
      ? {
          id: affix.id,
          name: affix.name,
          rarity: affix.rarity,
          description: affix.description,

          hpMult,
          attackMult,
          defenseMult,
          speedMult,

          xpMult: Number(affix.xp_mult || 1),
          goldMult: Number(affix.gold_mult || 1),
          lootMult: Number(affix.loot_mult || 1)
        }
      : null,

    level: chosen.level,
    description: chosen.description,

    hp: spawnedHp,
    maxHP: spawnedHp,
    maxhp: spawnedHp,

    img:
      chosen.img ||
      chosen.creatureimage ||
      chosen.image ||
      "/images/default_creature.png",

    attack: finalAttack,
    defense: finalDefense,
    agility: finalAgility,
    crit: chosen.crit,

    creatureId: chosen.id,
    affixId: affix?.id || null,

    zoneMin,
    zoneMax
  };
}