// services/lootService.ts
import { db } from "../db";


export type LootDrop = {
  itemId: number;
  qty: number;
  name?: string;
  icon?: string;
  rarity?: string;
};

type ItemMeta = {
  id: number;
  name: string;
  icon: string | null;
  rarity: string | null;
};

function randInt(min: number, max: number) {
  min = Math.max(1, Math.floor(min));
  max = Math.max(min, Math.floor(max));
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function rollCreatureLoot(playerId: number, creatureId: number): Promise<LootDrop[]> {
  const [rows]: any = await db.query(
    `
    SELECT item_id, drop_chance, min_qty, max_qty
    FROM creature_loot_items
    WHERE creature_id=?
    `,
    [creatureId]
  );

  const drops: LootDrop[] = [];

  for (const r of rows || []) {
    const chance = Math.max(0, Math.min(1, Number(r.drop_chance) || 0));
    if (chance <= 0) continue;

    if (Math.random() <= chance) {
      const qty = randInt(Number(r.min_qty) || 1, Number(r.max_qty) || 1);
      if (qty > 0) {
        const itemId = Number(r.item_id);
        drops.push({ itemId, qty });
      }
    }
  }

  // No drops -> nothing to enrich
  if (drops.length === 0) return drops;

  // ✅ define ids (and de-dupe)
  const ids = [...new Set(drops.map(d => d.itemId))];

  const [metaRows] = (await db.query(
    `SELECT id, name, icon, rarity FROM items WHERE id IN (?)`,
    [ids]
  )) as [ItemMeta[], any];

  // ✅ single typed map
  const metaMap = new Map<number, ItemMeta>(
    (metaRows || []).map(x => [Number(x.id), x])
  );

  return drops.map(d => {
    const meta = metaMap.get(d.itemId);
    return {
      ...d,
      name: meta?.name ?? "Unknown",
      icon: meta?.icon ?? "",
      rarity: meta?.rarity ?? "common",
    };
  });
}
