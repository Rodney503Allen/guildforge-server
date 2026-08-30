import type {
  SpellHandlerContext,
  SpellHandlerResult,
  SpellRecord
} from "../spellHandlers/types";
import {
  createSpellCastState,
  createSpellTalentHelpers
} from "./context";
import { requireSpellTalentHandler } from "./registry";
import {
  applySpellRankOverrides,
  loadActiveSpellTalents,
  loadPlayerSpellRank
} from "./spellTalentService";
import type {
  ActiveSpellTalent,
  PreparedSpellCast,
  SpellTalentCastContext,
  TalentSpellModifierContext
} from "./types";

function assertIdentity(
  playerId: number,
  baseSpell: SpellRecord
): void {
  if (!Number.isInteger(playerId) || playerId <= 0) {
    throw new Error("INVALID_PLAYER_ID");
  }

  if (!Number.isInteger(Number(baseSpell.id)) || Number(baseSpell.id) <= 0) {
    throw new Error("INVALID_SPELL_ID");
  }
}

export async function prepareSpellForCast(
  playerId: number,
  baseSpell: SpellRecord
): Promise<PreparedSpellCast> {
  assertIdentity(playerId, baseSpell);

  const [spellRank, talents] = await Promise.all([
    loadPlayerSpellRank(playerId, Number(baseSpell.id)),
    loadActiveSpellTalents(playerId, Number(baseSpell.id))
  ]);

  const spell = applySpellRankOverrides(baseSpell, spellRank);
  const castState = createSpellCastState({
    manaCost: Number(spell.mana_cost ?? 0),
    cooldownSeconds: Number(spell.cooldown ?? 0)
  });
  const helpers = createSpellTalentHelpers(talents);

  for (const talent of talents) {
    const handler = requireSpellTalentHandler(talent.handlerKey);

    if (!handler.modifySpell) {
      continue;
    }

    const context: TalentSpellModifierContext = {
      playerId,
      baseSpell,
      spell,
      spellRank,
      talents,
      talent,
      castState,
      ...helpers
    };

    await handler.modifySpell(context);
  }

  castState.manaCost = Math.max(
    0,
    Number(spell.mana_cost ?? castState.manaCost) || 0
  );
  castState.cooldownSeconds = Math.max(
    0,
    Number(spell.cooldown ?? castState.cooldownSeconds) || 0
  );

  return {
    playerId,
    baseSpell,
    spell,
    spellRank,
    talents,
    castState,
    ...helpers
  };
}

function buildTalentCastContext(
  prepared: PreparedSpellCast,
  handlerContext: SpellHandlerContext,
  talent: ActiveSpellTalent
): SpellTalentCastContext {
  return {
    ...handlerContext,
    spell: prepared.spell,
    baseSpell: prepared.baseSpell,
    spellRank: prepared.spellRank,
    talents: prepared.talents,
    talent,
    castState: prepared.castState,
    hasTalent: prepared.hasTalent,
    getTalent: prepared.getTalent,
    getTalentConfig: prepared.getTalentConfig
  };
}

export async function validatePreparedSpellTalents(
  prepared: PreparedSpellCast,
  handlerContext: SpellHandlerContext
): Promise<string | null> {
  for (const talent of prepared.talents) {
    const handler = requireSpellTalentHandler(talent.handlerKey);

    if (!handler.validateCast) {
      continue;
    }

    const error = await handler.validateCast(
      buildTalentCastContext(prepared, handlerContext, talent)
    );

    if (error) {
      return error;
    }
  }

  return null;
}

export async function runBeforeCastTalents(
  prepared: PreparedSpellCast,
  handlerContext: SpellHandlerContext
): Promise<void> {
  for (const talent of prepared.talents) {
    const handler = requireSpellTalentHandler(talent.handlerKey);

    if (handler.beforeCast) {
      await handler.beforeCast(
        buildTalentCastContext(prepared, handlerContext, talent)
      );
    }
  }
}

export async function runAfterCastTalents(
  prepared: PreparedSpellCast,
  handlerContext: SpellHandlerContext,
  initialResult: SpellHandlerResult
): Promise<SpellHandlerResult> {
  let result = initialResult;

  for (const talent of prepared.talents) {
    const handler = requireSpellTalentHandler(talent.handlerKey);

    if (!handler.afterCast) {
      continue;
    }

    const nextResult = await handler.afterCast(
      buildTalentCastContext(prepared, handlerContext, talent),
      result
    );

    if (nextResult) {
      result = nextResult;
    }
  }

  return result;
}

