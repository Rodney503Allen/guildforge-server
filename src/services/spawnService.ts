import { db } from "../db";

function randInt(min: number, max: number) {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

export async function trySpawnEnemy(
  playerId: number,
  mapX: number,
  mapY: number,
  terrain: string
) {
  // 1) If player already has an active creature, don't spawn another
  const [[existing]]: any = await db.query(
    "SELECT id FROM player_creatures WHERE player_id = ? LIMIT 1",
    [playerId]
  );
  if (existing) return null;

  // 3) Load zone level band from tile -> region
  const [[tile]]: any = await db.query(
    `
    SELECT
      COALESCE(r.level_min, 1) AS level_min,
      COALESCE(r.level_max, 1) AS level_max
    FROM world_map wm
    LEFT JOIN regions r ON r.id = wm.region_id
    WHERE wm.x = ? AND wm.y = ?
    LIMIT 1
    `,
    [mapX, mapY]
  );
  if (!tile) return null;

  const zoneMin = Math.max(1, Number(tile.level_min) || 1);
  const zoneMax = Math.max(zoneMin, Number(tile.level_max) || zoneMin);

  // 4) Pick an effective zone level (this is what you use to prevent mythics at level 1)
  const zoneLevel = randInt(zoneMin, zoneMax);

  // 5) Candidates: terrain match + creature's min_level must be <= zoneLevel
  // (No creature.max_level needed. High-level players can still be in low zones and see low mobs.)
const [candidates]: any = await db.query(
  `
  SELECT
    c.*,
    ca.img AS img
  FROM creatures c
  LEFT JOIN creature_archetypes ca ON ca.id = c.archetype_id
  WHERE (c.terrain = ? OR c.terrain = 'any')
    AND c.min_level <= ?
  `,
  [terrain, zoneLevel]
);

  if (!candidates.length) return null;

  // 6) Weighted selection by base_spawn_chance
  const totalWeight = candidates.reduce(
    (sum: number, c: any) => sum + Number(c.base_spawn_chance || 0),
    0
  );

  let chosen: any = null;

  if (totalWeight <= 0) {
    chosen = candidates[Math.floor(Math.random() * candidates.length)];
  } else {
    let roll = Math.random() * totalWeight;
    for (const c of candidates) {
      roll -= Number(c.base_spawn_chance || 0);
      if (roll <= 0) {
        chosen = c;
        break;
      }
    }
    if (!chosen) chosen = candidates[candidates.length - 1];
  }

  // 7) Spawn it
  await db.query(
    `
    INSERT INTO player_creatures (player_id, creature_id, hp, map_x, map_y)
    VALUES (?, ?, ?, ?, ?)
    `,
    [playerId, chosen.id, chosen.maxhp, mapX, mapY]
  );

  return { ...chosen, zoneLevel, zoneMin, zoneMax };
}
