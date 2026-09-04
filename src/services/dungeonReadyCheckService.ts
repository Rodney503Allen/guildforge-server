// src/services/dungeonReadyCheckService.ts
import { db } from "../db";
import { getPartyByPlayer } from "../partyService";

const READY_CHECK_SECONDS = 30;
type DbConnection = any;

export type DungeonReadyCheckSnapshot = {
  id: number;
  dungeonId: number;
  dungeonName: string;
  partyId: number | null;
  createdByPlayerId: number;
  status: "pending" | "completed" | "cancelled" | "expired";
  entranceMapX: number;
  entranceMapY: number;
  expiresAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  instanceId: number | null;
  players: Array<{
    playerId: number;
    name: string;
    level: number;
    className: string | null;
    isLeader: boolean;
    isReady: boolean;
    readyAt: string | null;
  }>;
};

function toIso(value: any): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

async function expireIfNeeded(connection: DbConnection, readyCheckId: number) {
  await connection.query(
    `
      UPDATE dungeon_ready_checks
      SET status = 'expired'
      WHERE id = ?
        AND status = 'pending'
        AND expires_at <= NOW()
    `,
    [readyCheckId],
  );
}

async function loadSnapshot(
  connection: DbConnection,
  readyCheckId: number,
): Promise<DungeonReadyCheckSnapshot> {
  const [rows]: any = await connection.query(
    `
      SELECT
        drc.id,
        drc.dungeon_id,
        d.name AS dungeon_name,
        drc.party_id,
        drc.created_by_player_id,
        drc.status,
        drc.entrance_map_x,
        drc.entrance_map_y,
        drc.expires_at,
        drc.completed_at,
        drc.cancelled_at,
        drc.created_at,
        drc.instance_id
      FROM dungeon_ready_checks drc
      JOIN dungeons d ON d.id = drc.dungeon_id
      WHERE drc.id = ?
      LIMIT 1
    `,
    [readyCheckId],
  );

  if (!rows.length) throw new Error("Dungeon ready check does not exist.");

  const [players]: any = await connection.query(
    `
      SELECT
        player_id,
        player_name,
        player_level,
        player_class,
        was_leader,
        is_ready,
        ready_at
      FROM dungeon_ready_check_players
      WHERE ready_check_id = ?
      ORDER BY was_leader DESC, id ASC
    `,
    [readyCheckId],
  );

  const row = rows[0];

  return {
    id: Number(row.id),
    dungeonId: Number(row.dungeon_id),
    dungeonName: String(row.dungeon_name),
    partyId: row.party_id == null ? null : Number(row.party_id),
    createdByPlayerId: Number(row.created_by_player_id),
    status: String(row.status) as DungeonReadyCheckSnapshot["status"],
    entranceMapX: Number(row.entrance_map_x),
    entranceMapY: Number(row.entrance_map_y),
    expiresAt: toIso(row.expires_at)!,
    completedAt: toIso(row.completed_at),
    cancelledAt: toIso(row.cancelled_at),
    createdAt: toIso(row.created_at)!,
    instanceId: row.instance_id == null ? null : Number(row.instance_id),
    players: (players ?? []).map((player: any) => ({
      playerId: Number(player.player_id),
      name: String(player.player_name),
      level: Number(player.player_level),
      className: player.player_class == null ? null : String(player.player_class),
      isLeader: Number(player.was_leader) === 1,
      isReady: Number(player.is_ready) === 1,
      readyAt: toIso(player.ready_at),
    })),
  };
}

async function assertNoActiveDungeon(
  connection: DbConnection,
  playerId: number,
  name: string,
) {
  const [rows]: any = await connection.query(
    `
      SELECT di.id
      FROM dungeon_instance_members dim
      JOIN dungeon_instances di ON di.id = dim.instance_id
      WHERE dim.player_id = ?
        AND dim.is_active = 1
        AND di.status = 'active'
      LIMIT 1
    `,
    [playerId],
  );

  if (rows.length) {
    throw new Error(`${name} is already inside an active dungeon.`);
  }
}

async function createDungeonInstanceFromReadyCheck(
  connection: DbConnection,
  readyCheckId: number,
) {
  const [checkRows]: any = await connection.query(
    `
      SELECT
        dungeon_id,
        party_id,
        created_by_player_id,
        entrance_map_x,
        entrance_map_y,
        status
      FROM dungeon_ready_checks
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
    `,
    [readyCheckId],
  );

  if (!checkRows.length || checkRows[0].status !== "pending") return null;

  const check = checkRows[0];

  const [members]: any = await connection.query(
    `
      SELECT
        player_id,
        player_name,
        player_level,
        player_class,
        was_leader,
        is_ready
      FROM dungeon_ready_check_players
      WHERE ready_check_id = ?
      ORDER BY was_leader DESC, id ASC
      FOR UPDATE
    `,
    [readyCheckId],
  );

  if (!members.length || members.some((m: any) => Number(m.is_ready) !== 1)) {
    return null;
  }

  const entranceX = Number(check.entrance_map_x);
  const entranceY = Number(check.entrance_map_y);

  for (const member of members) {
    const [stateRows]: any = await connection.query(
      `
        SELECT hpoints, map_x, map_y
        FROM players
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [Number(member.player_id)],
    );

    if (!stateRows.length) {
      throw new Error(`${member.player_name} could not be loaded.`);
    }

    const state = stateRows[0];

    if (Number(state.hpoints ?? 0) <= 0) {
      throw new Error(`${member.player_name} is defeated and cannot enter.`);
    }

    if (
      Number(state.map_x) !== entranceX ||
      Number(state.map_y) !== entranceY
    ) {
      throw new Error(`${member.player_name} left the dungeon entrance.`);
    }

    await assertNoActiveDungeon(
      connection,
      Number(member.player_id),
      String(member.player_name),
    );
  }

  const [rooms]: any = await connection.query(
    `
      SELECT id, room_order
      FROM dungeon_rooms
      WHERE dungeon_id = ?
        AND is_active = 1
      ORDER BY room_order ASC
    `,
    [Number(check.dungeon_id)],
  );

  if (!rooms?.length) throw new Error("This dungeon has no configured rooms.");

  const firstRoom = rooms[0];
  const leader = members.find((m: any) => Number(m.was_leader) === 1);
  const leaderPlayerId = leader
    ? Number(leader.player_id)
    : Number(check.created_by_player_id);

  const [result]: any = await connection.query(
    `
      INSERT INTO dungeon_instances (
        dungeon_id,
        party_id,
        leader_player_id,
        current_room_id,
        current_room_order,
        current_wave,
        current_phase,
        status
      )
      VALUES (?, ?, ?, ?, ?, 1, 'trash', 'active')
    `,
    [
      Number(check.dungeon_id),
      check.party_id == null ? null : Number(check.party_id),
      leaderPlayerId,
      Number(firstRoom.id),
      Number(firstRoom.room_order),
    ],
  );

  const instanceId = Number(result.insertId);

  for (const member of members) {
    await connection.query(
      `
        INSERT INTO dungeon_instance_members (
          instance_id,
          player_id,
          player_name,
          player_level,
          player_class,
          was_leader,
          is_active
        )
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `,
      [
        instanceId,
        Number(member.player_id),
        String(member.player_name),
        Number(member.player_level),
        member.player_class == null ? null : String(member.player_class),
        Number(member.was_leader) === 1 ? 1 : 0,
      ],
    );
  }

  for (const room of rooms) {
    const isFirst = Number(room.id) === Number(firstRoom.id);

    await connection.query(
      `
        INSERT INTO dungeon_instance_rooms (
          instance_id,
          room_id,
          room_order,
          status,
          current_wave,
          phase,
          entered_at
        )
        VALUES (?, ?, ?, ?, 1, 'trash', ?)
      `,
      [
        instanceId,
        Number(room.id),
        Number(room.room_order),
        isFirst ? "active" : "locked",
        isFirst ? new Date() : null,
      ],
    );
  }

  const [complete]: any = await connection.query(
    `
      UPDATE dungeon_ready_checks
      SET
        status = 'completed',
        instance_id = ?,
        completed_at = NOW()
      WHERE id = ?
        AND status = 'pending'
    `,
    [instanceId, readyCheckId],
  );

  if (Number(complete.affectedRows) !== 1) {
    throw new Error("Dungeon ready check could not be completed.");
  }

  return { instanceId };
}

async function completeIfReady(connection: DbConnection, readyCheckId: number) {
  const [rows]: any = await connection.query(
    `
      SELECT is_ready
      FROM dungeon_ready_check_players
      WHERE ready_check_id = ?
      FOR UPDATE
    `,
    [readyCheckId],
  );

  if (!rows.length || rows.some((row: any) => Number(row.is_ready) !== 1)) {
    return null;
  }

  return createDungeonInstanceFromReadyCheck(connection, readyCheckId);
}

export async function startDungeonReadyCheck(
  playerId: number,
  dungeonId: number,
) {
  const party = await getPartyByPlayer(playerId);

  let partyId: number | null = null;
  let leaderPlayerId = playerId;
  let roster: Array<{
    playerId: number;
    name: string;
    level: number;
    className: string | null;
    isLeader: boolean;
  }> = [];

  if (party) {
    partyId = Number(party.id);
    leaderPlayerId = Number(party.leaderPlayerId);

    if (leaderPlayerId !== playerId) {
      throw new Error("Only the party leader can start a dungeon.");
    }

    roster = party.members.map((member: any) => ({
      playerId: Number(member.playerId),
      name: String(member.name),
      level: Number(member.level),
      className: member.className == null ? null : String(member.className),
      isLeader: Number(member.playerId) === leaderPlayerId,
    }));
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [dungeonRows]: any = await connection.query(
      `
        SELECT
          id,
          name,
          min_level,
          max_level,
          min_party_size,
          max_party_size
        FROM dungeons
        WHERE id = ?
          AND is_active = 1
        LIMIT 1
        FOR UPDATE
      `,
      [dungeonId],
    );

    if (!dungeonRows.length) throw new Error("That dungeon is not available.");

    const dungeon = dungeonRows[0];

    const [initiatorRows]: any = await connection.query(
      `
        SELECT id, name, level, pclass, hpoints, map_x, map_y
        FROM players
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [playerId],
    );

    if (!initiatorRows.length) throw new Error("Player not found.");

    const initiator = initiatorRows[0];

    if (Number(initiator.hpoints ?? 0) <= 0) {
      throw new Error("You cannot enter a dungeon while defeated.");
    }

    const entranceX = Number(initiator.map_x);
    const entranceY = Number(initiator.map_y);

    const [entranceRows]: any = await connection.query(
      `
        SELECT d.id
        FROM locations l
        JOIN dungeons d
          ON d.name COLLATE utf8mb4_unicode_ci =
             l.name COLLATE utf8mb4_unicode_ci
        WHERE l.map_x = ?
          AND l.map_y = ?
          AND l.terrain = 'dungeon'
          AND d.id = ?
          AND d.is_active = 1
        LIMIT 1
      `,
      [entranceX, entranceY, dungeonId],
    );

    if (!entranceRows.length) {
      throw new Error("You must stand on this dungeon's entrance tile.");
    }

    if (!party) {
      roster = [{
        playerId,
        name: String(initiator.name),
        level: Number(initiator.level),
        className: initiator.pclass == null ? null : String(initiator.pclass),
        isLeader: true,
      }];
    }

    const minPartySize = Number(dungeon.min_party_size ?? 1);
    const maxPartySize = Number(dungeon.max_party_size ?? 4);
    const minLevel = Number(dungeon.min_level ?? 1);
    const maxLevel = dungeon.max_level == null ? null : Number(dungeon.max_level);

    if (roster.length < minPartySize) {
      throw new Error(`This dungeon requires at least ${minPartySize} players.`);
    }

    if (roster.length > maxPartySize) {
      throw new Error(`This dungeon allows no more than ${maxPartySize} players.`);
    }

    const missing: string[] = [];

    for (const member of roster) {
      const [stateRows]: any = await connection.query(
        `
          SELECT level, hpoints, map_x, map_y
          FROM players
          WHERE id = ?
          LIMIT 1
          FOR UPDATE
        `,
        [member.playerId],
      );

      if (!stateRows.length) throw new Error(`${member.name} could not be loaded.`);

      const state = stateRows[0];
      const level = Number(state.level ?? 1);

      if (level < minLevel) {
        throw new Error(`${member.name} must be level ${minLevel} to enter.`);
      }

      if (maxLevel != null && level > maxLevel) {
        throw new Error(`${member.name} is above this dungeon's maximum level.`);
      }

      if (Number(state.hpoints ?? 0) <= 0) {
        throw new Error(`${member.name} is defeated and cannot enter.`);
      }

      if (
        Number(state.map_x) !== entranceX ||
        Number(state.map_y) !== entranceY
      ) {
        missing.push(member.name);
      }

      await assertNoActiveDungeon(connection, member.playerId, member.name);
    }

    if (missing.length) {
      throw new Error(
        `All party members must reach the dungeon entrance. Waiting for: ${missing.join(", ")}.`,
      );
    }

    let existingSql = `
      SELECT id
      FROM dungeon_ready_checks
      WHERE dungeon_id = ?
        AND status = 'pending'
    `;
    const params: any[] = [dungeonId];

    if (partyId == null) {
      existingSql += ` AND party_id IS NULL AND created_by_player_id = ?`;
      params.push(playerId);
    } else {
      existingSql += ` AND party_id = ?`;
      params.push(partyId);
    }

    existingSql += ` ORDER BY id DESC LIMIT 1 FOR UPDATE`;

    const [existingRows]: any = await connection.query(existingSql, params);

    if (existingRows.length) {
      const existingId = Number(existingRows[0].id);
      await expireIfNeeded(connection, existingId);

      const existing = await loadSnapshot(connection, existingId);

      if (existing.status === "pending") {
        await connection.commit();
        return { readyCheck: existing, dungeon: null };
      }
    }

    const [insert]: any = await connection.query(
      `
        INSERT INTO dungeon_ready_checks (
          dungeon_id,
          party_id,
          created_by_player_id,
          status,
          entrance_map_x,
          entrance_map_y,
          expires_at
        )
        VALUES (?, ?, ?, 'pending', ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
      `,
      [
        dungeonId,
        partyId,
        playerId,
        entranceX,
        entranceY,
        READY_CHECK_SECONDS,
      ],
    );

    const readyCheckId = Number(insert.insertId);
    const solo = roster.length === 1;

    for (const member of roster) {
      const isReady = solo || member.playerId === playerId ? 1 : 0;

      await connection.query(
        `
          INSERT INTO dungeon_ready_check_players (
            ready_check_id,
            player_id,
            player_name,
            player_level,
            player_class,
            was_leader,
            is_ready,
            ready_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN NOW() ELSE NULL END)
        `,
        [
          readyCheckId,
          member.playerId,
          member.name,
          member.level,
          member.className,
          member.isLeader ? 1 : 0,
          isReady,
          isReady,
        ],
      );
    }

    const dungeonResult = await completeIfReady(connection, readyCheckId);
    const readyCheck = await loadSnapshot(connection, readyCheckId);

    await connection.commit();

    return {
      readyCheck,
      dungeon: dungeonResult,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getDungeonReadyCheck(playerId: number) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rows]: any = await connection.query(
      `
        SELECT drc.id
        FROM dungeon_ready_check_players drcp
        JOIN dungeon_ready_checks drc
          ON drc.id = drcp.ready_check_id
        WHERE drcp.player_id = ?
          AND drc.status IN ('pending', 'completed')
        ORDER BY (drc.status = 'pending') DESC, drc.id DESC
        LIMIT 1
        FOR UPDATE
      `,
      [playerId],
    );

    if (!rows.length) {
      await connection.commit();
      return null;
    }

    const readyCheckId = Number(rows[0].id);
    await expireIfNeeded(connection, readyCheckId);

    const snapshot = await loadSnapshot(connection, readyCheckId);

    await connection.commit();
    return snapshot;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function setDungeonReadyState(
  playerId: number,
  ready: boolean,
) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [memberRows]: any = await connection.query(
      `
        SELECT drc.id AS ready_check_id
        FROM dungeon_ready_check_players drcp
        JOIN dungeon_ready_checks drc
          ON drc.id = drcp.ready_check_id
        WHERE drcp.player_id = ?
          AND drc.status = 'pending'
        ORDER BY drc.id DESC
        LIMIT 1
      `,
      [playerId],
    );

    if (!memberRows.length) {
      throw new Error("No pending Dungeon ready check is available.");
    }

    const readyCheckId = Number(memberRows[0].ready_check_id);

    const [checkRows]: any = await connection.query(
      `
        SELECT status, entrance_map_x, entrance_map_y
        FROM dungeon_ready_checks
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [readyCheckId],
    );

    if (!checkRows.length || checkRows[0].status !== "pending") {
      throw new Error("No pending Dungeon ready check is available.");
    }

    await expireIfNeeded(connection, readyCheckId);

    const [statusRows]: any = await connection.query(
      `SELECT status FROM dungeon_ready_checks WHERE id = ? LIMIT 1`,
      [readyCheckId],
    );

    if (statusRows[0]?.status !== "pending") {
      throw new Error("The Dungeon ready check has expired.");
    }

    if (ready) {
      const [positionRows]: any = await connection.query(
        `
          SELECT hpoints, map_x, map_y
          FROM players
          WHERE id = ?
          LIMIT 1
          FOR UPDATE
        `,
        [playerId],
      );

      if (!positionRows.length || Number(positionRows[0].hpoints ?? 0) <= 0) {
        throw new Error("You cannot Ready while defeated.");
      }

      if (
        Number(positionRows[0].map_x) !== Number(checkRows[0].entrance_map_x) ||
        Number(positionRows[0].map_y) !== Number(checkRows[0].entrance_map_y)
      ) {
        throw new Error("You must remain on the dungeon entrance tile to be Ready.");
      }
    }

    const [updated]: any = await connection.query(
      `
        UPDATE dungeon_ready_check_players
        SET
          is_ready = ?,
          ready_at = CASE WHEN ? = 1 THEN NOW() ELSE NULL END
        WHERE ready_check_id = ?
          AND player_id = ?
      `,
      [ready ? 1 : 0, ready ? 1 : 0, readyCheckId, playerId],
    );

    if (Number(updated.affectedRows) !== 1) {
      throw new Error("You are not part of this Dungeon ready check.");
    }

    const dungeon = ready
      ? await completeIfReady(connection, readyCheckId)
      : null;

    const readyCheck = await loadSnapshot(connection, readyCheckId);

    await connection.commit();

    return { readyCheck, dungeon };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function cancelDungeonReadyCheck(playerId: number) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [candidateRows]: any = await connection.query(
      `
        SELECT drc.id AS ready_check_id
        FROM dungeon_ready_check_players drcp
        JOIN dungeon_ready_checks drc
          ON drc.id = drcp.ready_check_id
        WHERE drcp.player_id = ?
          AND drc.status = 'pending'
        ORDER BY drc.id DESC
        LIMIT 1
      `,
      [playerId],
    );

    if (!candidateRows.length) {
      throw new Error("No pending Dungeon ready check is available.");
    }

    const readyCheckId = Number(candidateRows[0].ready_check_id);

    const [checkRows]: any = await connection.query(
      `
        SELECT created_by_player_id, status
        FROM dungeon_ready_checks
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [readyCheckId],
    );

    if (!checkRows.length || checkRows[0].status !== "pending") {
      throw new Error("No pending Dungeon ready check is available.");
    }

    const [leaderRows]: any = await connection.query(
      `
        SELECT player_id
        FROM dungeon_ready_check_players
        WHERE ready_check_id = ?
          AND was_leader = 1
        LIMIT 1
      `,
      [readyCheckId],
    );

    const leaderId = leaderRows.length
      ? Number(leaderRows[0].player_id)
      : Number(checkRows[0].created_by_player_id);

    if (
      Number(checkRows[0].created_by_player_id) !== playerId &&
      leaderId !== playerId
    ) {
      throw new Error("Only the ready-check creator or party leader may cancel it.");
    }

    await connection.query(
      `
        UPDATE dungeon_ready_checks
        SET status = 'cancelled', cancelled_at = NOW()
        WHERE id = ?
          AND status = 'pending'
      `,
      [readyCheckId],
    );

    const readyCheck = await loadSnapshot(connection, readyCheckId);

    await connection.commit();

    return { readyCheck, dungeon: null };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}


export async function deleteResolvedDungeonReadyCheck(
  readyCheckId: number,
) {
  if (
    !Number.isInteger(
      readyCheckId
    ) ||
    readyCheckId <= 0
  ) {
    return;
  }

  /*
   * dungeon_ready_check_players is ON DELETE CASCADE, so deleting
   * the parent removes the frozen roster too.
   *
   * Only resolved rows are eligible. A pending ready check can never
   * be deleted through this helper.
   */
  await db.query(
    `
      DELETE FROM dungeon_ready_checks

      WHERE id = ?
        AND status IN (
          'completed',
          'cancelled',
          'expired'
        )
    `,
    [
      readyCheckId
    ]
  );
}
