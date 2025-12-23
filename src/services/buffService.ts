import { db } from "../db";

export type Buff = {
  stat: string;
  value: number;
  expires_at: Date;
  source?: string;
};

/**
 * Get all ACTIVE buffs for a player
 */
export async function getActiveBuffs(playerId: number): Promise<Buff[]> {
  const [rows]: any = await db.query(`
    SELECT stat, value, expires_at, source
    FROM player_buffs
    WHERE player_id = ?
      AND expires_at > NOW()
  `, [playerId]);

  return rows;
}

/**
 * Apply a new buff
 * - Buffs overwrite ONLY buffs with the same (stat + source)
 * - Duration refreshes instead of stacking
 */
export async function applyBuff(
  playerId: number,
  stat: string,
  value: number,
  durationSeconds: number,
  source?: string
) {
  const normalizedStat = stat.toLowerCase();
  const normalizedSource = source ?? null;

  // 1️⃣ Remove existing buff from SAME source on SAME stat
  await db.query(`
    DELETE FROM player_buffs
    WHERE player_id = ?
      AND stat = ?
      AND (
        source <=> ?
      )
  `, [playerId, normalizedStat, normalizedSource]);

  // 2️⃣ Insert refreshed buff
  await db.query(`
    INSERT INTO player_buffs
      (player_id, stat, value, expires_at, source)
    VALUES
      (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)
  `, [
    playerId,
    normalizedStat,
    value,
    durationSeconds,
    normalizedSource
  ]);
}

/**
 * Remove buffs manually (dispel, death, logout, etc)
 */
export async function removeBuffs(
  playerId: number,
  stat?: string
) {
  if (stat) {
    await db.query(`
      DELETE FROM player_buffs
      WHERE player_id = ? AND stat = ?
    `, [playerId, stat.toLowerCase()]);
  } else {
    await db.query(`
      DELETE FROM player_buffs
      WHERE player_id = ?
    `, [playerId]);
  }
}
