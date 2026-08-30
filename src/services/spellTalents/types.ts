import type {
  SpellHandlerContext,
  SpellHandlerResult,
  SpellRecord
} from "../spellHandlers/types";

export type TalentConfig = Record<string, unknown>;

export type ActiveSpellTalent = {
  id: number;
  spellId: number;
  name: string;
  description: string;
  requiredLevel: number;
  requiredSpellRank: 1 | 2 | 3;
  tier: number;
  position: number;
  choiceGroup: string | null;
  prerequisiteTalentId: number | null;
  handlerKey: string;
  config: TalentConfig;
};

export type SpellRankDefinition = {
  id: number;
  spellId: number;
  spellRank: 1 | 2 | 3;
  requiredLevel: number;
  skillPointCost: number;
  config: TalentConfig;
  overrides: Partial<SpellRecord>;
};

export type SpellCastState = {
  manaCost: number;
  cooldownSeconds: number;
  damageMultiplier: number;
  healingMultiplier: number;
  flags: Set<string>;
  values: Map<string, unknown>;
};

export type SpellTalentHelpers = {
  hasTalent: (handlerKey: string) => boolean;
  getTalent: (handlerKey: string) => ActiveSpellTalent | null;
  getTalentConfig: <T extends TalentConfig = TalentConfig>(
    handlerKey: string
  ) => T | null;
};

export type TalentSpellModifierContext = SpellTalentHelpers & {
  playerId: number;
  baseSpell: SpellRecord;
  spell: SpellRecord;
  spellRank: SpellRankDefinition;
  talents: ActiveSpellTalent[];
  talent: ActiveSpellTalent;
  castState: SpellCastState;
};

export type SpellTalentCastContext =
  SpellHandlerContext &
  SpellTalentHelpers & {
    baseSpell: SpellRecord;
    spellRank: SpellRankDefinition;
    talents: ActiveSpellTalent[];
    talent: ActiveSpellTalent;
    castState: SpellCastState;
  };

export type SpellTalentHandler = {
  modifySpell?: (
    context: TalentSpellModifierContext
  ) => void | Promise<void>;

  validateCast?: (
    context: SpellTalentCastContext
  ) => string | null | Promise<string | null>;

  beforeCast?: (
    context: SpellTalentCastContext
  ) => void | Promise<void>;

  afterCast?: (
    context: SpellTalentCastContext,
    result: SpellHandlerResult
  ) => SpellHandlerResult | void | Promise<SpellHandlerResult | void>;
};

export type PreparedSpellCast = SpellTalentHelpers & {
  playerId: number;
  baseSpell: SpellRecord;
  spell: SpellRecord;
  spellRank: SpellRankDefinition;
  talents: ActiveSpellTalent[];
  castState: SpellCastState;
};

