// src/services/statEngine.ts
export type BuffMods = ItemMods;
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


export type ItemMods = Partial<Pick<
  BasePlayerStats,
  "attack" | "defense" | "agility" | "vitality" | "intellect" | "crit"
>> & {
  // add more later (hpFlat, spFlat, etc)
};

export type DerivedStats = BasePlayerStats & {
  // derived “final” values you’ll actually use everywhere
  maxhp: number;
  maxspoints: number;

  // for spells later
  spellPower: number;

  // for agility later
  dodgeChance: number;
};

export type PerkMultipliers = {
  damageMult?: number; // 1.00 = no change, 1.05 = +5%
  hpMult?: number;
  critMult?: number;
};


function n(v: any, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function computePlayerStats(
  base: BasePlayerStats,
  gearMods: ItemMods[] = [],
  buffMods: BuffMods[] = [],
  perkMults: PerkMultipliers = {} // ✅ new
): DerivedStats {
  // 1) start from base
  const final: any = { ...base };

  // normalize required numbers
  final.level = n(final.level, 1);

  final.attack = n(final.attack);
  final.defense = n(final.defense);
  final.agility = n(final.agility);
  final.vitality = n(final.vitality);
  final.intellect = n(final.intellect);
  final.crit = n(final.crit);

  final.hpoints = n(final.hpoints);
  final.spoints = n(final.spoints);
  final.maxhp = n(final.maxhp, 1);
  final.maxspoints = n(final.maxspoints, 1);

  // 2) add gear into the same stat pool
  for (const g of gearMods) {
    final.attack += n(g.attack);
    final.defense += n(g.defense);
    final.agility += n(g.agility);
    final.vitality += n(g.vitality);
    final.intellect += n(g.intellect);
    final.crit += n(g.crit);
  }
  // 2.5) apply flat buffs into the same stat pool
  for (const b of buffMods) {
    final.attack += n(b.attack);
    final.defense += n(b.defense);
    final.agility += n(b.agility);
    final.vitality += n(b.vitality);
    final.intellect += n(b.intellect);
    final.crit += n(b.crit);
  }





  // 3) derived scaling rules
  const vitBonusHP = final.vitality * 10;
  const intBonusSP = final.intellect * 5;
  const agilityCritBonus = final.agility * 0.001;

  final.maxhp = Math.max(1, final.maxhp + vitBonusHP);
  final.maxspoints = Math.max(1, final.maxspoints + intBonusSP);

  final.crit = Math.min(0.5, final.crit + agilityCritBonus);
  // ✅ 3.5) apply perk multipliers (AFTER totals exist)
  const damageMult = n(perkMults.damageMult, 1);
  const hpMult = n(perkMults.hpMult, 1);
  const critMult = n(perkMults.critMult, 1);

  // “Damage” perk → multiply attack (until you have a dedicated damage stat)
  final.attack = Math.max(0, Math.round(final.attack * damageMult));


  // HP perk → multiply maxhp
  final.maxhp = Math.max(1, Math.floor(final.maxhp * hpMult));

  // Crit perk → multiply crit chance fraction
  final.crit = Math.min(0.5, final.crit * critMult);

  // clamp current resources to new maxes
  final.hpoints = Math.min(n(final.hpoints), final.maxhp);
  final.spoints = Math.min(n(final.spoints), final.maxspoints);

  // spell power / dodge unchanged
  final.spellPower = 1 + final.intellect * 0.05;
  final.dodgeChance = Math.max(0, Math.min(0.35, final.agility * 0.002));

  return final as DerivedStats;
}
