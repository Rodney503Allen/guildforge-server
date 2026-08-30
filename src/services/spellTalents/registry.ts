import {
  customTalentHandlers,
  genericTalentHandlers
} from "./handlers";
import type { SpellTalentHandler } from "./types";

const registeredTalentHandlers = new Map<
  string,
  SpellTalentHandler
>();

function normalizeHandlerKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function registerSpellTalentHandler(
  handlerKey: string,
  handler: SpellTalentHandler
): void {
  const normalized = normalizeHandlerKey(handlerKey);

  if (!normalized) {
    throw new Error("TALENT_HANDLER_KEY_REQUIRED");
  }

  if (
    genericTalentHandlers[normalized] ||
    customTalentHandlers[normalized]
  ) {
    throw new Error(`TALENT_HANDLER_KEY_RESERVED:${normalized}`);
  }

  if (registeredTalentHandlers.has(normalized)) {
    throw new Error(`TALENT_HANDLER_ALREADY_REGISTERED:${normalized}`);
  }

  registeredTalentHandlers.set(normalized, handler);
}

export function getSpellTalentHandler(
  handlerKey: string
): SpellTalentHandler | null {
  const normalized = normalizeHandlerKey(handlerKey);

  return (
    registeredTalentHandlers.get(normalized) ??
    customTalentHandlers[normalized] ??
    genericTalentHandlers[normalized] ??
    null
  );
}

export function requireSpellTalentHandler(
  handlerKey: string
): SpellTalentHandler {
  const handler = getSpellTalentHandler(handlerKey);

  if (!handler) {
    throw new Error(`UNKNOWN_TALENT_HANDLER:${handlerKey}`);
  }

  return handler;
}