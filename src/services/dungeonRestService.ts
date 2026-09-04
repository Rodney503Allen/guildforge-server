// src/services/dungeonRestService.ts
//
// Guildforge Dungeon Intermission Recovery
//
// Between completed rooms:
//   - 30 second intermission
//   - 25% max HP + 25% max SP every 5 seconds
//   - 6 recovery ticks total
//   - server-authoritative / catch-up safe
//
// The database row is created lazily the first time the rest phase is
// observed. Ticks are calculated from timestamps, so refreshing the page
// or briefly disconnecting never loses recovery.

import { db } from "../db";
import {
  getFinalPlayerStats,
} from "./playerService";

const REST_DURATION_MS =
  30_000;

const REST_TICK_MS =
  5_000;

const REST_RESTORE_PERCENT =
  0.25;

type DungeonRestMember = {
  playerId: number;
  name: string;
  hp: number;
  maxHp: number;
  sp: number;
  maxSp: number;
};

export type DungeonRestSnapshot = {
  instanceId: number;
  roomId: number;
  roomOrder: number;

  startedAt: number;
  endsAt: number;

  durationMs: number;
  remainingMs: number;

  tickMs: number;
  restorePercent: number;

  ticksApplied: number;
  totalTicks: number;
  nextTickInMs: number;

  complete: boolean;

  players: DungeonRestMember[];
};

async function getActiveRestContext(
  playerId: number,
) {
  const [[row]]: any =
    await db.query(
      `
        SELECT
          di.id AS instance_id,
          di.current_room_id,
          di.current_room_order,
          di.current_phase,
          di.status,
          dim.was_leader

        FROM dungeon_instance_members dim

        JOIN dungeon_instances di
          ON di.id = dim.instance_id

        WHERE dim.player_id = ?
          AND dim.is_active = 1
          AND di.status = 'active'

        ORDER BY di.id DESC

        LIMIT 1
      `,
      [
        playerId
      ]
    );

  if (!row) {
    throw new Error(
      "You are not inside an active dungeon."
    );
  }

  if (
    String(
      row.current_phase
    ) !== "rest"
  ) {
    throw new Error(
      "The dungeon is not currently resting."
    );
  }

  return {
    instanceId:
      Number(
        row.instance_id
      ),

    roomId:
      Number(
        row.current_room_id
      ),

    roomOrder:
      Number(
        row.current_room_order
      ),

    isLeader:
      Number(
        row.was_leader
      ) === 1,
  };
}

async function ensureDungeonRestState(
  instanceId: number,
  roomId: number,
) {
  await db.query(
    `
      INSERT INTO dungeon_instance_rest (
        instance_id,
        room_id,
        started_at,
        last_tick_at
      )

      VALUES (
        ?,
        ?,
        NOW(3),
        NOW(3)
      )

      ON DUPLICATE KEY UPDATE
        instance_id =
          VALUES(instance_id)
    `,
    [
      instanceId,
      roomId
    ]
  );
}

async function applyDungeonRestTicks(
  instanceId: number,
  roomId: number,
) {
  const connection =
    await db.getConnection();

  try {
    await connection.beginTransaction();

    const [[rest]]: any =
      await connection.query(
        `
          SELECT
            id,
            started_at,
            last_tick_at

          FROM dungeon_instance_rest

          WHERE instance_id = ?
            AND room_id = ?

          LIMIT 1

          FOR UPDATE
        `,
        [
          instanceId,
          roomId
        ]
      );

    if (!rest) {
      throw new Error(
        "Dungeon rest state was not found."
      );
    }

    const now =
      Date.now();

    const startedAt =
      new Date(
        rest.started_at
      ).getTime();

    const lastTickAt =
      new Date(
        rest.last_tick_at
      ).getTime();

    const endsAt =
      startedAt +
      REST_DURATION_MS;

    /*
     * Never create recovery ticks after the 30-second intermission.
     */
    const effectiveNow =
      Math.min(
        now,
        endsAt
      );

    const dueTicks =
      Math.floor(
        Math.max(
          0,
          effectiveNow -
          lastTickAt
        ) /
        REST_TICK_MS
      );

    if (
      dueTicks > 0
    ) {
      const [memberRows]: any =
        await connection.query(
          `
            SELECT
              dim.player_id,
              dim.player_name,
              p.hpoints,
              p.spoints

            FROM dungeon_instance_members dim

            JOIN players p
              ON p.id = dim.player_id

            WHERE dim.instance_id = ?
              AND dim.is_active = 1

            ORDER BY
              dim.was_leader DESC,
              dim.id ASC

            FOR UPDATE
          `,
          [
            instanceId
          ]
        );

      for (
        const member of
        memberRows ??
        []
      ) {
        const memberPlayerId =
          Number(
            member.player_id
          );

        /*
         * Use Guildforge's final-stat engine so rest respects equipment,
         * buffs, talents, etc. rather than relying on stale base columns.
         */
        const stats =
          await getFinalPlayerStats(
            memberPlayerId
          );

        if (!stats) {
          throw new Error(
            `Could not load final stats for dungeon rest player ${memberPlayerId}.`
          );
        }

        const maxHp =
          Math.max(
            1,
            Number(
              stats.maxhp
            ) || 1
          );

        const maxSp =
          Math.max(
            0,
            Number(
              stats.maxspoints
            ) || 0
          );

        const hpPerTick =
          Math.max(
            1,
            Math.floor(
              maxHp *
              REST_RESTORE_PERCENT
            )
          );

        const spPerTick =
          maxSp > 0
            ? Math.max(
                1,
                Math.floor(
                  maxSp *
                  REST_RESTORE_PERCENT
                )
              )
            : 0;

        const hpGain =
          hpPerTick *
          dueTicks;

        const spGain =
          spPerTick *
          dueTicks;

        /*
         * Do not resurrect defeated players through the normal room
         * intermission. Wipe/retry remains responsible for defeat flow.
         */
        await connection.query(
          `
            UPDATE players

            SET
              hpoints =
                CASE
                  WHEN hpoints > 0
                  THEN LEAST(
                    hpoints + ?,
                    ?
                  )
                  ELSE hpoints
                END,

              spoints =
                LEAST(
                  spoints + ?,
                  ?
                )

            WHERE id = ?
          `,
          [
            hpGain,
            maxHp,
            spGain,
            maxSp,
            memberPlayerId,
          ]
        );
      }

      const newLastTickAt =
        Math.min(
          endsAt,
          lastTickAt +
          (
            dueTicks *
            REST_TICK_MS
          )
        );

      await connection.query(
        `
          UPDATE dungeon_instance_rest

          SET last_tick_at =
            FROM_UNIXTIME(
              ? / 1000
            )

          WHERE id = ?
        `,
        [
          newLastTickAt,
          Number(
            rest.id
          ),
        ]
      );
    }

    await connection.commit();
  } catch (
    error
  ) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function buildDungeonRestSnapshot(
  instanceId: number,
  roomId: number,
  roomOrder: number,
): Promise<DungeonRestSnapshot> {
  const [[rest]]: any =
    await db.query(
      `
        SELECT
          started_at,
          last_tick_at

        FROM dungeon_instance_rest

        WHERE instance_id = ?
          AND room_id = ?

        LIMIT 1
      `,
      [
        instanceId,
        roomId
      ]
    );

  if (!rest) {
    throw new Error(
      "Dungeon rest state was not found."
    );
  }

  const startedAt =
    new Date(
      rest.started_at
    ).getTime();

  const lastTickAt =
    new Date(
      rest.last_tick_at
    ).getTime();

  const now =
    Date.now();

  const endsAt =
    startedAt +
    REST_DURATION_MS;

  const remainingMs =
    Math.max(
      0,
      endsAt -
      now
    );

  const totalTicks =
    Math.floor(
      REST_DURATION_MS /
      REST_TICK_MS
    );

  const ticksApplied =
    Math.max(
      0,
      Math.min(
        totalTicks,
        Math.floor(
          Math.max(
            0,
            Math.min(
              now,
              endsAt
            ) -
            startedAt
          ) /
          REST_TICK_MS
        )
      )
    );

  let nextTickInMs =
    0;

  if (
    remainingMs > 0 &&
    ticksApplied <
    totalTicks
  ) {
    const nextTickAt =
      Math.min(
        endsAt,
        lastTickAt +
        REST_TICK_MS
      );

    nextTickInMs =
      Math.max(
        0,
        nextTickAt -
        now
      );
  }

  const [memberRows]: any =
    await db.query(
      `
        SELECT
          dim.player_id,
          dim.player_name,
          p.hpoints,
          p.spoints

        FROM dungeon_instance_members dim

        JOIN players p
          ON p.id = dim.player_id

        WHERE dim.instance_id = ?
          AND dim.is_active = 1

        ORDER BY
          dim.was_leader DESC,
          dim.id ASC
      `,
      [
        instanceId
      ]
    );

  const players:
    DungeonRestMember[] =
    [];

  for (
    const member of
    memberRows ??
    []
  ) {
    const playerId =
      Number(
        member.player_id
      );

    const stats =
      await getFinalPlayerStats(
        playerId
      );

    if (!stats) {
      throw new Error(
        `Could not load final stats for dungeon rest player ${playerId}.`
      );
    }

    players.push({
      playerId,

      name:
        String(
          member.player_name
        ),

      hp:
        Math.max(
          0,
          Number(
            member.hpoints
          ) || 0
        ),

      maxHp:
        Math.max(
          1,
          Number(
            stats.maxhp
          ) || 1
        ),

      sp:
        Math.max(
          0,
          Number(
            member.spoints
          ) || 0
        ),

      maxSp:
        Math.max(
          0,
          Number(
            stats.maxspoints
          ) || 0
        ),
    });
  }

  return {
    instanceId,
    roomId,
    roomOrder,

    startedAt,
    endsAt,

    durationMs:
      REST_DURATION_MS,

    remainingMs,

    tickMs:
      REST_TICK_MS,

    restorePercent:
      REST_RESTORE_PERCENT,

    ticksApplied,
    totalTicks,

    nextTickInMs,

    complete:
      remainingMs <= 0,

    players,
  };
}

export async function getDungeonRestStateForPlayer(
  playerId: number,
) {
  const context =
    await getActiveRestContext(
      playerId
    );

  await ensureDungeonRestState(
    context.instanceId,
    context.roomId,
  );

  await applyDungeonRestTicks(
    context.instanceId,
    context.roomId,
  );

  return {
    ...await buildDungeonRestSnapshot(
      context.instanceId,
      context.roomId,
      context.roomOrder,
    ),

    isLeader:
      context.isLeader,
  };
}

export async function assertDungeonRestCompleteForPlayer(
  playerId: number,
) {
  const state =
    await getDungeonRestStateForPlayer(
      playerId
    );

  if (
    !state.isLeader
  ) {
    throw new Error(
      "Only the dungeon leader can continue the expedition."
    );
  }

  if (
    !state.complete
  ) {
    const seconds =
      Math.max(
        1,
        Math.ceil(
          state.remainingMs /
          1000
        )
      );

    throw new Error(
      `The party must rest for ${seconds} more second${seconds === 1 ? "" : "s"}.`
    );
  }

  return state;
}

export async function clearDungeonRestState(
  instanceId: number,
  roomId: number,
) {
  await db.query(
    `
      DELETE FROM dungeon_instance_rest

      WHERE instance_id = ?
        AND room_id = ?
    `,
    [
      instanceId,
      roomId
    ]
  );
}
