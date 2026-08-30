import type { CombatTimelineActor } from "./types";

export const COMBAT_TIMING = {
  baseAtbSeconds: 6,
  minimumAtbSeconds: 3,
  maximumAgility: 500,
  agilityExponent: 0.6,
  playerAutoAttackMs: 6000,
} as const;

export function getCombatATBTimeSeconds(agility: number): number {
  const bounded = Math.max(
    0,
    Math.min(COMBAT_TIMING.maximumAgility, Number(agility) || 0),
  );
  const progress = Math.pow(
    bounded / COMBAT_TIMING.maximumAgility,
    COMBAT_TIMING.agilityExponent,
  );
  return COMBAT_TIMING.baseAtbSeconds -
    progress * (COMBAT_TIMING.baseAtbSeconds - COMBAT_TIMING.minimumAtbSeconds);
}

export function getCombatATBFillRate(agility: number): number {
  return 100 / getCombatATBTimeSeconds(agility);
}

export function advanceCombatActorGauge(
  actor: CombatTimelineActor,
  previousUpdateAt: number,
  now: number = Date.now(),
): void {
  if (actor.hp <= 0 || actor.ready) return;
  const startedAt = Math.max(previousUpdateAt, actor.recoveryUntil);
  const elapsedMs = Math.max(0, now - startedAt);
  if (elapsedMs <= 0) return;
  const multiplier = Math.max(0.01, Number(actor.atbRateMult) || 1);
  actor.gauge = Math.min(
    100,
    actor.gauge + getCombatATBFillRate(actor.stats.agility) * multiplier * elapsedMs / 1000,
  );
  actor.ready = actor.gauge >= 100;
  if (actor.ready) actor.gauge = 100;
}

export function getCombatActorReadyInMs(
  actor: CombatTimelineActor,
  now: number = Date.now(),
): number {
  if (actor.hp <= 0 || actor.ready) return 0;
  const recoveryMs = Math.max(0, actor.recoveryUntil - now);
  const multiplier = Math.max(0.01, Number(actor.atbRateMult) || 1);
  const fillRate = Math.max(
    0.0001,
    getCombatATBFillRate(actor.stats.agility) * multiplier,
  );
  return recoveryMs + Math.max(0, 100 - actor.gauge) / fillRate * 1000;
}

export function consumeCombatActorTurn(
  actor: Pick<CombatTimelineActor, "gauge" | "ready" | "recoveryUntil">,
  recoveryMs: number,
  now: number = Date.now(),
): void {
  actor.gauge = 0;
  actor.ready = false;
  actor.recoveryUntil = now + Math.max(0, Number(recoveryMs) || 0);
}
