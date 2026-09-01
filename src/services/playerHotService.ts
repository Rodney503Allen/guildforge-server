import { db } from "../db";
import { getFinalPlayerStats } from "./playerService";


export type PlayerHotTickResult = {
  playerId: number;

  healing: number;

  newHP: number;
  maxHP: number;

  gaugeGain: number;

  partyEchoHealing: number;

  casterEchoPlayerId: number | null;
  casterEchoHealing: number;

  displayName: string;

  refreshed: boolean;
};


/* =========================================================
   PROCESS DUE PLAYER HOTS
========================================================= */

export async function processDuePlayerHots(
  playerIds?: number | number[]
): Promise<PlayerHotTickResult[]> {

  /* =========================================
     NORMALIZE OPTIONAL PLAYER FILTER
  ========================================= */

  const ids =
    (
      Array.isArray(playerIds)
        ? playerIds
        : playerIds === undefined
          ? []
          : [playerIds]
    )
      .map(Number)
      .filter(Number.isFinite);


  const filter =
    ids.length
      ? `
          AND player_id IN (
            ${ids.map(() => "?").join(", ")}
          )
        `
      : "";


  /* =========================================
     FIND DUE HOTS
  ========================================= */

  const [rows]: any =
    await db.query(
      `
        SELECT
          id

        FROM player_hots

        WHERE next_tick_at <= NOW(3)
          AND expires_at >= NOW(3)

          ${filter}

        ORDER BY
          next_tick_at ASC

        LIMIT 250
      `,
      ids
    );


  const results:
    PlayerHotTickResult[] = [];


  /* =========================================
     PROCESS EACH HOT
  ========================================= */

  for (const row of rows) {

    const connection =
      await db.getConnection();


    try {

      await connection.beginTransaction();


      /* =========================================
         LOAD + LOCK HOT
      ========================================= */

      const [[hot]]: any =
        await connection.query(
          `
            SELECT
              id,
              player_id,

              healing,
              tick_interval,

              next_tick_at,
              expires_at,

              source,
              display_name

            FROM player_hots

            WHERE id = ?
              AND next_tick_at <= NOW(3)
              AND expires_at >= NOW(3)

            FOR UPDATE
          `,
          [
            row.id
          ]
        );


      if (!hot) {

        await connection.rollback();

        continue;
      }


      const hotPlayerId =
        Number(
          hot.player_id
        );


      /* =========================================
         LOAD DERIVED PLAYER STATS

         IMPORTANT:
         Do this before locking the players row.

         players.maxhp is only the stored/base HP.
         The Stat Engine maxhp is the authoritative
         combat HP ceiling.
      ========================================= */

      const finalStats =
        await getFinalPlayerStats(
          hotPlayerId
        );


      const derivedMaxHP =
        Math.max(
          1,
          Number(
            finalStats?.maxhp
          ) || 1
        );


      /* =========================================
         LOAD + LOCK PLAYER HP
      ========================================= */

      const [[player]]: any =
        await connection.query(
          `
            SELECT
              hpoints

            FROM players

            WHERE id = ?

            FOR UPDATE
          `,
          [
            hotPlayerId
          ]
        );


      if (!player) {

        await connection.query(
          `
            DELETE FROM player_hots

            WHERE id = ?
          `,
          [
            hot.id
          ]
        );


        await connection.commit();

        continue;
      }


      /* =========================================
         LOAD HOT TALENT / STATUS EFFECTS
      ========================================= */

      const [effects]: any =
        await connection.query(
          `
            SELECT
              id,
              effect_key,
              value,
              charges

            FROM player_status_effects

            WHERE player_id = ?
              AND source = ?
              AND expires_at > NOW(3)
          `,
          [
            hotPlayerId,
            `hot:${hot.source}`
          ]
        );


      /* =========================================
         CURRENT HP STATE
      ========================================= */

      const currentHP =
        Math.max(
          0,
          Number(
            player.hpoints
          ) || 0
        );


      /*
       * Never use players.maxhp here.
       *
       * This must remain the Stat Engine value or
       * HoT ticks can incorrectly clamp players
       * down to their base maximum HP.
       */
      const maxHP =
        derivedMaxHP;


      /* =========================================
         BASE HOT VALUES
      ========================================= */

      let healing =
        Math.max(
          1,
          Number(
            hot.healing
          ) || 1
        );


      let gaugeGain =
        0;


      let partyEchoPercent =
        0;


      let casterEchoPlayerId:
        number | null = null;


      let casterEchoPercent =
        0;


      let refresh:
        any = null;


      /* =========================================
         PROCESS HOT EFFECT MODIFIERS
      ========================================= */

      for (const effect of effects) {

        /* -----------------------------------------
           LOW HEALTH HOT BONUS
        ----------------------------------------- */

        if (
          effect.effect_key ===
          "hot_low_health_bonus"
        ) {

          const packed =
            Math.max(
              0,
              Number(
                effect.value
              ) || 0
            );


          const threshold =
            Math.floor(
              packed / 1000
            );


          const bonus =
            packed % 1000;


          if (
            currentHP / maxHP <
            threshold / 100
          ) {

            healing =
              Math.max(
                1,
                Math.floor(
                  healing *
                  (
                    1 +
                    bonus / 100
                  )
                )
              );
          }

        }


        /* -----------------------------------------
           GAUGE PER HOT TICK
        ----------------------------------------- */

        else if (
          effect.effect_key ===
          "hot_gauge_per_tick"
        ) {

          gaugeGain +=
            Math.max(
              0,
              Number(
                effect.value
              ) || 0
            );

        }


        /* -----------------------------------------
           SENTINEL PARTY ECHO
        ----------------------------------------- */

        else if (
          effect.effect_key ===
          "sentinel_hot_party_echo_pct"
        ) {

          partyEchoPercent =
            Math.max(
              partyEchoPercent,

              Math.max(
                0,
                Number(
                  effect.value
                ) || 0
              )
            );

        }


        /* -----------------------------------------
           SAGE CASTER ECHO
        ----------------------------------------- */

        else if (
          effect.effect_key ===
          "sage_hot_caster_echo"
        ) {

          casterEchoPlayerId =
            Number(
              effect.value
            );


          casterEchoPercent =
            Math.max(
              casterEchoPercent,

              Math.max(
                0,
                Number(
                  effect.charges
                ) || 0
              )
            );

        }


        /* -----------------------------------------
           HOT REFRESH
        ----------------------------------------- */

        else if (
          effect.effect_key ===
            "hot_refresh" &&
          Number(
            effect.charges
          ) > 0
        ) {

          refresh =
            effect;
        }
      }


      /* =========================================
         APPLY HOT HEAL
      ========================================= */

      const newHP =
        Math.min(
          maxHP,
          currentHP + healing
        );


      const actualHealing =
        Math.max(
          0,
          newHP - currentHP
        );


      const interval =
        Math.max(
          0.1,
          Number(
            hot.tick_interval
          ) || 1
        );


      await connection.query(
        `
          UPDATE players

          SET hpoints = ?

          WHERE id = ?
        `,
        [
          newHP,
          hotPlayerId
        ]
      );


      /* =========================================
         ADVANCE / REFRESH HOT TIMER
      ========================================= */

      const nextTickMs =
        new Date(
          hot.next_tick_at
        ).getTime() +
        interval * 1000;


      const expiresMs =
        new Date(
          hot.expires_at
        ).getTime();


      let refreshed =
        false;


      if (
        refresh &&
        nextTickMs > expiresMs
      ) {

        const packed =
          Math.max(
            0,
            Number(
              refresh.value
            ) || 0
          );


        const percent =
          Math.floor(
            packed / 1000
          );


        const duration =
          Math.max(
            1,
            packed % 1000
          );


        await connection.query(
          `
            UPDATE player_hots

            SET
              healing =
                GREATEST(
                  1,
                  FLOOR(
                    healing * ? / 100
                  )
                ),

              next_tick_at =
                DATE_ADD(
                  NOW(3),
                  INTERVAL ? MICROSECOND
                ),

              expires_at =
                DATE_ADD(
                  NOW(3),
                  INTERVAL ? SECOND
                )

            WHERE id = ?
          `,
          [
            percent,
            Math.round(
              interval * 1_000_000
            ),
            duration,
            hot.id
          ]
        );


        if (
          Number(
            refresh.charges
          ) <= 1
        ) {

          await connection.query(
            `
              DELETE FROM player_status_effects

              WHERE id = ?
            `,
            [
              refresh.id
            ]
          );

        } else {

          await connection.query(
            `
              UPDATE player_status_effects

              SET charges =
                charges - 1

              WHERE id = ?
            `,
            [
              refresh.id
            ]
          );
        }


        refreshed =
          true;

      } else {

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
            Math.round(
              interval * 1_000_000
            ),
            hot.id
          ]
        );
      }


      /* =========================================
         PARTY ECHO HEALING
      ========================================= */

      const partyEchoHealing =
        Math.max(
          0,
          Math.floor(
            healing *
            partyEchoPercent /
            100
          )
        );


      /* =========================================
         CASTER ECHO HEALING
      ========================================= */

      let casterEchoHealing =
        0;


      if (
        casterEchoPlayerId &&
        casterEchoPercent > 0
      ) {

        /*
         * If the caster is also the HoT target,
         * we already have their derived max HP
         * and locked/current HP state.
         */
        if (
          casterEchoPlayerId ===
          hotPlayerId
        ) {

          const casterHP =
            newHP;


          const casterMaxHP =
            maxHP;


          const echoPotential =
            Math.max(
              0,
              Math.floor(
                actualHealing *
                casterEchoPercent /
                100
              )
            );


          const casterNewHP =
            Math.min(
              casterMaxHP,
              casterHP +
              echoPotential
            );


          casterEchoHealing =
            Math.max(
              0,
              casterNewHP -
              casterHP
            );


          if (
            casterEchoHealing > 0
          ) {

            await connection.query(
              `
                UPDATE players

                SET hpoints = ?

                WHERE id = ?
              `,
              [
                casterNewHP,
                casterEchoPlayerId
              ]
            );
          }

        } else {

          /*
           * Load Stat Engine HP BEFORE locking
           * the caster's players row.
           */
          const casterStats =
            await getFinalPlayerStats(
              casterEchoPlayerId
            );


          const casterMaxHP =
            Math.max(
              1,
              Number(
                casterStats?.maxhp
              ) || 1
            );


          const [[caster]]: any =
            await connection.query(
              `
                SELECT
                  hpoints

                FROM players

                WHERE id = ?

                FOR UPDATE
              `,
              [
                casterEchoPlayerId
              ]
            );


          if (caster) {

            const casterHP =
              Math.max(
                0,
                Number(
                  caster.hpoints
                ) || 0
              );


            const echoPotential =
              Math.max(
                0,
                Math.floor(
                  actualHealing *
                  casterEchoPercent /
                  100
                )
              );


            const casterNewHP =
              Math.min(
                casterMaxHP,
                casterHP +
                echoPotential
              );


            casterEchoHealing =
              Math.max(
                0,
                casterNewHP -
                casterHP
              );


            if (
              casterEchoHealing > 0
            ) {

              await connection.query(
                `
                  UPDATE players

                  SET hpoints = ?

                  WHERE id = ?
                `,
                [
                  casterNewHP,
                  casterEchoPlayerId
                ]
              );
            }
          }
        }
      }


      /* =========================================
         COMMIT TICK
      ========================================= */

      await connection.commit();


      results.push({
        playerId:
          hotPlayerId,

        healing:
          actualHealing,

        newHP,

        maxHP,

        gaugeGain,

        partyEchoHealing,

        casterEchoPlayerId,

        casterEchoHealing,

        displayName:
          String(
            hot.display_name ||
            "Healing over Time"
          ),

        refreshed
      });


    } catch (error) {

      await connection.rollback();


      console.error(
        "Failed to process player HOT",
        {
          hotId:
            row.id,

          error
        }
      );


    } finally {

      connection.release();
    }
  }


  /* =========================================
     REMOVE EXPIRED HOTS
  ========================================= */

  await db.query(
    `
      DELETE FROM player_hots

      WHERE expires_at < NOW(3)

      ${filter}
    `,
    ids
  );


  return results;
}