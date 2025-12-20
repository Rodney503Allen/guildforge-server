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
 */
export async function applyBuff(
  playerId: number,
  stat: string,
  value: number,
  durationSeconds: number,
  source?: string
) {
  await db.query(`
    INSERT INTO player_buffs (player_id, stat, value, expires_at, source)
    VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)
  `, [playerId, stat.toLowerCase(), value, durationSeconds, source || null]);
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
