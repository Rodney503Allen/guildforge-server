import type { CombatCooldownActor } from "./types";

export function isCombatCooldownReady(
  actor: CombatCooldownActor,
  key: string,
  now: number = Date.now(),
): boolean {
  return now >= (actor.cooldowns[key] || 0);
}

export function setCombatCooldown(
  actor: CombatCooldownActor,
  key: string,
  seconds: number,
  now: number = Date.now(),
): void {
  actor.cooldowns[key] = now + Math.max(0, Number(seconds) || 0) * 1000;
}

export function resetCombatSpellCooldown(
  actor: CombatCooldownActor,
  spellId: number,
  now: number = Date.now(),
): void {
  actor.cooldowns[`spell:${spellId}`] = now;
}

export function reduceCombatSpellCooldowns(
  actor: CombatCooldownActor,
  seconds: number,
  excludedSpellIds: Iterable<number> = [],
  now: number = Date.now(),
): void {
  const reductionMs = Math.max(0, Number(seconds) || 0) * 1000;
  if (reductionMs <= 0) return;
  const excluded = new Set(Array.from(excludedSpellIds, Number));
  for (const [key, until] of Object.entries(actor.cooldowns)) {
    if (!key.startsWith("spell:")) continue;
    if (excluded.has(Number(key.slice(6)))) continue;
    actor.cooldowns[key] = Math.max(now, Number(until || 0) - reductionMs);
  }
}
