import { db } from "../db";

export async function trySpawnEnemy(playerId: number) {
  // Is player already in combat?
  const [[existing]]: any = await db.query(
    "SELECT id FROM player_creatures WHERE player_id = ?",
    [playerId]
  );
  if (existing) return null;

  // Get player level + terrain + position
  const [[player]]: any = await db.query(`
    SELECT p.level, p.map_x, p.map_y, wm.terrain
    FROM players p
    JOIN world_map wm ON wm.x = p.map_x AND wm.y = p.map_y
    WHERE p.id = ?
  `, [playerId]);

  if (!player) return null;

  // Select candidate creatures
  const [candidates]: any = await db.query(`
    SELECT *
    FROM creatures
    WHERE (terrain = ? OR terrain = 'any')
      AND min_level <= ?
      AND max_level >= ?
  `, [player.terrain, player.level, player.level]);

  if (!candidates.length) return null;

  // 30% chance to spawn anything
  if (Math.random() > 0.3) return null;

  // Weighted selection
  const totalWeight = candidates.reduce(
    (sum: number, c: any) => sum + Number(c.base_spawn_chance),
    0
  );

  let roll = Math.random() * totalWeight;

  for (const c of candidates) {
    roll -= Number(c.base_spawn_chance);
    if (roll <= 0) {
      await db.query(`
        INSERT INTO player_creatures
          (player_id, creature_id, hp, map_x, map_y)
        VALUES (?, ?, ?, ?, ?)
      `, [playerId, c.id, c.maxhp, player.map_x, player.map_y]);

      return c;
    }
  }

  return null;
}
