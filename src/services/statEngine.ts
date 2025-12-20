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

function n(v: any, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function computePlayerStats(
  base: BasePlayerStats,
  gearMods: ItemMods[] = [],
  buffMods: BuffMods[] = []
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





  // 3) apply derived scaling rules (FIRST VERSION)
  // Vitality => +HP
  const vitBonusHP = final.vitality * 10;          // tune later
  // Intellect => +SP + spell power
  const intBonusSP = final.intellect * 5;          // tune later
  // Agility → crit chance bonus
  const agilityCritBonus = final.agility * 0.001; // 0.1% per agility
  final.maxhp = Math.max(1, final.maxhp + vitBonusHP);
  final.maxspoints = Math.max(1, final.maxspoints + intBonusSP);
  final.crit = Math.min(
    0.5, // 50% hard cap
    final.crit + agilityCritBonus
);
  // clamp current resources to new maxes
  final.hpoints = Math.min(final.hpoints, final.maxhp);
  final.spoints = Math.min(final.spoints, final.maxspoints);

  // spell power (simple start)
  final.spellPower = 1 + final.intellect * 0.05;   // multiplier, tune later

  // agility placeholder (we’ll define this next step)
  final.dodgeChance = Math.max(0, Math.min(0.35, final.agility * 0.002)); // 0–35%

  return final as DerivedStats;
}
