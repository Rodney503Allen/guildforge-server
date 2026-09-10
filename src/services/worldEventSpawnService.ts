// services/worldEventSpawnService.ts
import { db } from "../db";

async function query<T = any>(
  sql: string,
  params: any[] = []
): Promise<T> {
  const [rows] = await db.query(sql, params);
  return rows as T;
}

export type WorldEventSpawnDefinition = {
  id: number;
  phaseId: number;
  spawnKey: string;
  spawnType: string;
  targetId: number | null;
  quantity: number;
  regionId: number;
  minX: number | null;
  maxX: number | null;
  minY: number | null;
  maxY: number | null;
  terrainFilter: string | null;
  minDistanceFromPlayer: number;
  isRequired: boolean;
};

export type ActiveWorldEventSpawn = {
  id: number;
  activeEventId: number;
  spawnDefinitionId: number;
  x: number;
  y: number;
  spawnType: string;
  targetId: number | null;
  state: string;
  spawnedAt: Date | string;
  completedAt: Date | string | null;
  removedAt: Date | string | null;
};

export async function getWorldEventSpawnDefinitions(
  phaseId: number
): Promise<WorldEventSpawnDefinition[]> {
  const rows: any[] = await query(
    `
      SELECT
        id, phase_id, spawn_key, spawn_type, target_id, quantity,
        region_id, min_x, max_x, min_y, max_y, terrain_filter,
        min_distance_from_player, is_required
      FROM world_event_spawns
      WHERE phase_id = ?
      ORDER BY id ASC
    `,
    [phaseId]
  );

  return rows.map(row => ({
    id: Number(row.id),
    phaseId: Number(row.phase_id),
    spawnKey: String(row.spawn_key),
    spawnType: String(row.spawn_type),
    targetId: row.target_id == null ? null : Number(row.target_id),
    quantity: Number(row.quantity || 1),
    regionId: Number(row.region_id),
    minX: row.min_x == null ? null : Number(row.min_x),
    maxX: row.max_x == null ? null : Number(row.max_x),
    minY: row.min_y == null ? null : Number(row.min_y),
    maxY: row.max_y == null ? null : Number(row.max_y),
    terrainFilter: row.terrain_filter == null ? null : String(row.terrain_filter),
    minDistanceFromPlayer: Number(row.min_distance_from_player || 0),
    isRequired: Number(row.is_required) === 1,
  }));
}

export async function getActiveWorldEventSpawns(
  activeEventId: number
): Promise<ActiveWorldEventSpawn[]> {
  const rows: any[] = await query(
    `
      SELECT
        id, active_event_id, spawn_definition_id, x, y,
        spawn_type, target_id, state, spawned_at, completed_at, removed_at
      FROM active_world_event_spawns
      WHERE active_event_id = ?
        AND state = 'ACTIVE'
        AND removed_at IS NULL
      ORDER BY id ASC
    `,
    [activeEventId]
  );

  return rows.map(row => ({
    id: Number(row.id),
    activeEventId: Number(row.active_event_id),
    spawnDefinitionId: Number(row.spawn_definition_id),
    x: Number(row.x),
    y: Number(row.y),
    spawnType: String(row.spawn_type),
    targetId: row.target_id == null ? null : Number(row.target_id),
    state: String(row.state),
    spawnedAt: row.spawned_at,
    completedAt: row.completed_at ?? null,
    removedAt: row.removed_at ?? null,
  }));
}

async function getValidSpawnTiles(
  definition: WorldEventSpawnDefinition
) {
  const conditions: string[] = ["wm.region_id = ?"];
  const params: any[] = [definition.regionId];

  if (definition.minX != null) {
    conditions.push("wm.x >= ?");
    params.push(definition.minX);
  }
  if (definition.maxX != null) {
    conditions.push("wm.x <= ?");
    params.push(definition.maxX);
  }
  if (definition.minY != null) {
    conditions.push("wm.y >= ?");
    params.push(definition.minY);
  }
  if (definition.maxY != null) {
    conditions.push("wm.y <= ?");
    params.push(definition.maxY);
  }
  if (definition.terrainFilter) {
    conditions.push("wm.terrain = ?");
    params.push(definition.terrainFilter);
  }

  conditions.push(`
    wm.terrain NOT IN ('town', 'dungeon', 'castle')
  `);

  conditions.push(`
    NOT EXISTS (
      SELECT 1
      FROM active_world_event_spawns aws
      WHERE aws.x = wm.x
        AND aws.y = wm.y
        AND aws.state = 'ACTIVE'
        AND aws.removed_at IS NULL
    )
  `);

  return query<any[]>(
    `
      SELECT wm.x, wm.y, wm.terrain, wm.region_id
      FROM world_map wm
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY wm.y ASC, wm.x ASC
    `,
    params
  );
}

async function filterByPlayerDistance(
  tiles: any[],
  minDistance: number
) {
  if (!minDistance || minDistance <= 0) {
    return tiles;
  }

  const [players]: any = await db.query(
    `
      SELECT map_x, map_y
      FROM players
      WHERE map_x IS NOT NULL
        AND map_y IS NOT NULL
    `
  );

  if (!players || !players.length) {
    return tiles;
  }

  return tiles.filter(tile =>
    players.every((player: any) => {
      const dx = Math.abs(Number(tile.x) - Number(player.map_x));
      const dy = Math.abs(Number(tile.y) - Number(player.map_y));
      return dx + dy >= minDistance;
    })
  );
}

function pickRandomUniqueTiles(
  tiles: any[],
  quantity: number
) {
  const pool = [...tiles];
  const selected: any[] = [];

  while (selected.length < quantity && pool.length) {
    const index = Math.floor(Math.random() * pool.length);
    selected.push(pool.splice(index, 1)[0]);
  }

  return selected;
}

export async function spawnWorldEventPhase(
  activeEventId: number,
  phaseId: number
) {
  const eventRows: any[] = await query(
    `
      SELECT id, event_id, phase_id, region_id, status
      FROM active_world_events
      WHERE id = ?
        AND phase_id = ?
        AND status IN ('ACTIVE', 'PHASE_TRANSITION')
      LIMIT 1
    `,
    [activeEventId, phaseId]
  );

  if (!eventRows.length) {
    throw new Error("Active world event phase is invalid.");
  }

  const definitions = await getWorldEventSpawnDefinitions(phaseId);
  const created: ActiveWorldEventSpawn[] = [];

  for (const definition of definitions) {
    let validTiles = await getValidSpawnTiles(definition);
    validTiles = await filterByPlayerDistance(
      validTiles,
      definition.minDistanceFromPlayer
    );

    if (definition.isRequired && validTiles.length < definition.quantity) {
      throw new Error(
        `Unable to place required world event spawn: ${definition.spawnKey}`
      );
    }

    const chosen = pickRandomUniqueTiles(validTiles, definition.quantity);

    for (const tile of chosen) {
      const result: any = await query(
        `
          INSERT INTO active_world_event_spawns (
            active_event_id, spawn_definition_id, x, y,
            spawn_type, target_id, state, spawned_at,
            completed_at, removed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(), NULL, NULL)
        `,
        [
          activeEventId,
          definition.id,
          Number(tile.x),
          Number(tile.y),
          definition.spawnType,
          definition.targetId
        ]
      );

      created.push({
        id: Number(result.insertId),
        activeEventId,
        spawnDefinitionId: definition.id,
        x: Number(tile.x),
        y: Number(tile.y),
        spawnType: definition.spawnType,
        targetId: definition.targetId,
        state: "ACTIVE",
        spawnedAt: new Date(),
        completedAt: null,
        removedAt: null,
      });
    }
  }

  return created;
}

export async function hasPlayerInteractedWithWorldEventSpawn(
  activeEventId: number,
  playerId: number,
  spawnId: number
): Promise<boolean> {
  const rows: any[] = await query(
    `
      SELECT 1
      FROM player_world_event_spawn_interactions
      WHERE active_event_id = ?
        AND player_id = ?
        AND spawn_id = ?
      LIMIT 1
    `,
    [activeEventId, playerId, spawnId]
  );

  return rows.length > 0;
}

export async function recordPlayerWorldEventSpawnInteraction(
  activeEventId: number,
  playerId: number,
  spawnId: number
): Promise<boolean> {
  const result: any = await query(
    `
      INSERT IGNORE INTO player_world_event_spawn_interactions (
        active_event_id, player_id, spawn_id, interacted_at
      )
      VALUES (?, ?, ?, NOW())
    `,
    [activeEventId, playerId, spawnId]
  );

  return Number(result.affectedRows || 0) > 0;
}

export async function completeWorldEventSpawn(
  spawnId: number
) {
  const result: any = await query(
    `
      UPDATE active_world_event_spawns
      SET state = 'COMPLETED',
          completed_at = NOW()
      WHERE id = ?
        AND state = 'ACTIVE'
        AND removed_at IS NULL
    `,
    [spawnId]
  );

  return Number(result.affectedRows) > 0;
}

export async function removeWorldEventPhaseSpawns(
  activeEventId: number,
  phaseId: number
) {
  const result: any = await query(
    `
      UPDATE active_world_event_spawns aws
      JOIN world_event_spawns ws
        ON ws.id = aws.spawn_definition_id
      SET aws.state = 'REMOVED',
          aws.removed_at = NOW()
      WHERE aws.active_event_id = ?
        AND ws.phase_id = ?
        AND aws.state = 'ACTIVE'
    `,
    [activeEventId, phaseId]
  );

  return Number(result.affectedRows || 0);
}

export async function removeAllWorldEventSpawns(
  activeEventId: number
) {
  const result: any = await query(
    `
      UPDATE active_world_event_spawns
      SET state = 'REMOVED',
          removed_at = NOW()
      WHERE active_event_id = ?
        AND state = 'ACTIVE'
    `,
    [activeEventId]
  );

  return Number(result.affectedRows || 0);
}

export async function getWorldEventSpawnAtTile(
  playerId: number,
  x: number,
  y: number
): Promise<ActiveWorldEventSpawn | null> {
  const rows: any[] = await query(
    `
      SELECT
        aws.id,
        aws.active_event_id,
        aws.spawn_definition_id,
        aws.x,
        aws.y,
        aws.spawn_type,
        aws.target_id,
        aws.state,
        aws.spawned_at,
        aws.completed_at,
        aws.removed_at

      FROM active_world_event_spawns aws

      JOIN active_world_events awe
        ON awe.id = aws.active_event_id

      JOIN world_event_spawns ws
        ON ws.id = aws.spawn_definition_id

      LEFT JOIN player_world_event_spawn_interactions pwesi
        ON pwesi.active_event_id = aws.active_event_id
       AND pwesi.player_id = ?
       AND pwesi.spawn_id = aws.id

      LEFT JOIN player_world_event_state pwes
        ON pwes.active_event_id = aws.active_event_id
       AND pwes.player_id = ?

      WHERE aws.x = ?
        AND aws.y = ?
        AND aws.state = 'ACTIVE'
        AND aws.removed_at IS NULL
        AND awe.status = 'ACTIVE'

        /*
         * This physical event spawn has already been consumed by this
         * player. It remains ACTIVE globally for other players.
         */
        AND pwesi.spawn_id IS NULL

        /*
         * A commitment only locks contribution spawns belonging to the
         * phase in which that commitment was made.
         *
         * Once the event advances to a new phase, the old Phase 1
         * commitment must not hide new content such as the Sealborn Horror.
         *
         * player_world_event_state is scoped to the active event rather
         * than phase, so we determine whether the commitment belongs to the
         * CURRENT phase by checking whether the chosen outcome itself
         * belongs to the current phase.
         */
        AND NOT EXISTS (
          SELECT 1
          FROM world_event_outcomes committed_outcome
          WHERE committed_outcome.id = pwes.chosen_outcome_id
            AND committed_outcome.phase_id = awe.phase_id
        )

        /*
         * Protect against stale physical rows from another phase.
         */
        AND ws.phase_id = awe.phase_id

      ORDER BY aws.id DESC
      LIMIT 1
    `,
    [playerId, playerId, x, y]
  );

  if (!rows.length) {
    return null;
  }

  const row = rows[0];

  return {
    id: Number(row.id),
    activeEventId: Number(row.active_event_id),
    spawnDefinitionId: Number(row.spawn_definition_id),
    x: Number(row.x),
    y: Number(row.y),
    spawnType: String(row.spawn_type),
    targetId: row.target_id == null ? null : Number(row.target_id),
    state: String(row.state),
    spawnedAt: row.spawned_at,
    completedAt: row.completed_at ?? null,
    removedAt: row.removed_at ?? null,
  };
}
