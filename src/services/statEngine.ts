// src/services/statEngine.ts

export type BasePlayerStats = {
  id?: number;
  name?: string;
  pclass?: string;

  level: number;
  exper?: number;
  gold?: number;
  stat_points?: number;

  attack: number;
  defense: number;
  agility: number;
  vitality: number;
  intellect: number;
  crit: number;

  hpoints: number;
  spoints: number;
  maxhp: number;
  maxspoints: number;
};

export type ItemMods = Partial<
  Pick<
    BasePlayerStats,
    "attack" | "defense" | "agility" | "vitality" | "intellect" | "crit"
  >
> & {
  // base equipment stats
  base_attack?: number;
  base_defense?: number;

  // aliases / alternate keys
  strength?: number;
  dexterity?: number;
  intelligence?: number;
  attack_power?: number;
  crit_chance?: number;

  // flat resource bonuses
  health?: number;
  hp?: number;
  mana?: number;
  sp?: number;

  // percent / derived combat bonuses
  dodge?: number;              // e.g. 3 = +3% dodge
  crit_damage?: number;        // e.g. 15 = +15% crit damage
  damage_reduction?: number;   // e.g. 4 = +4% DR
  lifesteal?: number;          // e.g. 2 = +2% lifesteal
};

export type BuffMods = ItemMods;

export type DerivedStats = BasePlayerStats & {
  maxhp: number;
  maxspoints: number;
  spellPower: number;

  dodgeChance: number;       // 0.00 - 0.35
  critDamageMult: number;    // e.g. 1.50 = +50% crit damage baseline
  damageReduction: number;   // 0.00 - 0.50
  lifesteal: number;         // 0.00 - 0.25
};

export type PerkMultipliers = {
  damageMult?: number;
  hpMult?: number;
  critMult?: number;
};

function n(v: any, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function normalizeMod(mod: ItemMods = {}) {
  return {
    // primary stat pools
    attack:
      n(mod.attack) +
      n(mod.base_attack) +
      n(mod.strength) +
      n(mod.attack_power),

    defense:
      n(mod.defense) +
      n(mod.base_defense),

    agility:
      n(mod.agility) +
      n(mod.dexterity),

    intellect:
      n(mod.intellect) +
      n(mod.intelligence),

    vitality:
      n(mod.vitality),

    // crit stat points, not direct chance
    crit:
      n(mod.crit),

    // direct bonus percentages
    critChanceBonus:
      n(mod.crit_chance),

    // flat resources
    health:
      n(mod.health) + n(mod.hp),

    mana:
      n(mod.mana) + n(mod.sp),

    // derived combat bonuses
    dodge:
      n(mod.dodge),

    critDamage:
      n(mod.crit_damage),

    damageReduction:
      n(mod.damage_reduction),

    lifesteal:
      n(mod.lifesteal),
  };
}

export function computePlayerStats(
  base: BasePlayerStats,
  gearMods: ItemMods[] = [],
  buffMods: BuffMods[] = [],
  perkMults: PerkMultipliers = {}
): DerivedStats {
  const final: any = { ...base };

  // normalize base
  final.level = n(final.level, 1);

  final.attack = n(final.attack);
  final.defense = n(final.defense);
  final.agility = n(final.agility);
  final.vitality = n(final.vitality);
  final.intellect = n(final.intellect);

  const critStatBase = n(final.crit);
  let critStat = critStatBase;

  // final.crit becomes actual crit chance fraction later
  final.crit = 0;

  final.hpoints = n(final.hpoints);
  final.spoints = n(final.spoints);
  final.maxhp = n(final.maxhp, 1);
  final.maxspoints = n(final.maxspoints, 1);

  let flatHealthBonus = 0;
  let flatManaBonus = 0;

  let dodgeBonusPct = 0;
  let critChanceBonusPct = 0;
  let critDamageBonusPct = 0;
  let damageReductionPct = 0;
  let lifestealPct = 0;

  // gear mods
  for (const raw of gearMods) {
    const g = normalizeMod(raw);

    final.attack += g.attack;
    final.defense += g.defense;
    final.agility += g.agility;
    final.vitality += g.vitality;
    final.intellect += g.intellect;
    critStat += g.crit;

    flatHealthBonus += g.health;
    flatManaBonus += g.mana;

    dodgeBonusPct += g.dodge;
    critChanceBonusPct += g.critChanceBonus;
    critDamageBonusPct += g.critDamage;
    damageReductionPct += g.damageReduction;
    lifestealPct += g.lifesteal;
  }

  // buff mods
  for (const raw of buffMods) {
    const b = normalizeMod(raw);

    final.attack += b.attack;
    final.defense += b.defense;
    final.agility += b.agility;
    final.vitality += b.vitality;
    final.intellect += b.intellect;
    critStat += b.crit;

    flatHealthBonus += b.health;
    flatManaBonus += b.mana;

    dodgeBonusPct += b.dodge;
    critChanceBonusPct += b.critChanceBonus;
    critDamageBonusPct += b.critDamage;
    damageReductionPct += b.damageReduction;
    lifestealPct += b.lifesteal;
  }

  // derived scaling from core stats
  const vitBonusHP = final.vitality * 10;
  const intBonusSP = final.intellect * 5;

  // crit chance
  const critFromStat = critStat * 0.005;         // 0.5% per crit stat point
  const critFromAgi = final.agility * 0.001;    // 0.1% per agility point
  const critFromBonusPct = critChanceBonusPct / 100;

  final.crit = clamp(critFromStat + critFromAgi + critFromBonusPct, 0, 0.4);

  // resources
  final.maxhp = Math.max(1, final.maxhp + vitBonusHP + flatHealthBonus);
  final.maxspoints = Math.max(1, final.maxspoints + intBonusSP + flatManaBonus);

  // perk multipliers
  const damageMult = n(perkMults.damageMult, 1);
  const hpMult = n(perkMults.hpMult, 1);
  const critMult = n(perkMults.critMult, 1);

  final.attack = Math.max(0, Math.round(final.attack * damageMult));
  final.maxhp = Math.max(1, Math.floor(final.maxhp * hpMult));
  final.crit = clamp(final.crit * critMult, 0, 0.4);

  // clamp current resources
  final.hpoints = Math.min(n(final.hpoints), final.maxhp);
  final.spoints = Math.min(n(final.spoints), final.maxspoints);

  // derived secondaries
  final.spellPower = 1 + final.intellect * 0.05;

  const dodgeFromAgi = final.agility * 0.002; // 0.2% per agility
  const dodgeFromBonus = dodgeBonusPct / 100;
  final.dodgeChance = clamp(dodgeFromAgi + dodgeFromBonus, 0, 0.35);

  // baseline crit damage = 150%
  final.critDamageMult = 1.5 + (critDamageBonusPct / 100);

  // cap DR and lifesteal so gear can't get silly
  final.damageReduction = clamp(damageReductionPct / 100, 0, 0.5);
  final.lifesteal = clamp(lifestealPct / 100, 0, 0.25);

  return final as DerivedStats;
}