import express from "express";
import { db } from "./db";

const router = express.Router();

// ===========================
// GET INVENTORY (STACKED)
// ===========================
router.get("/api/inventory", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.json({ error: "Not logged in" });

  const [items]: any = await db.query(`
    SELECT
      inv.inventory_id AS id,
      inv.item_id,
      i.name,
      i.category,
      i.value,
      inv.quantity,
      inv.equipped,
      i.icon,
      i.rarity
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.player_id = ?
    ORDER BY inv.equipped DESC, i.name ASC
  `, [pid]);

  res.json(items);
});





router.get("/api/inventory/slot-check/:id", async (req, res) => {
  const pid = (req.session as any).playerId;
  const invId = req.params.id;

  const [[row]]: any = await db.execute(`
    SELECT i.slot
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ? AND inv.player_id = ?
  `,[invId,pid]);

  if (!row) return res.json({ error: true });

  res.json({ slot: row.slot });
});
// ===========================
// USE ITEM (STACK SAFE)
// ===========================
router.post("/api/inventory/use", async (req, res) => {
  const pid = (req.session as any).playerId;
  const { invId } = req.body;

  if (!pid) return res.json({ error: "Not logged in" });

  const [[item]]: any = await db.query(`
    SELECT
      inv.quantity,
      i.category,
      i.effect_type,
      i.effect_target,
      i.effect_value
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ? AND inv.player_id = ?
  `, [invId, pid]);

  if (!item) return res.json({ error: "Item not found" });


  // ===========================
// ITEM EFFECT ENGINE
// ===========================
if (item.category !== "consumable")
  return res.json({ error: "That item is not usable." });

let message = "";

switch (item.effect_type) {

  case "restore":
    if (item.effect_target === "hp") {
      await db.query(
        "UPDATE players SET hpoints = LEAST(maxhp, hpoints + ?) WHERE id = ?",
        [item.effect_value, pid]
      );
      message = `💚 Restored ${item.effect_value} HP`;
    }

    if (item.effect_target === "sp") {
      await db.query(
        "UPDATE players SET spoints = LEAST(maxspoints, spoints + ?) WHERE id = ?",
        [item.effect_value, pid]
      );
      message = `🔮 Restored ${item.effect_value} MP`;
    }
    break;

  case "buff":
    await db.query(
      `UPDATE players SET ${item.effect_target} = ${item.effect_target} + ? WHERE id = ?`,
      [item.effect_value, pid]
    );
    message = `📜 ${item.effect_target} increased by ${item.effect_value}`;
    break;

  case "damage":
    await db.query(
      `UPDATE players SET hpoints = GREATEST(0, hpoints - ?) WHERE id = ?`,
      [item.effect_value, pid]
    );
    message = `☠ Took ${item.effect_value} damage`;
    break;

  default:
    return res.json({ error: "This item has no effect." });
}





























  // ======================
  // STACK DECREMENT
  // ======================
  if (item.quantity > 1) {
    await db.query(`
      UPDATE inventory
      SET quantity = quantity - 1
      WHERE inventory_id = ?
    `, [invId]);
  } else {
    await db.query(`
      DELETE FROM inventory
      WHERE inventory_id = ?
    `, [invId]);
  }

  // ======================
  // RETURN UPDATED HP
  // ======================
  const [[player]]: any = await db.query(
    "SELECT hpoints, maxhp, spoints, maxspoints FROM players WHERE id=?",
    [pid]
  );

res.json({
  success: true,
  removed: 1,
  hp: player.hpoints,
  maxhp: player.maxhp,
  sp: player.spoints,
  maxsp: player.maxspoints
});
});

export default router;
