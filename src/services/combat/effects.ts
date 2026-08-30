export function calculateDistributedTickDamage(
  totalDamage: number,
  totalTicks: number,
  ticksApplied: number,
): number {
  const damage = Math.max(0, Number(totalDamage) || 0);
  const ticks = Math.max(1, Math.floor(Number(totalTicks) || 1));
  const applied = Math.max(0, Math.floor(Number(ticksApplied) || 0));
  const before = Math.floor(damage * applied / ticks);
  const after = Math.floor(damage * (applied + 1) / ticks);
  return Math.max(0, after - before);
}

export function calculateEffectTickCount(durationSeconds: number, tickRateSeconds: number): number {
  return Math.max(1, Math.floor(
    Math.max(0.1, Number(durationSeconds) || 0.1) /
    Math.max(0.1, Number(tickRateSeconds) || 0.1),
  ));
}

export function getEffectRemainingMs(expiresAt: number, now: number = Date.now()): number {
  return Math.max(0, Number(expiresAt) - now);
}
