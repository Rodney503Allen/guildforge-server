import { db } from "../db";

const TRADE_REQUEST_MINUTES = 10;

async function query<T = any>(
  sql: string,
  params: any[] = [],
): Promise<T> {
  const [rows] = await db.query(sql, params);
  return rows as T;
}

function positiveInt(
  value: any,
  message: string,
): number {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(message);
  }

  return number;
}

function nonNegativeInt(
  value: any,
  message: string,
): number {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 0) {
    throw new Error(message);
  }

  return number;
}

function assertParticipant(
  trade: any,
  playerId: number,
) {
  if (
    Number(trade.initiator_player_id) !== playerId &&
    Number(trade.recipient_player_id) !== playerId
  ) {
    throw new Error("You are not part of this trade.");
  }
}

function isInitiator(
  trade: any,
  playerId: number,
) {
  return Number(trade.initiator_player_id) === playerId;
}

function otherPlayerId(
  trade: any,
  playerId: number,
) {
  return isInitiator(trade, playerId)
    ? Number(trade.recipient_player_id)
    : Number(trade.initiator_player_id);
}

async function expireTradeIfNeeded(
  connection: any,
  trade: any,
) {
  if (
    ["requested", "active"].includes(trade.status) &&
    new Date(trade.expires_at).getTime() <= Date.now()
  ) {
    await connection.query(
      `
        UPDATE player_trades
        SET
          status = 'expired',
          initiator_confirmed = 0,
          recipient_confirmed = 0,
          initiator_accepted = 0,
          recipient_accepted = 0
        WHERE id = ?
      `,
      [trade.id],
    );

    trade.status = "expired";
  }
}

async function getLockedTrade(
  connection: any,
  tradeId: number,
) {
  const [rows]: any = await connection.query(
    `
      SELECT *
      FROM player_trades
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
    `,
    [tradeId],
  );

  if (!rows.length) {
    throw new Error("Trade not found.");
  }

  return rows[0];
}

async function getTradeOffers(
  connection: any,
  tradeId: number,
) {
  const [rows]: any = await connection.query(
    `
      SELECT
        pti.id,
        pti.trade_id,
        pti.offered_by_player_id,
        pti.slot_number,
        pti.inventory_id,
        pti.quantity,

        inv.item_id,
        inv.player_item_id,
        inv.durability,
        inv.randid,

        COALESCE(pi.name, items.name, ib.name) AS item_name,
        COALESCE(pi.rarity, items.rarity, 'base') AS rarity,
        COALESCE(ib.description, items.description, '') AS description,
        COALESCE(ib.slot, items.slot) AS slot,
        COALESCE(ib.icon, items.icon) AS icon,
        CASE WHEN inv.player_item_id IS NULL THEN items.value ELSE ib.sell_value END AS value,
        CASE WHEN inv.player_item_id IS NULL THEN items.item_type ELSE ib.item_type END AS item_type,
        CASE WHEN inv.player_item_id IS NULL THEN NULL ELSE ib.armor_weight END AS armor_weight,
        CASE WHEN inv.player_item_id IS NULL THEN NULL ELSE pi.item_level END AS item_level,
        CASE WHEN inv.player_item_id IS NULL THEN items.attack ELSE ib.base_attack END AS base_attack,
        CASE WHEN inv.player_item_id IS NULL THEN items.defense ELSE ib.base_defense END AS base_defense,
        CASE WHEN inv.player_item_id IS NULL THEN items.agility ELSE 0 END AS agility,
        CASE WHEN inv.player_item_id IS NULL THEN items.vitality ELSE 0 END AS vitality,
        CASE WHEN inv.player_item_id IS NULL THEN items.intellect ELSE 0 END AS intellect,
        CASE WHEN inv.player_item_id IS NULL THEN items.crit ELSE 0 END AS crit,
        pi.roll_json,
        CASE WHEN inv.player_item_id IS NULL THEN 0 ELSE 1 END AS is_unique

      FROM player_trade_items pti

      JOIN inventory inv
        ON inv.inventory_id = pti.inventory_id

      LEFT JOIN player_items pi
        ON pi.id = inv.player_item_id

      LEFT JOIN items
        ON items.id = inv.item_id

      LEFT JOIN item_bases ib
        ON ib.id = pi.item_base_id

      WHERE pti.trade_id = ?

      ORDER BY
        pti.offered_by_player_id ASC,
        pti.slot_number ASC
    `,
    [tradeId],
  );

  return rows;
}

async function buildTradeView(
  connection: any,
  tradeId: number,
  viewerPlayerId: number,
) {
  const [tradeRows]: any = await connection.query(
    `
      SELECT
        pt.*,

        initiator.name AS initiator_name,
        initiator.level AS initiator_level,
        initiator.pclass AS initiator_class,

        recipient.name AS recipient_name,
        recipient.level AS recipient_level,
        recipient.pclass AS recipient_class

      FROM player_trades pt

      JOIN players initiator
        ON initiator.id = pt.initiator_player_id

      JOIN players recipient
        ON recipient.id = pt.recipient_player_id

      WHERE pt.id = ?
      LIMIT 1
    `,
    [tradeId],
  );

  if (!tradeRows.length) {
    throw new Error("Trade not found.");
  }

  const trade = tradeRows[0];

  assertParticipant(trade, viewerPlayerId);

  const offers = await getTradeOffers(
    connection,
    tradeId,
  );

  const initiatorId = Number(
    trade.initiator_player_id,
  );

  const recipientId = Number(
    trade.recipient_player_id,
  );

  return {
    id: Number(trade.id),
    status: trade.status,
    location: trade.location,
    expiresAt: trade.expires_at,
    createdAt: trade.created_at,

    currentPlayerId: viewerPlayerId,

    initiator: {
      playerId: initiatorId,
      name: trade.initiator_name,
      level: Number(trade.initiator_level),
      pclass: trade.initiator_class,
      gold: Number(trade.initiator_gold),
      confirmed: Boolean(trade.initiator_confirmed),
      accepted: Boolean(trade.initiator_accepted),
      items: offers.filter(
        (offer: any) =>
          Number(offer.offered_by_player_id) ===
          initiatorId,
      ),
    },

    recipient: {
      playerId: recipientId,
      name: trade.recipient_name,
      level: Number(trade.recipient_level),
      pclass: trade.recipient_class,
      gold: Number(trade.recipient_gold),
      confirmed: Boolean(trade.recipient_confirmed),
      accepted: Boolean(trade.recipient_accepted),
      items: offers.filter(
        (offer: any) =>
          Number(offer.offered_by_player_id) ===
          recipientId,
      ),
    },
  };
}

/* =========================================================
   PLAYER SEARCH
========================================================= */

export async function searchTradePlayers(
  currentPlayerId: number,
  search: string,
) {
  const term = String(search || "").trim();

  if (term.length < 2) {
    return [];
  }

  return query<any[]>(
    `
      SELECT
        p.id,
        p.name,
        p.level,
        p.pclass,
        p.location

      FROM players p

      WHERE p.id <> ?
        AND p.name LIKE ?

      ORDER BY p.name ASC
      LIMIT 10
    `,
    [
      currentPlayerId,
      `%${term}%`,
    ],
  );
}

/* =========================================================
   TRADE REQUESTS
========================================================= */

export async function createTradeRequest(
  initiatorPlayerId: number,
  recipientPlayerId: number,
) {
  recipientPlayerId = positiveInt(
    recipientPlayerId,
    "A player is required.",
  );

  if (initiatorPlayerId === recipientPlayerId) {
    throw new Error("You cannot trade with yourself.");
  }

  const players: any[] = await query(
    `
      SELECT id, location
      FROM players
      WHERE id IN (?, ?)
    `,
    [
      initiatorPlayerId,
      recipientPlayerId,
    ],
  );

  if (players.length !== 2) {
    throw new Error("That player could not be found.");
  }

  const initiator = players.find(
    player => Number(player.id) === initiatorPlayerId,
  );

  const recipient = players.find(
    player => Number(player.id) === recipientPlayerId,
  );

  if (
    !initiator ||
    !recipient ||
    initiator.location !== recipient.location
  ) {
    throw new Error(
      "You must be in the same location to trade.",
    );
  }

  const existing: any[] = await query(
    `
      SELECT id
      FROM player_trades
      WHERE status IN ('requested', 'active')
        AND (
          initiator_player_id IN (?, ?)
          OR recipient_player_id IN (?, ?)
        )
      LIMIT 1
    `,
    [
      initiatorPlayerId,
      recipientPlayerId,
      initiatorPlayerId,
      recipientPlayerId,
    ],
  );

  if (existing.length) {
    throw new Error(
      "One of these players is already in a trade.",
    );
  }

  const result: any = await query(
    `
      INSERT INTO player_trades (
        initiator_player_id,
        recipient_player_id,
        location,
        expires_at
      )
      VALUES (
        ?,
        ?,
        ?,
        DATE_ADD(NOW(), INTERVAL ? MINUTE)
      )
    `,
    [
      initiatorPlayerId,
      recipientPlayerId,
      initiator.location,
      TRADE_REQUEST_MINUTES,
    ],
  );

  return getTradeForPlayer(
    Number(result.insertId),
    initiatorPlayerId,
  );
}

export async function getIncomingTradeRequests(
  playerId: number,
) {
  await query(
    `
      UPDATE player_trades
      SET status = 'expired'
      WHERE recipient_player_id = ?
        AND status = 'requested'
        AND expires_at <= NOW()
    `,
    [playerId],
  );

  return query<any[]>(
    `
      SELECT
        pt.id,
        pt.created_at,
        pt.expires_at,

        p.id AS initiator_player_id,
        p.name AS initiator_name,
        p.level AS initiator_level,
        p.pclass AS initiator_class

      FROM player_trades pt

      JOIN players p
        ON p.id = pt.initiator_player_id

      WHERE pt.recipient_player_id = ?
        AND pt.status = 'requested'
        AND pt.expires_at > NOW()

      ORDER BY pt.created_at DESC
    `,
    [playerId],
  );
}

export async function acceptTradeRequest(
  tradeId: number,
  playerId: number,
) {
  tradeId = positiveInt(
    tradeId,
    "Invalid trade.",
  );

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const trade = await getLockedTrade(
      connection,
      tradeId,
    );

    assertParticipant(trade, playerId);

    await expireTradeIfNeeded(connection, trade);

    if (
      Number(trade.recipient_player_id) !== playerId
    ) {
      throw new Error(
        "Only the invited player can accept this trade.",
      );
    }

    if (trade.status !== "requested") {
      throw new Error(
        "This trade request is no longer active.",
      );
    }

    await connection.query(
      `
        UPDATE player_trades
        SET status = 'active'
        WHERE id = ?
      `,
      [tradeId],
    );

    const result = await buildTradeView(
      connection,
      tradeId,
      playerId,
    );

    await connection.commit();

    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

export async function declineTradeRequest(
  tradeId: number,
  playerId: number,
) {
  tradeId = positiveInt(
    tradeId,
    "Invalid trade.",
  );

  const result: any = await query(
    `
      UPDATE player_trades
      SET status = 'declined'
      WHERE id = ?
        AND recipient_player_id = ?
        AND status = 'requested'
    `,
    [
      tradeId,
      playerId,
    ],
  );

  if (!result.affectedRows) {
    throw new Error(
      "Trade request not found or no longer active.",
    );
  }
}

/* =========================================================
   TRADE WINDOW / INVENTORY
========================================================= */

export async function getTradeForPlayer(
  tradeId: number,
  playerId: number,
) {
  tradeId = positiveInt(
    tradeId,
    "Invalid trade.",
  );

  const connection = await db.getConnection();

  try {
    const [rows]: any = await connection.query(
      `
        SELECT *
        FROM player_trades
        WHERE id = ?
        LIMIT 1
      `,
      [tradeId],
    );

    if (!rows.length) {
      throw new Error("Trade not found.");
    }

    assertParticipant(rows[0], playerId);

    return buildTradeView(
      connection,
      tradeId,
      playerId,
    );
  } finally {
    connection.release();
  }
}

export async function getTradeInventory(
  tradeId: number,
  playerId: number,
) {
  tradeId = positiveInt(
    tradeId,
    "Invalid trade.",
  );

  const tradeRows: any[] = await query(
    `
      SELECT *
      FROM player_trades
      WHERE id = ?
      LIMIT 1
    `,
    [tradeId],
  );

  if (!tradeRows.length) {
    throw new Error("Trade not found.");
  }

  assertParticipant(tradeRows[0], playerId);

  return query<any[]>(
    `
      SELECT
        inv.inventory_id,
        inv.item_id,
        inv.player_item_id,
        inv.quantity,
        inv.durability,
        inv.randid,

        COALESCE(pi.name, items.name, ib.name) AS item_name,
        COALESCE(pi.rarity, items.rarity, 'base') AS rarity,
        COALESCE(ib.description, items.description, '') AS description,
        COALESCE(ib.slot, items.slot) AS slot,
        COALESCE(ib.icon, items.icon) AS icon,
        CASE WHEN inv.player_item_id IS NULL THEN items.value ELSE ib.sell_value END AS value,
        CASE WHEN inv.player_item_id IS NULL THEN items.item_type ELSE ib.item_type END AS item_type,
        CASE WHEN inv.player_item_id IS NULL THEN NULL ELSE ib.armor_weight END AS armor_weight,
        CASE WHEN inv.player_item_id IS NULL THEN NULL ELSE pi.item_level END AS item_level,
        CASE WHEN inv.player_item_id IS NULL THEN items.attack ELSE ib.base_attack END AS base_attack,
        CASE WHEN inv.player_item_id IS NULL THEN items.defense ELSE ib.base_defense END AS base_defense,
        CASE WHEN inv.player_item_id IS NULL THEN items.agility ELSE 0 END AS agility,
        CASE WHEN inv.player_item_id IS NULL THEN items.vitality ELSE 0 END AS vitality,
        CASE WHEN inv.player_item_id IS NULL THEN items.intellect ELSE 0 END AS intellect,
        CASE WHEN inv.player_item_id IS NULL THEN items.crit ELSE 0 END AS crit,
        pi.roll_json,

        CASE
          WHEN inv.player_item_id IS NULL THEN 0
          ELSE 1
        END AS is_unique

      FROM inventory inv

      LEFT JOIN player_items pi
        ON pi.id = inv.player_item_id

      LEFT JOIN items
        ON items.id = inv.item_id

      LEFT JOIN item_bases ib
        ON ib.id = pi.item_base_id

      WHERE inv.player_id = ?
        AND COALESCE(inv.equipped, 0) = 0
        AND COALESCE(pi.is_equipped, 0) = 0

      ORDER BY item_name ASC, inv.inventory_id ASC
    `,
    [playerId],
  );
}

/* =========================================================
   OFFER EDITING
========================================================= */

export async function updateTradeOffer(
  tradeId: number,
  playerId: number,
  rawItems: any[],
  rawGold: any,
) {
  tradeId = positiveInt(
    tradeId,
    "Invalid trade.",
  );

  const gold = nonNegativeInt(
    rawGold,
    "Gold must be a whole number.",
  );

  const items = rawItems.map(
    (item: any, index: number) => ({
      inventoryId: positiveInt(
        item.inventoryId,
        "Invalid inventory item.",
      ),
      quantity: positiveInt(
        item.quantity,
        "Item quantity must be at least one.",
      ),
      slotNumber: index + 1,
    }),
  );

  if (items.length > 12) {
    throw new Error(
      "You can offer up to 12 item stacks.",
    );
  }

  const duplicateIds = new Set(
    items.map(item => item.inventoryId),
  );

  if (duplicateIds.size !== items.length) {
    throw new Error(
      "The same inventory item cannot be offered twice.",
    );
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const trade = await getLockedTrade(
      connection,
      tradeId,
    );

    assertParticipant(trade, playerId);

    await expireTradeIfNeeded(connection, trade);

    if (trade.status !== "active") {
      throw new Error("This trade is not active.");
    }

    const playerConfirmed = isInitiator(
      trade,
      playerId,
    )
      ? Boolean(trade.initiator_confirmed)
      : Boolean(trade.recipient_confirmed);

    if (playerConfirmed) {
      throw new Error(
        "Your offer is confirmed. Wait for the other player or cancel the trade.",
      );
    }

    const [playerRows]: any = await connection.query(
      `
        SELECT gold
        FROM players
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [playerId],
    );

    if (!playerRows.length) {
      throw new Error("Player not found.");
    }

    if (Number(playerRows[0].gold) < gold) {
      throw new Error(
        "You do not have enough gold.",
      );
    }

    for (const item of items) {
      const [inventoryRows]: any = await connection.query(
        `
          SELECT
            inv.inventory_id,
            inv.quantity,
            inv.player_item_id,
            inv.equipped,
            COALESCE(pi.is_equipped, 0) AS player_item_equipped

          FROM inventory inv

          LEFT JOIN player_items pi
            ON pi.id = inv.player_item_id

          WHERE inv.inventory_id = ?
            AND inv.player_id = ?
          LIMIT 1
          FOR UPDATE
        `,
        [
          item.inventoryId,
          playerId,
        ],
      );

      if (!inventoryRows.length) {
        throw new Error(
          "One of the offered items is no longer in your inventory.",
        );
      }

      const inventory = inventoryRows[0];

      if (
        Number(inventory.equipped) === 1 ||
        Number(inventory.player_item_equipped) === 1
      ) {
        throw new Error(
          "Unequip an item before offering it.",
        );
      }

      if (Number(inventory.quantity) < item.quantity) {
        throw new Error(
          "You do not have that many of an offered item.",
        );
      }

      if (
        inventory.player_item_id !== null &&
        item.quantity !== 1
      ) {
        throw new Error(
          "Unique equipment can only be traded one at a time.",
        );
      }
    }

    const goldColumn = isInitiator(trade, playerId)
      ? "initiator_gold"
      : "recipient_gold";

    await connection.query(
      `
        DELETE FROM player_trade_items
        WHERE trade_id = ?
          AND offered_by_player_id = ?
      `,
      [
        tradeId,
        playerId,
      ],
    );

    for (const item of items) {
      await connection.query(
        `
          INSERT INTO player_trade_items (
            trade_id,
            offered_by_player_id,
            slot_number,
            inventory_id,
            quantity
          )
          VALUES (?, ?, ?, ?, ?)
        `,
        [
          tradeId,
          playerId,
          item.slotNumber,
          item.inventoryId,
          item.quantity,
        ],
      );
    }

    await connection.query(
      `
        UPDATE player_trades
        SET
          ${goldColumn} = ?,
          initiator_confirmed = 0,
          recipient_confirmed = 0,
          initiator_accepted = 0,
          recipient_accepted = 0
        WHERE id = ?
      `,
      [
        gold,
        tradeId,
      ],
    );

    const result = await buildTradeView(
      connection,
      tradeId,
      playerId,
    );

    await connection.commit();

    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/* =========================================================
   CONFIRM / ACCEPT
========================================================= */

export async function confirmTrade(
  tradeId: number,
  playerId: number,
) {
  tradeId = positiveInt(
    tradeId,
    "Invalid trade.",
  );

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const trade = await getLockedTrade(
      connection,
      tradeId,
    );

    assertParticipant(trade, playerId);

    await expireTradeIfNeeded(connection, trade);

    if (trade.status !== "active") {
      throw new Error("This trade is not active.");
    }

    const confirmedColumn = isInitiator(trade, playerId)
      ? "initiator_confirmed"
      : "recipient_confirmed";

    await connection.query(
      `
        UPDATE player_trades
        SET ${confirmedColumn} = 1
        WHERE id = ?
      `,
      [tradeId],
    );

    const result = await buildTradeView(
      connection,
      tradeId,
      playerId,
    );

    await connection.commit();

    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

export async function acceptTrade(
  tradeId: number,
  playerId: number,
) {
  tradeId = positiveInt(
    tradeId,
    "Invalid trade.",
  );

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const trade = await getLockedTrade(
      connection,
      tradeId,
    );

    assertParticipant(trade, playerId);

    await expireTradeIfNeeded(connection, trade);

    if (trade.status !== "active") {
      throw new Error("This trade is not active.");
    }

    if (
      !trade.initiator_confirmed ||
      !trade.recipient_confirmed
    ) {
      throw new Error(
        "Both players must confirm their offers first.",
      );
    }

    const acceptedColumn = isInitiator(trade, playerId)
      ? "initiator_accepted"
      : "recipient_accepted";

    await connection.query(
      `
        UPDATE player_trades
        SET ${acceptedColumn} = 1
        WHERE id = ?
      `,
      [tradeId],
    );

    const updatedTrade = await getLockedTrade(
      connection,
      tradeId,
    );

    if (
      !updatedTrade.initiator_accepted ||
      !updatedTrade.recipient_accepted
    ) {
      const result = await buildTradeView(
        connection,
        tradeId,
        playerId,
      );

      await connection.commit();

      return result;
    }

    const [playerRows]: any = await connection.query(
      `
        SELECT id, gold
        FROM players
        WHERE id IN (?, ?)
        ORDER BY id ASC
        FOR UPDATE
      `,
      [
        updatedTrade.initiator_player_id,
        updatedTrade.recipient_player_id,
      ],
    );

    if (playerRows.length !== 2) {
      throw new Error("A trade participant no longer exists.");
    }

    const initiatorGold = Number(
      updatedTrade.initiator_gold,
    );

    const recipientGold = Number(
      updatedTrade.recipient_gold,
    );

    const initiator = playerRows.find(
      (row: any) =>
        Number(row.id) ===
        Number(updatedTrade.initiator_player_id),
    );

    const recipient = playerRows.find(
      (row: any) =>
        Number(row.id) ===
        Number(updatedTrade.recipient_player_id),
    );

    if (
      Number(initiator.gold) < initiatorGold ||
      Number(recipient.gold) < recipientGold
    ) {
      throw new Error(
        "A player no longer has enough gold for this trade.",
      );
    }

    const [offers]: any = await connection.query(
      `
        SELECT *
        FROM player_trade_items
        WHERE trade_id = ?
        ORDER BY id ASC
        FOR UPDATE
      `,
      [tradeId],
    );

    for (const offer of offers) {
      const [inventoryRows]: any = await connection.query(
        `
          SELECT
            inv.*,
            COALESCE(pi.is_equipped, 0) AS player_item_equipped

          FROM inventory inv

          LEFT JOIN player_items pi
            ON pi.id = inv.player_item_id

          WHERE inv.inventory_id = ?
            AND inv.player_id = ?
          LIMIT 1
          FOR UPDATE
        `,
        [
          offer.inventory_id,
          offer.offered_by_player_id,
        ],
      );

      if (!inventoryRows.length) {
        throw new Error(
          "An offered item is no longer available.",
        );
      }

      const inventory = inventoryRows[0];

      if (
        Number(inventory.equipped) === 1 ||
        Number(inventory.player_item_equipped) === 1 ||
        Number(inventory.quantity) < Number(offer.quantity)
      ) {
        throw new Error(
          "An offered item can no longer be traded.",
        );
      }

      if (
        inventory.player_item_id !== null &&
        Number(offer.quantity) !== 1
      ) {
        throw new Error(
          "A unique item has an invalid trade quantity.",
        );
      }

      const receiverId = otherPlayerId(
        updatedTrade,
        Number(offer.offered_by_player_id),
      );

      if (
        Number(inventory.quantity) ===
        Number(offer.quantity)
      ) {
        await connection.query(
          `
            UPDATE inventory
            SET
              player_id = ?,
              equipped = 0
            WHERE inventory_id = ?
          `,
          [
            receiverId,
            inventory.inventory_id,
          ],
        );

        if (inventory.player_item_id !== null) {
          await connection.query(
            `
              UPDATE player_items
              SET
                player_id = ?,
                is_equipped = 0
              WHERE id = ?
            `,
            [
              receiverId,
              inventory.player_item_id,
            ],
          );
        }
      } else {
        await connection.query(
          `
            UPDATE inventory
            SET quantity = quantity - ?
            WHERE inventory_id = ?
          `,
          [
            offer.quantity,
            inventory.inventory_id,
          ],
        );

        await connection.query(
          `
            INSERT INTO inventory (
              player_id,
              item_id,
              player_item_id,
              quantity,
              durability,
              randid,
              equipped
            )
            VALUES (?, ?, NULL, ?, ?, ?, 0)
          `,
          [
            receiverId,
            inventory.item_id,
            offer.quantity,
            inventory.durability,
            inventory.randid,
          ],
        );
      }
    }

    await connection.query(
      `
        UPDATE players
        SET gold =
          gold
          - CASE
              WHEN id = ? THEN ?
              ELSE ?
            END
          + CASE
              WHEN id = ? THEN ?
              ELSE ?
            END
        WHERE id IN (?, ?)
      `,
      [
        updatedTrade.initiator_player_id,
        initiatorGold,
        recipientGold,

        updatedTrade.initiator_player_id,
        recipientGold,
        initiatorGold,

        updatedTrade.initiator_player_id,
        updatedTrade.recipient_player_id,
      ],
    );

    const result = await buildTradeView(
      connection,
      tradeId,
      playerId,
    );

    // Preserve a final client-facing snapshot, then remove all transient
    // trade records in the same transaction as the item/gold transfer.
    result.status = "completed";

    await connection.query(
      `DELETE FROM player_trade_items WHERE trade_id = ?`,
      [tradeId],
    );

    await connection.query(
      `DELETE FROM player_trades WHERE id = ?`,
      [tradeId],
    );

    await connection.commit();

    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/* =========================================================
   CANCEL
========================================================= */

export async function cancelTrade(
  tradeId: number,
  playerId: number,
) {
  tradeId = positiveInt(
    tradeId,
    "Invalid trade.",
  );

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const trade = await getLockedTrade(
      connection,
      tradeId,
    );

    assertParticipant(trade, playerId);

    await expireTradeIfNeeded(connection, trade);

    if (!["requested", "active"].includes(trade.status)) {
      throw new Error("This trade is already closed.");
    }

    await connection.query(
      `DELETE FROM player_trade_items WHERE trade_id = ?`,
      [tradeId],
    );

    await connection.query(
      `DELETE FROM player_trades WHERE id = ?`,
      [tradeId],
    );

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}