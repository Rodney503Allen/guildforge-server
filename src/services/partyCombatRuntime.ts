// src/services/partyCombatRuntime.ts
import { getFinalPlayerStats } from "./playerService";
import type { DerivedStats } from "./statEngine";
import { createCombatThreatTable } from "./combatThreatService";

export type PartyCombatPlayer = {
  playerId: number;
  name: string;

  hp: number;
  maxHp: number;

  sp: number;
  maxSp: number;

  stats: DerivedStats;

  gauge: number;
  ready: boolean;

  recoveryUntil: number;
  nextAutoAttackAt: number;

  cooldowns: Record<string, number>;
};

export type PartyCombatEnemy = {
  encounterId: number;
  creatureId: number;

  /**
   * Optional context-specific source id.
   * Hunts use huntTargetId. Dungeons can later use
   * room/wave/boss identifiers without changing the
   * core combat runtime.
   */
  sourceId?: number | null;

  name: string;
  level: number;
  description: string;
  image: string | null;

  hp: number;
  maxHp: number;

  gauge: number;
  ready: boolean;
  recoveryUntil: number;

  threat: Record<number, number>;
  targetPlayerId: number | null;

  stats: DerivedStats;
};

export type PartyCombatDotEffect = {
  id: number;
  sourcePlayerId: number;

  spellId: number;
  spellName: string;

  totalDamage: number;
  totalTicks: number;
  ticksApplied: number;

  tickIntervalMs: number;
  nextTickAt: number;
  expiresAt: number;

  defenseReductionPerTick?: number;
  defenseReductionMaxStacks?: number;
  manaRestorePercentPerTick?: number;
  tickHealingPercent?: number;
};

export type PartyCombatDebuffStat =
  | "attack"
  | "defense"
  | "agility"
  | "vitality"
  | "intellect"
  | "crit"
  | "attack_speed_pct"
  | "damage_dealt_pct"
  | "damage_taken_pct"
  | "spell_damage_taken_pct"
  | "judgment"
  | "judgment_refresh_on_spell"
  | "judgment_refresh_icd"
  | "judgment_crit_upgrade"
  | "crit_chance_taken_pct"
  | "critical_damage_taken_pct"
  | "warlord_bounty_gauge"
  | "warlord_bounty_icd"
  | "warlord_mark_extension"
  | "warlord_claim_hp_pct"
  | "warlord_claim_mana_pct"
  | "warlord_claim_gauge";

export type PartyCombatDebuffEffect = {
  id: number;
  sourcePlayerId: number;

  spellId: number;
  spellName: string;

  stat: PartyCombatDebuffStat;
  value: number;

  appliedAt: number;
  expiresAt: number;
};

export function clampPartyCombatValue(
  value: number,
  min: number,
  max: number,
) {
  return Math.max(min, Math.min(max, value));
}

export async function createPartyCombatPlayers(
  playerIds: Iterable<number>,
  options: {
    now?: number;
    autoAttackMs: number;
  },
): Promise<Map<number, PartyCombatPlayer>> {
  const now = options.now ?? Date.now();
  const players = new Map<number, PartyCombatPlayer>();

  for (const rawPlayerId of playerIds) {
    const playerId = Number(rawPlayerId);

    if (!Number.isInteger(playerId) || playerId <= 0) {
      continue;
    }

    const stats = await getFinalPlayerStats(playerId);

    if (!stats) {
      continue;
    }

    players.set(playerId, {
      playerId,
      name: stats.name ?? "Adventurer",

      hp: Number(stats.hpoints ?? 0),
      maxHp: Math.max(1, Number(stats.maxhp ?? 1)),

      sp: Number(stats.spoints ?? 0),
      maxSp: Math.max(0, Number(stats.maxspoints ?? 0)),

      stats,

      gauge: 0,
      ready: false,

      recoveryUntil: 0,
      nextAutoAttackAt: now + options.autoAttackMs,

      cooldowns: {},
    });
  }

  return players;
}

export function createPartyCombatEnemyStats(args: {
  level: number;
  attack: number;
  defense: number;
  agility: number;
  crit: number;
  hp: number;
  maxHp: number;
}): DerivedStats {
  return {
    level: Number(args.level ?? 1),

    attack: Number(args.attack ?? 0),
    defense: Number(args.defense ?? 0),
    agility: Number(args.agility ?? 0),

    vitality: 0,
    intellect: 0,

    crit: clampPartyCombatValue(
      Number(args.crit ?? 0) * 0.005,
      0,
      0.4,
    ),

    hpoints: Number(args.hp ?? 0),
    spoints: 0,

    maxhp: Math.max(1, Number(args.maxHp ?? 1)),
    maxspoints: 0,

    spellPower: 1,

    dodgeChance: clampPartyCombatValue(
      Number(args.agility ?? 0) * 0.002,
      0,
      0.35,
    ),

    critDamageMult: 1.5,
    damageReduction: 0,
    lifesteal: 0,

    healingReceivedMult: 1,
    healingDealtMult: 1,

    atbRateMult: 1,
    damageTakenMult: 1,
  };
}

export function createPartyCombatEnemy(args: {
  encounterId: number;
  creatureId: number;
  sourceId?: number | null;

  name: string;
  level: number;
  description?: string;
  image?: string | null;

  hp: number;
  maxHp: number;

  attack: number;
  defense: number;
  agility: number;
  crit: number;

  participantIds: Iterable<number>;
}): PartyCombatEnemy {
  const stats = createPartyCombatEnemyStats({
    level: args.level,
    attack: args.attack,
    defense: args.defense,
    agility: args.agility,
    crit: args.crit,
    hp: args.hp,
    maxHp: args.maxHp,
  });

  return {
    encounterId: Number(args.encounterId),
    creatureId: Number(args.creatureId),
    sourceId: args.sourceId ?? null,

    name: String(args.name || "Enemy"),
    level: Number(args.level ?? 1),
    description: String(args.description ?? ""),
    image: args.image ?? null,

    hp: Number(args.hp ?? 0),
    maxHp: Math.max(1, Number(args.maxHp ?? 1)),

    gauge: 0,
    ready: false,
    recoveryUntil: 0,

    threat: createCombatThreatTable(args.participantIds),
    targetPlayerId: null,

    stats,
  };
}

export function getLivingPartyCombatPlayers<T extends PartyCombatPlayer>(
  players: Iterable<T>,
): T[] {
  return Array.from(players).filter(
    player => Number(player.hp) > 0,
  );
}
