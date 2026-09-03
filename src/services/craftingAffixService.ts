// src/services/craftingAffixService.ts
//
// Crafted-equipment affix generation.
// Mirrors Guildforge's existing loot affix rules so crafting can use a fixed
// rarity chosen by craftingQualityService without rolling loot rarity again.

export type EquipmentRarity =
  | "base"
  | "dormant"
  | "awakened"
  | "empowered"
  | "transcendent";

type ItemType = "weapon" | "armor" | "offhand";

type ItemBaseRow = {
  id: number;
  name: string;
  slot: string;
  item_type: ItemType;
  armor_weight: string | null;
  weapon_class: string | null;
  required_level: number;
  max_level: number | null;
  base_attack: number | null;
  base_defense: number | null;
};

type AffixRow = {
  id: number;
  stat_key: string;
  label: string;
  value_type: "flat" | "percent";
  applies_to: "any" | "weapon" | "armor" | "offhand";
  min_level: number;
  max_level: number;
  slot: string | null;
  armor_weight: string | null;
  rarity_min: string | null;
  value_min: number;
  value_max: number;
  weight: number;
};

export type RolledAffix = {
  stat: string;
  label: string;
  value: number;
  isPercent: boolean;
  resonant?: boolean;
  baseValue?: number;
};

const RARITY_ORDER: Record<EquipmentRarity, number> = {
  base: 0,
  dormant: 1,
  awakened: 2,
  empowered: 3,
  transcendent: 4
};

const RARITY_CONFIG: Record<EquipmentRarity, { affixCount: number }> = {
  base: { affixCount: 0 },
  dormant: { affixCount: 1 },
  awakened: { affixCount: 2 },
  empowered: { affixCount: 3 },
  transcendent: { affixCount: 3 }
};

const TRANSCENDENT_RESONANCE_MULTIPLIER = 1.2;

const ARMOR_WEIGHT_RULES = {
  light: {
    blockedStat: "defense",
    bestSourceStat: "agility",
    minMultiplier: 1.1,
    maxMultiplier: 1.25
  },
  medium: {
    blockedStat: null,
    bestSourceStat: null,
    minMultiplier: 1,
    maxMultiplier: 1
  },
  heavy: {
    blockedStat: "agility",
    bestSourceStat: "defense",
    minMultiplier: 1.1,
    maxMultiplier: 1.25
  }
} as const;

function normalizeRarity(value: string): EquipmentRarity {
  const v = String(value || "").toLowerCase().trim();

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

function getArmorWeightRule(weight: string | null) {
  if (!weight) return null;

  if (weight === "light" || weight === "medium" || weight === "heavy") {
    return ARMOR_WEIGHT_RULES[weight];
  }

  return null;
}

function getItemLevelMultiplier(itemLevel: number): number {
  const safeLevel = Math.max(1, Number(itemLevel) || 1);
  return 1 + Math.floor(safeLevel / 5) * 0.5;
}

function getAdjustedAffixRange(
  affix: AffixRow,
  armorWeight: string | null,
  itemLevel: number
): { min: number; max: number } {
  const levelMultiplier = getItemLevelMultiplier(itemLevel);
  const rule = getArmorWeightRule(armorWeight);

  let min = Number(affix.value_min || 0);
  let max = Number(affix.value_max || 0);

  min = Math.max(1, Math.floor(min * levelMultiplier));
  max = Math.max(min, Math.floor(max * levelMultiplier));

  if (rule?.bestSourceStat && affix.stat_key === rule.bestSourceStat) {
    min = Math.max(1, Math.floor(min * rule.minMultiplier));
    max = Math.max(min, Math.floor(max * rule.maxMultiplier));
  }

  return { min, max };
}

function randomInt(min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function rollWeighted<T>(entries: readonly { key: T; weight: number }[]): T {
  if (!entries.length) {
    throw new Error("rollWeighted called with empty entries array");
  }

  const total = entries.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry.weight) || 0),
    0
  );

  if (total <= 0) return entries[0].key;

  let roll = Math.random() * total;

  for (const entry of entries) {
    roll -= Math.max(0, Number(entry.weight) || 0);
    if (roll <= 0) return entry.key;
  }

  return entries[entries.length - 1].key;
}

async function getEligibleAffixes(args: {
  conn: any;
  base: ItemBaseRow;
  itemLevel: number;
  rarity: EquipmentRarity;
}): Promise<AffixRow[]> {
  const { conn, base, itemLevel, rarity } = args;

  const [rows]: any = await conn.query(
    `
    SELECT
      id,
      stat_key,
      label,
      value_type,
      applies_to,
      min_level,
      max_level,
      slot,
      armor_weight,
      rarity_min,
      value_min,
      value_max,
      weight
    FROM item_affixes
    WHERE is_active = 1
      AND min_level <= ?
      AND max_level >= ?
      AND (applies_to = 'any' OR applies_to = ?)
      AND (slot IS NULL OR slot = ?)
      AND (armor_weight IS NULL OR armor_weight = ?)
    `,
    [
      itemLevel,
      itemLevel,
      base.item_type,
      base.slot,
      base.armor_weight
    ]
  );

  const all = rows as AffixRow[];
  const weightRule = getArmorWeightRule(base.armor_weight);

  return all
    .filter((affix) => {
      if (!affix.rarity_min) return true;

      return (
        RARITY_ORDER[rarity] >=
        RARITY_ORDER[normalizeRarity(affix.rarity_min)]
      );
    })
    .filter((affix) => {
      if (!weightRule?.blockedStat) return true;
      return affix.stat_key !== weightRule.blockedStat;
    });
}

function rollAffixes(
  pool: AffixRow[],
  rarity: EquipmentRarity,
  armorWeight: string | null,
  itemLevel: number
): RolledAffix[] {
  const affixCount = RARITY_CONFIG[rarity].affixCount;

  if (affixCount <= 0) return [];

  const selected: RolledAffix[] = [];
  const usedStatKeys = new Set<string>();
  let remainingPool = [...pool];

  const resonantIndex =
    rarity === "transcendent" && affixCount > 0
      ? randomInt(0, affixCount - 1)
      : -1;

  for (let i = 0; i < affixCount; i++) {
    remainingPool = remainingPool.filter(
      (affix) => !usedStatKeys.has(affix.stat_key)
    );

    if (!remainingPool.length) break;

    const chosen = rollWeighted(
      remainingPool.map((affix) => ({
        key: affix,
        weight: Math.max(1, Number(affix.weight) || 1)
      }))
    );

    const isResonant =
      rarity === "transcendent" &&
      i === resonantIndex;

    const adjustedRange = getAdjustedAffixRange(
      chosen,
      armorWeight,
      itemLevel
    );

    const rawValue = isResonant
      ? adjustedRange.max
      : randomInt(adjustedRange.min, adjustedRange.max);

    const finalValue = isResonant
      ? Math.max(
          1,
          Math.round(rawValue * TRANSCENDENT_RESONANCE_MULTIPLIER)
        )
      : Math.max(1, rawValue);

    selected.push({
      stat: chosen.stat_key,
      label: chosen.label,
      value: finalValue,
      isPercent: chosen.value_type === "percent",
      resonant: isResonant || undefined,
      baseValue: isResonant ? rawValue : undefined
    });

    usedStatKeys.add(chosen.stat_key);
  }

  return selected;
}

export async function rollCraftedEquipmentAffixes(args: {
  conn: any;
  baseItemId: number;
  itemLevel: number;
  rarity: EquipmentRarity;
}): Promise<RolledAffix[]> {
  const { conn, baseItemId, rarity } = args;
  const itemLevel = Math.max(1, Number(args.itemLevel) || 1);

  if (rarity === "base") return [];

  const [[base]]: any = await conn.query(
    `
    SELECT
      id,
      name,
      slot,
      item_type,
      armor_weight,
      weapon_class,
      required_level,
      max_level,
      COALESCE(base_attack, 0) AS base_attack,
      COALESCE(base_defense, 0) AS base_defense
    FROM item_bases
    WHERE id = ?
      AND is_active = 1
    LIMIT 1
    `,
    [baseItemId]
  );

  if (!base) throw new Error("ITEM_BASE_NOT_FOUND");

  const affixPool = await getEligibleAffixes({
    conn,
    base,
    itemLevel,
    rarity
  });

  return rollAffixes(
    affixPool,
    rarity,
    base.armor_weight,
    itemLevel
  );
}
