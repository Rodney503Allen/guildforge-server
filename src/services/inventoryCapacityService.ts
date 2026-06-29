import { db } from "../db";

const BASE_INVENTORY_CAPACITY = 20;


export async function getInventoryCapacity(playerId: number) {
  // Future:
  // SELECT backpack_capacity_bonus FROM equipped_backpack ...

  const backpackBonus = 0;

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

export async function hasInventorySpace(
  playerId: number,
  slotsNeeded = 1
) {
  const capacity = await getInventoryCapacity(playerId);
  const used = await getUsedInventorySlots(playerId);

  return {
    hasSpace: used + slotsNeeded <= capacity,
    used,
    capacity,
    remaining: Math.max(0, capacity - used)
  };
}