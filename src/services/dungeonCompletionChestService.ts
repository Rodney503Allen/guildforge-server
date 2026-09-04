// src/services/dungeonCompletionChestService.ts
//
// Persistent personal dungeon completion chests.
//
// A chest is generated once for each member when the dungeon completes.
// Rewards are rolled and stored immediately so refreshing/restarting cannot
// reroll the contents. Claiming later awards the stored rewards exactly once.

import { db } from "../db";

import {
  addItemWithConn,
  addPlayerItemToInventoryWithConn,
} from "./inventoryService";

import {
  generateLootFromBaseItem,
  type LootRarity,
} from "./lootGenerator";

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

function rollDungeonCompletionRarity(): LootRarity {
  const roll =
    Math.random() * 100;

  if (roll < 8) {
    return "transcendent";
  }

  if (roll < 30) {
    return "empowered";
  }

  return "awakened";
}

export async function createDungeonCompletionChestsWithConn(
  conn: any,
  args: {
    instanceId: number;
    dungeonId: number;
    memberPlayerIds: number[];
  },
) {
  const {
    instanceId,
    dungeonId,
    memberPlayerIds,
  } = args;

  const [lootEntries]: any =
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

        FROM dungeon_completion_loot

        WHERE dungeon_id = ?
          AND is_active = 1

        ORDER BY
          display_order ASC,
          id ASC
      `,
      [dungeonId],
    );

  let chestsCreated = 0;

  for (
    const playerId of
    memberPlayerIds
  ) {
    const [insertChest]: any =
      await conn.query(
        `
          INSERT IGNORE INTO dungeon_completion_chests (
            instance_id,
            dungeon_id,
            player_id,
            status
          )
          VALUES (?, ?, ?, 'unclaimed')
        `,
        [
          instanceId,
          dungeonId,
          playerId,
        ],
      );

    let chestId =
      Number(
        insertChest?.insertId ??
        0
      );

    if (!chestId) {
      const [[existing]]: any =
        await conn.query(
          `
            SELECT id
            FROM dungeon_completion_chests
            WHERE instance_id = ?
              AND player_id = ?
            LIMIT 1
          `,
          [
            instanceId,
            playerId,
          ],
        );

      chestId =
        Number(
          existing?.id ??
          0
        );
    } else {
      chestsCreated++;
    }

    if (!chestId) {
      throw new Error(
        "Could not create dungeon completion chest.",
      );
    }

    /*
     * Roll each configured personal reward independently.
     * Because Stormvault's temporary seed is four 25% entries,
     * it is possible to get 0+ rewards. If all entries miss,
     * guarantee one random entry so the completion chest is never empty.
     */
    const successfulEntries: any[] =
      [];

    for (
      const entry of
      lootEntries ?? []
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
        Math.random() <=
        chance
      ) {
        successfulEntries.push(
          entry
        );
      }
    }

    if (
      successfulEntries.length ===
        0 &&
      (lootEntries ?? []).length >
        0
    ) {
      successfulEntries.push(
        lootEntries[
          randomIntInclusive(
            0,
            lootEntries.length - 1
          )
        ]
      );
    }

    for (
      const entry of
      successfulEntries
    ) {
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

      await conn.query(
        `
          INSERT IGNORE INTO dungeon_completion_chest_rewards (
            chest_id,
            loot_entry_id,
            reward_type,
            reward_id,
            quantity,
            item_level,
            claimed
          )
          VALUES (?, ?, ?, ?, ?, ?, 0)
        `,
        [
          chestId,
          Number(entry.id),
          String(
            entry.reward_type
          ),
          Number(
            entry.reward_id
          ),
          randomIntInclusive(
            minQty,
            maxQty,
          ),
          entry.item_level_override ==
          null
            ? null
            : Number(
                entry.item_level_override
              ),
        ],
      );
    }
  }

  return {
    chestsCreated,
  };
}

export async function getLatestDungeonCompletionChestForPlayer(
  playerId: number,
) {
  const [rows]: any =
    await db.query(
      `
        SELECT
          dcc.id AS chest_id,
          dcc.instance_id,
          dcc.dungeon_id,
          dcc.status,
          dcc.created_at,
          dcc.claimed_at,

          d.name AS dungeon_name,

          dccr.id AS reward_row_id,
          dccr.reward_type,
          dccr.reward_id,
          dccr.quantity,
          dccr.item_level,
          dccr.claimed AS reward_claimed,

          i.name AS item_name,
          i.icon AS item_icon,

          ib.name AS base_name,
          ib.icon AS base_icon,
          ib.item_type AS base_item_type,
          ib.slot AS base_slot

        FROM dungeon_completion_chests dcc

        JOIN dungeons d
          ON d.id = dcc.dungeon_id

        LEFT JOIN dungeon_completion_chest_rewards dccr
          ON dccr.chest_id = dcc.id

        LEFT JOIN items i
          ON dccr.reward_type = 'item'
         AND i.id = dccr.reward_id

        LEFT JOIN item_bases ib
          ON dccr.reward_type = 'item_base'
         AND ib.id = dccr.reward_id

        WHERE dcc.player_id = ?
          AND dcc.id = (
            SELECT latest.id
            FROM dungeon_completion_chests latest
            WHERE latest.player_id = ?
            ORDER BY latest.created_at DESC, latest.id DESC
            LIMIT 1
          )

        ORDER BY
          dccr.id ASC
      `,
      [
        playerId,
        playerId,
      ],
    );

  if (
    !rows?.length
  ) {
    return null;
  }

  const first =
    rows[0];

  return {
    id:
      Number(
        first.chest_id
      ),
    instanceId:
      Number(
        first.instance_id
      ),
    dungeonId:
      Number(
        first.dungeon_id
      ),
    dungeonName:
      String(
        first.dungeon_name
      ),
    status:
      String(
        first.status
      ),
    createdAt:
      first.created_at,
    claimedAt:
      first.claimed_at,
    rewards:
      rows
        .filter(
          (row: any) =>
            row.reward_row_id !=
            null
        )
        .map(
          (row: any) => ({
            id:
              Number(
                row.reward_row_id
              ),
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
                row.item_name ??
                row.base_name ??
                "Unknown Reward"
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
            claimed:
              Boolean(
                row.reward_claimed
              ),
          }),
        ),
  };
}

async function awardChestRewardWithConn(
  conn: any,
  args: {
    playerId: number;
    instanceId: number;
    rewardType:
      | "item"
      | "item_base";
    rewardId: number;
    quantity: number;
    itemLevel: number | null;
  },
) {
  const {
    playerId,
    instanceId,
    rewardType,
    rewardId,
    quantity,
    itemLevel,
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

  for (
    let i = 0;
    i < quantity;
    i++
  ) {
    const generated =
      await generateLootFromBaseItem({
        playerId,
        baseItemId:
          rewardId,
        itemLevel:
          Math.max(
            1,
            Number(
              itemLevel ??
              1
            ),
          ),
        sourceType:
          "dungeon",
        sourceId:
          instanceId,
        isClaimed:
          true,
        rarityOverride:
          rollDungeonCompletionRarity(),
        conn,
      });

    if (!generated) {
      throw new Error(
        "Could not generate dungeon chest equipment reward.",
      );
    }

    await addPlayerItemToInventoryWithConn(
      conn,
      playerId,
      generated.playerItemId,
    );
  }
}

export async function claimDungeonCompletionChest(
  playerId: number,
  chestId: number,
) {
  const connection =
    await db.getConnection();

  try {
    await connection.beginTransaction();

    const [[chest]]: any =
      await connection.query(
        `
          SELECT
            id,
            instance_id,
            player_id,
            status

          FROM dungeon_completion_chests

          WHERE id = ?

          FOR UPDATE
        `,
        [chestId],
      );

    if (!chest) {
      throw new Error(
        "Dungeon completion chest was not found.",
      );
    }

    if (
      Number(
        chest.player_id
      ) !== playerId
    ) {
      throw new Error(
        "This dungeon completion chest does not belong to you.",
      );
    }

    if (
      String(
        chest.status
      ) === "claimed"
    ) {
      throw new Error(
        "This dungeon completion chest has already been claimed.",
      );
    }

    const [rewards]: any =
      await connection.query(
        `
          SELECT
            id,
            reward_type,
            reward_id,
            quantity,
            item_level,
            claimed

          FROM dungeon_completion_chest_rewards

          WHERE chest_id = ?

          FOR UPDATE
        `,
        [chestId],
      );

    for (
      const reward of
      rewards ?? []
    ) {
      if (
        Number(
          reward.claimed
        ) === 1
      ) {
        continue;
      }

      await awardChestRewardWithConn(
        connection,
        {
          playerId,
          instanceId:
            Number(
              chest.instance_id
            ),
          rewardType:
            String(
              reward.reward_type
            ) as
              | "item"
              | "item_base",
          rewardId:
            Number(
              reward.reward_id
            ),
          quantity:
            Math.max(
              1,
              Number(
                reward.quantity ??
                1
              ),
            ),
          itemLevel:
            reward.item_level ==
            null
              ? null
              : Number(
                  reward.item_level
                ),
        },
      );

      await connection.query(
        `
          UPDATE dungeon_completion_chest_rewards
          SET claimed = 1
          WHERE id = ?
        `,
        [
          Number(
            reward.id
          ),
        ],
      );
    }

    await connection.query(
      `
        UPDATE dungeon_completion_chests

        SET
          status = 'claimed',
          claimed_at = NOW()

        WHERE id = ?
      `,
      [chestId],
    );

    await connection.commit();

    return {
      ok: true,
      chestId,
      claimed:
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
