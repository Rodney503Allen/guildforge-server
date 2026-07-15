// services/combatEngine.ts
import { DerivedStats } from "./statEngine";

export type CombatResult = {
  damage: number;
  crit: boolean;
  dodged: boolean;
};

function getDamageTakenMultiplier(
  defender: DerivedStats
): number {
  const value = Number(
    defender.damageTakenMult ?? 1
  );

  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(0, value);
}

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

  // Smooth defense mitigation.
  const attack = Math.max(
    1,
    Number(attacker.attack) || 1
  );

  const defense = Math.max(
    0,
    Number(defender.defense) || 0
  );

  const mitigation =
    defense / (defense + attack * 2);

  let damage =
    attack * (1 - mitigation);

  // Small damage variance: 90%–110%.
  const variance =
    0.9 + Math.random() * 0.2;

  damage *= variance;

  // Critical hit.
  let crit = false;

  if (Math.random() < attacker.crit) {
    damage *= attacker.critDamageMult;
    crit = true;
  }

  // Damage reduction may be negative for effects
  // such as Blood Rage.
  damage *=
    1 - Number(defender.damageReduction || 0);

  // Vulnerability effects such as Mark for Death.
  damage *=
    getDamageTakenMultiplier(defender);

  return {
    damage: Math.max(
      1,
      Math.floor(damage)
    ),
    crit,
    dodged: false
  };
}

// =========================
// SPELL DAMAGE
// =========================

export function resolveSpellDamage(
  caster: DerivedStats,
  defender: DerivedStats,
  baseValue: number
): CombatResult {
  const rawPower = Math.max(
    1,
    Math.floor(Number(baseValue) || 1)
  );

  const defense = Math.max(
    0,
    Number(defender.defense) || 0
  );

  const mitigation =
    defense / (defense + rawPower * 2);

  let damage =
    rawPower * (1 - mitigation);

  const variance =
    0.9 + Math.random() * 0.2;

  damage *= variance;

  let crit = false;

  if (Math.random() < caster.crit) {
    damage *= caster.critDamageMult;
    crit = true;
  }

  damage *=
    1 - Number(defender.damageReduction || 0);

  // Mark for Death and similar vulnerability effects.
  damage *=
    getDamageTakenMultiplier(defender);

  return {
    damage: Math.max(
      1,
      Math.floor(damage)
    ),
    crit,
    dodged: false
  };
}