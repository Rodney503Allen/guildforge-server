// src/services/dungeonService.ts
import { db } from "../db";
import { getPartyByPlayer } from "../partyService";

export type DungeonPhase = "trash" | "boss" | "loot" | "rest" | "complete";
export type DungeonStatus = "active" | "completed" | "failed" | "abandoned";

async function query<T = any>(sql: string, params: any[] = []): Promise<T> {
  const [rows] = await db.query(sql, params);
  return rows as T;
}

export async function getActiveDungeonForPlayer(playerId: number) {
  const rows = await query<any[]>(
    `
      SELECT
        di.id AS instance_id,
        di.dungeon_id,
        di.party_id,
        di.leader_player_id,
        di.current_room_id,
        di.current_room_order,
        di.current_wave,
        di.current_phase,
        di.status,
        di.started_at,
        di.updated_at,
        d.name AS dungeon_name,
        d.slug AS dungeon_slug,
        d.description AS dungeon_description,
        d.image AS dungeon_image,
        dr.name AS current_room_name
      FROM dungeon_instance_members dim
      JOIN dungeon_instances di ON di.id = dim.instance_id
      JOIN dungeons d ON d.id = di.dungeon_id
      LEFT JOIN dungeon_rooms dr ON dr.id = di.current_room_id
      WHERE dim.player_id = ?
        AND dim.is_active = 1
        AND di.status = 'active'
      ORDER BY di.id DESC
      LIMIT 1
    `,
    [playerId],
  );

  if (!rows.length) return null;
  const row = rows[0];

  const members = await query<any[]>(
    `
      SELECT player_id, player_name, player_level, player_class, was_leader, is_active
      FROM dungeon_instance_members
      WHERE instance_id = ?
      ORDER BY was_leader DESC, id ASC
    `,
    [row.instance_id],
  );

  return {
    instanceId: Number(row.instance_id),
    dungeonId: Number(row.dungeon_id),
    dungeonName: String(row.dungeon_name),
    dungeonSlug: String(row.dungeon_slug),
    description: String(row.dungeon_description ?? ""),
    image: row.dungeon_image ?? null,
    partyId: row.party_id == null ? null : Number(row.party_id),
    leaderPlayerId: Number(row.leader_player_id),
    currentRoomId: row.current_room_id == null ? null : Number(row.current_room_id),
    currentRoomOrder: Number(row.current_room_order ?? 1),
    currentRoomName: row.current_room_name ?? null,
    currentWave: Number(row.current_wave ?? 1),
    phase: String(row.current_phase) as DungeonPhase,
    status: String(row.status) as DungeonStatus,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    members: members.map((m) => ({
      playerId: Number(m.player_id),
      name: String(m.player_name),
      level: Number(m.player_level),
      className: m.player_class == null ? null : String(m.player_class),
      isLeader: Number(m.was_leader) === 1,
      isActive: Number(m.is_active) === 1,
    })),
  };
}

export async function listAvailableDungeons(playerId: number) {
  const [[player]]: any = await db.query(
    `SELECT level FROM players WHERE id = ? LIMIT 1`,
    [playerId],
  );

  const rows = await query<any[]>(
    `
      SELECT
        d.*,
        COUNT(dr.id) AS room_count
      FROM dungeons d
      LEFT JOIN dungeon_rooms dr
        ON dr.dungeon_id = d.id
       AND dr.is_active = 1
      WHERE d.is_active = 1
      GROUP BY d.id
      ORDER BY d.min_level ASC, d.id ASC
    `,
  );

  const level = Number(player?.level ?? 0);

  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description ?? ""),
    minLevel: Number(row.min_level ?? 1),
    maxLevel: row.max_level == null ? null : Number(row.max_level),
    recommendedLevel: row.recommended_level == null ? null : Number(row.recommended_level),
    minPartySize: Number(row.min_party_size ?? 1),
    maxPartySize: Number(row.max_party_size ?? 4),
    image: row.image ?? null,
    completionXp: Number(row.completion_xp ?? 0),
    completionGold: Number(row.completion_gold ?? 0),
    roomCount: Number(row.room_count ?? 0),
    meetsLevel:
      level >= Number(row.min_level ?? 1) &&
      (row.max_level == null || level <= Number(row.max_level)),
  }));
}

export async function createDungeonInstance(playerId: number, dungeonId: number) {
  const existing = await getActiveDungeonForPlayer(playerId);
  if (existing) throw new Error("You are already inside an active dungeon.");

  const [[dungeon]]: any = await db.query(
    `
      SELECT id, name, min_level, max_level, min_party_size, max_party_size
      FROM dungeons
      WHERE id = ? AND is_active = 1
      LIMIT 1
    `,
    [dungeonId],
  );
  if (!dungeon) throw new Error("That dungeon is not available.");

  const [[leaderState]]: any = await db.query(
    `
      SELECT id, name, level, pclass, hpoints, revive_at
      FROM players
      WHERE id = ?
      LIMIT 1
    `,
    [playerId],
  );
  if (!leaderState) throw new Error("Player not found.");
  if (Number(leaderState.hpoints ?? 0) <= 0) {
    throw new Error("You cannot enter a dungeon while defeated.");
  }

  const party = await getPartyByPlayer(playerId);
  let partyId: number | null = null;
  let leaderPlayerId = playerId;
  let members: any[] = [];

  if (party) {
    partyId = Number(party.id);
    leaderPlayerId = Number(party.leaderPlayerId);

    if (leaderPlayerId !== playerId) {
      throw new Error("Only the party leader can start a dungeon.");
    }

    members = party.members.map((m) => ({
      playerId: Number(m.playerId),
      name: String(m.name),
      level: Number(m.level),
      className: m.className == null ? null : String(m.className),
      isLeader: Number(m.playerId) === leaderPlayerId,
    }));
  } else {
    members = [{
      playerId,
      name: String(leaderState.name),
      level: Number(leaderState.level),
      className: leaderState.pclass == null ? null : String(leaderState.pclass),
      isLeader: true,
    }];
  }

  const minPartySize = Number(dungeon.min_party_size ?? 1);
  const maxPartySize = Number(dungeon.max_party_size ?? 4);
  if (members.length < minPartySize) {
    throw new Error(`This dungeon requires at least ${minPartySize} players.`);
  }
  if (members.length > maxPartySize) {
    throw new Error(`This dungeon allows no more than ${maxPartySize} players.`);
  }

  const minLevel = Number(dungeon.min_level ?? 1);
  const maxLevel = dungeon.max_level == null ? null : Number(dungeon.max_level);

  for (const member of members) {
    const active = await getActiveDungeonForPlayer(member.playerId);
    if (active) throw new Error(`${member.name} is already inside an active dungeon.`);

    const [[state]]: any = await db.query(
      `SELECT level, hpoints, revive_at FROM players WHERE id = ? LIMIT 1`,
      [member.playerId],
    );
    if (!state) throw new Error(`${member.name} could not be loaded.`);

    const level = Number(state.level ?? 1);
    if (level < minLevel) throw new Error(`${member.name} must be level ${minLevel} to enter.`);
    if (maxLevel != null && level > maxLevel) {
      throw new Error(`${member.name} is above this dungeon's maximum level.`);
    }
    if (Number(state.hpoints ?? 0) <= 0) {
      throw new Error(`${member.name} is defeated and cannot enter.`);
    }
  }

  const [rooms]: any = await db.query(
    `
      SELECT id, room_order, name
      FROM dungeon_rooms
      WHERE dungeon_id = ? AND is_active = 1
      ORDER BY room_order ASC
    `,
    [dungeonId],
  );
  if (!rooms?.length) throw new Error("This dungeon has no configured rooms.");

  const firstRoom = rooms[0];
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [result]: any = await connection.query(
      `
        INSERT INTO dungeon_instances (
          dungeon_id, party_id, leader_player_id,
          current_room_id, current_room_order,
          current_wave, current_phase, status
        )
        VALUES (?, ?, ?, ?, ?, 1, 'trash', 'active')
      `,
      [dungeonId, partyId, leaderPlayerId, Number(firstRoom.id), Number(firstRoom.room_order)],
    );

    const instanceId = Number(result.insertId);

    for (const member of members) {
      await connection.query(
        `
          INSERT INTO dungeon_instance_members (
            instance_id, player_id, player_name, player_level,
            player_class, was_leader, is_active
          )
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `,
        [
          instanceId,
          member.playerId,
          member.name,
          member.level,
          member.className,
          member.isLeader ? 1 : 0,
        ],
      );
    }

    for (const room of rooms) {
      const first = Number(room.id) === Number(firstRoom.id);
      await connection.query(
        `
          INSERT INTO dungeon_instance_rooms (
            instance_id, room_id, room_order,
            status, current_wave, phase, entered_at
          )
          VALUES (?, ?, ?, ?, 1, 'trash', ?)
        `,
        [
          instanceId,
          Number(room.id),
          Number(room.room_order),
          first ? "active" : "locked",
          first ? new Date() : null,
        ],
      );
    }

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  const snapshot = await getActiveDungeonForPlayer(playerId);
  if (!snapshot) throw new Error("Dungeon was created but could not be reloaded.");
  return snapshot;
}

export async function abandonDungeon(playerId: number) {
  const active =
    await getActiveDungeonForPlayer(
      playerId
    );

  if (!active) {
    throw new Error(
      "You are not inside an active dungeon.",
    );
  }

  if (
    active.leaderPlayerId !==
    playerId
  ) {
    throw new Error(
      "Only the dungeon leader can abandon the run.",
    );
  }

  const instanceId =
    Number(
      active.instanceId
    );

  const connection =
    await db.getConnection();

  try {
    await connection.beginTransaction();

    /*
     * Abandoned runs are disposable runtime state.
     *
     * Delete children explicitly instead of relying only on
     * foreign-key cascades. This keeps cleanup predictable even
     * if older/local/live schemas differ slightly in FK behavior.
     */

    await connection.query(
      `
        DELETE dlc
        FROM dungeon_loot_choices dlc

        JOIN dungeon_loot_rolls dlr
          ON dlr.id = dlc.roll_id

        WHERE dlr.instance_id = ?
      `,
      [instanceId],
    );

    await connection.query(
      `
        DELETE FROM dungeon_loot_rolls
        WHERE instance_id = ?
      `,
      [instanceId],
    );

    await connection.query(
      `
        DELETE dccr
        FROM dungeon_completion_chest_rewards dccr

        JOIN dungeon_completion_chests dcc
          ON dcc.id = dccr.chest_id

        WHERE dcc.instance_id = ?
      `,
      [instanceId],
    );

    await connection.query(
      `
        DELETE FROM dungeon_completion_chests
        WHERE instance_id = ?
      `,
      [instanceId],
    );

    await connection.query(
      `
        DELETE FROM dungeon_instance_wipes
        WHERE instance_id = ?
      `,
      [instanceId],
    );

    await connection.query(
      `
        DELETE FROM dungeon_instance_enemies
        WHERE instance_id = ?
      `,
      [instanceId],
    );

    await connection.query(
      `
        DELETE FROM dungeon_instance_rooms
        WHERE instance_id = ?
      `,
      [instanceId],
    );

    await connection.query(
      `
        DELETE FROM dungeon_instance_members
        WHERE instance_id = ?
      `,
      [instanceId],
    );

    /*
     * Delete the instance itself last.
     *
     * We intentionally do NOT delete:
     *   dungeons
     *   dungeon_rooms
     *   dungeon_waves
     *   dungeon_wave_creatures
     *   dungeon_boss_loot
     *   dungeon_completion_loot
     *
     * Those are permanent dungeon definitions, not run data.
     */
    const [instanceDelete]: any =
      await connection.query(
        `
          DELETE FROM dungeon_instances

          WHERE id = ?
            AND status = 'active'
        `,
        [instanceId],
      );

    if (
      Number(
        instanceDelete.affectedRows
      ) !== 1
    ) {
      throw new Error(
        "Dungeon instance could not be abandoned.",
      );
    }

    await connection.commit();

    return {
      ok: true,
      instanceId,
      deleted:
        true,
    };
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      // Preserve original error.
    }

    throw err;
  } finally {
    connection.release();
  }
}
