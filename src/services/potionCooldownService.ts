export type CombatPotionSlot = "health" | "mana";

const POTION_COOLDOWN_MS = 20_000;

const potionCooldowns = new Map<
  number,
  Record<CombatPotionSlot, number>
>();

function getPlayerCooldowns(
  playerId: number,
): Record<CombatPotionSlot, number> {
  const normalizedPlayerId = Number(playerId);
  const existing = potionCooldowns.get(normalizedPlayerId);
  if (existing) return existing;

  const fresh = { health: 0, mana: 0 };
  potionCooldowns.set(normalizedPlayerId, fresh);
  return fresh;
}

export function getPotionCooldownRemainingMs(
  playerId: number,
  slot: CombatPotionSlot,
  now = Date.now(),
): number {
  return Math.max(
    0,
    Number(getPlayerCooldowns(playerId)[slot] ?? 0) - now,
  );
}

export function getPotionCooldownSnapshot(
  playerId: number,
  now = Date.now(),
) {
  return {
    health: getPotionCooldownRemainingMs(playerId, "health", now),
    mana: getPotionCooldownRemainingMs(playerId, "mana", now),
  };
}

export function startPotionCooldown(
  playerId: number,
  slot: CombatPotionSlot,
  now = Date.now(),
): number {
  const cooldowns = getPlayerCooldowns(playerId);
  cooldowns[slot] = now + POTION_COOLDOWN_MS;
  return cooldowns[slot];
}

export const COMBAT_POTION_COOLDOWN_MS = POTION_COOLDOWN_MS;
