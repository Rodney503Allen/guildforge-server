import type { DerivedStats } from "../statEngine";

export type CombatActionType = "attack" | "spell" | "item";

export type CombatTimelineActor = {
  hp: number;
  gauge: number;
  ready: boolean;
  recoveryUntil: number;
  atbRateMult?: number;
  stats: DerivedStats;
};

export type CombatCooldownActor = {
  cooldowns: Record<string, number>;
};

export type SharedCombatActor = CombatTimelineActor & CombatCooldownActor & {
  side: "player" | "enemy";
  name: string;
  level?: number;
  description?: string;
  maxHp: number;
  sp: number;
  maxSp: number;
};

export type CombatDamageKind = "attack" | "spell" | "dot" | "item" | "reflect";

export type SharedCombatDamageEvent = {
  id: number;
  source?: "player" | "enemy";
  playerId?: number;
  target: "player" | "enemy";
  amount: number;
  crit: boolean;
  kind: CombatDamageKind;
  spellId?: number;
  spellName?: string;
  createdAt: number;
};

export type CombatDebuffTotals = Record<string, number>;
