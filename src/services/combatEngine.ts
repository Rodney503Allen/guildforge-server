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

  // =========================
  // DODGE CHECK (AGILITY)
  // =========================
  if (Math.random() < defender.dodgeChance) {
    return {
      damage: 0,
      crit: false,
      dodged: true
    };
  }

  // =========================
  // BASE DAMAGE
  // =========================
  let damage = Math.max(
    1,
    Math.floor(attacker.attack * 1.1 - defender.defense * 0.6)
  );

  // =========================
  // CRIT CHECK
  // =========================
  let crit = false;
  if (Math.random() < attacker.crit) {
    damage = Math.floor(damage * 1.5);
    crit = true;
  }

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
