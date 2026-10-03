// services/spellTooltipService.ts
//
// Builds player-aware spell tooltip values from the same prepared spell state
// used by combat. Damage shown here is PRE-MITIGATION because final damage
// depends on the target's defenses and combat modifiers.

import { getFinalPlayerStats } from "./playerService";
import { prepareSpellForCast } from "./spellTalents/prepareSpellForCast";
import {
  calculateScaledHealingAmount,
  calculateScaledSpellAmount
} from "./spellHandlers/helpers";

function cleanSentence(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function endSentence(value: string): string {
  if (!value) return "";
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function joinDescription(baseDescription: unknown, effects: string[]): string {
  const base = endSentence(cleanSentence(baseDescription));
  const extra = effects.map(cleanSentence).filter(Boolean).join(" ");
  return [base, extra].filter(Boolean).join(" ");
}

function formatDuration(seconds: number): string {
  const value = Math.max(0, Number(seconds) || 0);
  return value > 0 ? ` for ${value} sec` : "";
}

function describeBuff(
  statValue: unknown,
  rawValue: unknown,
  rawDuration: unknown
): string | null {
  const stat = String(statValue ?? "").trim().toLowerCase();
  const value = Number(rawValue) || 0;
  const duration = Math.max(0, Number(rawDuration) || 0);
  const durationText = formatDuration(duration);

  if (!stat || value === 0) return null;

  switch (stat) {
    case "shield_maxhp_pct":
      return `Absorbs damage equal to ${value}% of maximum health${durationText}.`;

    case "damage_dealt_pct":
      return `Increases damage dealt by ${value}%${durationText}.`;

    case "damage_reduction":
      return `Reduces damage taken by ${value}%${durationText}.`;

    case "attack_pct":
      return `Increases attack by ${value}%${durationText}.`;

    case "defense_pct":
      return `Increases defense by ${value}%${durationText}.`;

    case "crit_chance":
    case "crit_pct":
      return `Increases critical strike chance by ${value}%${durationText}.`;

    case "maxhp_pct":
      return `Increases maximum health by ${value}%${durationText}.`;

    case "maxsp_pct":
    case "maxmana_pct":
      return `Increases maximum mana by ${value}%${durationText}.`;

    case "healing_received_pct":
      return `Increases healing received by ${value}%${durationText}.`;

    case "damage_redirect_pct":
      return `Redirects ${value}% of damage taken by the protected ally${durationText}.`;

    case "cleanse":
      return `Removes harmful effects from the target.`;

    case "atb_rate_pct":
    case "attack_speed_pct":
      return `Increases action speed by ${value}%${durationText}.`;

    case "defense":
      return `Increases defense by ${value}${durationText}.`;

    case "attack":
      return `Increases attack by ${value}${durationText}.`;

    case "agility":
      return `Increases agility by ${value}${durationText}.`;

    case "vitality":
      return `Increases vitality by ${value}${durationText}.`;

    case "intellect":
      return `Increases intellect by ${value}${durationText}.`;

    case "crit":
      return `Increases critical strike chance by ${value}${durationText}.`;

    case "death_prevention":
      return `Prevents one lethal blow${durationText}.`;

    case "intercept":
      return `Intercepts ${value}% of the protected ally's incoming damage${durationText}.`;

    default:
      return null;
  }
}

function describeDebuff(
  statValue: unknown,
  rawValue: unknown,
  rawDuration: unknown
): string | null {
  const stat = String(statValue ?? "").trim().toLowerCase();
  const value = Math.abs(Number(rawValue) || 0);
  const duration = Math.max(0, Number(rawDuration) || 0);
  const durationText = formatDuration(duration);

  if (!stat || value === 0) return null;

  switch (stat) {
    case "damage_taken_pct":
      return `Increases damage taken by ${value}%${durationText}.`;

    case "damage_dealt_pct":
      return `Reduces damage dealt by ${value}%${durationText}.`;

    case "attack_speed_pct":
    case "atb_rate_pct":
      return `Reduces action speed by ${value}%${durationText}.`;

    case "attack":
      return `Reduces attack by ${value}${durationText}.`;

    case "defense":
      return `Reduces defense by ${value}${durationText}.`;

    case "agility":
      return `Reduces agility by ${value}${durationText}.`;

    case "vitality":
      return `Reduces vitality by ${value}${durationText}.`;

    case "intellect":
      return `Reduces intellect by ${value}${durationText}.`;

    case "crit":
    case "crit_chance":
      return `Reduces critical strike chance by ${value}%${durationText}.`;

    default:
      return null;
  }
}

export async function buildSpellTooltipPresentation(
  playerId: number,
  baseSpell: any,
  playerStats?: any
) {
  const [prepared, player] = await Promise.all([
    prepareSpellForCast(playerId, baseSpell),
    playerStats ? Promise.resolve(playerStats) : getFinalPlayerStats(playerId)
  ]);

  const spell: any = prepared.spell;
  const castState: any = prepared.castState;

  const baseDamage = Math.max(0, Number(spell.damage) || 0);
  const baseHeal = Math.max(0, Number(spell.heal) || 0);
  const baseDotDamage = Math.max(0, Number(spell.dot_damage) || 0);

  const damage =
    baseDamage > 0
      ? calculateScaledSpellAmount(player, baseDamage)
      : 0;

  const healing =
    baseHeal > 0
      ? calculateScaledHealingAmount(player, baseHeal)
      : 0;

  const dotDamage =
    baseDotDamage > 0
      ? calculateScaledSpellAmount(player, baseDotDamage)
      : 0;

  const dotDuration = Math.max(0, Number(spell.dot_duration) || 0);
  const dotTickRate = Math.max(0, Number(spell.dot_tick_rate) || 0);

  const buffStat = spell.buff_stat;
  const buffValue = Number(spell.buff_value) || 0;
  const buffDuration = Math.max(0, Number(spell.buff_duration) || 0);

  const debuffStat = spell.debuff_stat;
  const debuffValue = Number(spell.debuff_value) || 0;
  const debuffDuration = Math.max(0, Number(spell.debuff_duration) || 0);

  const effects: string[] = [];

  if (damage > 0) {
    effects.push(`Deals ${damage} damage before target mitigation.`);
  }

  if (healing > 0) {
    effects.push(`Restores ${healing} health.`);
  }

  if (dotDamage > 0) {
    const durationText = dotDuration > 0 ? ` over ${dotDuration} sec` : "";
    effects.push(`Deals ${dotDamage} damage${durationText}.`);
  }

  const buffDescription = describeBuff(
    buffStat,
    buffValue,
    buffDuration
  );

  if (buffDescription) {
    effects.push(buffDescription);
  }

  const debuffDescription = describeDebuff(
    debuffStat,
    debuffValue,
    debuffDuration
  );

  if (debuffDescription) {
    effects.push(debuffDescription);
  }

  return {
    manaCost: Math.max(0, Number(castState?.manaCost ?? spell.mana_cost) || 0),
    cooldown: Math.max(
      0,
      Number(castState?.cooldownSeconds ?? spell.cooldown) || 0
    ),

    damage,
    healing,
    dotDamage,
    dotDuration,
    dotTickRate,

    buffStat,
    buffValue,
    buffDuration,
    debuffStat,
    debuffValue,
    debuffDuration,

    description: joinDescription(
      spell.description ?? baseSpell.description,
      effects
    ),

    // Useful for other UI surfaces without forcing the browser to understand
    // spell-rank/talent internals.
    rank: Number(prepared.spellRank.spellRank) || 1
  };
}
