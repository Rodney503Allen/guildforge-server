//src/services/bestiaryService.ts
import { db } from "../db";

async function getCreatureArchetypeId(
  creatureId: number
): Promise<number | null> {
  const [[row]]: any = await db.query(
    `
    SELECT archetype_id
    FROM creatures
    WHERE id = ?
    LIMIT 1
    `,
    [creatureId]
  );

  return row?.archetype_id ? Number(row.archetype_id) : null;
}

async function recordAffixSeen(
  playerId: number,
  creatureId: number,
  affixId?: number | null
) {
  if (!affixId) return;

  await db.query(
    `
    INSERT INTO player_bestiary_affixes
      (player_id, creature_id, affix_id, seen_count, first_seen_at)
    VALUES
      (?, ?, ?, 1, NOW())
    ON DUPLICATE KEY UPDATE
      seen_count = seen_count + 1,
      first_seen_at = COALESCE(first_seen_at, NOW()),
      updated_at = CURRENT_TIMESTAMP
    `,
    [playerId, creatureId, affixId]
  );
}

async function recordAffixKill(
  playerId: number,
  creatureId: number,
  affixId?: number | null
) {
  if (!affixId) return;

  await db.query(
    `
    INSERT INTO player_bestiary_affixes
      (player_id, creature_id, affix_id, seen_count, kill_count, first_seen_at, first_killed_at)
    VALUES
      (?, ?, ?, 1, 1, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      kill_count = kill_count + 1,
      seen_count = GREATEST(seen_count, 1),
      first_seen_at = COALESCE(first_seen_at, NOW()),
      first_killed_at = COALESCE(first_killed_at, NOW()),
      updated_at = CURRENT_TIMESTAMP
    `,
    [playerId, creatureId, affixId]
  );
}

export async function recordCreatureSeen(
  playerId: number,
  creatureId: number,
  affixId?: number | null
) {
  const archetypeId = await getCreatureArchetypeId(creatureId);

  await db.query(
    `
    INSERT INTO player_bestiary_creatures
      (player_id, creature_id, seen_count, first_seen_at)
    VALUES
      (?, ?, 1, NOW())
    ON DUPLICATE KEY UPDATE
      seen_count = seen_count + 1,
      first_seen_at = COALESCE(first_seen_at, NOW()),
      updated_at = CURRENT_TIMESTAMP
    `,
    [playerId, creatureId]
  );

  if (archetypeId) {
    await db.query(
      `
      INSERT INTO player_bestiary_archetypes
        (player_id, archetype_id, seen_count, first_seen_at)
      VALUES
        (?, ?, 1, NOW())
      ON DUPLICATE KEY UPDATE
        seen_count = seen_count + 1,
        first_seen_at = COALESCE(first_seen_at, NOW()),
        updated_at = CURRENT_TIMESTAMP
      `,
      [playerId, archetypeId]
    );
  }

  await recordAffixSeen(playerId, creatureId, affixId);
}

export async function recordCreatureKill(
  playerId: number,
  creatureId: number,
  affixId?: number | null
) {
  const archetypeId = await getCreatureArchetypeId(creatureId);

  await db.query(
    `
    INSERT INTO player_bestiary_creatures
      (player_id, creature_id, seen_count, kill_count, first_seen_at, first_killed_at)
    VALUES
      (?, ?, 1, 1, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      kill_count = kill_count + 1,
      seen_count = GREATEST(seen_count, 1),
      first_seen_at = COALESCE(first_seen_at, NOW()),
      first_killed_at = COALESCE(first_killed_at, NOW()),
      updated_at = CURRENT_TIMESTAMP
    `,
    [playerId, creatureId]
  );

  if (archetypeId) {
    await db.query(
      `
      INSERT INTO player_bestiary_archetypes
        (player_id, archetype_id, seen_count, kill_count, first_seen_at, first_killed_at)
      VALUES
        (?, ?, 1, 1, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        kill_count = kill_count + 1,
        seen_count = GREATEST(seen_count, 1),
        first_seen_at = COALESCE(first_seen_at, NOW()),
        first_killed_at = COALESCE(first_killed_at, NOW()),
        updated_at = CURRENT_TIMESTAMP
      `,
      [playerId, archetypeId]
    );
  }

  await recordAffixKill(playerId, creatureId, affixId);
}