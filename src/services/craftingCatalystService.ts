// src/services/craftingCatalystService.ts
import type { CraftQuality } from "./craftingQualityService";

export type CraftingCatalyst = {
  id: number;
  itemId: number;
  name: string;
  icon: string | null;
  description: string | null;
  professionKey: string | null;
  effectKey: string;
  effectValue: number;
  minProfessionLevel: number;
  ownedQty: number;
};

export type AppliedCraftingCatalyst = CraftingCatalyst & {
  qualityWeightBonuses: Partial<Record<CraftQuality, number>>;
};

export async function getAvailableCraftingCatalysts(args: {
  conn: any;
  playerId: number;
  professionKey: string;
  professionLevel: number;
}): Promise<CraftingCatalyst[]> {
  const professionKey = String(args.professionKey || "").trim().toLowerCase();
  const professionLevel = Math.max(1, Number(args.professionLevel) || 1);

  const [rows]: any = await args.conn.query(
    `
    SELECT
      cc.id,
      cc.item_id AS itemId,
      i.name,
      i.icon,
      i.description,
      cc.profession_key AS professionKey,
      cc.effect_key AS effectKey,
      cc.effect_value AS effectValue,
      cc.min_profession_level AS minProfessionLevel,
      COALESCE(inv.quantity, 0) AS ownedQty
    FROM crafting_catalysts cc
    JOIN items i
      ON i.id = cc.item_id
    LEFT JOIN (
      SELECT item_id, SUM(quantity) AS quantity
      FROM inventory
      WHERE player_id = ?
        AND equipped = 0
      GROUP BY item_id
    ) inv
      ON inv.item_id = cc.item_id
    WHERE cc.is_active = 1
      AND cc.min_profession_level <= ?
      AND (
        cc.profession_key IS NULL
        OR LOWER(cc.profession_key) = ?
      )
    ORDER BY cc.min_profession_level ASC, cc.id ASC
    `,
    [args.playerId, professionLevel, professionKey]
  );

  return (rows || []).map((row: any) => ({
    id: Number(row.id),
    itemId: Number(row.itemId),
    name: String(row.name || "Catalyst"),
    icon: row.icon ? String(row.icon) : null,
    description: row.description ? String(row.description) : null,
    professionKey: row.professionKey ? String(row.professionKey).toLowerCase() : null,
    effectKey: String(row.effectKey || ""),
    effectValue: Number(row.effectValue || 0),
    minProfessionLevel: Number(row.minProfessionLevel || 1),
    ownedQty: Number(row.ownedQty || 0)
  }));
}

export async function validateAndConsumeCraftingCatalyst(args: {
  conn: any;
  playerId: number;
  catalystItemId: number;
  professionKey: string;
  professionLevel: number;
}): Promise<AppliedCraftingCatalyst> {
  const professionKey = String(args.professionKey || "").trim().toLowerCase();
  const professionLevel = Math.max(1, Number(args.professionLevel) || 1);
  const catalystItemId = Number(args.catalystItemId);

  const [[row]]: any = await args.conn.query(
    `
    SELECT
      cc.id,
      cc.item_id AS itemId,
      i.name,
      i.icon,
      i.description,
      cc.profession_key AS professionKey,
      cc.effect_key AS effectKey,
      cc.effect_value AS effectValue,
      cc.min_profession_level AS minProfessionLevel
    FROM crafting_catalysts cc
    JOIN items i
      ON i.id = cc.item_id
    WHERE cc.item_id = ?
      AND cc.is_active = 1
      AND cc.min_profession_level <= ?
      AND (
        cc.profession_key IS NULL
        OR LOWER(cc.profession_key) = ?
      )
    LIMIT 1
    FOR UPDATE
    `,
    [catalystItemId, professionLevel, professionKey]
  );

  if (!row) {
    throw new Error("INVALID_CATALYST");
  }

  const consumed = await consumeItemStacks(
    args.conn,
    args.playerId,
    catalystItemId,
    1
  );

  if (!consumed) {
    throw new Error("MISSING_CATALYST");
  }

  const effectKey = String(row.effectKey || "").trim().toLowerCase();
  const effectValue = Number(row.effectValue || 0);

  const qualityWeightBonuses: Partial<Record<CraftQuality, number>> = {};

  // Generic quality catalyst: increase every non-Base quality weight.
  // A value of 10 means +10% to Crafted/Forged/Tempered/Masterworked weights,
  // not +10 percentage points to the final roll chance.
  if (effectKey === "quality_weight_bonus" && effectValue !== 0) {
    qualityWeightBonuses.crafted = effectValue;
    qualityWeightBonuses.forged = effectValue;
    qualityWeightBonuses.tempered = effectValue;
    qualityWeightBonuses.masterworked = effectValue;
  }

  return {
    id: Number(row.id),
    itemId: Number(row.itemId),
    name: String(row.name || "Catalyst"),
    icon: row.icon ? String(row.icon) : null,
    description: row.description ? String(row.description) : null,
    professionKey: row.professionKey ? String(row.professionKey).toLowerCase() : null,
    effectKey,
    effectValue,
    minProfessionLevel: Number(row.minProfessionLevel || 1),
    ownedQty: 0,
    qualityWeightBonuses
  };
}

async function consumeItemStacks(
  conn: any,
  playerId: number,
  itemId: number,
  qtyNeeded: number
): Promise<boolean> {
  const [stacks]: any = await conn.query(
    `
    SELECT inventory_id, quantity
    FROM inventory
    WHERE player_id = ?
      AND item_id = ?
      AND equipped = 0
    ORDER BY inventory_id ASC
    FOR UPDATE
    `,
    [playerId, itemId]
  );

  let total = 0;
  for (const stack of stacks || []) {
    total += Number(stack.quantity || 0);
  }

  if (total < qtyNeeded) return false;

  let remaining = qtyNeeded;

  for (const stack of stacks || []) {
    if (remaining <= 0) break;

    const stackQty = Number(stack.quantity || 0);
    const take = Math.min(stackQty, remaining);
    const newQty = stackQty - take;

    if (newQty > 0) {
      await conn.query(
        `UPDATE inventory SET quantity = ? WHERE inventory_id = ?`,
        [newQty, stack.inventory_id]
      );
    } else {
      await conn.query(
        `DELETE FROM inventory WHERE inventory_id = ?`,
        [stack.inventory_id]
      );
    }

    remaining -= take;
  }

  return true;
}
