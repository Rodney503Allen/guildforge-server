import { db } from "../db";

// ==============================
// PLAYER WITH EQUIPMENT STATS
// ==============================
export async function getPlayerWithEquipment(playerId: number) {

  // Base stats
  const [[base]]: any = await db.query(`
    SELECT *
    FROM players
    WHERE id = ?
  `, [playerId]);

  if (!base) return null;

  // All equipped items
  const [gear]: any = await db.query(`
    SELECT i.*
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.player_id = ? AND inv.equipped = 1
  `, [playerId]);

  // Clone base stats so we don't overwrite DB object
  const final = { ...base };

  // Apply all equipment modifiers
  for (const g of gear) {
    final.attack    += g.attack || 0;
    final.defense   += g.defense || 0;
    final.agility   += g.agility || 0;
    final.vitality  += g.vitality || 0;
    final.intellect += g.intellect || 0;
    final.crit      += g.crit || 0;
  }

  return final;
}


// ==============================
// LEGACY SUPPORT (OPTIONAL)
// ==============================
export async function getPlayerById(id: number) {
  return getPlayerWithEquipment(id);
}
