import { db } from "../db";
import { addItemWithConn } from "./inventoryService";

/**
 * Drop type expected from loot rolls.
 * You can extend later with rarity, roll_json, etc.
 */
export type DropLine = {
  item_id?: number | null;
  player_item_id?: number | null;
  qty: number;
  roll_json?: any;
};

export type ChestSourceType = "combat" | "quest" | "guild" | "admin";
export type LootRarity = "base" | "dormant" | "awakened" | "empowered" | "transcendent";

export type ChestRow = {
  id: number;
  player_id: number;
  source_type: ChestSourceType;
  source_id: number | null;
  state: "sealed" | "opened" | "claimed";
  created_at: string;
  opened_at: string | null;
  claimed_at: string | null;
};

const RARITY_ORDER: Record<LootRarity, number> = {
  base: 0,
  dormant: 1,
  awakened: 2,
  empowered: 3,
  transcendent: 4,
};

function normalizeRarity(value: any): LootRarity {
  const v = String(value ?? "base").toLowerCase().trim();

  if (
    v === "base" ||
    v === "dormant" ||
    v === "awakened" ||
    v === "empowered" ||
    v === "transcendent"
  ) {
    return v;
  }

  return "base";
}

function getHighestRarityFromItems(items: any[]): LootRarity {
  let best: LootRarity = "base";

  for (const it of items ?? []) {
    const rarity = normalizeRarity(it?.rarity);
    if (RARITY_ORDER[rarity] > RARITY_ORDER[best]) {
      best = rarity;
    }
  }

  return best;
}

async function getChestItemsWithDisplayData(playerId: number, chestId: number) {
  const [items]: any = await db.query(
    `
    SELECT
        pci.id,
        pci.item_id,
        pci.player_item_id,
        pci.qty,
        pci.roll_json,

        -- static items
        i.name AS static_name,
        i.icon AS static_icon,
        i.rarity AS static_rarity,
        i.type AS static_type,
        i.description AS static_description,
        i.value AS static_value,

        -- rolled items
        pi.name AS rolled_name,
        pi.item_level AS rolled_item_level,
        pi.rarity AS rolled_rarity,
        pi.is_equipped AS rolled_is_equipped,

        ib.icon AS rolled_icon,
        ib.slot AS rolled_slot,
        ib.item_type AS rolled_item_type,
        ib.armor_weight AS rolled_armor_weight,
        COALESCE(ib.base_attack, 0) AS rolled_base_attack,
        COALESCE(ib.base_defense, 0) AS rolled_base_defense

    FROM player_chest_items pci
    LEFT JOIN items i
      ON i.id = pci.item_id
    LEFT JOIN player_items pi
      ON pi.id = pci.player_item_id
     AND pi.player_id = ?
    LEFT JOIN item_bases ib
      ON ib.id = pi.item_base_id
    WHERE pci.chest_id = ?
    ORDER BY pci.id ASC
    `,
    [playerId, chestId]
  );

  return (items ?? []).map((it: any) => {
    const isRolled = it.player_item_id != null && it.rolled_name != null;

    return {
      id: Number(it.id),
      item_id: it.item_id != null ? Number(it.item_id) : null,
      player_item_id: it.player_item_id != null ? Number(it.player_item_id) : null,
      qty: Number(it.qty),

      name: isRolled ? it.rolled_name : it.static_name,
      icon: isRolled ? it.rolled_icon : it.static_icon,
      rarity: normalizeRarity(isRolled ? it.rolled_rarity : it.static_rarity),

      type: isRolled ? "equipment" : (it.static_type ?? null),
      description: isRolled ? null : (it.static_description ?? null),
      value: isRolled
        ? null
        : (it.static_value != null ? Number(it.static_value) : null),

      roll_json: it.roll_json ? safeParseJson(it.roll_json) : null,

      slot: isRolled ? it.rolled_slot : null,
      item_type: isRolled ? it.rolled_item_type : null,
      armor_weight: isRolled ? it.rolled_armor_weight : null,
      item_level: isRolled && it.rolled_item_level != null ? Number(it.rolled_item_level) : null,
      base_attack: isRolled && it.rolled_base_attack != null ? Number(it.rolled_base_attack) : null,
      base_defense: isRolled && it.rolled_base_defense != null ? Number(it.rolled_base_defense) : null,
      is_rolled: isRolled
    };
  });
}

async function insertChestItems(
  chestId: number,
  drops: DropLine[],
  conn?: any
) {
  if (!drops.length) return;

  const q = `
    INSERT INTO player_chest_items (chest_id, item_id, player_item_id, qty, roll_json)
    VALUES ?
  `;

  for (const d of drops) {
    const hasStatic = d.item_id != null;
    const hasRolled = d.player_item_id != null;

    if (!hasStatic && !hasRolled) {
      throw new Error("Invalid chest drop: missing item_id and player_item_id");
    }

    if (hasStatic && hasRolled) {
      throw new Error("Invalid chest drop: cannot have both item_id and player_item_id");
    }
  }

  const values = drops.map((d) => [
    chestId,
    d.item_id != null ? Number(d.item_id) : null,
    d.player_item_id != null ? Number(d.player_item_id) : null,
    Number(d.qty ?? 1),
    d.roll_json ? JSON.stringify(d.roll_json) : null
  ]);

  if (conn) return conn.query(q, [values]);
  return db.query(q, [values]);
}

export async function createChestFromDrops(args: {
  playerId: number;
  sourceType: ChestSourceType;
  sourceId?: number | null;
  drops: DropLine[];
  conn?: any; // optional transaction connection
}): Promise<{ chestId: number } | null> {
  const { playerId, sourceType, sourceId = null, drops, conn } = args;

  // No drops? No chest.
  if (!drops || drops.length === 0) return null;

  const q = `
    INSERT INTO player_chests (player_id, source_type, source_id, state)
    VALUES (?, ?, ?, 'sealed')
  `;

  const runner = conn ?? db;

  const [result]: any = await runner.query(q, [playerId, sourceType, sourceId]);
  const chestId = Number(result.insertId);

  await insertChestItems(chestId, drops, conn);

  return { chestId };
}

export async function getPendingChest(playerId: number): Promise<(ChestRow & { rarity: LootRarity }) | null> {
  const q = `
    SELECT *
    FROM player_chests
    WHERE player_id = ?
      AND state IN ('sealed','opened')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const [[row]]: any = await db.query(q, [playerId]);
  if (!row) return null;

  const items = await getChestItemsWithDisplayData(playerId, Number(row.id));
  const rarity = getHighestRarityFromItems(items);

  return {
    ...(row as ChestRow),
    rarity
  };
}

export async function openChest(playerId: number, chestId: number) {
  // Ensure ownership + not claimed
  const [[chest]]: any = await db.query(
    `SELECT * FROM player_chests WHERE id=? AND player_id=? LIMIT 1`,
    [chestId, playerId]
  );
  if (!chest) return { ok: false, error: "Chest not found" as const };
  if (chest.state === "claimed") return { ok: false, error: "Chest already claimed" as const };

  // Move sealed -> opened (idempotent: if already opened, keep)
  if (chest.state === "sealed") {
    await db.query(
      `UPDATE player_chests SET state='opened', opened_at=NOW() WHERE id=? AND player_id=?`,
      [chestId, playerId]
    );
  }

  const mappedItems = await getChestItemsWithDisplayData(playerId, chestId);
  const chestRarity = getHighestRarityFromItems(mappedItems);

  return {
    ok: true,
    chest: {
      id: Number(chestId),
      state: "opened" as const,
      rarity: chestRarity
    },
    items: mappedItems
  };
}

export async function claimChest(playerId: number, chestId: number) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[chest]]: any = await conn.query(
      `SELECT * FROM player_chests WHERE id=? AND player_id=? FOR UPDATE`,
      [chestId, playerId]
    );
    if (!chest) throw new Error("CHEST_NOT_FOUND");
    if (chest.state === "claimed") throw new Error("CHEST_ALREADY_CLAIMED");

    const [items]: any = await conn.query(
      `SELECT item_id, player_item_id, qty FROM player_chest_items WHERE chest_id=?`,
      [chestId]
    );

    for (const it of items ?? []) {
      if (it.item_id != null) {
        await addItemWithConn(conn, playerId, Number(it.item_id), Number(it.qty));
      }

      if (it.player_item_id != null) {
        await conn.query(
          `
          UPDATE player_items
          SET is_claimed = 1
          WHERE id = ?
            AND player_id = ?
          `,
          [Number(it.player_item_id), playerId]
        );

        await conn.query(
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
          [playerId, Number(it.player_item_id)]
        );
      }
    }

    await conn.query(
      `UPDATE player_chests SET state='claimed', claimed_at=NOW() WHERE id=? AND player_id=?`,
      [chestId, playerId]
    );

    await conn.commit();
    return { ok: true };
  } catch (err: any) {
    try { await conn.rollback(); } catch {}
    return { ok: false, error: err?.message ?? "Claim failed" };
  } finally {
    try { conn.release(); } catch {}
  }
}

function safeParseJson(v: any) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}