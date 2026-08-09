import { db } from "../db";

export async function getActiveHuntEncounter(
  playerId: number
) {

  const [[row]]: any =
    await db.query(
      `
        SELECT
          he.id AS encounter_id,

          he.party_hunt_id,
          he.party_id,

          he.hunt_target_id,
          he.creature_id,

          he.status,

          he.hp,
          he.max_hp,

          he.map_x,
          he.map_y,

          he.started_at,

          ht.name AS target_name,
          ht.description AS target_description,

          c.level,
          c.attack,
          c.defense,
          c.agility,
          c.crit,
          c.attack_speed,
          c.creatureimage

        FROM party_members pm

        JOIN hunt_encounters he
          ON he.party_id =
             pm.party_id

        JOIN hunt_targets ht
          ON ht.id =
             he.hunt_target_id

        JOIN creatures c
          ON c.id =
             he.creature_id

        WHERE pm.player_id = ?
          AND he.status = 'active'

        ORDER BY
          he.started_at DESC

        LIMIT 1
      `,
      [playerId]
    );


  if (!row) {
    return null;
  }


  return {
    encounterId:
      Number(
        row.encounter_id
      ),

    partyHuntId:
      Number(
        row.party_hunt_id
      ),

    partyId:
      Number(
        row.party_id
      ),

    huntTargetId:
      Number(
        row.hunt_target_id
      ),

    creatureId:
      Number(
        row.creature_id
      ),

    status:
      String(
        row.status
      ),

    hp:
      Number(
        row.hp
      ),

    maxHp:
      Number(
        row.max_hp
      ),

    mapX:
      Number(
        row.map_x
      ),

    mapY:
      Number(
        row.map_y
      ),

    target: {
      name:
        String(
          row.target_name
        ),

      description:
        row.target_description ?? "",

      level:
        Number(
          row.level
        ),

      attack:
        Number(
          row.attack
        ),

      defense:
        Number(
          row.defense
        ),

      agility:
        Number(
          row.agility
        ),

      crit:
        Number(
          row.crit
        ),

      attackSpeed:
        Number(
          row.attack_speed
        ),

      image:
        row.creatureimage ?? null
    }
  };
}


export async function joinHuntEncounter(
  playerId: number
) {

  const connection =
    await db.getConnection();

  try {

    await connection.beginTransaction();


    const [rows]: any =
      await connection.query(
        `
          SELECT
            he.id AS encounter_id,

            he.map_x,
            he.map_y,

            pl.map_x AS player_map_x,
            pl.map_y AS player_map_y

          FROM party_members pm

          JOIN hunt_encounters he
            ON he.party_id =
               pm.party_id

          JOIN players pl
            ON pl.id =
               pm.player_id

          WHERE pm.player_id = ?
            AND he.status = 'active'

          LIMIT 1

          FOR UPDATE
        `,
        [playerId]
      );


    if (!rows.length) {
      throw new Error(
        "No active Hunt encounter is available."
      );
    }


    const encounter =
      rows[0];


    if (
      Number(
        encounter.player_map_x
      ) !==
      Number(
        encounter.map_x
      ) ||

      Number(
        encounter.player_map_y
      ) !==
      Number(
        encounter.map_y
      )
    ) {

      throw new Error(
        "You must reach the Hunt target before joining the battle."
      );
    }


    await connection.query(
      `
        INSERT INTO hunt_encounter_players (
          hunt_encounter_id,
          player_id,
          is_active
        )

        VALUES (?, ?, 1)

        ON DUPLICATE KEY UPDATE
          is_active = 1
      `,
      [
        Number(
          encounter.encounter_id
        ),

        playerId
      ]
    );


    await connection.commit();


    return {
      encounterId:
        Number(
          encounter.encounter_id
        ),

      joined:
        true
    };


  } catch (err) {

    await connection.rollback();

    throw err;

  } finally {

    connection.release();

  }
}


export async function getHuntEncounterPlayers(
  encounterId: number
) {

  const [rows]: any =
    await db.query(
      `
        SELECT
          hep.player_id,

          hep.is_active,

          p.name,
          p.level,
          p.pclass,

          p.hpoints,
          p.maxhp,

          p.spoints,
          p.maxspoints

        FROM hunt_encounter_players hep

        JOIN players p
          ON p.id =
             hep.player_id

        WHERE hep.hunt_encounter_id = ?

        ORDER BY
          hep.id ASC
      `,
      [encounterId]
    );


  return (rows || []).map(
    (row: any) => ({
      playerId:
        Number(
          row.player_id
        ),

      active:
        Boolean(
          row.is_active
        ),

      name:
        String(
          row.name
        ),

      level:
        Number(
          row.level
        ),

      className:
        String(
          row.pclass || ""
        ),

      hp:
        Number(
          row.hpoints
        ),

      maxHp:
        Number(
          row.maxhp
        ),

      sp:
        Number(
          row.spoints
        ),

      maxSp:
        Number(
          row.maxspoints
        )
    })
  );
}