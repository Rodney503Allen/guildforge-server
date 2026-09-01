import { db } from "../db";

import {
  createHuntEncounterInTransaction
} from "../huntService";

const READY_CHECK_SECONDS = 30;

type DbConnection = any;

type ReadyPlayer = {
  playerId: number;
  name: string;
  isReady: boolean;
  readyAt: string | null;
};

type ReadyCheckSnapshot = {
  id: number;
  partyHuntId: number;
  partyId: number;
  createdByPlayerId: number;
  status: "pending" | "completed" | "cancelled" | "expired";
  targetMapX: number;
  targetMapY: number;
  expiresAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  players: ReadyPlayer[];
};

function toIso(value: any): string | null {
  if (value == null) return null;

  const date = value instanceof Date
    ? value
    : new Date(value);

  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toISOString();
}

async function expireReadyCheckIfNeeded(
  connection: DbConnection,
  readyCheckId: number
) {
  await connection.query(
    `
      UPDATE hunt_ready_checks

      SET status = 'expired'

      WHERE id = ?
        AND status = 'pending'
        AND expires_at <= NOW()
    `,
    [readyCheckId]
  );
}

async function loadReadyCheckSnapshot(
  connection: DbConnection,
  readyCheckId: number
): Promise<ReadyCheckSnapshot> {
  const [checkRows]: any =
    await connection.query(
      `
        SELECT
          id,
          party_hunt_id,
          party_id,
          created_by_player_id,
          status,
          target_map_x,
          target_map_y,
          expires_at,
          completed_at,
          cancelled_at,
          created_at

        FROM hunt_ready_checks

        WHERE id = ?

        LIMIT 1
      `,
      [readyCheckId]
    );

  if (!checkRows.length) {
    throw new Error("Hunt ready check does not exist.");
  }

  const [playerRows]: any =
    await connection.query(
      `
        SELECT
          hrcp.player_id,
          hrcp.is_ready,
          hrcp.ready_at,
          pl.name

        FROM hunt_ready_check_players hrcp

        JOIN players pl
          ON pl.id = hrcp.player_id

        WHERE hrcp.ready_check_id = ?

        ORDER BY
          hrcp.joined_at ASC,
          hrcp.player_id ASC
      `,
      [readyCheckId]
    );

  const row = checkRows[0];

  return {
    id: Number(row.id),
    partyHuntId: Number(row.party_hunt_id),
    partyId: Number(row.party_id),
    createdByPlayerId: Number(row.created_by_player_id),
    status: row.status,
    targetMapX: Number(row.target_map_x),
    targetMapY: Number(row.target_map_y),
    expiresAt: toIso(row.expires_at)!,
    completedAt: toIso(row.completed_at),
    cancelledAt: toIso(row.cancelled_at),
    createdAt: toIso(row.created_at)!,
    players: playerRows.map((player: any) => ({
      playerId: Number(player.player_id),
      name: String(player.name),
      isReady: Boolean(player.is_ready),
      readyAt: toIso(player.ready_at)
    }))
  };
}

async function completeIfEveryoneReady(
  connection: DbConnection,
  readyCheckId: number,
  partyHuntId: number
) {
  const [playerRows]: any =
    await connection.query(
      `
        SELECT
          hrcp.player_id,
          pl.name,
          hrcp.is_ready

        FROM hunt_ready_check_players hrcp

        JOIN players pl
          ON pl.id = hrcp.player_id

        WHERE hrcp.ready_check_id = ?

        ORDER BY hrcp.player_id ASC

        FOR UPDATE
      `,
      [readyCheckId]
    );

  if (
    !playerRows.length ||
    playerRows.some((row: any) => !Boolean(row.is_ready))
  ) {
    return null;
  }

  const readyPlayers = playerRows.map((row: any) => ({
    playerId: Number(row.player_id),
    name: String(row.name)
  }));

  const encounter =
    await createHuntEncounterInTransaction(
      connection,
      partyHuntId,
      readyPlayers
    );

  const [completeResult]: any =
    await connection.query(
      `
        UPDATE hunt_ready_checks

        SET
          status = 'completed',
          completed_at = NOW()

        WHERE id = ?
          AND status = 'pending'
      `,
      [readyCheckId]
    );

  if (Number(completeResult.affectedRows) !== 1) {
    throw new Error("Hunt ready check could not be completed.");
  }

  return encounter;
}

export async function startHuntReadyCheck(
  playerId: number
) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    /* Lock the Hunt row first. All state-changing ready-check
       operations use this same lock order. */
    const [huntRows]: any =
      await connection.query(
        `
          SELECT
            ph.id AS party_hunt_id,
            ph.party_id,
            ph.status,
            ph.target_revealed,
            ph.target_map_x,
            ph.target_map_y,
            pl.map_x AS player_map_x,
            pl.map_y AS player_map_y

          FROM hunt_participants hp

          JOIN party_hunts ph
            ON ph.id = hp.party_hunt_id

          JOIN players pl
            ON pl.id = hp.player_id

          WHERE hp.player_id = ?
            AND ph.status = 'revealed'

          ORDER BY ph.id DESC

          LIMIT 1

          FOR UPDATE
        `,
        [playerId]
      );

    if (!huntRows.length) {
      throw new Error("No revealed Hunt target is available.");
    }

    const hunt = huntRows[0];
    const partyHuntId = Number(hunt.party_hunt_id);
    const partyId = Number(hunt.party_id);
    const targetMapX = Number(hunt.target_map_x);
    const targetMapY = Number(hunt.target_map_y);

    if (!Boolean(hunt.target_revealed)) {
      throw new Error("The Hunt target has not been revealed.");
    }

    if (!Number.isFinite(targetMapX) || !Number.isFinite(targetMapY)) {
      throw new Error("The Hunt target has no valid location.");
    }

    if (
      Number(hunt.player_map_x) !== targetMapX ||
      Number(hunt.player_map_y) !== targetMapY
    ) {
      throw new Error("You must reach the Hunt target before confronting it.");
    }

    const [existingRows]: any =
      await connection.query(
        `
          SELECT id, expires_at

          FROM hunt_ready_checks

          WHERE party_hunt_id = ?
            AND status = 'pending'

          ORDER BY id DESC

          LIMIT 1

          FOR UPDATE
        `,
        [partyHuntId]
      );

    if (existingRows.length) {
      const existingId = Number(existingRows[0].id);

      await expireReadyCheckIfNeeded(connection, existingId);

      const existing =
        await loadReadyCheckSnapshot(connection, existingId);

      if (existing.status === "pending") {
        await connection.commit();

        return {
          readyCheck: existing,
          encounter: null
        };
      }
    }

/* =========================================
   LOAD COMPLETE FROZEN HUNT ROSTER

   The ready check always represents every
   player who accepted this Hunt.

   We intentionally do NOT filter by location
   here. Location is validated separately so
   missing players cannot silently disappear
   from the ready-check roster.
========================================= */

const [rosterRows]: any =
  await connection.query(
    `
      SELECT
        hp.player_id,
        pl.name,
        pl.map_x,
        pl.map_y

      FROM hunt_participants hp

      JOIN players pl
        ON pl.id = hp.player_id

      WHERE hp.party_hunt_id = ?

      ORDER BY hp.player_id ASC

      FOR UPDATE
    `,
    [
      partyHuntId
    ]
  );


if (!rosterRows.length) {
  throw new Error(
    "This Hunt has no participating players."
  );
}


/* =========================================
   VERIFY INITIATOR IS A PARTICIPANT
========================================= */

if (
  !rosterRows.some(
    (row: any) =>
      Number(row.player_id) ===
      playerId
  )
) {
  throw new Error(
    "You are not eligible for this Hunt ready check."
  );
}


/* =========================================
   REQUIRE COMPLETE PARTY AT TARGET

   Every frozen Hunt participant must be
   standing on the Hunt target tile before
   the ready check can begin.
========================================= */

const missingPlayers =
  rosterRows.filter(
    (row: any) =>
      Number(row.map_x) !==
        targetMapX ||
      Number(row.map_y) !==
        targetMapY
  );


if (missingPlayers.length) {

  const missingNames =
    missingPlayers
      .map(
        (row: any) =>
          String(row.name)
      )
      .join(", ");


  throw new Error(
    `All Hunt participants must reach the target before confronting it. Waiting for: ${missingNames}.`
  );
}

    const [insertResult]: any =
      await connection.query(
        `
          INSERT INTO hunt_ready_checks (
            party_hunt_id,
            party_id,
            created_by_player_id,
            status,
            target_map_x,
            target_map_y,
            expires_at
          )

          VALUES (
            ?,
            ?,
            ?,
            'pending',
            ?,
            ?,
            DATE_ADD(NOW(), INTERVAL ? SECOND)
          )
        `,
        [
          partyHuntId,
          partyId,
          playerId,
          targetMapX,
          targetMapY,
          READY_CHECK_SECONDS
        ]
      );

    const readyCheckId = Number(insertResult.insertId);

    const rosterValues = rosterRows
      .map(() => "(?, ?, ?, CASE WHEN ? = 1 THEN NOW() ELSE NULL END)")
      .join(", ");

    const rosterParameters = rosterRows.flatMap((row: any) => {
      const rosterPlayerId = Number(row.player_id);
      const isReady = rosterPlayerId === playerId ? 1 : 0;

      return [readyCheckId, rosterPlayerId, isReady, isReady];
    });

    await connection.query(
      `
        INSERT INTO hunt_ready_check_players (
          ready_check_id,
          player_id,
          is_ready,
          ready_at
        )

        VALUES ${rosterValues}
      `,
      rosterParameters
    );

    const encounter =
      await completeIfEveryoneReady(
        connection,
        readyCheckId,
        partyHuntId
      );

    const readyCheck =
      await loadReadyCheckSnapshot(connection, readyCheckId);

    await connection.commit();

    return {
      readyCheck,
      encounter
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getHuntReadyCheck(
  playerId: number
) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rows]: any =
      await connection.query(
        `
          SELECT hrc.id

          FROM hunt_ready_check_players hrcp

          JOIN hunt_ready_checks hrc
            ON hrc.id = hrcp.ready_check_id

          WHERE hrcp.player_id = ?
            AND hrc.status IN ('pending', 'completed')

          ORDER BY
            (hrc.status = 'pending') DESC,
            hrc.id DESC

          LIMIT 1

          FOR UPDATE
        `,
        [playerId]
      );

    if (!rows.length) {
      await connection.commit();
      return null;
    }

    const readyCheckId = Number(rows[0].id);

    await expireReadyCheckIfNeeded(connection, readyCheckId);

    const snapshot =
      await loadReadyCheckSnapshot(connection, readyCheckId);

    await connection.commit();

    return snapshot;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function setHuntReadyState(
  playerId: number,
  ready: boolean
) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [membershipRows]: any =
      await connection.query(
        `
          SELECT
            hrc.id AS ready_check_id,
            hrc.party_hunt_id

          FROM hunt_ready_check_players hrcp

          JOIN hunt_ready_checks hrc
            ON hrc.id = hrcp.ready_check_id

          WHERE hrcp.player_id = ?
            AND hrc.status = 'pending'

          ORDER BY hrc.id DESC

          LIMIT 1
        `,
        [playerId]
      );

    if (!membershipRows.length) {
      throw new Error("No pending Hunt ready check is available.");
    }

    const readyCheckId = Number(membershipRows[0].ready_check_id);
    const partyHuntId = Number(membershipRows[0].party_hunt_id);

    const [huntRows]: any =
      await connection.query(
        `
          SELECT id, status

          FROM party_hunts

          WHERE id = ?

          LIMIT 1

          FOR UPDATE
        `,
        [partyHuntId]
      );

    if (!huntRows.length || huntRows[0].status !== "revealed") {
      throw new Error("This Hunt can no longer accept ready responses.");
    }

    const [checkRows]: any =
      await connection.query(
        `
          SELECT
            id,
            status,
            target_map_x,
            target_map_y,
            expires_at

          FROM hunt_ready_checks

          WHERE id = ?

          LIMIT 1

          FOR UPDATE
        `,
        [readyCheckId]
      );

    if (!checkRows.length || checkRows[0].status !== "pending") {
      throw new Error("No pending Hunt ready check is available.");
    }

    await expireReadyCheckIfNeeded(connection, readyCheckId);

    const [statusRows]: any =
      await connection.query(
        "SELECT status FROM hunt_ready_checks WHERE id = ? LIMIT 1",
        [readyCheckId]
      );

    if (statusRows[0]?.status !== "pending") {
      throw new Error("The Hunt ready check has expired.");
    }

    if (ready) {
      const [positionRows]: any =
        await connection.query(
          `
            SELECT map_x, map_y

            FROM players

            WHERE id = ?

            LIMIT 1

            FOR UPDATE
          `,
          [playerId]
        );

      if (
        !positionRows.length ||
        Number(positionRows[0].map_x) !== Number(checkRows[0].target_map_x) ||
        Number(positionRows[0].map_y) !== Number(checkRows[0].target_map_y)
      ) {
        throw new Error("You must remain on the Hunt target tile to be Ready.");
      }
    }

    const [updateResult]: any =
      await connection.query(
        `
          UPDATE hunt_ready_check_players

          SET
            is_ready = ?,
            ready_at = CASE
              WHEN ? = 1 THEN NOW()
              ELSE NULL
            END

          WHERE ready_check_id = ?
            AND player_id = ?
        `,
        [ready ? 1 : 0, ready ? 1 : 0, readyCheckId, playerId]
      );

    if (Number(updateResult.affectedRows) !== 1) {
      throw new Error("You are not part of this Hunt ready check.");
    }

    const encounter = ready
      ? await completeIfEveryoneReady(
          connection,
          readyCheckId,
          partyHuntId
        )
      : null;

    const readyCheck =
      await loadReadyCheckSnapshot(connection, readyCheckId);

    await connection.commit();

    return {
      readyCheck,
      encounter
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function cancelHuntReadyCheck(
  playerId: number
) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [candidateRows]: any =
      await connection.query(
        `
          SELECT
            hrc.id AS ready_check_id,
            hrc.party_hunt_id

          FROM hunt_ready_check_players hrcp

          JOIN hunt_ready_checks hrc
            ON hrc.id = hrcp.ready_check_id

          WHERE hrcp.player_id = ?
            AND hrc.status = 'pending'

          ORDER BY hrc.id DESC

          LIMIT 1
        `,
        [playerId]
      );

    if (!candidateRows.length) {
      throw new Error("No pending Hunt ready check is available.");
    }

    const readyCheckId = Number(candidateRows[0].ready_check_id);
    const partyHuntId = Number(candidateRows[0].party_hunt_id);

    await connection.query(
      `
        SELECT id

        FROM party_hunts

        WHERE id = ?

        LIMIT 1

        FOR UPDATE
      `,
      [partyHuntId]
    );

    const [checkRows]: any =
      await connection.query(
        `
          SELECT
            hrc.id,
            hrc.created_by_player_id,
            hrc.status,
            p.leader_player_id

          FROM hunt_ready_checks hrc

          JOIN parties p
            ON p.id = hrc.party_id

          WHERE hrc.id = ?

          LIMIT 1

          FOR UPDATE
        `,
        [readyCheckId]
      );

    if (!checkRows.length || checkRows[0].status !== "pending") {
      throw new Error("No pending Hunt ready check is available.");
    }

    const mayCancel =
      Number(checkRows[0].created_by_player_id) === playerId ||
      Number(checkRows[0].leader_player_id) === playerId;

    if (!mayCancel) {
      throw new Error("Only the ready-check creator or party leader may cancel it.");
    }

    const [cancelResult]: any =
      await connection.query(
        `
          UPDATE hunt_ready_checks

          SET
            status = 'cancelled',
            cancelled_at = NOW()

          WHERE id = ?
            AND status = 'pending'
        `,
        [readyCheckId]
      );

    if (Number(cancelResult.affectedRows) !== 1) {
      throw new Error("Hunt ready check could not be cancelled.");
    }

    const readyCheck =
      await loadReadyCheckSnapshot(connection, readyCheckId);

    await connection.commit();

    return {
      readyCheck,
      encounter: null
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
