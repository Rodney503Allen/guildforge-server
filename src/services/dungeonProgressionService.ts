// src/services/dungeonProgressionService.ts
//
// Guildforge Dungeon Framework - Phase 2A
// Authoritative room/wave progression.
//
// This does NOT start combat yet.
// It establishes the state transitions that combat will call when a wave dies.

import { db } from "../db";
import {
  getActiveDungeonForPlayer,
} from "./dungeonService";
import {
  createDungeonBossLootRollsWithConn,
} from "./dungeonLootService";
import {
  createDungeonCompletionChestsWithConn,
} from "./dungeonCompletionChestService";

export type DungeonEncounterState = {
  instanceId: number;
  dungeonId: number;
  roomId: number;
  roomOrder: number;
  roomName: string | null;

  phase:
    | "trash"
    | "boss"
    | "loot"
    | "rest"
    | "complete";

  wave: number;

  bossCreatureId: number | null;

  waveDefinition: null | {
    id: number;
    waveNumber: number;
    name: string | null;
    creatures: Array<{
      assignmentId: number;
      creatureId: number;
      quantity: number;
      displayOrder: number;
    }>;
  };
};

async function loadInstanceEncounterState(
  instanceId: number,
): Promise<DungeonEncounterState | null> {
  const [rows]: any = await db.query(
    `
      SELECT
        di.id AS instance_id,
        di.dungeon_id,
        di.current_room_id,
        di.current_room_order,
        di.current_wave,
        di.current_phase,

        dr.name AS room_name,
        dr.boss_creature_id

      FROM dungeon_instances di

      LEFT JOIN dungeon_rooms dr
        ON dr.id = di.current_room_id

      WHERE di.id = ?
        AND di.status = 'active'

      LIMIT 1
    `,
    [instanceId],
  );

  if (!rows?.length) {
    return null;
  }

  const row = rows[0];

  const phase = String(row.current_phase) as DungeonEncounterState["phase"];
  const roomId = Number(row.current_room_id);
  const wave = Number(row.current_wave ?? 1);

  let waveDefinition: DungeonEncounterState["waveDefinition"] = null;

  if (phase === "trash") {
    const [waveRows]: any = await db.query(
      `
        SELECT
          id,
          wave_number,
          name

        FROM dungeon_room_waves

        WHERE room_id = ?
          AND wave_number = ?

        LIMIT 1
      `,
      [roomId, wave],
    );

    if (waveRows?.length) {
      const waveRow = waveRows[0];

      const [creatureRows]: any = await db.query(
        `
          SELECT
            id,
            creature_id,
            quantity,
            display_order

          FROM dungeon_wave_creatures

          WHERE wave_id = ?

          ORDER BY
            display_order ASC,
            id ASC
        `,
        [waveRow.id],
      );

      waveDefinition = {
        id: Number(waveRow.id),
        waveNumber: Number(waveRow.wave_number),
        name:
          waveRow.name == null
            ? null
            : String(waveRow.name),

        creatures: (creatureRows ?? []).map((creature: any) => ({
          assignmentId: Number(creature.id),
          creatureId: Number(creature.creature_id),
          quantity: Number(creature.quantity ?? 1),
          displayOrder: Number(creature.display_order ?? 1),
        })),
      };
    }
  }

  return {
    instanceId: Number(row.instance_id),
    dungeonId: Number(row.dungeon_id),
    roomId,
    roomOrder: Number(row.current_room_order ?? 1),
    roomName:
      row.room_name == null
        ? null
        : String(row.room_name),

    phase,
    wave,

    bossCreatureId:
      row.boss_creature_id == null
        ? null
        : Number(row.boss_creature_id),

    waveDefinition,
  };
}

/* =========================================================
   GET CURRENT DUNGEON ENCOUNTER
========================================================= */

export async function getCurrentDungeonEncounterForPlayer(
  playerId: number,
): Promise<DungeonEncounterState | null> {
  const active =
    await getActiveDungeonForPlayer(playerId);

  if (!active) {
    return null;
  }

  return loadInstanceEncounterState(
    active.instanceId,
  );
}

/* =========================================================
   COMPLETE CURRENT TRASH WAVE
========================================================= */

/**
 * Called after the current trash wave has been fully defeated.
 *
 * Wave 1 -> Wave 2
 * Wave 2 -> Wave 3
 * Wave 3 -> Boss phase
 *
 * This function is intentionally server authoritative.
 * Clients should never directly decide the next wave number.
 */
export async function completeCurrentDungeonWave(
  instanceId: number,
) {
  const connection =
    await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rows]: any =
      await connection.query(
        `
          SELECT
            id,
            dungeon_id,
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

    if (!rows?.length) {
      throw new Error(
        "Dungeon instance not found.",
      );
    }

    const instance = rows[0];

    if (instance.status !== "active") {
      throw new Error(
        "This dungeon run is no longer active.",
      );
    }

    if (instance.current_phase !== "trash") {
      throw new Error(
        "The dungeon is not currently in a trash-wave phase.",
      );
    }

    const roomId =
      Number(instance.current_room_id);

    const currentWave =
      Number(instance.current_wave ?? 1);

    if (
      !Number.isInteger(currentWave) ||
      currentWave < 1 ||
      currentWave > 3
    ) {
      throw new Error(
        "Dungeon wave state is invalid.",
      );
    }

    /*
     * Verify the current wave actually exists in the dungeon definition.
     */
    const [currentWaveRows]: any =
      await connection.query(
        `
          SELECT id
          FROM dungeon_room_waves
          WHERE room_id = ?
            AND wave_number = ?
          LIMIT 1
        `,
        [roomId, currentWave],
      );

    if (!currentWaveRows?.length) {
      throw new Error(
        `Room ${instance.current_room_order} does not have Wave ${currentWave} configured.`,
      );
    }

    if (currentWave < 3) {
      const nextWave =
        currentWave + 1;

      /*
       * Verify the next wave exists before advancing.
       */
      const [nextWaveRows]: any =
        await connection.query(
          `
            SELECT id
            FROM dungeon_room_waves
            WHERE room_id = ?
              AND wave_number = ?
            LIMIT 1
          `,
          [roomId, nextWave],
        );

      if (!nextWaveRows?.length) {
        throw new Error(
          `Room ${instance.current_room_order} does not have Wave ${nextWave} configured.`,
        );
      }

      await connection.query(
        `
          UPDATE dungeon_instances

          SET
            current_wave = ?,
            current_phase = 'trash'

          WHERE id = ?
        `,
        [
          nextWave,
          instanceId,
        ],
      );

      await connection.query(
        `
          UPDATE dungeon_instance_rooms

          SET
            current_wave = ?,
            phase = 'trash'

          WHERE instance_id = ?
            AND room_id = ?
            AND status = 'active'
        `,
        [
          nextWave,
          instanceId,
          roomId,
        ],
      );

      await connection.commit();

      return {
        ok: true,
        transition: "next_wave" as const,
        roomOrder:
          Number(instance.current_room_order),
        completedWave:
          currentWave,
        currentWave:
          nextWave,
        phase: "trash" as const,
      };
    }

    /*
     * Wave 3 was completed.
     * The room now moves into its boss phase.
     */
    await connection.query(
      `
        UPDATE dungeon_instances

        SET
          current_phase = 'boss'

        WHERE id = ?
      `,
      [instanceId],
    );

    await connection.query(
      `
        UPDATE dungeon_instance_rooms

        SET
          phase = 'boss'

        WHERE instance_id = ?
          AND room_id = ?
          AND status = 'active'
      `,
      [
        instanceId,
        roomId,
      ],
    );

    await connection.commit();

    return {
      ok: true,
      transition: "boss" as const,
      roomOrder:
        Number(instance.current_room_order),
      completedWave: 3,
      currentWave: 3,
      phase: "boss" as const,
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
   COMPLETE CURRENT BOSS
   Boss -> Loot
========================================================= */

/**
 * Called by dungeon combat after the room boss is defeated.
 *
 * This does NOT skip the intermission. The room enters the
 * authoritative loot phase first.
 */
export async function completeCurrentDungeonBoss(
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
            di.id,
            di.current_room_id,
            di.current_room_order,
            di.current_phase,
            di.status,
            dr.boss_creature_id

          FROM dungeon_instances di

          JOIN dungeon_rooms dr
            ON dr.id = di.current_room_id

          WHERE di.id = ?

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
      throw new Error(
        "This dungeon run is no longer active.",
      );
    }

    if (
      String(instance.current_phase) ===
        "loot" ||
      String(instance.current_phase) ===
        "rest"
    ) {
      await connection.commit();

      return {
        ok: true,
        transition:
          String(
            instance.current_phase
          ) as "loot" | "rest",
        alreadyCompleted:
          true,
        roomOrder:
          Number(
            instance.current_room_order
          ),
        phase:
          String(
            instance.current_phase
          ) as "loot" | "rest",
      };
    }

    if (
      String(instance.current_phase) !==
      "boss"
    ) {
      throw new Error(
        "The dungeon is not currently in a boss phase.",
      );
    }

    const roomId =
      Number(
        instance.current_room_id
      );

    const bossCreatureId =
      Number(
        instance.boss_creature_id
      );

    if (!bossCreatureId) {
      throw new Error(
        "This dungeon room has no boss configured.",
      );
    }

    const loot =
      await createDungeonBossLootRollsWithConn(
        connection,
        {
          instanceId,
          roomId,
          bossCreatureId,
        },
      );

    /*
     * If this boss has no configured/dropped loot,
     * there is nothing for the party to resolve.
     * Move directly into the rest phase.
     */
    const nextPhase =
      loot.created > 0
        ? "loot"
        : "rest";

    await connection.query(
      `
        UPDATE dungeon_instances

        SET
          current_phase = ?

        WHERE id = ?
      `,
      [
        nextPhase,
        instanceId,
      ],
    );

    await connection.query(
      `
        UPDATE dungeon_instance_rooms

        SET
          phase = ?

        WHERE instance_id = ?
          AND room_id = ?
          AND status = 'active'
      `,
      [
        nextPhase,
        instanceId,
        roomId,
      ],
    );

    await connection.commit();

    return {
      ok: true,
      transition:
        nextPhase as
          | "loot"
          | "rest",
      alreadyCompleted:
        false,
      roomOrder:
        Number(
          instance.current_room_order
        ),
      phase:
        nextPhase as
          | "loot"
          | "rest",
      lootRollsCreated:
        loot.created,
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
   LOOT -> REST
========================================================= */

/**
 * Temporary Alpha lifecycle action.
 *
 * Later, Need/Greed/Pass resolution will call this automatically
 * after all boss loot has been resolved. Until then, the dungeon
 * leader explicitly closes the loot phase.
 */
export async function beginDungeonRestForPlayer(
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
    active.leaderPlayerId !==
    playerId
  ) {
    throw new Error(
      "Only the dungeon leader can continue after boss loot.",
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
        [active.instanceId],
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
      String(instance.current_phase) !==
      "loot"
    ) {
      throw new Error(
        "Boss loot must be resolved before resting.",
      );
    }

    const roomId =
      Number(
        instance.current_room_id
      );

    await connection.query(
      `
        UPDATE dungeon_instances

        SET
          current_phase = 'rest'

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
          phase = 'rest'

        WHERE instance_id = ?
          AND room_id = ?
          AND status = 'active'
      `,
      [
        active.instanceId,
        roomId,
      ],
    );

    await connection.commit();

    const encounter =
      await loadInstanceEncounterState(
        active.instanceId
      );

    return {
      ok: true,
      transition:
        "rest" as const,
      encounter,
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
   REST -> NEXT ROOM / COMPLETE
========================================================= */

/**
 * Leader-authoritative room advance.
 *
 * Non-final room:
 * Rest -> mark current room complete -> activate next room -> Wave 1
 *
 * Final room:
 * Rest -> mark room complete -> complete dungeon -> award the
 * configured dungeon completion XP/gold to each active member.
 *
 * The personal completion chest is intentionally separate and can
 * be added later without changing this room lifecycle.
 */
export async function advanceDungeonAfterRestForPlayer(
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
    active.leaderPlayerId !==
    playerId
  ) {
    throw new Error(
      "Only the dungeon leader can advance to the next room.",
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
            di.id,
            di.dungeon_id,
            di.current_room_id,
            di.current_room_order,
            di.current_phase,
            di.status,
            d.completion_xp,
            d.completion_gold

          FROM dungeon_instances di

          JOIN dungeons d
            ON d.id = di.dungeon_id

          WHERE di.id = ?

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
      String(instance.current_phase) !==
      "rest"
    ) {
      throw new Error(
        "The party must be in the rest phase before advancing.",
      );
    }

    const [[pendingWipe]]: any =
      await connection.query(
        `
          SELECT id

          FROM dungeon_instance_wipes

          WHERE instance_id = ?
            AND status = 'awaiting_retry'

          ORDER BY id DESC

          LIMIT 1

          FOR UPDATE
        `,
        [
          active.instanceId
        ],
      );

    if (pendingWipe) {
      throw new Error(
        "This room was wiped. Retry the room before advancing the dungeon.",
      );
    }

    const currentRoomId =
      Number(
        instance.current_room_id
      );

    const currentRoomOrder =
      Number(
        instance.current_room_order
      );

    const [[nextRoom]]: any =
      await connection.query(
        `
          SELECT
            id,
            room_order,
            name

          FROM dungeon_rooms

          WHERE dungeon_id = ?
            AND is_active = 1
            AND room_order > ?

          ORDER BY
            room_order ASC

          LIMIT 1
        `,
        [
          Number(
            instance.dungeon_id
          ),
          currentRoomOrder,
        ],
      );

    /*
     * Close the room we just cleared.
     */
    await connection.query(
      `
        UPDATE dungeon_instance_rooms

        SET
          status = 'completed',
          phase = 'complete',
          completed_at =
            COALESCE(
              completed_at,
              NOW()
            )

        WHERE instance_id = ?
          AND room_id = ?
          AND status = 'active'
      `,
      [
        active.instanceId,
        currentRoomId,
      ],
    );

    if (nextRoom) {
      const nextRoomId =
        Number(
          nextRoom.id
        );

      const nextRoomOrder =
        Number(
          nextRoom.room_order
        );

      await connection.query(
        `
          UPDATE dungeon_instance_rooms

          SET
            status = 'active',
            current_wave = 1,
            phase = 'trash',
            entered_at =
              COALESCE(
                entered_at,
                NOW()
              )

          WHERE instance_id = ?
            AND room_id = ?
            AND status IN (
              'locked',
              'available'
            )
        `,
        [
          active.instanceId,
          nextRoomId,
        ],
      );

      await connection.query(
        `
          UPDATE dungeon_instances

          SET
            current_room_id = ?,
            current_room_order = ?,
            current_wave = 1,
            current_phase = 'trash'

          WHERE id = ?
        `,
        [
          nextRoomId,
          nextRoomOrder,
          active.instanceId,
        ],
      );

      await connection.commit();

      const encounter =
        await loadInstanceEncounterState(
          active.instanceId
        );

      return {
        ok: true,
        transition:
          "next_room" as const,
        completedRoomOrder:
          currentRoomOrder,
        currentRoomOrder:
          nextRoomOrder,
        currentRoomName:
          String(
            nextRoom.name ??
            `Room ${nextRoomOrder}`
          ),
        encounter,
      };
    }

    /*
     * Final room complete.
     *
     * Completion XP/gold are per-player dungeon completion rewards.
     * Enemy rewards and the personal completion chest remain separate.
     */
    const completionXp =
      Math.max(
        0,
        Number(
          instance.completion_xp ??
          0
        ),
      );

    const completionGold =
      Math.max(
        0,
        Number(
          instance.completion_gold ??
          0
        ),
      );

    const [memberRows]: any =
      await connection.query(
        `
          SELECT
            player_id

          FROM dungeon_instance_members

          WHERE instance_id = ?
            AND is_active = 1

          FOR UPDATE
        `,
        [
          active.instanceId
        ],
      );

    const completionMemberIds =
      (memberRows ?? []).map(
        (member: any) =>
          Number(
            member.player_id
          ),
      );

    const chestResult =
      await createDungeonCompletionChestsWithConn(
        connection,
        {
          instanceId:
            active.instanceId,
          dungeonId:
            Number(
              instance.dungeon_id
            ),
          memberPlayerIds:
            completionMemberIds,
        },
      );

    for (
      const member of
      memberRows ?? []
    ) {
      await connection.query(
        `
          UPDATE players

          SET
            exper =
              exper + ?,
            gold =
              gold + ?

          WHERE id = ?
        `,
        [
          completionXp,
          completionGold,
          Number(
            member.player_id
          ),
        ],
      );
    }

    await connection.query(
      `
        UPDATE dungeon_instances

        SET
          current_phase = 'complete',
          status = 'completed',
          completed_at =
            COALESCE(
              completed_at,
              NOW()
            )

        WHERE id = ?
      `,
      [
        active.instanceId
      ],
    );

    await connection.query(
      `
        UPDATE dungeon_instance_members

        SET
          is_active = 0,
          left_at =
            COALESCE(
              left_at,
              NOW()
            )

        WHERE instance_id = ?
          AND is_active = 1
      `,
      [
        active.instanceId
      ],
    );

    await connection.commit();

    return {
      ok: true,
      transition:
        "complete" as const,
      completedRoomOrder:
        currentRoomOrder,
      phase:
        "complete" as const,
      status:
        "completed" as const,
      rewards: {
        xp:
          completionXp,
        gold:
          completionGold,
      },
      completionChests: {
        created:
          chestResult.chestsCreated,
      },
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
   PLAYER-BASED TEST HELPER
========================================================= */

/**
 * Development/test helper.
 *
 * This resolves the player's active instance and then calls the
 * same authoritative progression function combat will eventually use.
 */
export async function completeCurrentDungeonWaveForPlayer(
  playerId: number,
) {
  const active =
    await getActiveDungeonForPlayer(playerId);

  if (!active) {
    throw new Error(
      "You are not inside an active dungeon.",
    );
  }

  if (
    active.leaderPlayerId !== playerId
  ) {
    throw new Error(
      "Only the dungeon leader can advance the test encounter.",
    );
  }

  const result =
    await completeCurrentDungeonWave(
      active.instanceId,
    );

  const encounter =
    await loadInstanceEncounterState(
      active.instanceId,
    );

  return {
    ...result,
    encounter,
  };
}
