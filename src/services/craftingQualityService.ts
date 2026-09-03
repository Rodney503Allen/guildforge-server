// src/services/craftingQualityService.ts

export type CraftQuality =
  | "base"
  | "crafted"
  | "forged"
  | "tempered"
  | "masterworked";

export type EquipmentRarity =
  | "base"
  | "dormant"
  | "awakened"
  | "empowered"
  | "transcendent";

type QualityTierRow = {
  quality_key: CraftQuality;
  required_level: number;
  base_weight: number | string;
  requires_specialization: number;
};

export type CraftingQualityRoll = {
  craftQuality: CraftQuality;
  rarity: EquipmentRarity;
  effectiveWeight: number;
  chancePercent: number;
  pool: Array<{
    craftQuality: CraftQuality;
    rarity: EquipmentRarity;
    weight: number;
    chancePercent: number;
  }>;
};

export type CraftingQualityRollArgs = {
  conn: any;
  professionLevel: number;
  isSpecialized: boolean;
  recipeRequiredLevel: number;
  qualityDifficulty?: number;
  qualityWeightBonuses?: Partial<Record<CraftQuality, number>>;
};

const QUALITY_TO_RARITY: Record<CraftQuality, EquipmentRarity> = {
  base: "base",
  crafted: "dormant",
  forged: "awakened",
  tempered: "empowered",
  masterworked: "transcendent"
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeQuality(value: any): CraftQuality {
  const v = String(value || "").toLowerCase();

  if (
    v === "base" ||
    v === "crafted" ||
    v === "forged" ||
    v === "tempered" ||
    v === "masterworked"
  ) {
    return v;
  }

  return "base";
}

function rollWeighted<T>(entries: Array<{ key: T; weight: number }>): T {
  if (!entries.length) throw new Error("CRAFT_QUALITY_EMPTY_POOL");

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

function getSkillMultiplier(args: {
  professionLevel: number;
  recipeRequiredLevel: number;
  qualityDifficulty: number;
}) {
  const professionLevel = Math.max(1, Number(args.professionLevel) || 1);
  const recipeRequiredLevel = Math.max(1, Number(args.recipeRequiredLevel) || 1);
  const qualityDifficulty = Math.max(0, Number(args.qualityDifficulty) || 0);

  const effectiveChallenge = recipeRequiredLevel + qualityDifficulty;
  const skillDelta = professionLevel - effectiveChallenge;

  return clamp(1 + skillDelta * 0.03, 0.35, 2);
}

export function mapCraftQualityToRarity(
  craftQuality: CraftQuality
): EquipmentRarity {
  return QUALITY_TO_RARITY[craftQuality] ?? "base";
}

export async function rollCraftingQuality(
  args: CraftingQualityRollArgs
): Promise<CraftingQualityRoll> {
  const {
    conn,
    professionLevel,
    isSpecialized,
    recipeRequiredLevel,
    qualityDifficulty = 0,
    qualityWeightBonuses = {}
  } = args;

  const [rows]: any = await conn.query(
    `
    SELECT
      quality_key,
      required_level,
      base_weight,
      requires_specialization
    FROM crafting_quality_tiers
    WHERE is_active = 1
    ORDER BY display_order ASC, id ASC
    `
  );

  if (!rows?.length) throw new Error("CRAFT_QUALITY_TIERS_NOT_CONFIGURED");

  const level = Math.max(1, Number(professionLevel) || 1);
  const specialized = Boolean(isSpecialized);

  const skillMultiplier = getSkillMultiplier({
    professionLevel: level,
    recipeRequiredLevel,
    qualityDifficulty
  });

  const eligible: Array<{
    craftQuality: CraftQuality;
    rarity: EquipmentRarity;
    weight: number;
  }> = [];

  for (const raw of rows as QualityTierRow[]) {
    const craftQuality = normalizeQuality(raw.quality_key);
    const requiredLevel = Math.max(1, Number(raw.required_level) || 1);
    const requiresSpecialization =
      Number(raw.requires_specialization || 0) === 1;

    if (level < requiredLevel) continue;
    if (requiresSpecialization && !specialized) continue;

    const baseWeight = Math.max(0, Number(raw.base_weight) || 0);
    const bonusPercent = Number(qualityWeightBonuses[craftQuality] || 0);
    const bonusMultiplier = Math.max(0, 1 + bonusPercent / 100);

    const progressionMultiplier =
      craftQuality === "base" ? 1 : skillMultiplier;

    const weight =
      baseWeight *
      progressionMultiplier *
      bonusMultiplier;

    if (weight <= 0) continue;

    eligible.push({
      craftQuality,
      rarity: mapCraftQualityToRarity(craftQuality),
      weight
    });
  }

  if (!eligible.length) {
    eligible.push({
      craftQuality: "base",
      rarity: "base",
      weight: 100
    });
  }

  const totalWeight = eligible.reduce((sum, tier) => sum + tier.weight, 0);

  const pool = eligible.map((tier) => ({
    craftQuality: tier.craftQuality,
    rarity: tier.rarity,
    weight: Number(tier.weight.toFixed(4)),
    chancePercent:
      totalWeight > 0
        ? Number(((tier.weight / totalWeight) * 100).toFixed(4))
        : 0
  }));

  const rolledQuality = rollWeighted(
    eligible.map((tier) => ({
      key: tier.craftQuality,
      weight: tier.weight
    }))
  );

  const rolled = pool.find((tier) => tier.craftQuality === rolledQuality);

  return {
    craftQuality: rolledQuality,
    rarity: mapCraftQualityToRarity(rolledQuality),
    effectiveWeight: rolled?.weight ?? 0,
    chancePercent: rolled?.chancePercent ?? 0,
    pool
  };
}
