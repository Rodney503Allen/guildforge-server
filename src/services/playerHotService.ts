import { db } from "../db";

type ActiveHot = {
  id: number;
  player_id: number;
  healing: number;
  tick_interval: number;
  expires_at: Date;
  source: string;
};

export async function processDuePlayerHots() {
  const [rows]: any = await db.query(
    `
    SELECT
      id,
      player_id,
      healing,
      tick_interval,
      expires_at,
      source
    FROM player_hots
    WHERE next_tick_at <= NOW(3)
      AND expires_at >= NOW(3)
    ORDER BY next_tick_at ASC
    LIMIT 250
    `
  );

  const dueHots = rows as ActiveHot[];

  for (const hot of dueHots) {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [[lockedHot]]: any =
        await connection.query(
          `
          SELECT
            id,
            player_id,
            healing,
            tick_interval,
            expires_at
          FROM player_hots
          WHERE id = ?
            AND next_tick_at <= NOW(3)
            AND expires_at >= NOW(3)
          FOR UPDATE
          `,
          [hot.id]
        );

      // Another process may already have handled it.
      if (!lockedHot) {
        await connection.rollback();
        continue;
      }

      const [[player]]: any =
        await connection.query(
          `
          SELECT
            hpoints,
            maxhp
          FROM players
          WHERE id = ?
          FOR UPDATE
          `,
          [lockedHot.player_id]
        );

      if (!player) {
        await connection.query(
          `
          DELETE FROM player_hots
          WHERE id = ?
          `,
          [lockedHot.id]
        );

        await connection.commit();
        continue;
      }

      const currentHP =
        Number(player.hpoints) || 0;

      const maxHP = Math.max(
        1,
        Number(player.maxhp) || 1
      );

      const healing = Math.max(
        1,
        Number(lockedHot.healing) || 1
      );

      const newHP = Math.min(
        maxHP,
        currentHP + healing
      );

      await connection.query(
        `
        UPDATE players
        SET hpoints = ?
        WHERE id = ?
        `,
        [newHP, lockedHot.player_id]
      );

      const tickIntervalSeconds = Math.max(
        0.1,
        Number(lockedHot.tick_interval) || 1
      );

      const tickIntervalMilliseconds =
        Math.round(tickIntervalSeconds * 1000);

      await connection.query(
        `
        UPDATE player_hots
        SET next_tick_at =
          DATE_ADD(
            next_tick_at,
            INTERVAL ? MICROSECOND
          )
        WHERE id = ?
        `,
        [
          tickIntervalMilliseconds * 1000,
          lockedHot.id
        ]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();

      console.error(
        "Failed to process player HOT",
        {
          hotId: hot.id,
          error
        }
      );
    } finally {
      connection.release();
    }
  }

  // Remove finished HOTs.
  await db.query(
    `
    DELETE FROM player_hots
    WHERE expires_at < NOW(3)
    `
  );
}