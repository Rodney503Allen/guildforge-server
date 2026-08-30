import { db } from "../../db";
import type { SpellRecord } from "../spellHandlers/types";
import type {
  ActiveSpellTalent,
  SpellRankDefinition,
  TalentConfig
} from "./types";

const RANK_OVERRIDE_FIELDS: Array<keyof SpellRecord> = [
  "mana_cost",
  "cooldown",
  "damage",
  "heal",
  "dot_damage",
  "dot_duration",
  "dot_tick_rate",
  "buff_stat",
  "buff_value",
  "buff_duration",
  "debuff_stat",
  "debuff_value",
  "debuff_duration"
];

function parseJsonObject(value: unknown): TalentConfig {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as TalentConfig;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as TalentConfig;
      }
    } catch {
      throw new Error("INVALID_TALENT_JSON_CONFIG");
    }
  }

  throw new Error("INVALID_TALENT_JSON_CONFIG");
}

function toSpellRank(value: unknown): 1 | 2 | 3 {
  const rank = Number(value);

  if (rank !== 1 && rank !== 2 && rank !== 3) {
    throw new Error("INVALID_PLAYER_SPELL_RANK");
  }

  return rank;
}

export async function loadPlayerSpellRank(
  playerId: number,
  spellId: number
): Promise<SpellRankDefinition> {
  const [[row]]: any = await db.query(
    `
      SELECT
        sr.*
      FROM player_spells ps
      JOIN spell_ranks sr
        ON sr.spell_id = ps.spell_id
       AND sr.spell_rank = ps.skill_level
      WHERE ps.player_id = ?
        AND ps.spell_id = ?
      LIMIT 1
    `,
    [playerId, spellId]
  );

  if (!row) {
    throw new Error("PLAYER_SPELL_RANK_NOT_FOUND");
  }

  const overrides: Partial<SpellRecord> = {};

  for (const field of RANK_OVERRIDE_FIELDS) {
    if (row[field] !== null && row[field] !== undefined) {
      overrides[field] = row[field];
    }
  }

  return {
    id: Number(row.id),
    spellId: Number(row.spell_id),
    spellRank: toSpellRank(row.spell_rank),
    requiredLevel: Number(row.required_level),
    skillPointCost: Number(row.skill_point_cost),
    config: parseJsonObject(row.config),
    overrides
  };
}

export async function loadActiveSpellTalents(
  playerId: number,
  spellId: number
): Promise<ActiveSpellTalent[]> {
  const [rows]: any = await db.query(
    `
      SELECT
        st.id,
        st.spell_id,
        st.name,
        st.description,
        st.required_level,
        st.required_spell_rank,
        st.tier,
        st.position,
        st.choice_group,
        st.prerequisite_talent_id,
        st.handler_key,
        st.config
      FROM player_spell_talents pst
      JOIN spell_talents st
        ON st.id = pst.talent_id
       AND st.is_active = 1
      WHERE pst.player_id = ?
        AND st.spell_id = ?
      ORDER BY st.tier ASC, st.position ASC, st.id ASC
    `,
    [playerId, spellId]
  );

  return (rows ?? []).map((row: any): ActiveSpellTalent => ({
    id: Number(row.id),
    spellId: Number(row.spell_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    requiredLevel: Number(row.required_level),
    requiredSpellRank: toSpellRank(row.required_spell_rank),
    tier: Number(row.tier),
    position: Number(row.position),
    choiceGroup: row.choice_group
      ? String(row.choice_group)
      : null,
    prerequisiteTalentId: row.prerequisite_talent_id === null
      ? null
      : Number(row.prerequisite_talent_id),
    handlerKey: String(row.handler_key)
      .trim()
      .toLowerCase(),
    config: parseJsonObject(row.config)
  }));
}

export function applySpellRankOverrides(
  baseSpell: SpellRecord,
  rank: SpellRankDefinition
): SpellRecord {
  return {
    ...baseSpell,
    ...rank.overrides,
    skill_rank: rank.spellRank,
    rank_required_level: rank.requiredLevel,
    rank_config: rank.config
  };
}

