// services/inventoryService.ts
import { db } from "../db";

export type InventoryRow = {
  inventory_id: number;
  player_id: number;
  item_id: number | null;
  player_item_id: number | null;
  quantity: number;
  equipped: 0 | 1;
};

export type InventoryItemView = {
  id: number; // inventory_id
  source: "inventory";
  item_id: number | null;
  player_item_id: number | null;

  name: string;
  category: string | null;
  item_type: string | null;
  slot: string | null;
  armor_weight: string | null;

  value: number | null;
  quantity: number;
  equipped: number;
  icon: string | null;
  rarity: string | null;
  description?: string | null;

  item_level?: number | null;
  base_attack?: number | null;
  base_defense?: number | null;
  roll_json?: any;
};

function parseRollJson(v: any) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return [];
  }
}

export async function getInventory(pid: number): Promise<InventoryItemView[]> {
  const [rows]: any = await db.query(
    `
    SELECT
      inv.inventory_id AS id,
      'inventory' AS source,
      inv.item_id,
      inv.player_item_id,
      inv.quantity,
      inv.equipped,

      -- static item path
      i.name AS static_name,
      i.category AS static_category,
      i.type AS static_type,
      i.slot AS static_slot,
      i.value AS static_value,
      i.icon AS static_icon,
      i.rarity AS static_rarity,
      i.description AS static_description,

      -- rolled item path
      pi.item_level AS rolled_item_level,
      pi.rarity AS rolled_rarity,
      pi.roll_json AS rolled_roll_json,

      ib.name AS base_name,
      ib.item_type AS base_item_type,
      ib.slot AS base_slot,
      ib.armor_weight AS base_armor_weight,
      ib.sell_value AS base_sell_value,
      ib.icon AS base_icon,
      ib.description AS base_description,
      ib.base_attack AS base_attack,
      ib.base_defense AS base_defense

    FROM inventory inv
    LEFT JOIN items i
      ON i.id = inv.item_id
    LEFT JOIN player_items pi
      ON pi.id = inv.player_item_id
    LEFT JOIN item_bases ib
      ON ib.id = pi.item_base_id
    WHERE inv.player_id = ?
    ORDER BY inv.equipped DESC, COALESCE(i.name, ib.name) ASC
    `,
    [pid]
  );

  return (rows || []).map((r: any) => {
    const isRolled = r.player_item_id != null;

    return {
      id: Number(r.id),
      source: "inventory",
      item_id: r.item_id != null ? Number(r.item_id) : null,
      player_item_id: r.player_item_id != null ? Number(r.player_item_id) : null,

      name: isRolled ? r.base_name : r.static_name,
      category: isRolled ? "equipment" : (r.static_category ?? null),
      item_type: isRolled ? r.base_item_type : (r.static_type ?? null),
      slot: isRolled ? r.base_slot : (r.static_slot ?? null),
      armor_weight: isRolled ? r.base_armor_weight : null,

      value: isRolled ? Number(r.base_sell_value || 0) : (r.static_value != null ? Number(r.static_value) : null),
      quantity: Number(r.quantity || 1),
      equipped: Number(r.equipped || 0),
      icon: isRolled ? r.base_icon : r.static_icon,
      rarity: isRolled ? r.rolled_rarity : r.static_rarity,
      description: isRolled ? r.base_description : r.static_description,

      item_level: isRolled && r.rolled_item_level != null ? Number(r.rolled_item_level) : null,
      base_attack: isRolled && r.base_attack != null ? Number(r.base_attack) : null,
      base_defense: isRolled && r.base_defense != null ? Number(r.base_defense) : null,
      roll_json: isRolled ? parseRollJson(r.rolled_roll_json) : null
    };
  });
}

export async function getSlotForInventoryId(pid: number, invId: number): Promise<string | null> {
  const [[row]]: any = await db.query(
    `
    SELECT
      i.slot AS static_slot,
      ib.slot AS rolled_slot
    FROM inventory inv
    LEFT JOIN items i
      ON i.id = inv.item_id
    LEFT JOIN player_items pi
      ON pi.id = inv.player_item_id
    LEFT JOIN item_bases ib
      ON ib.id = pi.item_base_id
    WHERE inv.inventory_id = ?
      AND inv.player_id = ?
    LIMIT 1
    `,
    [invId, pid]
  );

  return row?.rolled_slot ?? row?.static_slot ?? null;
}

export async function getSlotForPlayerItemId(pid: number, playerItemId: number): Promise<string | null> {
  const [[row]]: any = await db.query(
    `
    SELECT ib.slot
    FROM player_items pi
    JOIN item_bases ib ON ib.id = pi.item_base_id
    WHERE pi.id = ? AND pi.player_id = ?
    LIMIT 1
    `,
    [playerItemId, pid]
  );

  return row?.slot ?? null;
}

const STACKABLE_CATEGORIES = new Set(["material", "consumable", "quest", "misc"]);

// Same rules as addItemAtomic, but uses an existing transaction connection.
// IMPORTANT: caller must begin/commit/rollback.
export async function addItemWithConn(
  conn: any,
  pid: number,
  itemId: number,
  qty = 1
): Promise<void> {
  qty = Math.max(1, Math.floor(qty));

  const [[item]]: any = await conn.query(
    `SELECT category FROM items WHERE id=? LIMIT 1 FOR UPDATE`,
    [itemId]
  );
  if (!item) throw new Error("ITEM_NOT_FOUND");

  const category = String(item.category || "").toLowerCase();
  const isStackable = STACKABLE_CATEGORIES.has(category);

  if (isStackable) {
    const [[row]]: any = await conn.query(
      `
      SELECT inventory_id
      FROM inventory
      WHERE player_id=?
        AND item_id=?
        AND player_item_id IS NULL
        AND equipped=0
        AND randid IS NULL
        AND durability IS NULL
      ORDER BY inventory_id ASC
      LIMIT 1
      FOR UPDATE
      `,
      [pid, itemId]
    );

    if (row?.inventory_id) {
      const [u]: any = await conn.query(
        `UPDATE inventory SET quantity = quantity + ? WHERE inventory_id=? AND player_id=?`,
        [qty, row.inventory_id, pid]
      );
      if (!u?.affectedRows) throw new Error("INV_ADD_FAILED");
    } else {
      const [i]: any = await conn.query(
        `INSERT INTO inventory (player_id, item_id, player_item_id, quantity, equipped, durability, randid)
         VALUES (?, ?, NULL, ?, 0, NULL, NULL)`,
        [pid, itemId, qty]
      );
      if (!i?.affectedRows) throw new Error("INV_INSERT_FAILED");
    }

    return;
  }

  for (let n = 0; n < qty; n++) {
    const [i]: any = await conn.query(
      `INSERT INTO inventory (player_id, item_id, player_item_id, quantity, equipped, durability, randid)
       VALUES (?, ?, NULL, 1, 0, NULL, NULL)`,
      [pid, itemId]
    );
    if (!i?.affectedRows) throw new Error("INV_INSERT_FAILED");
  }
}

export async function addPlayerItemToInventoryWithConn(
  conn: any,
  pid: number,
  playerItemId: number
): Promise<void> {
  const [i]: any = await conn.query(
    `
    INSERT INTO inventory (
      player_id,
      item_id,
      player_item_id,
      quantity,
      equipped,
      durability,
      randid
    )
    VALUES (?, NULL, ?, 1, 0, NULL, NULL)
    `,
    [pid, playerItemId]
  );

  if (!i?.affectedRows) throw new Error("INV_PLAYER_ITEM_INSERT_FAILED");
}

export async function addItemAtomic(
  pid: number,
  itemId: number,
  qty = 1
): Promise<void> {
  qty = Math.max(1, Math.floor(qty));

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await addItemWithConn(conn, pid, itemId, qty);
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}

/**
 * Remove qty from a specific inventory instance (inventory_id).
 * Safe for static stacked items only.
 */
export async function removeFromStack(
  pid: number,
  invId: number,
  qty = 1
): Promise<{ removed: number; deletedRow: boolean }> {
  qty = Math.max(1, Math.floor(qty));

  const [[row]]: any = await db.query(
    `SELECT inventory_id, item_id, player_item_id, quantity FROM inventory WHERE inventory_id=? AND player_id=? LIMIT 1`,
    [invId, pid]
  );
  if (!row) throw new Error("INV_NOT_FOUND");
  if (row.player_item_id != null) throw new Error("INV_NOT_STACKABLE");

  const available = Math.max(1, Number(row.quantity) || 1);
  const take = Math.min(available, qty);

  if (available > take) {
    const [r]: any = await db.query(
      `UPDATE inventory SET quantity = quantity - ? WHERE inventory_id=? AND player_id=?`,
      [take, invId, pid]
    );
    if (!r?.affectedRows) throw new Error("INV_REMOVE_FAILED");
    return { removed: take, deletedRow: false };
  } else {
    const [r]: any = await db.query(
      `DELETE FROM inventory WHERE inventory_id=? AND player_id=?`,
      [invId, pid]
    );
    if (!r?.affectedRows) throw new Error("INV_DELETE_FAILED");
    return { removed: take, deletedRow: true };
  }
}

export async function removeItemFromInventory(
  pid: number,
  itemId: number,
  qty = 1
): Promise<{ removed: number }> {
  qty = Math.max(1, Math.floor(qty));

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows]: any = await conn.query(
      `
      SELECT inventory_id, quantity
      FROM inventory
      WHERE player_id = ?
        AND item_id = ?
        AND player_item_id IS NULL
        AND equipped = 0
      ORDER BY inventory_id ASC
      FOR UPDATE
      `,
      [pid, itemId]
    );

    let remaining = qty;
    let removed = 0;

    for (const r of rows) {
      if (remaining <= 0) break;

      const available = Math.max(0, Number(r.quantity) || 0);
      const take = Math.min(available, remaining);

      if (available > take) {
        const [u]: any = await conn.query(
          `UPDATE inventory SET quantity = quantity - ? WHERE inventory_id=? AND player_id=?`,
          [take, r.inventory_id, pid]
        );
        if (!u?.affectedRows) throw new Error("INV_REMOVE_FAILED");
      } else {
        const [d]: any = await conn.query(
          `DELETE FROM inventory WHERE inventory_id=? AND player_id=?`,
          [r.inventory_id, pid]
        );
        if (!d?.affectedRows) throw new Error("INV_DELETE_FAILED");
      }

      removed += take;
      remaining -= take;
    }

    await conn.commit();
    return { removed };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}

export const SELL_RATE = 0.35;

export async function sellItemAtomic(
  pid: number,
  itemId: number,
  qty: number
): Promise<{ removed: number; goldGained: number }> {
  qty = Math.max(1, Math.floor(qty));

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[item]]: any = await conn.query(
      `SELECT value FROM items WHERE id = ? LIMIT 1 FOR UPDATE`,
      [itemId]
    );
    if (!item) {
      await conn.rollback();
      return { removed: 0, goldGained: 0 };
    }

    const value = Math.max(0, Number(item.value) || 0);
    const unit = Math.max(0, Math.floor(value * SELL_RATE));

    const [rows]: any = await conn.query(
      `
      SELECT inventory_id, quantity
      FROM inventory
      WHERE player_id = ?
        AND item_id = ?
        AND player_item_id IS NULL
        AND equipped = 0
      ORDER BY inventory_id ASC
      FOR UPDATE
      `,
      [pid, itemId]
    );

    if (!rows || rows.length === 0) {
      await conn.rollback();
      return { removed: 0, goldGained: 0 };
    }

    let remaining = qty;
    let removed = 0;

    for (const r of rows) {
      if (remaining <= 0) break;

      const available = Math.max(1, Number(r.quantity) || 1);
      const take = Math.min(available, remaining);

      if (available > take) {
        const [u]: any = await conn.query(
          `UPDATE inventory SET quantity = quantity - ? WHERE inventory_id = ? AND player_id = ?`,
          [take, r.inventory_id, pid]
        );
        if (!u?.affectedRows) throw new Error("INV_REMOVE_FAILED");
      } else {
        const [d]: any = await conn.query(
          `DELETE FROM inventory WHERE inventory_id = ? AND player_id = ?`,
          [r.inventory_id, pid]
        );
        if (!d?.affectedRows) throw new Error("INV_DELETE_FAILED");
      }

      removed += take;
      remaining -= take;
    }

    const goldGained = unit * removed;

    if (goldGained > 0) {
      const [g]: any = await conn.query(
        `UPDATE players SET gold = gold + ? WHERE id = ?`,
        [goldGained, pid]
      );
      if (!g?.affectedRows) throw new Error("GOLD_UPDATE_FAILED");
    }

    await conn.commit();
    return { removed, goldGained };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}

function getRolledRarityMultiplier(rarity: string | null | undefined): number {
  switch (String(rarity || "").toLowerCase()) {
    case "awakened":
      return 1.15;
    case "empowered":
      return 1.35;
    case "transcendent":
      return 1.75;
    case "dormant":
    default:
      return 1;
  }
}

export async function sellInventoryEntryAtomic(
  pid: number,
  inventoryId: number,
  qty: number
): Promise<{ removed: number; goldGained: number }> {
  qty = Math.max(1, Math.floor(qty));

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[inv]]: any = await conn.query(
      `
      SELECT
        inventory_id,
        item_id,
        player_item_id,
        quantity,
        equipped
      FROM inventory
      WHERE inventory_id = ?
        AND player_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [inventoryId, pid]
    );

    if (!inv) {
      await conn.rollback();
      return { removed: 0, goldGained: 0 };
    }

    if (Number(inv.equipped) === 1) {
      await conn.rollback();
      return { removed: 0, goldGained: 0 };
    }

    // Rolled equipment
    if (inv.player_item_id != null) {
      const [[rolled]]: any = await conn.query(
        `
        SELECT
          pi.id,
          pi.rarity,
          ib.sell_value
        FROM player_items pi
        JOIN item_bases ib ON ib.id = pi.item_base_id
        WHERE pi.id = ?
          AND pi.player_id = ?
        LIMIT 1
        FOR UPDATE
        `,
        [inv.player_item_id, pid]
      );

      if (!rolled) {
        await conn.rollback();
        return { removed: 0, goldGained: 0 };
      }

      const baseValue = Math.max(0, Number(rolled.sell_value) || 0);
      const rarityMult = getRolledRarityMultiplier(rolled.rarity);
      const finalValue = baseValue * rarityMult;
      const goldGained = Math.max(0, Math.floor(finalValue * SELL_RATE));

      const [d1]: any = await conn.query(
        `DELETE FROM inventory WHERE inventory_id = ? AND player_id = ?`,
        [inventoryId, pid]
      );
      if (!d1?.affectedRows) throw new Error("INV_DELETE_FAILED");

      const [d2]: any = await conn.query(
        `DELETE FROM player_items WHERE id = ? AND player_id = ?`,
        [inv.player_item_id, pid]
      );
      if (!d2?.affectedRows) throw new Error("PLAYER_ITEM_DELETE_FAILED");

      if (goldGained > 0) {
        const [g]: any = await conn.query(
          `UPDATE players SET gold = gold + ? WHERE id = ?`,
          [goldGained, pid]
        );
        if (!g?.affectedRows) throw new Error("GOLD_UPDATE_FAILED");
      }

      await conn.commit();
      return { removed: 1, goldGained };
    }

    // Static item
    if (inv.item_id == null) {
      await conn.rollback();
      return { removed: 0, goldGained: 0 };
    }

    const [[item]]: any = await conn.query(
      `SELECT value FROM items WHERE id = ? LIMIT 1 FOR UPDATE`,
      [inv.item_id]
    );

    if (!item) {
      await conn.rollback();
      return { removed: 0, goldGained: 0 };
    }

    const available = Math.max(0, Number(inv.quantity) || 0);
    const removed = Math.min(available, qty);

    if (removed <= 0) {
      await conn.rollback();
      return { removed: 0, goldGained: 0 };
    }

    if (available > removed) {
      const [u]: any = await conn.query(
        `UPDATE inventory SET quantity = quantity - ? WHERE inventory_id = ? AND player_id = ?`,
        [removed, inventoryId, pid]
      );
      if (!u?.affectedRows) throw new Error("INV_REMOVE_FAILED");
    } else {
      const [d]: any = await conn.query(
        `DELETE FROM inventory WHERE inventory_id = ? AND player_id = ?`,
        [inventoryId, pid]
      );
      if (!d?.affectedRows) throw new Error("INV_DELETE_FAILED");
    }

    const unit = Math.max(0, Math.floor((Number(item.value) || 0) * SELL_RATE));
    const goldGained = unit * removed;

    if (goldGained > 0) {
      const [g]: any = await conn.query(
        `UPDATE players SET gold = gold + ? WHERE id = ?`,
        [goldGained, pid]
      );
      if (!g?.affectedRows) throw new Error("GOLD_UPDATE_FAILED");
    }

    await conn.commit();
    return { removed, goldGained };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}