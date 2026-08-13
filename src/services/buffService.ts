//src/services/buffService.ts
import { db } from "../db";
import { publishPlayerStatePatch } from "../playerStateEvents";

export type Buff = {
  stat: string;
  value: number;
  expires_at: Date;
  source?: string;
};

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
  const [rows]: any = await db.query(`
    SELECT stat, value, expires_at, source
    FROM player_buffs
    WHERE player_id = ?
      AND expires_at > NOW()
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
}