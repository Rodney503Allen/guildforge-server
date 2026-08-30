import type { SharedCombatDamageEvent } from "./types";

export function appendCombatLog(
  log: string[],
  line: string,
  maximumEntries: number = 60,
): void {
  log.push(line);
  if (log.length > maximumEntries) log.splice(0, log.length - maximumEntries);
}

export function appendCombatDamageEvent(
  events: SharedCombatDamageEvent[],
  nextId: () => number,
  event: Omit<SharedCombatDamageEvent, "id" | "createdAt">,
  maximumEntries: number = 40,
): void {
  const amount = Math.max(0, Math.floor(Number(event.amount) || 0));
  if (amount <= 0) return;
  events.push({ ...event, id: nextId(), amount, crit: Boolean(event.crit), createdAt: Date.now() });
  if (events.length > maximumEntries) events.splice(0, events.length - maximumEntries);
}
