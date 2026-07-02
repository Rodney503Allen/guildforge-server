// src/services/professionExperienceService.ts
import { db } from "../db";

export function professionXpNeeded(level: number) {
  return Math.floor(50 + level * level * 25);
}

export async function grantProfessionExperience(
  conn: any,
  playerId: number,
  professionName: string,
  xpGained: number
) {
  const [[profession]]: any = await conn.query(
    `SELECT id, name FROM professions WHERE name = ? LIMIT 1`,
    [professionName]
  );

  if (!profession) throw new Error("profession_not_found");

  const [rows]: any = await conn.query(
    `
    SELECT level, experience
    FROM player_professions
    WHERE player_id = ? AND profession_id = ?
    FOR UPDATE
    `,
    [playerId, profession.id]
  );

  let level = 1;
  let experience = 0;

  if (!rows.length) {
    await conn.query(
      `
      INSERT INTO player_professions
      (player_id, profession_id, level, experience, is_specialized)
      VALUES (?, ?, 1, 0, 0)
      `,
      [playerId, profession.id]
    );
  } else {
    level = Number(rows[0].level || 1);
    experience = Number(rows[0].experience || 0);
  }

  experience += Number(xpGained || 0);

  let levelsGained = 0;

  while (experience >= professionXpNeeded(level)) {
    experience -= professionXpNeeded(level);
    level += 1;
    levelsGained += 1;
  }

  await conn.query(
    `
    UPDATE player_professions
    SET level = ?, experience = ?
    WHERE player_id = ? AND profession_id = ?
    `,
    [level, experience, playerId, profession.id]
  );

  return {
    professionName: profession.name,
    xpGained: Number(xpGained || 0),
    leveledUp: levelsGained > 0,
    newLevel: level,
    levelsGained
  };
}