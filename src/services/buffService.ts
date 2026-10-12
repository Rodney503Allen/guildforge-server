//src/services/buffService.ts
import { db } from "../db";
import { publishPlayerStatePatch } from "../playerStateEvents";
import { getFinalPlayerStats } from "./playerService";

export type Buff = {
  stat: string;
  value: number;
  expires_at: Date;
  source?: string;
  spellName?: string | null;
};

// A persistent ledger is required because expired player_buffs rows remain in
// the database and the Node timer is lost on process restart.
// Run the companion SQL migration before deploying this service.
const FORTITUDE_STAT = "maxhp_pct";

async function settleExpiredFortitude(playerId: number): Promise<boolean> {
  const [rows]: any = await db.query(`
    SELECT source, granted_hp FROM player_buff_health_grants
    WHERE player_id = ? AND expires_at <= NOW(3)
  `, [playerId]);
  if (!rows.length) return false;

  // Each expired grant is consumed exactly once. Serialize via row locks so
  // simultaneous timer/UI requests cannot subtract it twice.
  const conn = await db.getConnection();
  let changed = false;
  try {
    await conn.beginTransaction();
    const [expired]: any = await conn.query(`
      SELECT source, granted_hp FROM player_buff_health_grants
      WHERE player_id = ? AND expires_at <= NOW(3) FOR UPDATE
    `, [playerId]);
    const reduction = expired.reduce((sum: number, row: any) => sum + Number(row.granted_hp || 0), 0);
    if (expired.length) {
      await conn.query(`DELETE FROM player_buff_health_grants WHERE player_id = ? AND expires_at <= NOW(3)`, [playerId]);
      await conn.query(`UPDATE players SET hpoints = CASE WHEN hpoints <= 0 THEN 0 ELSE GREATEST(1, hpoints - ?) END WHERE id = ?`, [reduction, playerId]);
      changed = true;
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return changed;
}

async function publishHealth(playerId: number): Promise<void> {
  const stats = await getFinalPlayerStats(playerId);
  if (!stats) return;
  publishPlayerStatePatch(playerId, {
    hpoints: stats.hpoints,
    maxhp: stats.maxhp,
    refreshDerivedStats: true
  });
}

const buffExpiryTimers =
  new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

function getBuffTimerKey(
  playerId: number,
  stat: string,
  source?: string | null
) {
  return [
    playerId,
    String(stat || "")
      .toLowerCase(),
    source ?? "__null__"
  ].join(":");
}

function clearBuffExpiryTimer(
  playerId: number,
  stat: string,
  source?: string | null
) {
  const key =
    getBuffTimerKey(
      playerId,
      stat,
      source
    );

  const timer =
    buffExpiryTimers.get(
      key
    );

  if (!timer) {
    return;
  }

  clearTimeout(
    timer
  );

  buffExpiryTimers.delete(
    key
  );
}

function scheduleBuffExpiry(
  playerId: number,
  stat: string,
  durationSeconds: number,
  source?: string | null
) {
  clearBuffExpiryTimer(
    playerId,
    stat,
    source
  );

  const key =
    getBuffTimerKey(
      playerId,
      stat,
      source
    );

  const delayMs =
    Math.max(
      0,
      Math.round(
        Number(
          durationSeconds
        ) * 1000
      )
    ) + 75;

  const timer =
    setTimeout(
      async () => {
        buffExpiryTimers.delete(
          key
        );

        try {
          const buffs =
            await getActiveBuffs(
              playerId
            );
          if (stat === FORTITUDE_STAT) await publishHealth(playerId);

          publishPlayerStatePatch(
            playerId,
            {
              buffs,
              refreshDerivedStats:
                true
            }
          );
        } catch (error) {
          console.error(
            "Failed to publish expired buff state:",
            {
              playerId,
              stat,
              source,
              error
            }
          );
        }
      },
      delayMs
    );

  buffExpiryTimers.set(
    key,
    timer
  );
}

/**
 * Get all ACTIVE buffs for a player
 */
export async function getActiveBuffs(playerId: number): Promise<Buff[]> {
  const settled = await settleExpiredFortitude(playerId);
  if (settled) {
    // The next regular state update will also carry these vitals.
    const [[hp]]: any = await db.query(`SELECT hpoints FROM players WHERE id = ?`, [playerId]);
    publishPlayerStatePatch(playerId, { hpoints: Number(hp?.hpoints ?? 0), refreshDerivedStats: true });
  }
  const [rows]: any = await db.query(`
    SELECT pb.stat, pb.value, pb.expires_at, pb.source,
      s.name AS spellName
    FROM player_buffs pb
    LEFT JOIN spells s ON s.id = CASE
      WHEN pb.source LIKE 'spell:%'
      THEN CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(pb.source, '|', 1), ':', -1) AS UNSIGNED)
      ELSE NULL END
    WHERE pb.player_id = ?
      AND pb.expires_at > NOW()
  `, [playerId]);

  return rows;
}


async function publishActiveBuffs(
  playerId: number,
  refreshDerivedStats = false,
) {
  const buffs =
    await getActiveBuffs(
      playerId
    );

  publishPlayerStatePatch(
    playerId,
    {
      buffs,
      ...(refreshDerivedStats
        ? {
            refreshDerivedStats:
              true
          }
        : {})
    }
  );
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

  // Until player debuffs have their own table/service, negative player
  // stat effects are represented by player_buffs. Purify's Sacred Immunity
  // uses this stable gate now and can later be moved into playerDebuffService.
  if (Number(value) < 0) {
    const [immunity]: any = await db.query(`
      SELECT id FROM player_status_effects
      WHERE player_id = ? AND effect_key = 'cleanse_immunity_all'
        AND expires_at > NOW(3) LIMIT 1
    `, [playerId]);
    if (immunity?.length) return;
  }

  // Fortitude's grant is the change in actual derived maximum HP.
  // Recasts only award the difference, not another full heal.
  if (normalizedStat === FORTITUDE_STAT) await settleExpiredFortitude(playerId);
  const previousMaxHP = normalizedStat === FORTITUDE_STAT
    ? Number((await getFinalPlayerStats(playerId))?.maxhp ?? 1)
    : 0;

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

  if (normalizedStat === FORTITUDE_STAT) {
    const nextMaxHP = Number((await getFinalPlayerStats(playerId))?.maxhp ?? previousMaxHP);
    const delta = nextMaxHP - previousMaxHP;
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [existing]: any = await conn.query(`
        SELECT granted_hp FROM player_buff_health_grants
        WHERE player_id = ? AND source <=> ? FOR UPDATE
      `, [playerId, normalizedSource ?? "__null__"]);
      const previousGrant = Number(existing[0]?.granted_hp ?? 0);
      const newGrant = Math.max(0, previousGrant + delta);
      await conn.query(`
        INSERT INTO player_buff_health_grants (player_id, source, granted_hp, expires_at)
        VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND))
        ON DUPLICATE KEY UPDATE granted_hp = VALUES(granted_hp), expires_at = VALUES(expires_at)
      `, [playerId, normalizedSource ?? "__null__", newGrant, durationSeconds]);
      if (delta !== 0) {
        await conn.query(`
          UPDATE players SET hpoints = CASE WHEN hpoints <= 0 THEN 0
            ELSE GREATEST(1, LEAST(?, hpoints + ?)) END WHERE id = ?
        `, [nextMaxHP, delta, playerId]);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    await publishHealth(playerId);
  }

  scheduleBuffExpiry(
    playerId,
    normalizedStat,
    durationSeconds,
    normalizedSource
  );

  await publishActiveBuffs(
    playerId,
    true
  );
  await publishHealth(playerId);
}

/**
 * Remove buffs manually (dispel, death, logout, etc)
 */
export async function removeBuffs(
  playerId: number,
  stat?: string
) {
  const normalizedStat =
    stat
      ? stat.toLowerCase()
      : null;

  await settleExpiredFortitude(playerId);
  if (!normalizedStat || normalizedStat === FORTITUDE_STAT) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [grants]: any = await conn.query(`
        SELECT granted_hp FROM player_buff_health_grants WHERE player_id = ? FOR UPDATE
      `, [playerId]);
      const total = grants.reduce((sum: number, row: any) => sum + Number(row.granted_hp || 0), 0);
      await conn.query(`DELETE FROM player_buff_health_grants WHERE player_id = ?`, [playerId]);
      if (total > 0) await conn.query(`
        UPDATE players SET hpoints = CASE WHEN hpoints <= 0 THEN 0 ELSE GREATEST(1, hpoints - ?) END WHERE id = ?
      `, [total, playerId]);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }
  if (normalizedStat) {
    await db.query(`
      DELETE FROM player_buffs
      WHERE player_id = ? AND stat = ?
    `, [
      playerId,
      normalizedStat
    ]);

    for (
      const [
        key,
        timer
      ] of buffExpiryTimers
    ) {
      if (
        key.startsWith(
          `${playerId}:${normalizedStat}:`
        )
      ) {
        clearTimeout(
          timer
        );

        buffExpiryTimers.delete(
          key
        );
      }
    }
  } else {
    await db.query(`
      DELETE FROM player_buffs
      WHERE player_id = ?
    `, [playerId]);

    for (
      const [
        key,
        timer
      ] of buffExpiryTimers
    ) {
      if (
        key.startsWith(
          `${playerId}:`
        )
      ) {
        clearTimeout(
          timer
        );

        buffExpiryTimers.delete(
          key
        );
      }
    }
  }

  await publishActiveBuffs(
    playerId,
    true
  );
  await publishHealth(playerId);
}
