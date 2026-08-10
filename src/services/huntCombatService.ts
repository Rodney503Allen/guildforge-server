//huntCombatService.ts
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
  if (
    !Number.isInteger(playerId) ||
    playerId <= 0
  ) {
    throw new Error(
      "Invalid player."
    );
  }

  const connection =
    await db.getConnection();

  try {
    await connection.beginTransaction();

    // =========================================
    // FIND AND LOCK ACTIVE PARTY ENCOUNTER
    // =========================================

    const [encounterRows]: any =
      await connection.query(
        `
          SELECT
            he.id AS encounter_id,
            he.party_hunt_id,
            he.party_id,
            he.status

          FROM party_members pm

          JOIN hunt_encounters he
            ON he.party_id = pm.party_id

          WHERE pm.player_id = ?
            AND he.status = 'active'

          ORDER BY
            he.started_at DESC

          LIMIT 1

          FOR UPDATE
        `,
        [
          playerId
        ]
      );

    if (!encounterRows.length) {
      throw new Error(
        "No active Hunt encounter is available."
      );
    }

    const encounter =
      encounterRows[0];

    const encounterId =
      Number(
        encounter.encounter_id
      );

    const partyHuntId =
      Number(
        encounter.party_hunt_id
      );

    const partyId =
      Number(
        encounter.party_id
      );

    // =========================================
    // REQUIRE FROZEN-ROSTER MEMBERSHIP
    // =========================================

    /*
     * createHuntEncounterInTransaction()
     * inserted the complete frozen ready-check
     * roster into hunt_encounter_players.
     *
     * Therefore, the absence of this row means
     * the player was not included in the roster
     * and must not be allowed to join afterward.
     */
    const [participantRows]: any =
      await connection.query(
        `
          SELECT
            player_id,
            is_active

          FROM hunt_encounter_players

          WHERE hunt_encounter_id = ?
            AND player_id = ?

          LIMIT 1

          FOR UPDATE
        `,
        [
          encounterId,
          playerId
        ]
      );

    if (!participantRows.length) {
      throw new Error(
        "You were not included in this Hunt encounter's ready-check roster."
      );
    }

    const participant =
      participantRows[0];

    const wasActive =
      Boolean(
        participant.is_active
      );

    // =========================================
    // REACTIVATE EXISTING PARTICIPANT
    // =========================================

    if (!wasActive) {
      const [updateResult]: any =
        await connection.query(
          `
            UPDATE hunt_encounter_players

            SET is_active = 1

            WHERE hunt_encounter_id = ?
              AND player_id = ?
          `,
          [
            encounterId,
            playerId
          ]
        );

      if (
        Number(updateResult.affectedRows) !==
        1
      ) {
        throw new Error(
          "Unable to rejoin the Hunt encounter."
        );
      }
    }

    await connection.commit();

    return {
      encounterId,
      partyHuntId,
      partyId,

      joined: true,

      /*
       * True only when this request changed the
       * player from inactive to active.
       */
      rejoined:
        !wasActive,

      alreadyActive:
        wasActive
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