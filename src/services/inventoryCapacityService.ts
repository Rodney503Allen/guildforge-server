import { db } from "../db";

const BASE_INVENTORY_CAPACITY = 20;

export async function getInventoryCapacity(playerId: number) {
  const [[row]]: any = await db.query(
    `
      SELECT COALESCE(i.inventory_slots, 0) AS backpackBonus
      FROM inventory inv
      JOIN items i ON i.id = inv.item_id
      WHERE inv.player_id = ?
        AND inv.equipped = 1
        AND i.slot = 'backpack'
      LIMIT 1
    `,
    [playerId]
  );

  const backpackBonus = Math.max(0, Number(row?.backpackBonus || 0));
  return BASE_INVENTORY_CAPACITY + backpackBonus;
}

export async function getUsedInventorySlots(playerId: number) {
  const [[row]]: any = await db.query(
    `
      SELECT COUNT(*) AS usedSlots
      FROM inventory
      WHERE player_id = ?
        AND equipped = 0
        AND quantity > 0
    `,
    [playerId]
  );

  return Number(row?.usedSlots || 0);
}

export async function hasInventorySpace(playerId: number, slotsNeeded = 1) {
  const capacity = await getInventoryCapacity(playerId);
  const used = await getUsedInventorySlots(playerId);

  return {
    hasSpace: used + slotsNeeded <= capacity,
    used,
    capacity,
    remaining: Math.max(0, capacity - used)
  };
}

export async function canUseBackpackCapacity(
  playerId: number,
  backpackBonus: number,
  additionalInventorySlots = 0
) {
  const used = await getUsedInventorySlots(playerId);
  const capacity = BASE_INVENTORY_CAPACITY + Math.max(0, Number(backpackBonus || 0));
  const required = used + Math.max(0, Number(additionalInventorySlots || 0));

  return {
    canFit: required <= capacity,
    used,
    required,
    capacity,
    remaining: Math.max(0, capacity - required)
  };
}
