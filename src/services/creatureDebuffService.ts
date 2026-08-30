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

/**
 * Extend active effects from one spell without allowing repeated hits to
 * increase their remaining duration forever.
 */
export async function extendCreatureSpellDebuffs(
  playerCreatureId: number,
  spellId: number,
  extensionSeconds: number,
  maximumRemainingSeconds: number,
) {
  const extension = Math.max(0, Number(extensionSeconds) || 0);
  const cap = Math.max(extension, Number(maximumRemainingSeconds) || 0);

  if (extension <= 0 || cap <= 0) return;

  await db.query(
    `
      UPDATE player_creature_debuffs
      SET expires_at = LEAST(
        DATE_ADD(expires_at, INTERVAL ? SECOND),
        DATE_ADD(NOW(3), INTERVAL ? SECOND)
      )
      WHERE player_creature_id = ?
        AND source = ?
        AND expires_at > NOW(3)
    `,
    [extension, cap, playerCreatureId, `spell:${spellId}`]
  );
}

/** Extend Mark for Death by one second per hit, capped from its original end. */
export async function extendWarlordMarkDebuffs(
  playerCreatureId: number,
  maximumExtensionSeconds: number,
): Promise<number> {
  const capSeconds = Math.max(0, Number(maximumExtensionSeconds) || 0);
  if (capSeconds <= 0) return 0;

  const [[marker]]: any = await db.query(
    `SELECT expires_at FROM player_creature_debuffs
     WHERE player_creature_id=? AND stat='warlord_mark_extension'
       AND expires_at>NOW(3) ORDER BY expires_at DESC LIMIT 1`,
    [playerCreatureId],
  );
  if (!marker) return 0;

  const [result]: any = await db.query(
    `UPDATE player_creature_debuffs
     SET expires_at=LEAST(
       DATE_ADD(expires_at,INTERVAL 1 SECOND),
       DATE_ADD(?,INTERVAL ? SECOND)
     )
     WHERE player_creature_id=? AND source='spell:16'
       AND stat<>'warlord_mark_extension' AND expires_at>NOW(3)`,
    [marker.expires_at, capSeconds, playerCreatureId],
  );
  return Number(result?.affectedRows) > 0 ? 1 : 0;
}
