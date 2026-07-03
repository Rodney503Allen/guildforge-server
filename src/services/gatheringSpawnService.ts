import { db } from "../db";

const RESOURCE_SPAWN_CHANCE = 0.04;
const NODE_DESPAWN_MINUTES = 4;
const MAX_ACTIVE_NODES_PER_PLAYER = 5;

export async function cleanupExpiredResourceNodes() {
  await db.query(`
    DELETE FROM spawned_resource_nodes
    WHERE despawns_at IS NOT NULL
      AND despawns_at <= NOW()
  `);
}
async function getRandomNearbyTile(playerX: number, playerY: number, range = 2) {
  const [tiles]: any = await db.query(
    `
    SELECT x, y, terrain, region_id
    FROM world_map
    WHERE x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
      AND terrain != 'town'
    ORDER BY RAND()
    LIMIT 1
    `,
    [
      playerX - range,
      playerX + range,
      playerY - range,
      playerY + range,
    ]
  );

  return tiles[0] || null;
}
async function rollResourceAffixId() {
  // 75% chance: no affix
  if (Math.random() > 0.25) return null;

  const [rows]: any = await db.query(`
    SELECT id, spawn_weight
    FROM resource_node_affixes
  `);

  if (!rows.length) return null;

  const totalWeight = rows.reduce(
    (sum: number, row: any) => sum + Number(row.spawn_weight || 0),
    0
  );

  let roll = Math.random() * totalWeight;

  for (const row of rows) {
    roll -= Number(row.spawn_weight || 0);
    if (roll <= 0) return Number(row.id);
  }

  return null;
}

export async function maybeSpawnResourceNodeForPlayer(playerId: number) {
  if (Math.random() > RESOURCE_SPAWN_CHANCE) {
    return null;
  }

  const [[player]]: any = await db.query(
    `
    SELECT id, map_x, map_y
    FROM players
    WHERE id = ?
    `,
    [playerId]
  );

  if (!player) return null;

  const [[activeCount]]: any = await db.query(
    `
    SELECT COUNT(*) AS count
    FROM spawned_resource_nodes
    WHERE player_id = ?
      AND remaining_uses > 0
      AND (despawns_at IS NULL OR despawns_at > NOW())
    `,
    [playerId]
  );

  if (Number(activeCount.count) >= MAX_ACTIVE_NODES_PER_PLAYER) {
    return null;
  }

  const tile = await getRandomNearbyTile(player.map_x, player.map_y, 2);

    if (!tile || !tile.region_id) return null;

  const [nodeRows]: any = await db.query(
    `
    SELECT
        rn.id,
        rn.name,
        rn.image,
        rn.base_spawn_chance,
        rn.rarity
    FROM resource_nodes rn
    JOIN resource_node_regions rnr
        ON rnr.node_id = rn.id
    WHERE rnr.region_id = ?
    ORDER BY RAND()
    LIMIT 1
    `,
    [tile.region_id]
    );

  if (!nodeRows.length) return null;

  const node = nodeRows[0];

  await cleanupExpiredResourceNodes();

  const affixId = await rollResourceAffixId();
  const remainingUses = Math.floor(Math.random() * 3) + 1; // 1-3

  const [insertResult]: any = await db.query(
    `
    INSERT INTO spawned_resource_nodes
    (player_id, node_id, affix_id, map_x, map_y, despawns_at, remaining_uses)
    VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?)
    `,
    [
        playerId,
        node.id,
        affixId,
        tile.x,
        tile.y,
        NODE_DESPAWN_MINUTES,
        remainingUses
    ]
    );

  return {
    spawnedNodeId: insertResult.insertId,
    nodeName: node.name,
    map_x: tile.x,
    map_y: tile.y
  };
}