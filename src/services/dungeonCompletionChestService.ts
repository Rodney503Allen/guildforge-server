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
  generateLootPreviewFromBaseItem,
  savePreRolledLootFromBaseItem,
  type GeneratedItem,
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
     * If the chest already existed, its contents were already rolled.
     * Do not roll again on an idempotent/repeated completion call.
     */
    if (
      Number(
        insertChest?.affectedRows ??
        0
      ) === 0
    ) {
      continue;
    }

    // Exactly one guaranteed completion reward per player.
    // Existing drop_chance values act as relative selection weights,
    // rather than independent rolls that can award multiple items.
    const eligibleEntries = (lootEntries ?? []).filter(
      (entry: any) => String(entry.reward_type) === "item_base"
    );
    if (!eligibleEntries.length) {
      throw new Error("Dungeon has no configured equipment completion rewards.");
    }

    const weights = eligibleEntries.map((entry: any) =>
      Math.max(0, Number(entry.drop_chance) || 0)
    );
    const totalWeight = weights.reduce((sum: number, weight: number) => sum + weight, 0);
    let chosenIndex = 0;
    if (totalWeight > 0) {
      let roll = Math.random() * totalWeight;
      for (let i = 0; i < eligibleEntries.length; i++) {
        roll -= weights[i];
        if (roll < 0) { chosenIndex = i; break; }
      }
    } else {
      chosenIndex = randomIntInclusive(0, eligibleEntries.length - 1);
    }

    const entry = eligibleEntries[chosenIndex];
    const quantity = 1;
      const rewardType = String(entry.reward_type);
      const rewardId = Number(entry.reward_id);
      const itemLevel = entry.item_level_override == null
        ? null
        : Number(entry.item_level_override);

      // Freeze the complete equipment rolls at chest creation, not at claim.
      const rolledItems: GeneratedItem[] = [];
      if (rewardType === "item_base") {
        for (let i = 0; i < quantity; i++) {
          const preview = await generateLootPreviewFromBaseItem({
            baseItemId: rewardId,
            itemLevel: Math.max(1, Number(itemLevel ?? 1)),
            rarityOverride: rollDungeonCompletionRarity(),
            conn,
          });
          if (!preview) {
            throw new Error("Unable to pre-roll dungeon completion equipment.");
          }
          rolledItems.push(preview);
        }
      }

      await conn.query(
        `INSERT IGNORE INTO dungeon_completion_chest_rewards
         (chest_id, loot_entry_id, reward_type, reward_id,
          quantity, item_level, rolled_items_json, claimed)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          chestId, Number(entry.id), rewardType, rewardId,
          quantity, itemLevel,
          rewardType === "item_base" ? JSON.stringify(rolledItems) : null,
        ],
      );
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
          ib.slot AS base_slot,
          ib.armor_weight AS base_armor_weight,
          ib.weapon_class AS base_weapon_class,
          ib.base_attack AS base_attack,
          ib.attack_speed_ms AS base_attack_speed_ms,
          ib.base_defense AS base_defense,
          ib.sell_value AS base_sell_value,
          dccr.rolled_items_json,
          i.rarity AS item_rarity,
          i.attack AS item_attack,
          i.defense AS item_defense,
          i.agility AS item_agility,
          i.vitality AS item_vitality,
          i.intellect AS item_intellect,
          i.crit AS item_crit

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
            rarity: (() => {
              const raw = row.rolled_items_json;
              const rolls = typeof raw === "string" ? JSON.parse(raw) : raw;
              return rolls?.[0]?.rarity ?? row.item_rarity ?? "base";
            })(),
            roll_json: (() => {
              const raw = row.rolled_items_json;
              const rolls = typeof raw === "string" ? JSON.parse(raw) : raw;
              return rolls?.[0]?.affixes ?? [];
            })(),
            rolledItems: (() => {
              const raw = row.rolled_items_json;
              return typeof raw === "string" ? JSON.parse(raw) : (raw ?? []);
            })(),
            armor_weight: row.base_armor_weight ?? null,
            weapon_class: row.base_weapon_class ?? null,
            base_attack: row.base_attack ?? 0,
            attack_speed_ms: row.base_slot === "weapon"
              ? (Number(row.base_attack_speed_ms) > 0 ? Number(row.base_attack_speed_ms) : 6000)
              : null,
            base_defense: row.base_defense ?? 0,
            sell_value: row.base_sell_value ?? 0,
            attack: row.item_attack ?? 0,
            defense: row.item_defense ?? 0,
            agility: row.item_agility ?? 0,
            vitality: row.item_vitality ?? 0,
            intellect: row.item_intellect ?? 0,
            crit: row.item_crit ?? 0,
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
    rolledItems: GeneratedItem[] | null;
  },
) {
  const {
    playerId,
    instanceId,
    rewardType,
    rewardId,
    quantity,
    itemLevel,
    rolledItems,
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

  if (!rolledItems || rolledItems.length !== quantity) {
    // Fail safely for legacy, unrolled chests rather than silently rerolling.
    throw new Error(
      "Dungeon chest equipment was not pre-rolled. Migrate existing pending chests before claiming."
    );
  }
  for (const item of rolledItems) {
    if (item.itemBaseId !== rewardId) {
      throw new Error("Dungeon chest equipment data is inconsistent.");
    }
    const generated = await savePreRolledLootFromBaseItem({
      playerId,
      item,
      sourceType: "dungeon",
      sourceId: instanceId,
      isClaimed: true,
      conn,
    });
    await addPlayerItemToInventoryWithConn(
      conn, playerId, generated.playerItemId
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
            claimed,
            rolled_items_json

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
          rolledItems: (() => {
            const raw = reward.rolled_items_json;
            return raw == null ? null :
              (typeof raw === "string" ? JSON.parse(raw) : raw);
          })(),
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
