// src/services/consumableService.ts

import { db } from "../db";
import { applyBuff, getActiveBuffs } from "./buffService";
import { getFinalPlayerStats } from "./playerService";
import { publishPlayerStatePatch } from "../playerStateEvents";

export type ConsumableEffectType = "buff" | "heal" | "restore_sp";

export type ConsumableEffect = {
  id: number;
  item_id: number;
  effect_type: ConsumableEffectType;
  stat_key: string | null;
  effect_value: number;
  duration_seconds: number;
  stacking_group: string | null;
  display_order: number;
};

export type RestConsumable = {
  itemId: number;
  name: string;
  icon: string | null;
  description: string | null;
  family: string | null;
  quantity: number;
  effects: ConsumableEffect[];
};

function cleanSourcePart(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .slice(0, 18);
}

function getEffectSource(itemId: number, stackingGroup?: string | null): string {
  const group = cleanSourcePart(stackingGroup || `item_${itemId}`);
  // player_buffs.source is currently varchar(32)
  return `consumable:${group}`.slice(0, 32);
}

async function loadItemEffects(itemId: number): Promise<ConsumableEffect[]> {
  const [rows]: any = await db.query(
    `
      SELECT
        id,
        item_id,
        effect_type,
        stat_key,
        effect_value,
        duration_seconds,
        stacking_group,
        display_order
      FROM item_effects
      WHERE item_id = ?
        AND is_active = 1
      ORDER BY display_order ASC, id ASC
    `,
    [itemId],
  );

  return (rows || []).map((row: any) => ({
    id: Number(row.id),
    item_id: Number(row.item_id),
    effect_type: String(row.effect_type) as ConsumableEffectType,
    stat_key: row.stat_key ? String(row.stat_key) : null,
    effect_value: Number(row.effect_value) || 0,
    duration_seconds: Number(row.duration_seconds) || 0,
    stacking_group: row.stacking_group ? String(row.stacking_group) : null,
    display_order: Number(row.display_order) || 0,
  }));
}

export async function getRestConsumables(playerId: number): Promise<RestConsumable[]> {
  const [rows]: any = await db.query(
    `
      SELECT
        i.id,
        i.name,
        i.icon,
        i.description,
        i.consumable_family,
        SUM(inv.quantity) AS quantity
      FROM inventory inv
      JOIN items i ON i.id = inv.item_id
      WHERE inv.player_id = ?
        AND inv.item_id IS NOT NULL
        AND inv.quantity > 0
        AND i.category = 'consumable'
        AND (
          i.consumable_family IS NOT NULL
          OR i.effect_type IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM item_effects ie
            WHERE ie.item_id = i.id
              AND ie.is_active = 1
          )
        )
      GROUP BY
        i.id,
        i.name,
        i.icon,
        i.description,
        i.consumable_family
      ORDER BY
        FIELD(i.consumable_family, 'potion','tonic','draught','elixir','flask','oil','other'),
        i.name ASC
    `,
    [playerId],
  );

  const result: RestConsumable[] = [];

  for (const row of rows || []) {
    result.push({
      itemId: Number(row.id),
      name: String(row.name),
      icon: row.icon ? String(row.icon) : null,
      description: row.description ? String(row.description) : null,
      family: row.consumable_family ? String(row.consumable_family) : null,
      quantity: Number(row.quantity) || 0,
      effects: await loadItemEffects(Number(row.id)),
    });
  }

  return result;
}

export async function getActiveConsumableBuffs(playerId: number) {
  const buffs = await getActiveBuffs(playerId);

  return buffs.filter((buff) =>
    String(buff.source || "").startsWith("consumable:"),
  );
}

async function consumeOneInventoryItem(
  conn: any,
  playerId: number,
  itemId: number,
) {
  const [rows]: any = await conn.query(
    `
      SELECT inventory_id, quantity
      FROM inventory
      WHERE player_id = ?
        AND item_id = ?
        AND quantity > 0
      ORDER BY inventory_id ASC
      FOR UPDATE
    `,
    [playerId, itemId],
  );

  const row = rows?.[0];
  if (!row) {
    throw new Error("You do not have that item.");
  }

  const inventoryId = Number(row.inventory_id);
  const quantity = Number(row.quantity) || 0;

  if (quantity <= 1) {
    await conn.query(
      `DELETE FROM inventory WHERE inventory_id = ?`,
      [inventoryId],
    );
  } else {
    await conn.query(
      `UPDATE inventory SET quantity = quantity - 1 WHERE inventory_id = ?`,
      [inventoryId],
    );
  }
}

async function removeConflictingConsumableBuffs(
  playerId: number,
  effects: ConsumableEffect[],
) {
  const groups = Array.from(
    new Set(
      effects
        .filter((effect) => effect.effect_type === "buff")
        .map((effect) => effect.stacking_group)
        .filter((group): group is string => Boolean(group)),
    ),
  );

  for (const group of groups) {
    const source = getEffectSource(0, group);

    await db.query(
      `
        DELETE FROM player_buffs
        WHERE player_id = ?
          AND source = ?
      `,
      [playerId, source],
    );
  }
}

export async function useRestConsumable(playerId: number, itemId: number) {
  const safePlayerId = Number(playerId);
  const safeItemId = Number(itemId);

  if (!Number.isInteger(safePlayerId) || safePlayerId <= 0) {
    throw new Error("Invalid player.");
  }

  if (!Number.isInteger(safeItemId) || safeItemId <= 0) {
    throw new Error("Invalid item.");
  }

  const [[player]]: any = await db.query(
    `SELECT id, hpoints, spoints FROM players WHERE id = ? LIMIT 1`,
    [safePlayerId],
  );

  if (!player) {
    throw new Error("Player not found.");
  }

  if (Number(player.hpoints) <= 0) {
    throw new Error("You cannot use consumables while dead.");
  }

  const [[activeCreature]]: any = await db.query(
    `SELECT id FROM player_creatures WHERE player_id = ? LIMIT 1`,
    [safePlayerId],
  );

  if (activeCreature) {
    throw new Error("You cannot use Rest consumables while in combat.");
  }

  const [[item]]: any = await db.query(
    `
      SELECT
        id,
        name,
        category,
        consumable_family,
        effect_type,
        effect_value,
        effect_target
      FROM items
      WHERE id = ?
      LIMIT 1
    `,
    [safeItemId],
  );

  if (!item || String(item.category) !== "consumable") {
    throw new Error("That item cannot be used here.");
  }

  const configuredEffects = await loadItemEffects(safeItemId);

  // Backward compatibility for Guildforge's existing simple health/mana potions.
  const legacyEffects: ConsumableEffect[] = [];
  if (!configuredEffects.length && String(item.effect_type || "") === "heal") {
    const target = String(item.effect_target || "").toLowerCase();
    const amount = Number(item.effect_value) || 0;

    if (target === "hp" && amount > 0) {
      legacyEffects.push({
        id: 0,
        item_id: safeItemId,
        effect_type: "heal",
        stat_key: null,
        effect_value: amount,
        duration_seconds: 0,
        stacking_group: null,
        display_order: 0,
      });
    }

    if (target === "sp" && amount > 0) {
      legacyEffects.push({
        id: 0,
        item_id: safeItemId,
        effect_type: "restore_sp",
        stat_key: null,
        effect_value: amount,
        duration_seconds: 0,
        stacking_group: null,
        display_order: 0,
      });
    }
  }

  const effects = configuredEffects.length ? configuredEffects : legacyEffects;

  if (!effects.length) {
    throw new Error("This consumable has no configured effect.");
  }

  const conn: any = await db.getConnection();

  try {
    await conn.beginTransaction();
    await consumeOneInventoryItem(conn, safePlayerId, safeItemId);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  // The item is confirmed/consumed now, so replacing an existing
  // preparation cannot accidentally remove a buff for a failed use.
  await removeConflictingConsumableBuffs(safePlayerId, effects);

  const beforeStats = await getFinalPlayerStats(safePlayerId);
  const maxHp = Math.max(1, Number(beforeStats?.maxhp) || 1);
  const maxSp = Math.max(0, Number(beforeStats?.maxspoints) || 0);

  let healed = 0;
  let restoredSp = 0;
  const appliedBuffs: Array<{ stat: string; value: number; durationSeconds: number }> = [];

  for (const effect of effects) {
    if (effect.effect_type === "heal") {
      const amount = Math.max(0, Math.floor(effect.effect_value));
      if (amount <= 0) continue;

      const [[current]]: any = await db.query(
        `SELECT hpoints FROM players WHERE id = ? LIMIT 1`,
        [safePlayerId],
      );

      const currentHp = Number(current?.hpoints) || 0;
      const nextHp = Math.min(maxHp, currentHp + amount);
      healed += Math.max(0, nextHp - currentHp);

      await db.query(
        `UPDATE players SET hpoints = ? WHERE id = ?`,
        [nextHp, safePlayerId],
      );
      continue;
    }

    if (effect.effect_type === "restore_sp") {
      const amount = Math.max(0, Math.floor(effect.effect_value));
      if (amount <= 0) continue;

      const [[current]]: any = await db.query(
        `SELECT spoints FROM players WHERE id = ? LIMIT 1`,
        [safePlayerId],
      );

      const currentSp = Number(current?.spoints) || 0;
      const nextSp = Math.min(maxSp, currentSp + amount);
      restoredSp += Math.max(0, nextSp - currentSp);

      await db.query(
        `UPDATE players SET spoints = ? WHERE id = ?`,
        [nextSp, safePlayerId],
      );
      continue;
    }

    if (effect.effect_type === "buff") {
      const stat = String(effect.stat_key || "").trim().toLowerCase();
      const value = Number(effect.effect_value) || 0;
      const durationSeconds = Math.max(1, Math.floor(effect.duration_seconds));

      if (!stat || value === 0) continue;

      const source = getEffectSource(safeItemId, effect.stacking_group);
      await applyBuff(safePlayerId, stat, value, durationSeconds, source);

      appliedBuffs.push({ stat, value, durationSeconds });
    }
  }

  const finalStats = await getFinalPlayerStats(safePlayerId);
  const [[finalPlayer]]: any = await db.query(
    `SELECT hpoints, spoints FROM players WHERE id = ? LIMIT 1`,
    [safePlayerId],
  );

  publishPlayerStatePatch(safePlayerId, {
    hpoints: Number(finalPlayer?.hpoints) || 0,
    spoints: Number(finalPlayer?.spoints) || 0,
    maxhp: Number(finalStats?.maxhp) || maxHp,
    maxspoints: Number(finalStats?.maxspoints) || maxSp,
    refreshDerivedStats: appliedBuffs.length > 0,
  });

  return {
    itemId: safeItemId,
    itemName: String(item.name || "Consumable"),
    healed,
    restoredSp,
    appliedBuffs,
    activeBuffs: await getActiveConsumableBuffs(safePlayerId),
  };
}
