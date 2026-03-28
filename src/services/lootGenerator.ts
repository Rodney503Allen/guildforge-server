// services/lootGenerator.ts
import { db } from "../db";

type Creature = {
  id: number;
  name: string;
  level: number;
  rarity?: string;
};

type Player = {
  id: number;
  level?: number;
};

type ItemType = "weapon" | "armor" | "offhand";

type ItemBaseRow = {
  id: number;
  name: string;
  slot: string;
  item_type: ItemType;
  armor_weight: string | null;
  weapon_class: "sword" | "axe" | "ranged" | "staff" | "mace" | null;
  required_level: number;
  max_level: number | null;
  base_attack: number | null;
  base_defense: number | null;
  icon: string | null;
  sell_value: number | null;
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

type RolledAffix = {
  stat: string;
  label: string;
  value: number;
  isPercent: boolean;
  resonant?: boolean;
  baseValue?: number;
};

type GeneratedItem = {
  itemBaseId: number;
  name: string;
  slot: string;
  itemType: ItemType;
  armorWeight: string | null;
  itemLevel: number;
  rarity: LootRarity;
  baseAttack: number;
  baseDefense: number;
  affixes: RolledAffix[];
  icon: string | null;
  sellValue: number;
};

type SavedItem = GeneratedItem & {
  playerItemId: number;
};

type LootRarity = "base" | "dormant" | "awakened" | "empowered" | "transcendent";

const RARITY_ORDER: Record<LootRarity, number> = {
  base: 0,
  dormant: 1,
  awakened: 2,
  empowered: 3,
  transcendent: 4,
};

const RARITY_LABELS: Record<LootRarity, string> = {
  base: "",
  dormant: "Dormant",
  awakened: "Awakened",
  empowered: "Empowered",
  transcendent: "Transcendent",
};

const RARITY_CONFIG: Record<LootRarity, { affixCount: number }> = {
  base: { affixCount: 0 },
  dormant: { affixCount: 1 },
  awakened: { affixCount: 2 },
  empowered: { affixCount: 3 },
  transcendent: { affixCount: 3 },
};

const TRANSCENDENT_RESONANCE_MULTIPLIER = 1.2;

const DEFAULT_GEAR_DROP_CHANCES = {
  common: 1.0,
  uncommon: 0.28,
  elite: 0.55,
  boss: 1.0,
};

const CATEGORY_WEIGHTS = [
  { key: "armor" as const, weight: 55 },
  { key: "weapon" as const, weight: 35 },
  { key: "jewelry" as const, weight: 10 }, // future-proof; ignored if no bases
];

const SLOT_WEIGHTS_BY_CATEGORY: Record<string, { key: string; weight: number }[]> = {
  armor: [
    { key: "chest", weight: 30 },
    { key: "legs", weight: 20 },
    { key: "head", weight: 18 },
    { key: "hands", weight: 16 },
    { key: "feet", weight: 16 },
  ],
  weapon: [
    { key: "weapon", weight: 100 },
  ],
  offhand: [
    { key: "offhand", weight: 100 },
  ],
  jewelry: [
    { key: "ring", weight: 60 },
    { key: "amulet", weight: 40 },
  ],
};

const ARMOR_WEIGHT_RULES = {
  light: {
    blockedStat: "defense",
    bestSourceStat: "agility",
    minMultiplier: 1.1,
    maxMultiplier: 1.25,
  },
  medium: {
    blockedStat: null,
    bestSourceStat: null,
    minMultiplier: 1,
    maxMultiplier: 1,
  },
  heavy: {
    blockedStat: "agility",
    bestSourceStat: "defense",
    minMultiplier: 1.1,
    maxMultiplier: 1.25,
  },
} as const;

function getArmorWeightRule(weight: string | null) {
  if (!weight) return null;
  if (weight === "light" || weight === "medium" || weight === "heavy") {
    return ARMOR_WEIGHT_RULES[weight];
  }
  return null;
}

function getAdjustedAffixRange(
  affix: AffixRow,
  armorWeight: string | null
): { min: number; max: number } {
  const rule = getArmorWeightRule(armorWeight);

  let min = Number(affix.value_min || 0);
  let max = Number(affix.value_max || 0);

  if (rule?.bestSourceStat && affix.stat_key === rule.bestSourceStat) {
    min = Math.max(1, Math.floor(min * rule.minMultiplier));
    max = Math.max(min, Math.floor(max * rule.maxMultiplier));
  }

  return { min, max };
}

export async function generateLootForCreature(
  creature: Creature,
  player: Player
): Promise<SavedItem[]> {
  const results: SavedItem[] = [];

  const gearDropChance = getGearDropChance(creature);
  if (!rollChance(gearDropChance)) {
    return results;
  }

  const itemLevel = pickItemLevel(creature);
  const availableCategories = await getAvailableCategories(itemLevel);

  const filteredWeights = CATEGORY_WEIGHTS.filter((c) =>
    availableCategories.includes(c.key)
  );

  if (!filteredWeights.length) {
    return results;
  }

  const category = rollWeighted(filteredWeights);
  const slot = rollWeighted(
    SLOT_WEIGHTS_BY_CATEGORY[category] || [{ key: "chest", weight: 100 }]
  );
  const rarity = rollRarity(creature);

  const base = await pickItemBase({
    itemLevel,
    category,
    slot,
  });

  if (!base) {
    return results;
  }

  const affixPool = await getEligibleAffixes({
    base,
    itemLevel,
    rarity,
  });


console.log("[LOOT] eligible affixes", {
  base: base.name,
  slot: base.slot,
  itemType: base.item_type,
  armorWeight: base.armor_weight,
  rarity,
  itemLevel,
  count: affixPool.length,
  affixes: affixPool.map(a => ({
    stat: a.stat_key,
    label: a.label,
    slot: a.slot,
    applies_to: a.applies_to,
    armor_weight: a.armor_weight,
    rarity_min: a.rarity_min
  }))
});

  const affixes = rollAffixes(affixPool, rarity, base.armor_weight);

  const item = buildFinalItem({
    base,
    itemLevel,
    rarity,
    affixes,
  });

  const saved = await saveItemInstance(
    player.id,
    item,
    "combat",
    creature.id
  );

  results.push(saved);
  return results;
}

function getGearDropChance(creature: Creature): number {
  const rarity = (creature.rarity || "common").toLowerCase();

  switch (rarity) {
    case "boss":
    case "mini-boss":
    case "miniboss":
      return DEFAULT_GEAR_DROP_CHANCES.boss;
    case "elite":
      return DEFAULT_GEAR_DROP_CHANCES.elite;
    case "uncommon":
      return DEFAULT_GEAR_DROP_CHANCES.uncommon;
    case "common":
    default:
      return DEFAULT_GEAR_DROP_CHANCES.common;
  }
}

function pickItemLevel(creature: Creature): number {
  return creature.level;
}

function rollRarity(creature: Creature): LootRarity {
  const rarity = (creature.rarity || "common").toLowerCase();

  let weights: { key: LootRarity; weight: number }[];

  switch (rarity) {
    case "boss":
    case "mini-boss":
    case "miniboss":
      weights = [
        { key: "base", weight: 15 },
        { key: "dormant", weight: 30 },
        { key: "awakened", weight: 27 },
        { key: "empowered", weight: 18 },
        { key: "transcendent", weight: 10 },
      ];
      break;

    case "elite":
      weights = [
        { key: "base", weight: 35 },
        { key: "dormant", weight: 30 },
        { key: "awakened", weight: 20 },
        { key: "empowered", weight: 10 },
        { key: "transcendent", weight: 5 },
      ];
      break;

    case "uncommon":
      weights = [
        { key: "base", weight: 50 },
        { key: "dormant", weight: 28 },
        { key: "awakened", weight: 14 },
        { key: "empowered", weight: 6 },
        { key: "transcendent", weight: 2 },
      ];
      break;

    case "common":
      default:
      weights = [
        { key: "base", weight: 68 },
        { key: "dormant", weight: 22 },
        { key: "awakened", weight: 7 },
        { key: "empowered", weight: 2 },
        { key: "transcendent", weight: 1 },
      ];
      break;
  }

  return rollWeighted(weights);
}

async function pickItemBase(args: {
  itemLevel: number;
  category: string;
  slot: string;
}): Promise<ItemBaseRow | null> {
  const { itemLevel, category, slot } = args;

  // jewelry is future content, so skip unless later added
  if (category === "jewelry") return null;

  const [rows]: any = await db.query(
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
      COALESCE(base_defense, 0) AS base_defense,
      icon,
      COALESCE(sell_value, 0) AS sell_value
    FROM item_bases
    WHERE is_active = 1
      AND item_type = ?
      AND slot = ?
      AND required_level <= ?
      AND max_level >= ?
    `,
    [category, slot, itemLevel, itemLevel]
  );

  const pool = rows as ItemBaseRow[];
  if (!pool.length) return null;

  return randomFrom(pool);
}

async function getEligibleAffixes(args: {
  base: ItemBaseRow;
  itemLevel: number;
  rarity: LootRarity;
}): Promise<AffixRow[]> {
  const { base, itemLevel, rarity } = args;

  const [rows]: any = await db.query(
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
    [itemLevel, itemLevel, base.item_type, base.slot, base.armor_weight]
  );

  const all = rows as AffixRow[];
  const weightRule = getArmorWeightRule(base.armor_weight);

  return all
    .filter((affix) => {
      if (affix.rarity_min) {
        return (
          RARITY_ORDER[rarity] >=
          RARITY_ORDER[normalizeRarity(affix.rarity_min)]
        );
      }
      return true;
    })
    .filter((affix) => {
      if (!weightRule?.blockedStat) return true;
      return affix.stat_key !== weightRule.blockedStat;
    });
}

function rollAffixes(
  pool: AffixRow[],
  rarity: LootRarity,
  armorWeight: string | null
): RolledAffix[] {
  const affixCount = RARITY_CONFIG[rarity].affixCount;

  const selected: RolledAffix[] = [];
  const usedStatKeys = new Set<string>();

  let remainingPool = [...pool];
  const resonantIndex =
    rarity === "transcendent" && affixCount > 0
      ? randomInt(0, affixCount - 1)
      : -1;

  for (let i = 0; i < affixCount; i++) {
    remainingPool = remainingPool.filter((a) => !usedStatKeys.has(a.stat_key));
    if (!remainingPool.length) break;

    const chosen = rollWeighted(
      remainingPool.map((a) => ({
        key: a,
        weight: Math.max(1, a.weight || 1),
      }))
    );

    const isResonant = rarity === "transcendent" && i === resonantIndex;
    const adjustedRange = getAdjustedAffixRange(chosen, armorWeight);

    const rawValue = isResonant
      ? adjustedRange.max
      : randomInt(adjustedRange.min, adjustedRange.max);

    const finalValue = isResonant
      ? Math.max(1, Math.round(rawValue * TRANSCENDENT_RESONANCE_MULTIPLIER))
      : Math.max(1, rawValue);

    selected.push({
      stat: chosen.stat_key,
      label: chosen.label,
      value: finalValue,
      isPercent: chosen.value_type === "percent",
      resonant: isResonant || undefined,
      baseValue: isResonant ? rawValue : undefined,
    });

    usedStatKeys.add(chosen.stat_key);
  }

  return selected;
}

function buildFinalItem(args: {
  base: ItemBaseRow;
  itemLevel: number;
  rarity: LootRarity;
  affixes: RolledAffix[];
}): GeneratedItem {
  const { base, itemLevel, rarity, affixes } = args;

  const rarityLabel = RARITY_LABELS[rarity];
  const name = rarityLabel ? `${rarityLabel} ${base.name}` : base.name;
  const baseAttack = Number(base.base_attack || 0);
  const baseDefense = Number(base.base_defense || 0);

  const sellValueBase = Number(base.sell_value || 0);
  const sellValue =
    sellValueBase +
    Math.floor(itemLevel * 2) +
    affixes.reduce((sum, a) => sum + a.value, 0) +
    (rarity === "dormant" ? 2 : 0) +
    (rarity === "awakened" ? 5 : 0) +
    (rarity === "empowered" ? 12 : 0) +
    (rarity === "transcendent" ? 25 : 0);

  return {
    itemBaseId: base.id,
    name,
    slot: base.slot,
    itemType: base.item_type,
    armorWeight: base.armor_weight,
    itemLevel,
    rarity,
    baseAttack,
    baseDefense,
    affixes,
    icon: base.icon,
    sellValue,
  };
}

async function saveItemInstance(
  playerId: number,
  item: GeneratedItem,
  sourceType: string = "combat",
  sourceId?: number | null
): Promise<SavedItem> {
  const [result]: any = await db.query(
    `
    INSERT INTO player_items (
      player_id,
      item_base_id,
      name,
      item_level,
      rarity,
      is_equipped,
      is_claimed,
      roll_json,
      source_type,
      source_id
    ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `,
    [
      playerId,
      item.itemBaseId,
      item.name,
      item.itemLevel,
      mapLootRarityToDb(item.rarity),
      JSON.stringify(item.affixes),
      sourceType,
      sourceId ?? null
    ]
  );

  return {
    ...item,
    playerItemId: Number(result.insertId),
  };
}

async function getAvailableCategories(itemLevel: number): Promise<string[]> {
  const [rows]: any = await db.query(
    `
    SELECT DISTINCT item_type
    FROM item_bases
    WHERE is_active = 1
      AND required_level <= ?
      AND max_level >= ?
    `,
    [itemLevel, itemLevel]
  );

  return (rows ?? []).map((r: any) => String(r.item_type));
}

function mapLootRarityToDb(rarity: LootRarity): LootRarity {
  return rarity;
}

function normalizeRarity(value: string): LootRarity {
  const v = value.toLowerCase().trim();
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

function rollChance(chance: number): boolean {
  return Math.random() < chance;
}

function randomInt(min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rollWeighted<T>(entries: readonly { key: T; weight: number }[]): T {
  if (!entries.length) {
    throw new Error("rollWeighted called with empty entries array");
  }

  const total = entries.reduce((sum, e) => sum + Math.max(0, e.weight), 0);

  if (total <= 0) {
    return entries[0].key;
  }

  let roll = Math.random() * total;

  for (const entry of entries) {
    roll -= Math.max(0, entry.weight);
    if (roll <= 0) return entry.key;
  }

  return entries[entries.length - 1].key;
}