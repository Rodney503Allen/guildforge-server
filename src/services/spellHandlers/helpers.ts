import { ARCHETYPE_SCALING } from "../archetypeScaling";
import { resolveSpellDamage } from "../combatEngine";
import { SpellEnemy } from "./types";


export function getPlayerScalingStat(player: any): number {
  const archetype = String(player.archetype || "");

  if (!(archetype in ARCHETYPE_SCALING)) {
    console.warn(
      `Unknown player archetype "${archetype}"`
    );

    return 0;
  }

  const scalingStat =
    ARCHETYPE_SCALING[
      archetype as keyof typeof ARCHETYPE_SCALING
    ];

  switch (scalingStat) {
    case "attack":
      return Number(player.attack) || 0;

    case "agility":
      return Number(player.agility) || 0;

    case "intellect":
      return Number(player.intellect) || 0;

    default:
      return 0;
  }
}

export function calculateScaledSpellAmount(
  player: any,
  baseAmount: number,
  coefficient = 0.5
): number {
  const statValue = getPlayerScalingStat(player);

  return Math.max(
    1,
    Math.floor(
      baseAmount +
      statValue * coefficient
    )
  );
}

export function resolveDamageAgainstEnemy(
  player: any,
  enemy: SpellEnemy,
  amount: number
) {
  return resolveSpellDamage(
    player,
    {
      ...player,

      // The enemy's defense is the important defensive value here.
      attack: 0,
      defense: Number(enemy.defense) || 0,

      damageReduction: 0,
      dodgeChance: 0,
      crit: 0,
      critDamageMult: 1,
      spellPower: 1
    },
    amount
  );
}

export function getConfiguredDebuff(spell: any) {
  return {
    stat: String(spell.debuff_stat || "").trim(),
    value: Number(spell.debuff_value) || 0,
    duration: Number(spell.debuff_duration) || 0
  };
}

export function getConfiguredBuff(spell: any) {
  return {
    stat: String(spell.buff_stat || "").trim(),
    value: Number(spell.buff_value) || 0,
    duration: Number(spell.buff_duration) || 0
  };
}

export function applyHealingReceivedMultiplier(
  player: any,
  healing: number
): number {
  const multiplier = Math.max(
    0,
    Number(player.healingReceivedMult) || 1
  );

  return Math.max(
    1,
    Math.floor(healing * multiplier)
  );
}