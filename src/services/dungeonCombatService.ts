// src/services/dungeonCombatService.ts
//
// Guildforge Dungeon multi-enemy runtime queue.
//
// Trash waves:
//   - every configured enemy in the current wave is activated together
//   - the wave completes only after every runtime enemy is defeated
//
// Boss phases:
//   - use the same collection model, normally containing one boss

import { db } from "../db";

import {
  completeCurrentDungeonBoss,
  completeCurrentDungeonWave,
  getCurrentDungeonEncounterForPlayer,
} from "./dungeonProgressionService";

export type DungeonRuntimeEnemyStatus =
  | "pending"
  | "active"
  | "defeated"
  | "skipped";

export type DungeonRuntimeEnemy = {
  id: number;
  instanceId: number;
  roomId: number;

  phase: "trash" | "boss";
  waveNumber: number;

  assignmentId: number | null;
  creatureId: number;

  sequenceNumber: number;
  quantityIndex: number;

  hp: number;
  maxHp: number;

  status: DungeonRuntimeEnemyStatus;

  name: string;
  description: string;
  image: string | null;

  level: number;
  attack: number;
  defense: number;
  agility: number;
  crit: number;
};

function toRuntimeEnemy(
  row: any,
): DungeonRuntimeEnemy {
  return {
    id:
      Number(row.id),

    instanceId:
      Number(row.instance_id),

    roomId:
      Number(row.room_id),

    phase:
      String(row.phase) as
        | "trash"
        | "boss",

    waveNumber:
      Number(
        row.wave_number ??
        1
      ),

    assignmentId:
      row.assignment_id == null
        ? null
        : Number(
            row.assignment_id
          ),

    creatureId:
      Number(row.creature_id),

    sequenceNumber:
      Number(
        row.sequence_number
      ),

    quantityIndex:
      Number(
        row.quantity_index ??
        1
      ),

    hp:
      Number(row.hp ?? 0),

    maxHp:
      Math.max(
        1,
        Number(
          row.max_hp ??
          1
        ),
      ),

    status:
      String(
        row.status
      ) as DungeonRuntimeEnemyStatus,

    name:
      String(
        row.name ??
        "Enemy"
      ),

    description:
      String(
        row.description ??
        ""
      ),

    image:
      row.image ??
      null,

    level:
      Number(
        row.level ??
        1
      ),

    attack:
      Number(
        row.attack ??
        0
      ),

    defense:
      Number(
        row.defense ??
        0
      ),

    agility:
      Number(
        row.agility ??
        0
      ),

    crit:
      Number(
        row.crit ??
        0
      ),
  };
}

async function loadCreatureForQueue(
  connection: any,
  creatureId: number,
) {
  const [[creature]]: any =
    await connection.query(
      `
        SELECT
          id,
          maxhp

        FROM creatures

        WHERE id = ?

        LIMIT 1
      `,
      [creatureId],
    );

  if (!creature) {
    throw new Error(
      `Dungeon creature ${creatureId} was not found.`,
    );
  }

  return {
    creatureId:
      Number(creature.id),

    maxHp:
      Math.max(
        1,
        Number(
          creature.maxhp ??
          1
        ),
      ),
  };
}

/* =========================================================
   BUILD CURRENT WAVE / BOSS RUNTIME ROWS
========================================================= */

export async function ensureDungeonEnemyQueue(
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
      throw new Error(
        "This dungeon run is no longer active.",
      );
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
        created: false,
        phase,
        enemyCount: 0,
      };
    }

    const roomId =
      Number(
        instance.current_room_id
      );

    const waveNumber =
      Number(
        instance.current_wave ??
        1
      );

    const [[existing]]: any =
      await connection.query(
        `
          SELECT COUNT(*) AS total

          FROM dungeon_instance_enemies

          WHERE instance_id = ?
            AND room_id = ?
            AND phase = ?
            AND wave_number = ?
        `,
        [
          instanceId,
          roomId,
          phase,
          waveNumber,
        ],
      );

    if (
      Number(
        existing?.total ??
        0
      ) > 0
    ) {
      await connection.commit();

      return {
        created: false,
        phase,
        enemyCount:
          Number(
            existing?.total ??
            0
          ),
      };
    }

    let sequenceNumber =
      1;

    if (
      phase === "trash"
    ) {
      const [[wave]]: any =
        await connection.query(
          `
            SELECT id

            FROM dungeon_room_waves

            WHERE room_id = ?
              AND wave_number = ?

            LIMIT 1
          `,
          [
            roomId,
            waveNumber,
          ],
        );

      if (!wave) {
        throw new Error(
          `Dungeon wave ${waveNumber} is not configured for this room.`,
        );
      }

      const [assignments]: any =
        await connection.query(
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
          [wave.id],
        );

      if (!assignments?.length) {
        throw new Error(
          "This dungeon wave has no creatures configured.",
        );
      }

      for (
        const assignment of
        assignments
      ) {
        const creatureId =
          Number(
            assignment.creature_id
          );

        const quantity =
          Math.max(
            1,
            Number(
              assignment.quantity ??
              1
            ),
          );

        const creature =
          await loadCreatureForQueue(
            connection,
            creatureId,
          );

        for (
          let quantityIndex = 1;
          quantityIndex <= quantity;
          quantityIndex++
        ) {
          await connection.query(
            `
              INSERT INTO dungeon_instance_enemies (
                instance_id,
                room_id,
                phase,
                wave_number,
                assignment_id,
                creature_id,
                sequence_number,
                quantity_index,
                hp,
                max_hp,
                status
              )
              VALUES (
                ?, ?, 'trash', ?,
                ?, ?, ?, ?,
                ?, ?, 'pending'
              )
            `,
            [
              instanceId,
              roomId,
              waveNumber,
              Number(
                assignment.id
              ),
              creatureId,
              sequenceNumber,
              quantityIndex,
              creature.maxHp,
              creature.maxHp,
            ],
          );

          sequenceNumber++;
        }
      }
    } else {
      const [[room]]: any =
        await connection.query(
          `
            SELECT
              boss_creature_id

            FROM dungeon_rooms

            WHERE id = ?

            LIMIT 1
          `,
          [roomId],
        );

      const bossCreatureId =
        room?.boss_creature_id == null
          ? null
          : Number(
              room.boss_creature_id
            );

      if (!bossCreatureId) {
        throw new Error(
          "This dungeon room has no boss configured.",
        );
      }

      const creature =
        await loadCreatureForQueue(
          connection,
          bossCreatureId,
        );

      await connection.query(
        `
          INSERT INTO dungeon_instance_enemies (
            instance_id,
            room_id,
            phase,
            wave_number,
            assignment_id,
            creature_id,
            sequence_number,
            quantity_index,
            hp,
            max_hp,
            status
          )
          VALUES (
            ?, ?, 'boss', ?,
            NULL, ?, 1, 1,
            ?, ?, 'pending'
          )
        `,
        [
          instanceId,
          roomId,
          waveNumber,
          bossCreatureId,
          creature.maxHp,
          creature.maxHp,
        ],
      );

      sequenceNumber =
        2;
    }

    await connection.commit();

    return {
      created: true,
      phase,
      enemyCount:
        sequenceNumber - 1,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/* =========================================================
   ACTIVE WAVE COLLECTION
========================================================= */

async function loadDungeonEnemiesByStatus(
  instanceId: number,
  statuses:
    DungeonRuntimeEnemyStatus[],
): Promise<DungeonRuntimeEnemy[]> {
  if (!statuses.length) {
    return [];
  }

  const placeholders =
    statuses
      .map(
        () => "?"
      )
      .join(", ");

  const [rows]: any =
    await db.query(
      `
        SELECT
          die.*,

          c.name,
          c.description,
          COALESCE(
            c.image,
            c.creatureimage
          ) AS image,
          c.level,
          c.attack,
          c.defense,
          c.agility,
          c.crit

        FROM dungeon_instance_enemies die

        JOIN creatures c
          ON c.id =
             die.creature_id

        JOIN dungeon_instances di
          ON di.id =
             die.instance_id

        WHERE die.instance_id = ?
          AND die.room_id =
              di.current_room_id
          AND die.phase =
              di.current_phase
          AND die.wave_number =
              di.current_wave
          AND die.status IN (
            ${placeholders}
          )

        ORDER BY
          die.sequence_number ASC,
          die.id ASC
      `,
      [
        instanceId,
        ...statuses,
      ],
    );

  return (
    rows ?? []
  ).map(
    toRuntimeEnemy
  );
}

export async function getActiveDungeonEnemies(
  instanceId: number,
) {
  return loadDungeonEnemiesByStatus(
    instanceId,
    ["active"],
  );
}

/*
 * Backward-compatible singular helper.
 * New dungeon code should prefer getActiveDungeonEnemies().
 */
export async function getActiveDungeonEnemy(
  instanceId: number,
): Promise<DungeonRuntimeEnemy | null> {
  const enemies =
    await getActiveDungeonEnemies(
      instanceId
    );

  return (
    enemies[0] ??
    null
  );
}

/*
 * Activates EVERY pending enemy belonging to the current
 * room / phase / wave.
 */
export async function activateDungeonEnemyWave(
  instanceId: number,
): Promise<DungeonRuntimeEnemy[]> {
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
            current_wave,
            current_phase,
            status

          FROM dungeon_instances

          WHERE id = ?

          FOR UPDATE
        `,
        [instanceId],
      );

    if (
      !instance ||
      String(
        instance.status
      ) !== "active"
    ) {
      await connection.rollback();

      return [];
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

      return [];
    }

    await connection.query(
      `
        UPDATE dungeon_instance_enemies

        SET
          status = 'active',
          activated_at =
            COALESCE(
              activated_at,
              NOW()
            )

        WHERE instance_id = ?
          AND room_id = ?
          AND phase = ?
          AND wave_number = ?
          AND status = 'pending'
      `,
      [
        instanceId,
        Number(
          instance.current_room_id
        ),
        phase,
        Number(
          instance.current_wave ??
          1
        ),
      ],
    );

    await connection.commit();

    return getActiveDungeonEnemies(
      instanceId
    );
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/*
 * Backward-compatible old name. It now activates the whole
 * wave and returns the first living runtime enemy.
 */
export async function activateNextDungeonEnemy(
  instanceId: number,
): Promise<DungeonRuntimeEnemy | null> {
  const enemies =
    await activateDungeonEnemyWave(
      instanceId
    );

  return (
    enemies[0] ??
    null
  );
}

export async function ensureCurrentDungeonEnemies(
  instanceId: number,
): Promise<DungeonRuntimeEnemy[]> {
  await ensureDungeonEnemyQueue(
    instanceId
  );

  let active =
    await getActiveDungeonEnemies(
      instanceId
    );

  /*
   * This also repairs old sequential test instances:
   * any pending enemies in the current wave are promoted
   * alongside the already-active one.
   */
  const pending =
    await loadDungeonEnemiesByStatus(
      instanceId,
      ["pending"],
    );

  if (
    pending.length > 0
  ) {
    active =
      await activateDungeonEnemyWave(
        instanceId
      );
  }

  return active;
}

export async function ensureCurrentDungeonEnemy(
  instanceId: number,
): Promise<DungeonRuntimeEnemy | null> {
  const enemies =
    await ensureCurrentDungeonEnemies(
      instanceId
    );

  return (
    enemies[0] ??
    null
  );
}

/* =========================================================
   HP
========================================================= */

export async function updateDungeonEnemyHp(
  runtimeEnemyId: number,
  hp: number,
) {
  const finalHp =
    Math.max(
      0,
      Math.floor(
        Number(hp) || 0
      ),
    );

  await db.query(
    `
      UPDATE dungeon_instance_enemies

      SET hp = ?

      WHERE id = ?
        AND status = 'active'
    `,
    [
      finalHp,
      runtimeEnemyId,
    ],
  );
}

/* =========================================================
   DEFEAT
========================================================= */

export async function completeDungeonEnemy(
  instanceId: number,
  runtimeEnemyId: number,
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
            current_wave,
            current_phase,
            status

          FROM dungeon_instances

          WHERE id = ?

          FOR UPDATE
        `,
        [instanceId],
      );

    if (
      !instance ||
      String(
        instance.status
      ) !== "active"
    ) {
      throw new Error(
        "Dungeon instance is no longer active.",
      );
    }

    const [[enemy]]: any =
      await connection.query(
        `
          SELECT
            id,
            room_id,
            phase,
            wave_number,
            status

          FROM dungeon_instance_enemies

          WHERE id = ?
            AND instance_id = ?

          FOR UPDATE
        `,
        [
          runtimeEnemyId,
          instanceId,
        ],
      );

    if (!enemy) {
      throw new Error(
        "Dungeon enemy was not found.",
      );
    }

    if (
      String(
        enemy.status
      ) === "defeated"
    ) {
      await connection.commit();

      return {
        alreadyDefeated: true,
        completedWave: false,
        completedBoss: false,
        remainingCount: 0,
      };
    }

    await connection.query(
      `
        UPDATE dungeon_instance_enemies

        SET
          hp = 0,
          status = 'defeated',
          defeated_at = NOW()

        WHERE id = ?
      `,
      [runtimeEnemyId],
    );

    const [[remaining]]: any =
      await connection.query(
        `
          SELECT
            COUNT(*) AS total

          FROM dungeon_instance_enemies

          WHERE instance_id = ?
            AND room_id = ?
            AND phase = ?
            AND wave_number = ?
            AND status IN (
              'pending',
              'active'
            )
        `,
        [
          instanceId,
          Number(
            enemy.room_id
          ),
          String(
            enemy.phase
          ),
          Number(
            enemy.wave_number
          ),
        ],
      );

    const remainingCount =
      Number(
        remaining?.total ??
        0
      );

    await connection.commit();

    if (
      remainingCount > 0
    ) {
      return {
        completedWave: false,
        completedBoss: false,
        remainingCount,
      };
    }

    if (
      String(
        enemy.phase
      ) === "trash"
    ) {
      const progression =
        await completeCurrentDungeonWave(
          instanceId
        );

      return {
        completedWave: true,
        completedBoss: false,
        remainingCount: 0,
        progression,
      };
    }

    const progression =
      await completeCurrentDungeonBoss(
        instanceId
      );

    return {
      completedWave: false,
      completedBoss: true,
      remainingCount: 0,
      progression,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // May already be committed before progression call.
    }

    throw error;
  } finally {
    connection.release();
  }
}

/* =========================================================
   PLAYER ENTRY
========================================================= */

export async function getDungeonCombatEnemyForPlayer(
  playerId: number,
) {
  const encounter =
    await getCurrentDungeonEncounterForPlayer(
      playerId
    );

  if (!encounter) {
    return null;
  }

  if (
    encounter.phase !== "trash" &&
    encounter.phase !== "boss"
  ) {
    return {
      encounter,
      enemy: null,
      enemies: [],
    };
  }

  const enemies =
    await ensureCurrentDungeonEnemies(
      encounter.instanceId
    );

  return {
    encounter,
    enemy:
      enemies[0] ??
      null,
    enemies,
  };
}
