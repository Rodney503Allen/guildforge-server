import { db } from "../db";

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

  // 2) Load player level (only what we need)
  const [[player]]: any = await db.query(
    "SELECT level FROM players WHERE id = ? LIMIT 1",
    [playerId]
  );
  if (!player) return null;

  const level = Number(player.level) || 1;

  // 3) Select candidate creatures for THIS terrain (or 'any') and level range
  const [candidates]: any = await db.query(
    `
    SELECT *
    FROM creatures
    WHERE (terrain = ? OR terrain = 'any')
      AND min_level <= ?
      AND max_level >= ?
    `,
    [terrain, level, level] // ✅ use the terrain arg, not player.terrain
  );

  if (!candidates.length) return null;

  // 4) 30% chance to spawn anything
  if (Math.random() > 0.15) return null;

  // 5) Weighted selection by base_spawn_chance
  const totalWeight = candidates.reduce(
    (sum: number, c: any) => sum + Number(c.base_spawn_chance || 0),
    0
  );

  // Safety: if weights are bad, fallback to random candidate
  if (totalWeight <= 0) {
    const c = candidates[Math.floor(Math.random() * candidates.length)];
    await db.query(
      `
      INSERT INTO player_creatures (player_id, creature_id, hp, map_x, map_y)
      VALUES (?, ?, ?, ?, ?)
      `,
      [playerId, c.id, c.maxhp, mapX, mapY] // ✅ use mapX/mapY args
    );
    return c;
  }

  let roll = Math.random() * totalWeight;

  for (const c of candidates) {
    roll -= Number(c.base_spawn_chance || 0);
    if (roll <= 0) {
      await db.query(
        `
        INSERT INTO player_creatures (player_id, creature_id, hp, map_x, map_y)
        VALUES (?, ?, ?, ?, ?)
        `,
        [playerId, c.id, c.maxhp, mapX, mapY] // ✅ use mapX/mapY args
      );

      return c;
    }
  }

  return null;
}
