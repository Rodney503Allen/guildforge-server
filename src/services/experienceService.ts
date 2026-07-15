//services/experienceService.ts
import { db } from "../db";
import { getFinalPlayerStats } from "./playerService";

export function getExpForLevel(level: number): number {
  return level * 50 + level * level * 50;
}

export async function grantExperience(playerId: number, amount: number) {
  if (!amount || amount <= 0) {
    return {
      expGained: 0,
      levelUp: null
    };
  }

  await db.query(`
    UPDATE players
    SET exper = exper + ?
    WHERE id = ?
  `, [amount, playerId]);

  const levelUp = await checkAndApplyLevelUp(playerId);

  return {
    expGained: amount,
    levelUp
  };
}

export async function grantExperienceTx(conn: any, playerId: number, amount: number) {
  if (!amount || amount <= 0) {
    return {
      expGained: 0,
      levelUp: null
    };
  }

  await conn.query(`
    UPDATE players
    SET exper = exper + ?
    WHERE id = ?
  `, [amount, playerId]);

  const levelUp = await checkAndApplyLevelUpTx(conn, playerId);

  return {
    expGained: amount,
    levelUp
  };
}

export async function checkAndApplyLevelUp(playerId: number) {
  const [[p]]: any = await db.query(`
    SELECT id, level, exper, maxhp, maxspoints
    FROM players
    WHERE id = ?
  `, [playerId]);

  if (!p) return null;

  let level = p.level;
  let exp = p.exper;
  let levelsGained = 0;

  while (exp >= getExpForLevel(level)) {
    exp -= getExpForLevel(level);
    level++;
    levelsGained++;
  }

  if (levelsGained === 0) return null;

  return await applyLevelUp(playerId, p, level, exp, levelsGained, db);
}

export async function checkAndApplyLevelUpTx(conn: any, playerId: number) {
  const [[p]]: any = await conn.query(`
    SELECT id, level, exper, maxhp, maxspoints
    FROM players
    WHERE id = ?
    FOR UPDATE
  `, [playerId]);

  if (!p) return null;

  let level = p.level;
  let exp = p.exper;
  let levelsGained = 0;

  while (exp >= getExpForLevel(level)) {
    exp -= getExpForLevel(level);
    level++;
    levelsGained++;
  }

  if (levelsGained === 0) return null;

  return await applyLevelUp(playerId, p, level, exp, levelsGained, conn);
}

async function applyLevelUp(
  playerId: number,
  p: any,
  level: number,
  exp: number,
  levelsGained: number,
  querySource: any
) {
  const hpGainPerLevel = 10;
  const spGainPerLevel = 10;
  const statPointsPerLevel = 5;

  const oldLevel = Number(p.level);
  const newLevel = Number(level);

  const totalHpGain = hpGainPerLevel * levelsGained;
  const totalSpGain = spGainPerLevel * levelsGained;
  const totalStatPoints = statPointsPerLevel * levelsGained;

  // Award 1 skill point for every even level reached.
  // Examples:
  // Level 1 -> 2 awards 1
  // Level 2 -> 3 awards 0
  // Level 3 -> 6 awards 2 (levels 4 and 6)
  const totalSkillPoints =
    Math.floor(newLevel / 2) - Math.floor(oldLevel / 2);

  // Apply level, max-resource, stat-point, and skill-point gains.
  await querySource.query(
    `
      UPDATE players
      SET level = ?,
          exper = ?,
          maxhp = maxhp + ?,
          maxspoints = maxspoints + ?,
          stat_points = stat_points + ?,
          skill_points = skill_points + ?
      WHERE id = ?
    `,
    [
      newLevel,
      exp,
      totalHpGain,
      totalSpGain,
      totalStatPoints,
      totalSkillPoints,
      playerId
    ]
  );

  // Recalculate final derived maximums after the level-up.
  const finalStats = await getFinalPlayerStats(playerId);

  if (finalStats) {
    await querySource.query(
      `
        UPDATE players
        SET hpoints = ?,
            spoints = ?
        WHERE id = ?
      `,
      [
        finalStats.maxhp,
        finalStats.maxspoints,
        playerId
      ]
    );
  }

  return {
    oldLevel,
    newLevel,
    levelsGained,
    exp,
    hpGain: totalHpGain,
    spGain: totalSpGain,
    statPoints: totalStatPoints,
    skillPoints: totalSkillPoints,
    restoredToFull: true
  };
}