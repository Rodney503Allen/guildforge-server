import { db } from "../db";
import { emitPlayerStatePatch } from "../socketServer";
import { getFinalPlayerStats } from "./playerService";
import {
  getPotionCooldownRemainingMs,
  getPotionCooldownSnapshot,
  startPotionCooldown,
  type CombatPotionSlot,
} from "./potionCooldownService";

export async function getEquippedCombatPotions(playerId: number) {
  const [[player]]: any = await db.query(
    `SELECT
       equip_potion_hp_inventory_id AS hpInv,
       equip_potion_sp_inventory_id AS spInv
     FROM players
     WHERE id = ?`,
    [playerId],
  );

  async function loadPotion(
    inventoryId: number | null,
    expectedTarget: "hp" | "sp",
  ) {
    if (!inventoryId) return null;

    const [[row]]: any = await db.query(
      `SELECT
         inv.inventory_id AS inventoryId,
         inv.quantity AS qty,
         i.id AS item_id,
         i.name,
         i.icon,
         i.type,
         i.effect_target,
         i.effect_value,
         i.effect_type,
         i.description,
         i.is_combat
       FROM inventory inv
       JOIN items i ON i.id = inv.item_id
       WHERE inv.inventory_id = ?
         AND inv.player_id = ?
       LIMIT 1`,
      [inventoryId, playerId],
    );

    if (!row || Number(row.qty) <= 0) return null;
    if (String(row.type) !== "potion") return null;
    if (Number(row.is_combat) !== 1) return null;
    if (String(row.effect_target).toLowerCase() !== expectedTarget) return null;
    return row;
  }

  const health = await loadPotion(player?.hpInv ?? null, "hp");
  const mana = await loadPotion(player?.spInv ?? null, "sp");

  if (!health && player?.hpInv) {
    await db.query(
      `UPDATE players SET equip_potion_hp_inventory_id = NULL WHERE id = ?`,
      [playerId],
    );
  }
  if (!mana && player?.spInv) {
    await db.query(
      `UPDATE players SET equip_potion_sp_inventory_id = NULL WHERE id = ?`,
      [playerId],
    );
  }

  return {
    health,
    mana,
    cooldowns: getPotionCooldownSnapshot(playerId),
  };
}

export async function useEquippedCombatPotion(
  playerId: number,
  slot: CombatPotionSlot,
) {
  const column = slot === "health"
    ? "equip_potion_hp_inventory_id"
    : "equip_potion_sp_inventory_id";

  const [[equipped]]: any = await db.query(
    `SELECT ${column} AS inventoryId FROM players WHERE id = ?`,
    [playerId],
  );
  const inventoryId = Number(equipped?.inventoryId);
  if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
    return { ok: false, status: 400, error: "No potion equipped." };
  }

  const [[item]]: any = await db.query(
    `SELECT
       inv.quantity,
       i.name,
       i.type,
       i.is_combat,
       i.effect_target,
       i.effect_value
     FROM inventory inv
     JOIN items i ON i.id = inv.item_id
     WHERE inv.inventory_id = ?
       AND inv.player_id = ?
     LIMIT 1`,
    [inventoryId, playerId],
  );

  const expectedTarget = slot === "health" ? "hp" : "sp";
  if (
    !item ||
    Number(item.quantity) <= 0 ||
    String(item.type) !== "potion" ||
    Number(item.is_combat) !== 1 ||
    String(item.effect_target).toLowerCase() !== expectedTarget
  ) {
    await db.query(`UPDATE players SET ${column} = NULL WHERE id = ?`, [playerId]);
    return { ok: false, status: 400, error: "The equipped potion is unavailable." };
  }

  const remainingMs = getPotionCooldownRemainingMs(playerId, slot);
  if (remainingMs > 0) {
    return { ok: false, status: 429, error: "cooldown", remainingMs };
  }

  const stats = await getFinalPlayerStats(playerId);
  if (!stats) {
    return { ok: false, status: 404, error: "Player not found." };
  }

  let hp = Number(stats.hpoints ?? 0);
  let sp = Number(stats.spoints ?? 0);
  const maxHp = Math.max(1, Number(stats.maxhp ?? 1));
  const maxSp = Math.max(0, Number(stats.maxspoints ?? 0));
  const amount = Math.max(0, Number(item.effect_value) || 0);

  if (slot === "health" && hp >= maxHp) {
    return { ok: false, status: 400, error: "Your HP is already full." };
  }
  if (slot === "mana" && sp >= maxSp) {
    return { ok: false, status: 400, error: "Your SP is already full." };
  }

  const before = slot === "health" ? hp : sp;
  if (slot === "health") hp = Math.min(maxHp, hp + amount);
  else sp = Math.min(maxSp, sp + amount);
  const restored = (slot === "health" ? hp : sp) - before;

  startPotionCooldown(playerId, slot);

  await db.query(
    slot === "health"
      ? `UPDATE players SET hpoints = ? WHERE id = ?`
      : `UPDATE players SET spoints = ? WHERE id = ?`,
    [slot === "health" ? hp : sp, playerId],
  );
  await db.query(
    `UPDATE inventory
     SET quantity = GREATEST(0, quantity - 1)
     WHERE inventory_id = ? AND player_id = ?`,
    [inventoryId, playerId],
  );
  await db.query(
    `DELETE FROM inventory
     WHERE inventory_id = ? AND player_id = ? AND quantity <= 0`,
    [inventoryId, playerId],
  );

  const [[after]]: any = await db.query(
    `SELECT quantity FROM inventory WHERE inventory_id = ? AND player_id = ?`,
    [inventoryId, playerId],
  );
  const depleted = !after || Number(after.quantity) <= 0;
  if (depleted) {
    await db.query(`UPDATE players SET ${column} = NULL WHERE id = ?`, [playerId]);
  }

  emitPlayerStatePatch(playerId, {
    hpoints: hp,
    maxhp: maxHp,
    spoints: sp,
    maxspoints: maxSp,
  });

  return {
    ok: true,
    log: `🧪 ${stats.name ?? "Adventurer"} used ${item.name} and restored ${restored} ${slot === "health" ? "HP" : "SP"}.`,
    playerHP: hp,
    playerSP: sp,
    restored,
    depleted,
    cooldownMs: 20_000,
  };
}
