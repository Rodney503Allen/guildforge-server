import type { DerivedStats } from "../statEngine";
import type { CombatDebuffTotals } from "./types";

export type EffectiveEnemyStats = DerivedStats & {
  critChanceTakenPercent?: number;
  criticalDamageTakenPercent?: number;
};

export function applyEnemyDebuffs(
  base: DerivedStats,
  debuffs: CombatDebuffTotals,
): EffectiveEnemyStats {
  const damageDealtReduction = Math.max(0, Math.min(80, Number(debuffs.damage_dealt_pct) || 0));
  const attack = Math.max(0, Number(base.attack || 0) + Number(debuffs.attack || 0));
  return {
    ...base,
    attack: Math.max(0, Math.floor(attack * (1 - damageDealtReduction / 100))),
    defense: Math.max(0, Number(base.defense || 0) + Number(debuffs.defense || 0)),
    agility: Math.max(0, Number(base.agility || 0) + Number(debuffs.agility || 0)),
    vitality: Number(base.vitality || 0) + Number(debuffs.vitality || 0),
    intellect: Number(base.intellect || 0) + Number(debuffs.intellect || 0),
    crit: Math.max(0, Number(base.crit || 0) + Number(debuffs.crit || 0)),
    damageTakenMult: 1 + Math.max(0, Number(debuffs.damage_taken_pct) || 0) / 100,
    spellDamageTakenMult: 1 + Math.max(0, Number(debuffs.spell_damage_taken_pct) || 0) / 100,
    critChanceTakenPercent: Math.max(0, Number(debuffs.crit_chance_taken_pct) || 0),
    criticalDamageTakenPercent: Math.max(0, Number(debuffs.critical_damage_taken_pct) || 0),
  };
}

export function getEnemyAtbRateMultiplier(debuffs: CombatDebuffTotals): number {
  const slow = Math.max(0, Math.min(80, Number(debuffs.attack_speed_pct) || 0));
  return Math.max(0.2, 1 - slow / 100);
}
