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
  // Dodge check
  if (Math.random() < defender.dodgeChance) {
    return {
      damage: 0,
      crit: false,
      dodged: true
    };
  }

  // Smooth defense mitigation:
  // Higher defense reduces damage, but never completely shuts it down.
  const attack = Math.max(1, attacker.attack);
  const defense = Math.max(0, defender.defense);

  const mitigation = defense / (defense + attack * 2);

  let damage = attack * (1 - mitigation);

  // Small damage variance: 90%–110%
  const variance = 0.9 + Math.random() * 0.2;
  damage *= variance;

  // Crit check
  let crit = false;
  if (Math.random() < attacker.crit) {
    damage *= attacker.critDamageMult;
    crit = true;
  }

  // Extra reduction from buffs/items/etc.
  damage *= 1 - defender.damageReduction;

  return {
    damage: Math.max(1, Math.floor(damage)),
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
