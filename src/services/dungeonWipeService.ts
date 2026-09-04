// src/services/dungeonWipeService.ts
//
// Dungeon wipe / room retry lifecycle.
//
// A wipe:
//   - keeps the dungeon instance active
//   - preserves previously completed rooms
//   - deletes only the CURRENT room's combat-enemy runtime
//   - resets the current room to Wave 1
//   - places the party into recovery/rest
//   - restores active members to 25% HP/SP so they are alive
//   - requires the leader to explicitly retry the room
//
// Retry:
//   rest -> trash / Wave 1
//
// This is intentionally forgiving for Alpha testing.

import { db } from "../db";

import {
  getActiveDungeonForPlayer,
} from "./dungeonService";

const WIPE_RECOVERY_PERCENT =
  0.25;

/* =========================================================
   HANDLE PARTY WIPE
========================================================= */

export async function handleDungeonPartyWipe(
  instanceId: number,
) {
  const connection =
    await db.getConnection();

  try {
    await connection.beginTransaction();

    const [[instance]]: any =
      await connection.query(
        `
          SELECT
            id,
            current_room_id,
            current_room_order,
            current_wave,
            current_phase,
            status

          FROM dungeon_instances

          WHERE id = ?

          FOR UPDATE
        `,
        [instanceId],
      );

    if (!instance) {
      throw new Error(
        "Dungeon instance not found.",
      );
    }

    if (
      String(instance.status) !==
      "active"
    ) {
      await connection.commit();

      return {
        ok: true,
        ignored: true,
        reason:
          "inactive_instance",
      };
    }

    /*
     * Idempotency:
     * if this wipe has already transitioned the room into
     * recovery, don't create another wipe row.
     */
    const [[existingWipe]]: any =
      await connection.query(
        `
          SELECT
            id,
            room_id,
            room_order,
            phase_at_wipe,
            wave_at_wipe,
            created_at

          FROM dungeon_instance_wipes

          WHERE instance_id = ?
            AND status = 'awaiting_retry'

          ORDER BY
            id DESC

          LIMIT 1

          FOR UPDATE
        `,
        [instanceId],
      );

    if (existingWipe) {
      await connection.commit();

      return {
        ok: true,
        alreadyReset:
          true,
        wipeId:
          Number(
            existingWipe.id
          ),
      };
    }

    const phase =
      String(
        instance.current_phase
      );

    if (
      phase !== "trash" &&
      phase !== "boss"
    ) {
      await connection.commit();

      return {
        ok: true,
        ignored: true,
        reason:
          `phase_${phase}`,
      };
    }

    const roomId =
      Number(
        instance.current_room_id
      );

    const roomOrder =
      Number(
        instance.current_room_order
      );

    const wave =
      Math.max(
        1,
        Number(
          instance.current_wave ??
          1
        ),
      );

    const [wipeInsert]: any =
      await connection.query(
        `
          INSERT INTO dungeon_instance_wipes (
            instance_id,
            room_id,
            room_order,
            phase_at_wipe,
            wave_at_wipe,
            status
          )
          VALUES (
            ?, ?, ?, ?, ?, 'awaiting_retry'
          )
        `,
        [
          instanceId,
          roomId,
          roomOrder,
          phase,
          wave,
        ],
      );

    /*
     * Reset ALL combat-runtime enemies for the current room.
     *
     * This intentionally removes defeated Wave 1/2/3 rows too,
     * because a retry starts the room over from Wave 1.
     */
    await connection.query(
      `
        DELETE FROM dungeon_instance_enemies

        WHERE instance_id = ?
          AND room_id = ?
      `,
      [
        instanceId,
        roomId,
      ],
    );

    /*
     * Put the dungeon into its recovery state.
     */
    await connection.query(
      `
        UPDATE dungeon_instances

        SET
          current_wave = 1,
          current_phase = 'rest'

        WHERE id = ?
      `,
      [instanceId],
    );

    await connection.query(
      `
        UPDATE dungeon_instance_rooms

        SET
          status = 'active',
          current_wave = 1,
          phase = 'rest'

        WHERE instance_id = ?
          AND room_id = ?
      `,
      [
        instanceId,
        roomId,
      ],
    );

    /*
     * A wiped player is at 0 HP and cannot meaningfully prepare.
     * Restore active dungeon members to 25% HP/SP.
     *
     * This is NOT a full heal. The rest/prep phase still matters.
     */
    await connection.query(
      `
        UPDATE players p

        JOIN dungeon_instance_members dim
          ON dim.player_id = p.id
         AND dim.instance_id = ?
         AND dim.is_active = 1

        SET
          p.hpoints =
            GREATEST(
              1,
              CEIL(
                GREATEST(
                  1,
                  p.maxhp
                ) * ?
              )
            ),

          p.spoints =
            GREATEST(
              0,
              CEIL(
                GREATEST(
                  0,
                  p.maxspoints
                ) * ?
              )
            )
      `,
      [
        instanceId,
        WIPE_RECOVERY_PERCENT,
        WIPE_RECOVERY_PERCENT,
      ],
    );

    await connection.commit();

    return {
      ok: true,

      wipeId:
        Number(
          wipeInsert.insertId
        ),

      instanceId,

      roomId,
      roomOrder,

      failedPhase:
        phase,

      failedWave:
        wave,

      phase:
        "rest" as const,

      recoveryPercent:
        WIPE_RECOVERY_PERCENT,
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

/* =========================================================
   LOAD CURRENT WIPE STATE
========================================================= */

export async function getDungeonWipeStateForPlayer(
  playerId: number,
) {
  const active =
    await getActiveDungeonForPlayer(
      playerId
    );

  if (!active) {
    return null;
  }

  const [rows]: any =
    await db.query(
      `
        SELECT
          diw.id,
          diw.instance_id,
          diw.room_id,
          diw.room_order,
          diw.phase_at_wipe,
          diw.wave_at_wipe,
          diw.status,
          diw.created_at,

          dr.name AS room_name

        FROM dungeon_instance_wipes diw

        JOIN dungeon_rooms dr
          ON dr.id = diw.room_id

        WHERE diw.instance_id = ?
          AND diw.status = 'awaiting_retry'

        ORDER BY
          diw.id DESC

        LIMIT 1
      `,
      [
        active.instanceId
      ],
    );

  if (!rows?.length) {
    return null;
  }

  const row =
    rows[0];

  return {
    id:
      Number(row.id),

    instanceId:
      Number(
        row.instance_id
      ),

    roomId:
      Number(
        row.room_id
      ),

    roomOrder:
      Number(
        row.room_order
      ),

    roomName:
      String(
        row.room_name ??
        `Room ${row.room_order}`
      ),

    failedPhase:
      String(
        row.phase_at_wipe
      ),

    failedWave:
      Number(
        row.wave_at_wipe
      ),

    status:
      String(
        row.status
      ),

    createdAt:
      row.created_at,

    canRetry:
      Number(
        active.leaderPlayerId
      ) ===
      Number(playerId),
  };
}

/* =========================================================
   RETRY CURRENT ROOM
========================================================= */

export async function retryDungeonRoomForPlayer(
  playerId: number,
) {
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
    Number(
      active.leaderPlayerId
    ) !==
    Number(playerId)
  ) {
    throw new Error(
      "Only the dungeon leader can retry the room.",
    );
  }

  const connection =
    await db.getConnection();

  try {
    await connection.beginTransaction();

    const [[instance]]: any =
      await connection.query(
        `
          SELECT
            id,
            current_room_id,
            current_room_order,
            current_phase,
            status

          FROM dungeon_instances

          WHERE id = ?

          FOR UPDATE
        `,
        [
          active.instanceId
        ],
      );

    if (
      !instance ||
      String(instance.status) !==
        "active"
    ) {
      throw new Error(
        "This dungeon run is no longer active.",
      );
    }

    if (
      String(
        instance.current_phase
      ) !== "rest"
    ) {
      throw new Error(
        "The party is not currently recovering from a room wipe.",
      );
    }

    const [[wipe]]: any =
      await connection.query(
        `
          SELECT
            id,
            room_id,
            room_order

          FROM dungeon_instance_wipes

          WHERE instance_id = ?
            AND status = 'awaiting_retry'

          ORDER BY
            id DESC

          LIMIT 1

          FOR UPDATE
        `,
        [
          active.instanceId
        ],
      );

    if (!wipe) {
      throw new Error(
        "There is no wiped room waiting to be retried.",
      );
    }

    if (
      Number(
        wipe.room_id
      ) !==
      Number(
        instance.current_room_id
      )
    ) {
      throw new Error(
        "The pending dungeon wipe does not match the current room.",
      );
    }

    /*
     * Safety cleanup in case a stale runtime row appeared while
     * the party was in the recovery state.
     */
    await connection.query(
      `
        DELETE FROM dungeon_instance_enemies

        WHERE instance_id = ?
          AND room_id = ?
      `,
      [
        active.instanceId,
        Number(
          wipe.room_id
        ),
      ],
    );

    await connection.query(
      `
        UPDATE dungeon_instances

        SET
          current_wave = 1,
          current_phase = 'trash'

        WHERE id = ?
      `,
      [
        active.instanceId
      ],
    );

    await connection.query(
      `
        UPDATE dungeon_instance_rooms

        SET
          status = 'active',
          current_wave = 1,
          phase = 'trash'

        WHERE instance_id = ?
          AND room_id = ?
      `,
      [
        active.instanceId,
        Number(
          wipe.room_id
        ),
      ],
    );

    await connection.query(
      `
        UPDATE dungeon_instance_wipes

        SET
          status = 'retried',
          retried_at = NOW()

        WHERE id = ?
      `,
      [
        Number(
          wipe.id
        ),
      ],
    );

    await connection.commit();

    return {
      ok: true,

      transition:
        "retry_room" as const,

      instanceId:
        active.instanceId,

      roomId:
        Number(
          wipe.room_id
        ),

      roomOrder:
        Number(
          wipe.room_order
        ),

      currentWave:
        1,

      phase:
        "trash" as const,
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
