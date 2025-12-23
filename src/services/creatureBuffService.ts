// src/services/creatureDebuffService.ts
import { db } from "../db";

export type CreatureDebuff = {
  stat: string;
  value: number;
  expires_at: Date;
  source?: string | null;
};

export async function getActiveCreatureDebuffs(playerCreatureId: number): Promise<CreatureDebuff[]> {
  const [rows]: any = await db.query(
    `
    SELECT stat, value, expires_at, source
    FROM player_creature_debuffs
    WHERE player_creature_id = ?
      AND expires_at > NOW()
    `,
    [playerCreatureId]
  );

  return rows;
}

/**
 * Apply / refresh debuff:
 * - overrides debuffs from the SAME source + stat on this creature instance
 * - does NOT override other sources
 */
export async function applyCreatureDebuff(
  playerCreatureId: number,
  stat: string,
  value: number,
  durationSeconds: number,
  source?: string
) {
  const normStat = String(stat || "").toLowerCase().trim();
  const src = source || null;

  await db.query(
    `
    INSERT INTO player_creature_debuffs (player_creature_id, stat, value, expires_at, source)
    VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)
    ON DUPLICATE KEY UPDATE
      value = VALUES(value),
      expires_at = VALUES(expires_at)
    `,
    [playerCreatureId, normStat, Number(value) || 0, Number(durationSeconds) || 0, src]
  );
}

/** Sum debuff values by stat (attack/defense/etc). */
export async function getCreatureDebuffTotals(playerCreatureId: number) {
  const [rows]: any = await db.query(
    `
    SELECT stat, SUM(value) AS total
    FROM player_creature_debuffs
    WHERE player_creature_id = ?
      AND expires_at > NOW()
    GROUP BY stat
    `,
    [playerCreatureId]
  );

  const totals: Record<string, number> = {};
  for (const r of rows) totals[String(r.stat)] = Number(r.total) || 0;
  return totals;
}
