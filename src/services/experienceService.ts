import { db } from "../db";

export function getExpForLevel(level: number): number {
  return level * 100; // your current formula
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
  let leveledUp = false;

  while (exp >= getExpForLevel(level)) {
    exp -= getExpForLevel(level);
    level++;
    leveledUp = true;
  }

  if (!leveledUp) return null;

  // level rewards
  const hpGain = 10;
  const spGain = 5;
  const statPoints = 2;

  await db.query(`
    UPDATE players
    SET level = ?, exper = ?, 
        maxhp = maxhp + ?, 
        maxspoints = maxspoints + ?,
        hpoints = maxhp + ?, 
        spoints = maxspoints + ?,
        stat_points = stat_points + ?
    WHERE id = ?
  `, [
    level, exp,
    hpGain, spGain,
    hpGain, spGain,
    statPoints,
    playerId
  ]);

  return {
    newLevel: level,
    exp,
    hpGain,
    spGain,
    statPoints
  };
}
