import type {
  ActiveSpellTalent,
  SpellCastState,
  SpellTalentHelpers,
  TalentConfig
} from "./types";

function normalizeHandlerKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function createSpellCastState(args: {
  manaCost: number;
  cooldownSeconds: number;
}): SpellCastState {
  return {
    manaCost: Math.max(0, Number(args.manaCost) || 0),
    cooldownSeconds: Math.max(
      0,
      Number(args.cooldownSeconds) || 0
    ),
    damageMultiplier: 1,
    healingMultiplier: 1,
    flags: new Set<string>(),
    values: new Map<string, unknown>()
  };
}

export function createSpellTalentHelpers(
  talents: ActiveSpellTalent[]
): SpellTalentHelpers {
  const byHandlerKey = new Map<string, ActiveSpellTalent>();

  for (const talent of talents) {
    const handlerKey = normalizeHandlerKey(talent.handlerKey);

    if (handlerKey) {
      byHandlerKey.set(handlerKey, talent);
    }
  }

  const getTalent = (
    handlerKey: string
  ): ActiveSpellTalent | null => {
    return byHandlerKey.get(
      normalizeHandlerKey(handlerKey)
    ) ?? null;
  };

  return {
    hasTalent(handlerKey: string): boolean {
      return getTalent(handlerKey) !== null;
    },

    getTalent,

    getTalentConfig<T extends TalentConfig = TalentConfig>(
      handlerKey: string
    ): T | null {
      const talent = getTalent(handlerKey);
      return talent ? (talent.config as T) : null;
    }
  };
}

