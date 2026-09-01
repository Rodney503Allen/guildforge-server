import type { EnemyMechanicHandler } from "./types";

const handlers = new Map<string, EnemyMechanicHandler>();

export function registerEnemyMechanicHandler(
  handlerKey: string,
  handler: EnemyMechanicHandler,
): void {
  const key = String(handlerKey || "").trim();
  if (!key) throw new Error("Enemy mechanic handler key is required.");
  handlers.set(key, handler);
}

export function registerEnemyMechanicHandlers(
  definitions: Record<string, EnemyMechanicHandler>,
): void {
  for (const [handlerKey, handler] of Object.entries(definitions)) {
    registerEnemyMechanicHandler(handlerKey, handler);
  }
}

export function getEnemyMechanicHandler(
  handlerKey: string,
): EnemyMechanicHandler | null {
  return handlers.get(String(handlerKey || "").trim()) ?? null;
}

export function hasEnemyMechanicHandler(handlerKey: string): boolean {
  return handlers.has(String(handlerKey || "").trim());
}
