import { db } from "../db";

export type SpellProgressionErrorCode =
  | "PLAYER_NOT_FOUND"
  | "SPELL_NOT_AVAILABLE_TO_CLASS"
  | "SPELL_ALREADY_MAX_RANK"
  | "SPELL_RANK_NOT_CONFIGURED"
  | "LEVEL_TOO_LOW"
  | "NOT_ENOUGH_SKILL_POINTS"
  | "SPELL_NOT_LEARNED"
  | "SPELL_RANK_TOO_LOW"
  | "TALENT_NOT_AVAILABLE_TO_CLASS"
  | "TALENT_ALREADY_LEARNED"
  | "TALENT_PREREQUISITE_REQUIRED"
  | "TALENT_CHOICE_CONFLICT"
  | "PROGRESSION_UPDATE_FAILED";

export class SpellProgressionError extends Error {
  code: SpellProgressionErrorCode;

  constructor(
    code: SpellProgressionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SpellProgressionError";
    this.code = code;
  }
}

export type TrainSpellResult = {
  spellId: number;
  previousRank: number;
  newRank: 1 | 2 | 3;
  skillPointsSpent: number;
  skillPointsRemaining: number;
};

export type LearnTalentResult = {
  spellId: number;
  talentId: number;
  skillPointsSpent: number;
  skillPointsRemaining: number;
};

function fail(
  code: SpellProgressionErrorCode,
  message: string
): never {
  throw new SpellProgressionError(code, message);
}

async function spendSkillPoints(
  conn: any,
  playerId: number,
  cost: number
): Promise<number> {
  const normalizedCost = Math.max(1, Math.floor(Number(cost) || 1));
  const [result]: any = await conn.query(
    `
      UPDATE players
      SET skill_points = skill_points - ?
      WHERE id = ?
        AND skill_points >= ?
    `,
    [normalizedCost, playerId, normalizedCost]
  );

  if (result.affectedRows !== 1) {
    fail("NOT_ENOUGH_SKILL_POINTS", "You do not have enough skill points.");
  }

  const [[player]]: any = await conn.query(
    `SELECT skill_points FROM players WHERE id = ? LIMIT 1`,
    [playerId]
  );

  return Math.max(0, Number(player?.skill_points) || 0);
}

export async function trainNextSpellRank(
  playerId: number,
  spellId: number
): Promise<TrainSpellResult> {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [[player]]: any = await conn.query(
      `
        SELECT class_id, level, skill_points
        FROM players
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [playerId]
    );

    if (!player) {
      fail("PLAYER_NOT_FOUND", "Player not found.");
    }

    const [[spell]]: any = await conn.query(
      `
        SELECT s.id, s.name
        FROM spells s
        JOIN disciplines d
          ON d.id = s.discipline_id
         AND d.is_active = 1
        WHERE s.id = ?
          AND d.class_id = ?
        LIMIT 1
      `,
      [spellId, player.class_id]
    );

    if (!spell) {
      fail(
        "SPELL_NOT_AVAILABLE_TO_CLASS",
        "That spell is not available to your class."
      );
    }

    const [[owned]]: any = await conn.query(
      `
        SELECT skill_level
        FROM player_spells
        WHERE player_id = ?
          AND spell_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [playerId, spellId]
    );

    const previousRank = owned
      ? Math.max(1, Number(owned.skill_level) || 1)
      : 0;
    const nextRank = previousRank + 1;

    if (nextRank > 3) {
      fail("SPELL_ALREADY_MAX_RANK", `${spell.name} is already Rank 3.`);
    }

    const [[rank]]: any = await conn.query(
      `
        SELECT required_level, skill_point_cost
        FROM spell_ranks
        WHERE spell_id = ?
          AND spell_rank = ?
        LIMIT 1
      `,
      [spellId, nextRank]
    );

    if (!rank) {
      fail(
        "SPELL_RANK_NOT_CONFIGURED",
        `Rank ${nextRank} is not configured for ${spell.name}.`
      );
    }

    const requiredLevel = Math.max(1, Number(rank.required_level) || 1);
    const cost = Math.max(1, Number(rank.skill_point_cost) || 1);

    if (Number(player.level) < requiredLevel) {
      fail("LEVEL_TOO_LOW", `Rank ${nextRank} requires Level ${requiredLevel}.`);
    }

    if (Number(player.skill_points) < cost) {
      fail(
        "NOT_ENOUGH_SKILL_POINTS",
        `Rank ${nextRank} requires ${cost} skill point${cost === 1 ? "" : "s"}.`
      );
    }

    const skillPointsRemaining = await spendSkillPoints(conn, playerId, cost);

    if (previousRank === 0) {
      const [result]: any = await conn.query(
        `
          INSERT INTO player_spells (player_id, spell_id, skill_level)
          VALUES (?, ?, 1)
        `,
        [playerId, spellId]
      );

      if (result.affectedRows !== 1) {
        fail("PROGRESSION_UPDATE_FAILED", "Failed to learn the spell.");
      }
    } else {
      const [result]: any = await conn.query(
        `
          UPDATE player_spells
          SET skill_level = ?
          WHERE player_id = ?
            AND spell_id = ?
            AND skill_level = ?
        `,
        [nextRank, playerId, spellId, previousRank]
      );

      if (result.affectedRows !== 1) {
        fail("PROGRESSION_UPDATE_FAILED", "Failed to upgrade the spell.");
      }
    }

    await conn.commit();

    return {
      spellId,
      previousRank,
      newRank: nextRank as 1 | 2 | 3,
      skillPointsSpent: cost,
      skillPointsRemaining
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function learnSpellTalent(
  playerId: number,
  talentId: number
): Promise<LearnTalentResult> {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [[player]]: any = await conn.query(
      `
        SELECT class_id, level, skill_points
        FROM players
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [playerId]
    );

    if (!player) {
      fail("PLAYER_NOT_FOUND", "Player not found.");
    }

    const [[talent]]: any = await conn.query(
      `
        SELECT
          st.id,
          st.spell_id,
          st.name,
          st.required_level,
          st.required_spell_rank,
          st.skill_point_cost,
          st.choice_group,
          st.prerequisite_talent_id
        FROM spell_talents st
        JOIN spells s ON s.id = st.spell_id
        JOIN disciplines d
          ON d.id = s.discipline_id
         AND d.is_active = 1
        WHERE st.id = ?
          AND st.is_active = 1
          AND d.class_id = ?
        LIMIT 1
      `,
      [talentId, player.class_id]
    );

    if (!talent) {
      fail(
        "TALENT_NOT_AVAILABLE_TO_CLASS",
        "That talent is not available to your class."
      );
    }

    const [[ownedSpell]]: any = await conn.query(
      `
        SELECT skill_level
        FROM player_spells
        WHERE player_id = ?
          AND spell_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [playerId, talent.spell_id]
    );

    if (!ownedSpell) {
      fail(
        "SPELL_NOT_LEARNED",
        "You must learn the spell before purchasing its talents."
      );
    }

    const requiredLevel = Math.max(1, Number(talent.required_level) || 1);
    const requiredRank = Math.max(1, Number(talent.required_spell_rank) || 1);
    const cost = Math.max(1, Number(talent.skill_point_cost) || 1);

    if (Number(player.level) < requiredLevel) {
      fail("LEVEL_TOO_LOW", `${talent.name} requires Level ${requiredLevel}.`);
    }

    if (Number(ownedSpell.skill_level) < requiredRank) {
      fail(
        "SPELL_RANK_TOO_LOW",
        `${talent.name} requires spell Rank ${requiredRank}.`
      );
    }

    const [[alreadyLearned]]: any = await conn.query(
      `
        SELECT 1
        FROM player_spell_talents
        WHERE player_id = ?
          AND talent_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [playerId, talentId]
    );

    if (alreadyLearned) {
      fail("TALENT_ALREADY_LEARNED", "You already know that talent.");
    }

    if (talent.prerequisite_talent_id !== null) {
      const [[prerequisite]]: any = await conn.query(
        `
          SELECT 1
          FROM player_spell_talents
          WHERE player_id = ?
            AND talent_id = ?
          LIMIT 1
          FOR UPDATE
        `,
        [playerId, talent.prerequisite_talent_id]
      );

      if (!prerequisite) {
        fail(
          "TALENT_PREREQUISITE_REQUIRED",
          "You must learn the previous talent first."
        );
      }
    }

    if (talent.choice_group) {
      const [[conflict]]: any = await conn.query(
        `
          SELECT selected.name
          FROM player_spell_talents pst
          JOIN spell_talents selected ON selected.id = pst.talent_id
          WHERE pst.player_id = ?
            AND selected.spell_id = ?
            AND selected.choice_group = ?
          LIMIT 1
          FOR UPDATE
        `,
        [playerId, talent.spell_id, talent.choice_group]
      );

      if (conflict) {
        fail(
          "TALENT_CHOICE_CONFLICT",
          `You already selected ${conflict.name} from this choice.`
        );
      }
    }

    if (Number(player.skill_points) < cost) {
      fail(
        "NOT_ENOUGH_SKILL_POINTS",
        `${talent.name} requires ${cost} skill point${cost === 1 ? "" : "s"}.`
      );
    }

    const skillPointsRemaining = await spendSkillPoints(conn, playerId, cost);
    const [result]: any = await conn.query(
      `
        INSERT INTO player_spell_talents (player_id, talent_id)
        VALUES (?, ?)
      `,
      [playerId, talentId]
    );

    if (result.affectedRows !== 1) {
      fail("PROGRESSION_UPDATE_FAILED", "Failed to learn the talent.");
    }

    await conn.commit();

    return {
      spellId: Number(talent.spell_id),
      talentId,
      skillPointsSpent: cost,
      skillPointsRemaining
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
