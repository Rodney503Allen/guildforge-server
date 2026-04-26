// experienceService.ts
import { db } from "../db";

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
  const hpGainPerLevel = 25;
  const spGainPerLevel = 10;
  const statPointsPerLevel = 5;

  const totalHpGain = hpGainPerLevel * levelsGained;
  const totalSpGain = spGainPerLevel * levelsGained;
  const totalStatPoints = statPointsPerLevel * levelsGained;

  await querySource.query(`
    UPDATE players
    SET level = ?,
        exper = ?,
        maxhp = maxhp + ?,
        maxspoints = maxspoints + ?,
        hpoints = hpoints + ?,
        spoints = spoints + ?,
        stat_points = stat_points + ?
    WHERE id = ?
  `, [
    level,
    exp,
    totalHpGain,
    totalSpGain,
    totalHpGain,
    totalSpGain,
    totalStatPoints,
    playerId
  ]);

  return {
    oldLevel: p.level,
    newLevel: level,
    levelsGained,
    exp,
    hpGain: totalHpGain,
    spGain: totalSpGain,
    statPoints: totalStatPoints
  };
}