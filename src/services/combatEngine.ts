//services/combatEngine.ts
import { DerivedStats } from "./statEngine";

export type CombatResult = {
  damage: number;
  crit: boolean;
  dodged: boolean;
};

export function resolveAttack(
  attacker: DerivedStats,
  defender: DerivedStats
): CombatResult {
  if (Math.random() < defender.dodgeChance) {
    return {
      damage: 0,
      crit: false,
      dodged: true
    };
  }

  let damage = Math.max(
    1,
    Math.floor(attacker.attack * 1.1 - defender.defense * 0.6)
  );

  let crit = false;
  if (Math.random() < attacker.crit) {
    damage = Math.floor(damage * attacker.critDamageMult);
    crit = true;
  }

  damage = Math.max(1, Math.floor(damage * (1 - defender.damageReduction)));

  return {
    damage,
    crit,
    dodged: false
  };
}

// =========================
// SPELL DAMAGE
// =========================
export function resolveSpellDamage(
  caster: DerivedStats,
  baseValue: number
): number {
  return Math.floor(baseValue * caster.spellPower);
}
