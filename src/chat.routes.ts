import express from "express";
import { db } from "./db";
import { getInventory } from "./services/inventoryService";

const router = express.Router();

const MAX_CHAT_LENGTH = 240;
const MAX_LINKED_ITEMS = 4;

function cleanLinkedIds(value: any): number[] {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .map(Number)
        .filter(
          id =>
            Number.isInteger(id) &&
            id > 0
        )
    )
  ].slice(0, MAX_LINKED_ITEMS);
}

function buildItemSnapshot(item: any) {
  return {
    inventoryId: Number(item.id),
    itemId:
      item.item_id != null
        ? Number(item.item_id)
        : null,
    playerItemId:
      item.player_item_id != null
        ? Number(item.player_item_id)
        : null,

    name: String(
      item.name || "Unknown Item"
    ),
    category:
      item.category || null,
    itemType:
      item.item_type || null,
    slot:
      item.slot || null,
    armorWeight:
      item.armor_weight || null,

    value:
      item.value != null
        ? Number(item.value)
        : null,
    quantity:
      Math.max(
        1,
        Number(item.quantity) || 1
      ),
    icon:
      item.icon || null,
    rarity:
      item.rarity || "common",
    description:
      item.description || null,

    itemLevel:
      item.item_level != null
        ? Number(item.item_level)
        : null,
    baseAttack:
      item.base_attack != null
        ? Number(item.base_attack)
        : null,
    baseDefense:
      item.base_defense != null
        ? Number(item.base_defense)
        : null,

    rollJson:
      Array.isArray(item.roll_json)
        ? item.roll_json
        : []
  };
}

// =======================
// FETCH WORLD CHAT
// =======================
router.get(
  "/api/chat/world",
  async (req, res) => {
    try {
      const [rows]: any =
        await db.query(`
          SELECT
            wc.id,
            wc.player_id,
            wc.player_name,
            wc.message,
            wc.created_at,
            COALESCE(
              a.image_url,
              '/images/avatars/default_adventurer.webp'
            ) AS portrait_url
          FROM world_chat wc
          LEFT JOIN players p
            ON p.id = wc.player_id
          LEFT JOIN avatars a
            ON a.id = p.equipped_avatar_id
            AND a.is_active = 1
          ORDER BY wc.id DESC
          LIMIT 50
        `);

      const messages =
        (rows || []).reverse();

      if (!messages.length) {
        return res.json([]);
      }

      const messageIds =
        messages.map(
          (row: any) =>
            Number(row.id)
        );

      const placeholders =
        messageIds
          .map(() => "?")
          .join(",");

      const [linkRows]: any =
        await db.query(
          `
            SELECT
              id,
              world_chat_id,
              link_index,
              item_snapshot
            FROM world_chat_item_links
            WHERE world_chat_id IN (
              ${placeholders}
            )
            ORDER BY
              world_chat_id ASC,
              link_index ASC
          `,
          messageIds
        );

      const linksByMessage =
        new Map<number, any[]>();

      for (
        const link of
        linkRows || []
      ) {
        const chatId =
          Number(
            link.world_chat_id
          );

        let snapshot: any = null;

        try {
          snapshot =
            typeof link.item_snapshot ===
            "string"
              ? JSON.parse(
                  link.item_snapshot
                )
              : link.item_snapshot;
        } catch {
          snapshot = null;
        }

        if (!snapshot) continue;

        if (
          !linksByMessage.has(chatId)
        ) {
          linksByMessage.set(
            chatId,
            []
          );
        }

        linksByMessage
          .get(chatId)!
          .push({
            id: Number(link.id),
            index: Number(
              link.link_index
            ),
            item: snapshot
          });
      }

      return res.json(
        messages.map(
          (row: any) => ({
            ...row,
            item_links:
              linksByMessage.get(
                Number(row.id)
              ) || []
          })
        )
      );
    } catch (err) {
      console.error(
        "World chat fetch failed:",
        err
      );

      return res
        .status(500)
        .json({
          error: "server_error"
        });
    }
  }
);

// =======================
// LINKABLE INVENTORY
// =======================
router.get(
  "/api/chat/linkable-items",
  async (req, res) => {
    try {
      const pid =
        Number(
          (req.session as any)
            ?.playerId
        );

      if (!pid) {
        return res
          .status(401)
          .json({
            error: "Not logged in"
          });
      }

      const inventory =
        await getInventory(pid);

      return res.json(
        inventory.map(
          buildItemSnapshot
        )
      );
    } catch (err) {
      console.error(
        "Chat linkable inventory failed:",
        err
      );

      return res
        .status(500)
        .json({
          error: "server_error"
        });
    }
  }
);

// =======================
// POST WORLD MESSAGE
// =======================
router.post(
  "/api/chat/world",
  async (req, res) => {
    const pid =
      Number(
        (req.session as any)
          ?.playerId
      );

    const message =
      String(
        req.body?.message || ""
      ).trim();

    const linkedInventoryIds =
      cleanLinkedIds(
        req.body?.linkedInventoryIds
      );

    if (!pid) {
      return res
        .status(401)
        .json({
          error: "Not logged in"
        });
    }

    if (
      !message &&
      linkedInventoryIds.length === 0
    ) {
      return res
        .status(400)
        .json({
          error: "Empty message"
        });
    }

    const cleanMessage =
      message.substring(
        0,
        MAX_CHAT_LENGTH
      );

    try {
      const [[player]]: any =
        await db.query(
          `
            SELECT name
            FROM players
            WHERE id = ?
            LIMIT 1
          `,
          [pid]
        );

      if (!player) {
        return res
          .status(404)
          .json({
            error:
              "Player not found"
          });
      }

      const inventory =
        await getInventory(pid);

      const inventoryById =
        new Map(
          inventory.map(
            item => [
              Number(item.id),
              item
            ]
          )
        );

      const linkedItems =
        linkedInventoryIds.map(
          id =>
            inventoryById.get(id)
        );

      if (
        linkedItems.some(
          item => !item
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "One or more linked items are no longer in your inventory."
          });
      }

      const conn =
        await db.getConnection();

      try {
        await conn.beginTransaction();

        const [insert]: any =
          await conn.query(
            `
              INSERT INTO world_chat (
                player_id,
                player_name,
                message
              )
              VALUES (?, ?, ?)
            `,
            [
              pid,
              player.name,
              cleanMessage
            ]
          );

        const chatId =
          Number(insert.insertId);

        for (
          let index = 0;
          index <
          linkedItems.length;
          index++
        ) {
          const snapshot =
            buildItemSnapshot(
              linkedItems[index]
            );

          await conn.query(
            `
              INSERT INTO
                world_chat_item_links (
                  world_chat_id,
                  link_index,
                  item_snapshot
                )
              VALUES (?, ?, ?)
            `,
            [
              chatId,
              index,
              JSON.stringify(
                snapshot
              )
            ]
          );
        }

        await conn.commit();

        return res.json({
          success: true,
          chatId
        });
      } catch (err) {
        try {
          await conn.rollback();
        } catch {}

        throw err;
      } finally {
        try {
          conn.release();
        } catch {}
      }
    } catch (err) {
      console.error(
        "World chat send failed:",
        err
      );

      return res
        .status(500)
        .json({
          error: "server_error"
        });
    }
  }
);

export default router;
