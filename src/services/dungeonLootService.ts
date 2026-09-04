// src/services/dungeonLootService.ts
//
// Guildforge Dungeon Boss Loot v1
// Persistent Need / Greed / Pass resolution.
//
// Boss loot is generated once per dungeon-instance room.
// Choices are immutable. Need has priority over Greed.
// Highest d100 wins within the highest-priority choice.
// When every roll in the room is resolved, the dungeon
// automatically moves from loot -> rest.

import { db } from "../db";
import {
  addItemWithConn,
  addPlayerItemToInventoryWithConn,
} from "./inventoryService";

import {
  generateLootPreviewFromBaseItem,
  type LootRarity,
} from "./lootGenerator";

export type DungeonLootChoice =
  | "need"
  | "greed"
  | "pass";

function randomIntInclusive(
  min: number,
  max: number,
) {
  return (
    Math.floor(
      Math.random() *
        (max - min + 1)
    ) + min
  );
}

function rollDungeonBossRarity(): LootRarity {
  const roll =
    Math.random() * 100;

  if (roll < 5) {
    return "transcendent";
  }

  if (roll < 20) {
    return "empowered";
  }

  return "awakened";
}

async function moveDungeonToRestWithConn(
  conn: any,
  instanceId: number,
  roomId: number,
) {
  await conn.query(
    `
      UPDATE dungeon_instances
      SET current_phase = 'rest'
      WHERE id = ?
        AND status = 'active'
    `,
    [instanceId],
  );

  await conn.query(
    `
      UPDATE dungeon_instance_rooms
      SET phase = 'rest'
      WHERE instance_id = ?
        AND room_id = ?
        AND status = 'active'
    `,
    [
      instanceId,
      roomId,
    ],
  );
}

export async function createDungeonBossLootRollsWithConn(
  conn: any,
  args: {
    instanceId: number;
    roomId: number;
    bossCreatureId: number;
  },
) {
  const {
    instanceId,
    roomId,
    bossCreatureId,
  } = args;

  const [entries]: any =
    await conn.query(
      `
        SELECT
          id,
          reward_type,
          reward_id,
          drop_chance,
          min_quantity,
          max_quantity,
          item_level_override

        FROM dungeon_boss_loot

        WHERE room_id = ?
          AND is_active = 1

        ORDER BY
          display_order ASC,
          id ASC
      `,
      [roomId],
    );

  let created = 0;

  for (
    const entry of
    entries ?? []
  ) {
    const chance =
      Math.max(
        0,
        Math.min(
          1,
          Number(
            entry.drop_chance ??
            0
          ),
        ),
      );

    if (
      Math.random() >
      chance
    ) {
      continue;
    }

    const minQty =
      Math.max(
        1,
        Number(
          entry.min_quantity ??
          1
        ),
      );

    const maxQty =
      Math.max(
        minQty,
        Number(
          entry.max_quantity ??
          minQty
        ),
      );

    const quantity =
      randomIntInclusive(
        minQty,
        maxQty,
      );

    let itemLevel:
      number | null =
      entry.item_level_override == null
        ? null
        : Number(
            entry.item_level_override
          );

    if (
      String(
        entry.reward_type
      ) === "item_base" &&
      itemLevel == null
    ) {
      const [[boss]]: any =
        await conn.query(
          `
            SELECT level
            FROM creatures
            WHERE id = ?
            LIMIT 1
          `,
          [
            bossCreatureId
          ],
        );

      itemLevel =
        Math.max(
          1,
          Number(
            boss?.level ??
            1
          ),
        );
    }

    let generatedName:
      string | null =
      null;

    let generatedRarity:
      LootRarity | null =
      null;

    let generatedRollJson:
      string | null =
      null;

    if (
      String(
        entry.reward_type
      ) === "item_base"
    ) {
      const preview =
        await generateLootPreviewFromBaseItem({
          baseItemId:
            Number(
              entry.reward_id
            ),

          itemLevel:
            Math.max(
              1,
              Number(
                itemLevel ??
                1
              ),
            ),

          rarityOverride:
            rollDungeonBossRarity(),

          conn,
        });

      if (!preview) {
        throw new Error(
          "Could not generate dungeon boss loot preview.",
        );
      }

      generatedName =
        preview.name;

      generatedRarity =
        preview.rarity;

      generatedRollJson =
        JSON.stringify(
          preview.affixes
        );
    }

    const [insert]: any =
      await conn.query(
        `
          INSERT IGNORE INTO dungeon_loot_rolls (
            instance_id,
            room_id,
            boss_creature_id,
            loot_entry_id,
            reward_type,
            reward_id,
            quantity,
            item_level,
            generated_name,
            generated_rarity,
            generated_roll_json,
            status
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open'
          )
        `,
        [
          instanceId,
          roomId,
          bossCreatureId,
          Number(entry.id),
          String(
            entry.reward_type
          ),
          Number(
            entry.reward_id
          ),
          quantity,
          itemLevel,
          generatedName,
          generatedRarity,
          generatedRollJson,
        ],
      );

    if (
      Number(
        insert?.affectedRows ??
        0
      ) >
      0
    ) {
      created++;
    }
  }

  return {
    created,
  };
}

async function awardDungeonLootWithConn(
  conn: any,
  args: {
    playerId: number;
    rollId: number;
    rewardType:
      | "item"
      | "item_base";
    rewardId: number;
    quantity: number;
    itemLevel: number | null;
    instanceId: number;
    generatedName?: string | null;
    generatedRarity?: LootRarity | null;
    generatedRollJson?: string | null;
  },
) {
  const {
    playerId,
    rollId,
    rewardType,
    rewardId,
    quantity,
    itemLevel,
    instanceId,
    generatedName,
    generatedRarity,
    generatedRollJson,
  } = args;

  if (
    rewardType ===
    "item"
  ) {
    await addItemWithConn(
      conn,
      playerId,
      rewardId,
      quantity,
    );

    return;
  }

  if (
    !generatedName ||
    !generatedRarity
  ) {
    throw new Error(
      "Dungeon equipment roll is missing its generated preview.",
    );
  }

  /*
   * The item was rolled when the boss died, before Need/Greed.
   * Award exactly that persisted rarity/affix roll to the winner.
   */
  for (
    let i = 0;
    i < quantity;
    i++
  ) {
    const [insert]: any =
      await conn.query(
        `
          INSERT INTO player_items (
            player_id,
            item_base_id,
            name,
            item_level,
            rarity,
            craft_quality,
            is_equipped,
            is_claimed,
            roll_json,
            source_type,
            source_id
          )
          VALUES (
            ?, ?, ?, ?, ?,
            NULL, 0, 1, ?,
            'dungeon', ?
          )
        `,
        [
          playerId,
          rewardId,
          generatedName,
          Math.max(
            1,
            Number(
              itemLevel ??
              1
            ),
          ),
          generatedRarity,
          generatedRollJson,
          instanceId,
        ],
      );

    const playerItemId =
      Number(
        insert?.insertId
      );

    if (!playerItemId) {
      throw new Error(
        "Could not create dungeon equipment reward.",
      );
    }

    await addPlayerItemToInventoryWithConn(
      conn,
      playerId,
      playerItemId,
    );
  }

  void rollId;
}

async function resolveDungeonLootRollWithConn(
  conn: any,
  rollId: number,
) {
  const [[roll]]: any =
    await conn.query(
      `
        SELECT
          id,
          instance_id,
          room_id,
          reward_type,
          reward_id,
          quantity,
          item_level,
          generated_name,
          generated_rarity,
          generated_roll_json,
          status

        FROM dungeon_loot_rolls

        WHERE id = ?

        FOR UPDATE
      `,
      [rollId],
    );

  if (!roll) {
    throw new Error(
      "Dungeon loot roll was not found.",
    );
  }

  if (
    String(roll.status) !==
    "open"
  ) {
    return {
      resolved: true,
      alreadyResolved: true,
    };
  }

  const [[memberCountRow]]: any =
    await conn.query(
      `
        SELECT
          COUNT(*) AS total

        FROM dungeon_instance_members

        WHERE instance_id = ?
          AND is_active = 1
      `,
      [
        Number(
          roll.instance_id
        ),
      ],
    );

  const eligibleCount =
    Number(
      memberCountRow?.total ??
      0
    );

  const [[choiceCountRow]]: any =
    await conn.query(
      `
        SELECT
          COUNT(*) AS total

        FROM dungeon_loot_choices

        WHERE roll_id = ?
      `,
      [rollId],
    );

  const choiceCount =
    Number(
      choiceCountRow?.total ??
      0
    );

  if (
    choiceCount <
    eligibleCount
  ) {
    return {
      resolved: false,
      waitingFor:
        Math.max(
          0,
          eligibleCount -
          choiceCount
        ),
    };
  }

  const [needers]: any =
    await conn.query(
      `
        SELECT
          player_id,
          roll_value

        FROM dungeon_loot_choices

        WHERE roll_id = ?
          AND choice = 'need'

        ORDER BY
          roll_value DESC,
          submitted_at ASC,
          player_id ASC
      `,
      [rollId],
    );

  const [greeders]: any =
    await conn.query(
      `
        SELECT
          player_id,
          roll_value

        FROM dungeon_loot_choices

        WHERE roll_id = ?
          AND choice = 'greed'

        ORDER BY
          roll_value DESC,
          submitted_at ASC,
          player_id ASC
      `,
      [rollId],
    );

  const candidates =
    needers?.length
      ? needers
      : greeders ?? [];

  if (
    !candidates.length
  ) {
    await conn.query(
      `
        UPDATE dungeon_loot_rolls

        SET
          status = 'no_winner',
          resolved_at = NOW()

        WHERE id = ?
      `,
      [rollId],
    );

    return {
      resolved: true,
      winnerPlayerId:
        null,
      winningChoice:
        null,
      winningRoll:
        null,
    };
  }

  const winner =
    candidates[0];

  const winningChoice:
    "need" | "greed" =
    needers?.length
      ? "need"
      : "greed";

  const winnerPlayerId =
    Number(
      winner.player_id
    );

  const winningRoll =
    Number(
      winner.roll_value
    );

  await awardDungeonLootWithConn(
    conn,
    {
      playerId:
        winnerPlayerId,
      rollId,
      rewardType:
        String(
          roll.reward_type
        ) as
          | "item"
          | "item_base",
      rewardId:
        Number(
          roll.reward_id
        ),
      quantity:
        Number(
          roll.quantity ??
          1
        ),
      itemLevel:
        roll.item_level ==
        null
          ? null
          : Number(
              roll.item_level
            ),
      instanceId:
        Number(
          roll.instance_id
        ),

      generatedName:
        roll.generated_name ??
        null,

      generatedRarity:
        roll.generated_rarity ??
        null,

      generatedRollJson:
        roll.generated_roll_json == null
          ? null
          : (
              typeof roll.generated_roll_json === "string"
                ? roll.generated_roll_json
                : JSON.stringify(
                    roll.generated_roll_json
                  )
            ),
    },
  );

  await conn.query(
    `
      UPDATE dungeon_loot_rolls

      SET
        status = 'resolved',
        winner_player_id = ?,
        winning_choice = ?,
        winning_roll = ?,
        resolved_at = NOW()

      WHERE id = ?
    `,
    [
      winnerPlayerId,
      winningChoice,
      winningRoll,
      rollId,
    ],
  );

  return {
    resolved: true,
    winnerPlayerId,
    winningChoice,
    winningRoll,
  };
}

async function maybeFinishDungeonLootPhaseWithConn(
  conn: any,
  instanceId: number,
  roomId: number,
) {
  const [[openRow]]: any =
    await conn.query(
      `
        SELECT
          COUNT(*) AS total

        FROM dungeon_loot_rolls

        WHERE instance_id = ?
          AND room_id = ?
          AND status = 'open'
      `,
      [
        instanceId,
        roomId,
      ],
    );

  const openCount =
    Number(
      openRow?.total ??
      0
    );

  if (
    openCount >
    0
  ) {
    return false;
  }

  await moveDungeonToRestWithConn(
    conn,
    instanceId,
    roomId,
  );

  return true;
}

export async function getDungeonLootForPlayer(
  playerId: number,
) {
  const [instanceRows]: any =
    await db.query(
      `
        SELECT
          di.id AS instance_id,
          di.current_room_id,
          di.current_phase

        FROM dungeon_instances di

        JOIN dungeon_instance_members dim
          ON dim.instance_id = di.id
         AND dim.player_id = ?
         AND dim.is_active = 1

        WHERE di.status = 'active'

        ORDER BY
          di.started_at DESC

        LIMIT 1
      `,
      [playerId],
    );

  if (
    !instanceRows?.length
  ) {
    return null;
  }

  const instance =
    instanceRows[0];

  const instanceId =
    Number(
      instance.instance_id
    );

  const roomId =
    Number(
      instance.current_room_id
    );

  const [rows]: any =
    await db.query(
      `
        SELECT
          dlr.id,
          dlr.reward_type,
          dlr.reward_id,
          dlr.quantity,
          dlr.item_level,
          dlr.generated_name,
          dlr.generated_rarity,
          dlr.generated_roll_json,
          dlr.status,
          dlr.winner_player_id,
          dlr.winning_choice,
          dlr.winning_roll,
          dlr.created_at,
          dlr.resolved_at,

          i.name AS item_name,
          i.icon AS item_icon,
          i.rarity AS item_rarity,

          ib.name AS base_name,
          ib.icon AS base_icon,
          ib.item_type AS base_item_type,
          ib.slot AS base_slot,
          ib.armor_weight AS base_armor_weight,
          COALESCE(ib.base_attack, 0) AS base_attack,
          COALESCE(ib.base_defense, 0) AS base_defense,

          my.choice AS my_choice,
          my.roll_value AS my_roll,

          (
            SELECT COUNT(*)
            FROM dungeon_instance_members members
            WHERE members.instance_id = dlr.instance_id
              AND members.is_active = 1
          ) AS eligible_count,

          (
            SELECT COUNT(*)
            FROM dungeon_loot_choices choices
            WHERE choices.roll_id = dlr.id
          ) AS choice_count

        FROM dungeon_loot_rolls dlr

        LEFT JOIN items i
          ON dlr.reward_type = 'item'
         AND i.id = dlr.reward_id

        LEFT JOIN item_bases ib
          ON dlr.reward_type = 'item_base'
         AND ib.id = dlr.reward_id

        LEFT JOIN dungeon_loot_choices my
          ON my.roll_id = dlr.id
         AND my.player_id = ?

        WHERE dlr.instance_id = ?
          AND dlr.room_id = ?

        ORDER BY
          dlr.id ASC
      `,
      [
        playerId,
        instanceId,
        roomId,
      ],
    );

  return {
    instanceId,
    roomId,
    phase:
      String(
        instance.current_phase
      ),
    rolls:
      (rows ?? []).map(
        (row: any) => ({
          id:
            Number(row.id),
          rewardType:
            String(
              row.reward_type
            ),
          rewardId:
            Number(
              row.reward_id
            ),
          name:
            String(
              row.generated_name ??
              row.item_name ??
              row.base_name ??
              "Unknown Reward"
            ),

          rarity:
            row.generated_rarity ??
            row.item_rarity ??
            null,

          rollJson:
            row.generated_roll_json ==
            null
              ? null
              : (
                  typeof row.generated_roll_json ===
                  "string"
                    ? row.generated_roll_json
                    : JSON.stringify(
                        row.generated_roll_json
                      )
                ),
          icon:
            row.item_icon ??
            row.base_icon ??
            null,
          itemType:
            row.base_item_type ??
            null,
          slot:
            row.base_slot ??
            null,

          armorWeight:
            row.base_armor_weight ??
            null,

          baseAttack:
            Number(
              row.base_attack ??
              0
            ),

          baseDefense:
            Number(
              row.base_defense ??
              0
            ),

          quantity:
            Number(
              row.quantity ??
              1
            ),
          itemLevel:
            row.item_level ==
            null
              ? null
              : Number(
                  row.item_level
                ),
          status:
            String(
              row.status
            ),
          myChoice:
            row.my_choice ??
            null,
          myRoll:
            row.my_roll ==
            null
              ? null
              : Number(
                  row.my_roll
                ),
          eligibleCount:
            Number(
              row.eligible_count ??
              0
            ),
          choiceCount:
            Number(
              row.choice_count ??
              0
            ),
          winnerPlayerId:
            row.winner_player_id ==
            null
              ? null
              : Number(
                  row.winner_player_id
                ),
          winningChoice:
            row.winning_choice ??
            null,
          winningRoll:
            row.winning_roll ==
            null
              ? null
              : Number(
                  row.winning_roll
                ),
        }),
      ),
  };
}

export async function submitDungeonLootChoice(
  playerId: number,
  rollId: number,
  choice: DungeonLootChoice,
) {
  const normalizedChoice =
    String(
      choice
    ).toLowerCase() as
      DungeonLootChoice;

  if (
    ![
      "need",
      "greed",
      "pass",
    ].includes(
      normalizedChoice
    )
  ) {
    throw new Error(
      "Invalid dungeon loot choice.",
    );
  }

  const connection =
    await db.getConnection();

  try {
    await connection.beginTransaction();

    const [[roll]]: any =
      await connection.query(
        `
          SELECT
            id,
            instance_id,
            room_id,
            status

          FROM dungeon_loot_rolls

          WHERE id = ?

          FOR UPDATE
        `,
        [rollId],
      );

    if (!roll) {
      throw new Error(
        "Dungeon loot roll was not found.",
      );
    }

    if (
      String(
        roll.status
      ) !== "open"
    ) {
      throw new Error(
        "This dungeon loot roll has already been resolved.",
      );
    }

    const [[instance]]: any =
      await connection.query(
        `
          SELECT
            id,
            current_room_id,
            current_phase,
            status

          FROM dungeon_instances

          WHERE id = ?

          FOR UPDATE
        `,
        [
          Number(
            roll.instance_id
          ),
        ],
      );

    if (
      !instance ||
      String(
        instance.status
      ) !== "active" ||
      String(
        instance.current_phase
      ) !== "loot" ||
      Number(
        instance.current_room_id
      ) !==
        Number(
          roll.room_id
        )
    ) {
      throw new Error(
        "This loot roll is no longer active.",
      );
    }

    const [[member]]: any =
      await connection.query(
        `
          SELECT id

          FROM dungeon_instance_members

          WHERE instance_id = ?
            AND player_id = ?
            AND is_active = 1

          LIMIT 1
        `,
        [
          Number(
            roll.instance_id
          ),
          playerId,
        ],
      );

    if (!member) {
      throw new Error(
        "You are not eligible for this dungeon loot.",
      );
    }

    const [[existing]]: any =
      await connection.query(
        `
          SELECT id

          FROM dungeon_loot_choices

          WHERE roll_id = ?
            AND player_id = ?

          LIMIT 1
        `,
        [
          rollId,
          playerId,
        ],
      );

    if (existing) {
      throw new Error(
        "You have already chosen for this loot roll.",
      );
    }

    const rollValue =
      normalizedChoice ===
      "pass"
        ? null
        : randomIntInclusive(
            1,
            100,
          );

    await connection.query(
      `
        INSERT INTO dungeon_loot_choices (
          roll_id,
          player_id,
          choice,
          roll_value
        )
        VALUES (?, ?, ?, ?)
      `,
      [
        rollId,
        playerId,
        normalizedChoice,
        rollValue,
      ],
    );

    const resolution =
      await resolveDungeonLootRollWithConn(
        connection,
        rollId,
      );

    const movedToRest =
      resolution.resolved
        ? await maybeFinishDungeonLootPhaseWithConn(
            connection,
            Number(
              roll.instance_id
            ),
            Number(
              roll.room_id
            ),
          )
        : false;

    await connection.commit();

    return {
      ok: true,
      choice:
        normalizedChoice,
      roll:
        rollValue,
      resolution,
      movedToRest,
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
