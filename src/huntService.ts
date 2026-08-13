//huntService.ts
import { db } from "./db";

import {
  getPartyByPlayer
} from "./partyService";

import type {
  HuntDefinition,
  HuntObjectiveProgress,
  ActivePartyHunt,
  HuntProgressEvent
} from "./hunt.types";


import {
  publishHuntProgressEvent
} from "./huntEvents";


/* =========================================================
   QUERY HELPER
========================================================= */

async function query<T = any>(
  sql: string,
  params: any[] = []
): Promise<T> {

  const [rows] =
    await db.query(
      sql,
      params
    );

  return rows as T;
}


/* =========================================================
   MAP HUNT DEFINITION
========================================================= */

function mapHunt(
  row: any
): HuntDefinition {

  return {
    id:
      Number(row.id),

    name:
      String(row.name),

    slug:
      String(row.slug),

    description:
      row.description ?? null,

    flavorText:
      row.flavor_text ?? null,

    targetCreatureId:
      row.target_creature_id !== null
        ? Number(row.target_creature_id)
        : null,

    regionId:
      row.region_id !== null
        ? Number(row.region_id)
        : null,

    recommendedLevel:
      Number(
        row.recommended_level
      ),

    recommendedPartySize:
      Number(
        row.recommended_party_size
      ),

    difficulty:
      Number(row.difficulty),

    rewardXp:
      Number(row.reward_xp),

    rewardGold:
      Number(row.reward_gold),

    rewardHuntMarks:
      Number(
        row.reward_hunt_marks
      ),

    trackingRequired:
      Number(
        row.tracking_required
      ),

    isActive:
      Boolean(row.is_active)
  };
}


/* =========================================================
   AVAILABLE HUNTS
========================================================= */

export async function getAvailableHunts():
Promise<HuntDefinition[]> {

  const rows: any[] =
    await query(
      `
        SELECT
          h.id,
          h.name,
          h.slug,

          h.description,
          h.flavor_text,

          h.target_creature_id,
          h.region_id,

          h.recommended_level,
          h.recommended_party_size,

          h.difficulty,

          h.reward_xp,
          h.reward_gold,
          h.reward_hunt_marks,

          h.tracking_required,

          h.is_active,

          c.name AS target_creature_name

        FROM hunts h

        LEFT JOIN creatures c
          ON c.id =
             h.target_creature_id

        WHERE h.is_active = 1

        ORDER BY
          h.recommended_level ASC,
          h.difficulty ASC,
          h.id ASC
      `
    );

  return rows.map(
    mapHunt
  );
}


/* =========================================================
   GET HUNT DEFINITION
========================================================= */

export async function getHuntById(
  huntId: number
): Promise<HuntDefinition | null> {

  const rows: any[] =
    await query(
      `
        SELECT
          id,
          name,
          slug,

          description,
          flavor_text,

          target_creature_id,
          region_id,

          recommended_level,
          recommended_party_size,

          difficulty,

          reward_xp,
          reward_gold,
          reward_hunt_marks,

          tracking_required,

          is_active

        FROM hunts

        WHERE id = ?
          AND is_active = 1

        LIMIT 1
      `,
      [huntId]
    );

  if (!rows.length) {
    return null;
  }

  return mapHunt(
    rows[0]
  );
}
/* =========================================================
   CREATE HUNT ENCOUNTER INSIDE EXISTING TRANSACTION
========================================================= */

export async function createHuntEncounterInTransaction(
  connection: any,
  partyHuntId: number,
  readyPlayers: Array<{
    playerId: number;
    name?: string;
  }>
) {
  // =========================================
  // VALIDATE INPUT
  // =========================================

  if (
    !Number.isInteger(partyHuntId) ||
    partyHuntId <= 0
  ) {
    throw new Error(
      "Invalid party Hunt."
    );
  }

  /*
   * Deduplicate the roster defensively.
   * The ready-check table should already enforce
   * uniqueness, but encounter scaling must never
   * count the same player twice.
   */
  const uniqueReadyPlayers =
    Array.from(
      new Map(
        readyPlayers
          .filter(player =>
            Number.isInteger(
              Number(player.playerId)
            ) &&
            Number(player.playerId) > 0
          )
          .map(player => [
            Number(player.playerId),
            {
              ...player,
              playerId:
                Number(player.playerId)
            }
          ])
      ).values()
    );

  const partySize =
    uniqueReadyPlayers.length;

  if (partySize < 1) {
    throw new Error(
      "The Hunt encounter requires at least one ready player."
    );
  }

  // =========================================
  // LOAD AND LOCK REVEALED HUNT
  // =========================================

  const [rows]: any =
    await connection.query(
      `
        SELECT
          ph.id AS party_hunt_id,
          ph.party_id,
          ph.hunt_id,
          ph.status,
          ph.target_revealed,
          ph.target_map_x,
          ph.target_map_y,

          ht.id AS hunt_target_id,
          ht.creature_id AS target_creature_id,

          ht.hp_multiplier,
          ht.attack_multiplier,
          ht.defense_multiplier,
          ht.speed_multiplier,

          ht.party_hp_scaling,
          ht.party_attack_scaling,

          p.leader_player_id

        FROM party_hunts ph

        JOIN hunts h
          ON h.id = ph.hunt_id

        JOIN hunt_targets ht
          ON ht.hunt_id = h.id
         AND ht.is_active = 1

        JOIN parties p
          ON p.id = ph.party_id

        WHERE ph.id = ?
          AND ph.status = 'revealed'

        LIMIT 1

        FOR UPDATE
      `,
      [
        partyHuntId
      ]
    );

  if (!rows.length) {
    throw new Error(
      "No revealed Hunt target is available."
    );
  }

  const hunt =
    rows[0];

  const loadedPartyHuntId =
    Number(
      hunt.party_hunt_id
    );

  const partyId =
    Number(
      hunt.party_id
    );

  const huntTargetId =
    Number(
      hunt.hunt_target_id
    );

  const targetCreatureId =
    Number(
      hunt.target_creature_id
    );

  const targetMapX =
    Number(
      hunt.target_map_x
    );

  const targetMapY =
    Number(
      hunt.target_map_y
    );

  if (!hunt.target_revealed) {
    throw new Error(
      "The Hunt target has not been revealed."
    );
  }

  if (
    !Number.isFinite(targetMapX) ||
    !Number.isFinite(targetMapY)
  ) {
    throw new Error(
      "The Hunt target has no valid location."
    );
  }

  // =========================================
  // VERIFY FROZEN ROSTER
  // =========================================

  /*
   * Every ready player must still be a
   * snapshotted participant in this Hunt.
   */
  const readyPlayerIds =
    uniqueReadyPlayers.map(
      player => player.playerId
    );

  const playerPlaceholders =
    readyPlayerIds
      .map(() => "?")
      .join(", ");

  const [participantRows]: any =
    await connection.query(
      `
        SELECT
          player_id

        FROM hunt_participants

        WHERE party_hunt_id = ?
          AND player_id IN (
            ${playerPlaceholders}
          )

        FOR UPDATE
      `,
      [
        loadedPartyHuntId,
        ...readyPlayerIds
      ]
    );

  const participantIds =
    new Set(
      participantRows.map(
        (row: any) =>
          Number(row.player_id)
      )
    );

  const invalidReadyPlayer =
    readyPlayerIds.find(
      playerId =>
        !participantIds.has(playerId)
    );

  if (
    invalidReadyPlayer != null
  ) {
    throw new Error(
      "The ready-check roster contains a player who is not participating in this Hunt."
    );
  }

  // =========================================
  // VERIFY PLAYERS REMAIN ON TARGET TILE
  // =========================================

  /*
   * This protects the final Ready transition
   * against movement occurring just before
   * encounter creation.
   */
  const [positionRows]: any =
    await connection.query(
      `
        SELECT
          id,
          map_x,
          map_y

        FROM players

        WHERE id IN (
          ${playerPlaceholders}
        )

        FOR UPDATE
      `,
      readyPlayerIds
    );

  if (
    positionRows.length !== partySize
  ) {
    throw new Error(
      "One or more ready players no longer exist."
    );
  }

  const playerAwayFromTarget =
    positionRows.find(
      (player: any) =>
        Number(player.map_x) !==
          targetMapX ||
        Number(player.map_y) !==
          targetMapY
    );

  if (playerAwayFromTarget) {
    throw new Error(
      "Every ready player must remain on the Hunt target tile."
    );
  }

  // =========================================
  // PREVENT DUPLICATE ENCOUNTERS
  // =========================================

  const [existingRows]: any =
    await connection.query(
      `
        SELECT id

        FROM hunt_encounters

        WHERE party_hunt_id = ?

        LIMIT 1

        FOR UPDATE
      `,
      [
        loadedPartyHuntId
      ]
    );

  if (existingRows.length) {
    throw new Error(
      "This Hunt encounter already exists."
    );
  }

  // =========================================
  // LOAD BASE CREATURE
  // =========================================

  const [creatureRows]: any =
    await connection.query(
      `
        SELECT
          id,
          level,
          maxhp,
          attack,
          defense,
          agility,
          attack_speed

        FROM creatures

        WHERE id = ?

        LIMIT 1
      `,
      [
        targetCreatureId
      ]
    );

  if (!creatureRows.length) {
    throw new Error(
      "Hunt target creature does not exist."
    );
  }

  const creature =
    creatureRows[0];

  // =========================================
  // TARGET MULTIPLIERS
  // =========================================

  const hpMultiplier =
    Math.max(
      0.01,
      Number(
        hunt.hp_multiplier ?? 1
      )
    );

  const attackMultiplier =
    Math.max(
      0.01,
      Number(
        hunt.attack_multiplier ?? 1
      )
    );

  const defenseMultiplier =
    Math.max(
      0.01,
      Number(
        hunt.defense_multiplier ?? 1
      )
    );

  const speedMultiplier =
    Math.max(
      0.01,
      Number(
        hunt.speed_multiplier ?? 1
      )
    );

  const partyHpScaling =
    Math.max(
      0,
      Number(
        hunt.party_hp_scaling ?? 0
      )
    );

  const partyAttackScaling =
    Math.max(
      0,
      Number(
        hunt.party_attack_scaling ?? 0
      )
    );

  // =========================================
  // PARTY SCALING
  // =========================================

  const additionalPlayers =
    Math.max(
      0,
      partySize - 1
    );

  const partyHpMultiplier =
    1 +
    additionalPlayers *
      partyHpScaling;

  const partyAttackMultiplier =
    1 +
    additionalPlayers *
      partyAttackScaling;

  // =========================================
  // BASE CREATURE STATS
  // =========================================

  const baseMaxHp =
    Math.max(
      1,
      Number(
        creature.maxhp ?? 1
      )
    );

  const baseAttack =
    Math.max(
      0,
      Number(
        creature.attack ?? 0
      )
    );

  const baseDefense =
    Math.max(
      0,
      Number(
        creature.defense ?? 0
      )
    );

  const baseAgility =
    Math.max(
      0,
      Number(
        creature.agility ?? 0
      )
    );

  const baseAttackSpeed =
    Math.max(
      1,
      Number(
        creature.attack_speed ?? 1500
      )
    );

  // =========================================
  // FINAL BOSS STATS
  // =========================================

  const maxHp =
    Math.max(
      1,
      Math.floor(
        baseMaxHp *
        hpMultiplier *
        partyHpMultiplier
      )
    );

  const scaledAttack =
    Math.max(
      0,
      Math.floor(
        baseAttack *
        attackMultiplier *
        partyAttackMultiplier
      )
    );

  const scaledDefense =
    Math.max(
      0,
      Math.floor(
        baseDefense *
        defenseMultiplier
      )
    );

  const scaledAgility =
    Math.max(
      0,
      Math.floor(
        baseAgility *
        speedMultiplier
      )
    );

  const scaledAttackSpeed =
    Math.max(
      250,
      Math.floor(
        baseAttackSpeed /
        speedMultiplier
      )
    );

  console.log(
    "Hunt boss scaling:",
    {
      partyHuntId:
        loadedPartyHuntId,

      huntTargetId,
      targetCreatureId,
      partySize,

      baseMaxHp,
      hpMultiplier,
      partyHpScaling,
      partyHpMultiplier,
      maxHp,

      baseAttack,
      attackMultiplier,
      partyAttackScaling,
      partyAttackMultiplier,
      scaledAttack,

      baseDefense,
      defenseMultiplier,
      scaledDefense,

      baseAgility,
      speedMultiplier,
      scaledAgility,

      baseAttackSpeed,
      scaledAttackSpeed
    }
  );

  // =========================================
  // CREATE SHARED ENCOUNTER
  // =========================================

  const [encounterResult]: any =
    await connection.query(
      `
        INSERT INTO hunt_encounters (
          party_hunt_id,
          party_id,
          hunt_target_id,
          creature_id,
          status,
          hp,
          max_hp,
          map_x,
          map_y,
          started_at
        )

        VALUES (
          ?,
          ?,
          ?,
          ?,
          'active',
          ?,
          ?,
          ?,
          ?,
          NOW()
        )
      `,
      [
        loadedPartyHuntId,
        partyId,
        huntTargetId,
        targetCreatureId,

        maxHp,
        maxHp,

        targetMapX,
        targetMapY
      ]
    );

  const encounterId =
    Number(
      encounterResult.insertId
    );

  // =========================================
  // ADD COMPLETE FROZEN ROSTER
  // =========================================

  const encounterPlayerValues =
    uniqueReadyPlayers
      .map(() => "(?, ?, 1)")
      .join(", ");

  const encounterPlayerParams =
    uniqueReadyPlayers.flatMap(
      player => [
        encounterId,
        player.playerId
      ]
    );

  await connection.query(
    `
      INSERT INTO hunt_encounter_players (
        hunt_encounter_id,
        player_id,
        is_active
      )

      VALUES
        ${encounterPlayerValues}

      ON DUPLICATE KEY UPDATE
        is_active = 1
    `,
    encounterPlayerParams
  );

  // =========================================
  // MARK HUNT PARTICIPATION
  // =========================================

  const [participationResult]: any =
    await connection.query(
      `
        UPDATE hunt_participants

        SET participated_in_boss = 1

        WHERE party_hunt_id = ?
          AND player_id IN (
            ${playerPlaceholders}
          )
      `,
      [
        loadedPartyHuntId,
        ...readyPlayerIds
      ]
    );

  if (
    Number(
      participationResult.affectedRows
    ) !== partySize
  ) {
    throw new Error(
      "Unable to record every Hunt encounter participant."
    );
  }

  // =========================================
  // UPDATE HUNT STATE
  // =========================================

  const [huntUpdateResult]: any =
    await connection.query(
      `
        UPDATE party_hunts

        SET status = 'engaged'

        WHERE id = ?
          AND status = 'revealed'
      `,
      [
        loadedPartyHuntId
      ]
    );

  if (
    Number(
      huntUpdateResult.affectedRows
    ) !== 1
  ) {
    throw new Error(
      "The Hunt is no longer available for engagement."
    );
  }

  // =========================================
  // RETURN ENCOUNTER
  // =========================================

  return {
    encounterId,

    partyHuntId:
      loadedPartyHuntId,

    partyId,
    huntTargetId,

    creatureId:
      targetCreatureId,

    partySize,

    hp:
      maxHp,

    maxHp,

    scaledAttack,
    scaledDefense,
    scaledAgility,
    scaledAttackSpeed,

    mapX:
      targetMapX,

    mapY:
      targetMapY,

    status:
      "active"
  };
}

/* =========================================================
   ACTIVE PARTY HUNT
========================================================= */

export async function getActivePartyHunt(
  playerId: number
): Promise<ActivePartyHunt | null> {

  const party =
    await getPartyByPlayer(
      playerId
    );

  if (!party) {
    return null;
  }


  const rows: any[] =
    await query(
      `
        SELECT
          ph.id AS party_hunt_id,

          ph.party_id,
          ph.hunt_id,

          ph.accepted_by_player_id,

          ph.status,

          ph.tracking_progress,

          ph.target_revealed,

          ph.target_map_x,
          ph.target_map_y,

          ph.accepted_at,
          ph.revealed_at,
          ph.completed_at,
          ph.failed_at,

          h.name,
          h.slug,

          h.description,
          h.flavor_text,

          h.target_creature_id,
          h.region_id,

          h.recommended_level,
          h.recommended_party_size,

          h.difficulty,

          h.reward_xp,
          h.reward_gold,
          h.reward_hunt_marks,

          h.tracking_required,

          h.is_active

        FROM party_hunts ph

        JOIN hunts h
          ON h.id = ph.hunt_id

        WHERE ph.party_id = ?
          AND ph.status IN (
            'tracking',
            'revealed',
            'engaged'
          )

        ORDER BY
          ph.accepted_at DESC

        LIMIT 1
      `,
      [party.id]
    );


  if (!rows.length) {
    return null;
  }


  const row =
    rows[0];


  const objectiveRows: any[] =
    await query(
      `
        SELECT
          ho.id,

          ho.objective_type,

          ho.target_creature_id,
          ho.target_region_id,
          ho.target_object_id,

          ho.required_count,

          pho.progress_count,

          ho.tracking_value,

          ho.description,

          ho.sort_order,

          ho.is_required,

          pho.is_complete,
          pho.completed_at

        FROM party_hunt_objectives pho

        JOIN hunt_objectives ho
          ON ho.id =
             pho.hunt_objective_id

        WHERE pho.party_hunt_id = ?

        ORDER BY
          ho.sort_order ASC,
          ho.id ASC
      `,
      [
        Number(
          row.party_hunt_id
        )
      ]
    );


  const objectives:
    HuntObjectiveProgress[] =
    objectiveRows.map(
      objective => ({
        id:
          Number(objective.id),

        objectiveType:
          String(
            objective.objective_type
          ),

        targetCreatureId:
          objective.target_creature_id !== null
            ? Number(
                objective.target_creature_id
              )
            : null,

        targetRegionId:
          objective.target_region_id !== null
            ? Number(
                objective.target_region_id
              )
            : null,

        targetObjectId:
          objective.target_object_id !== null
            ? Number(
                objective.target_object_id
              )
            : null,

        requiredCount:
          Number(
            objective.required_count
          ),

        progressCount:
          Number(
            objective.progress_count
          ),

        trackingValue:
          Number(
            objective.tracking_value
          ),

        description:
          String(
            objective.description
          ),

        sortOrder:
          Number(
            objective.sort_order
          ),

        isRequired:
          Boolean(
            objective.is_required
          ),

        isComplete:
          Boolean(
            objective.is_complete
          ),

        completedAt:
          objective.completed_at ??
          null
      })
    );


  const hunt =
    mapHunt({
      id:
        row.hunt_id,

      name:
        row.name,

      slug:
        row.slug,

      description:
        row.description,

      flavor_text:
        row.flavor_text,

      target_creature_id:
        row.target_creature_id,

      region_id:
        row.region_id,

      recommended_level:
        row.recommended_level,

      recommended_party_size:
        row.recommended_party_size,

      difficulty:
        row.difficulty,

      reward_xp:
        row.reward_xp,

      reward_gold:
        row.reward_gold,

      reward_hunt_marks:
        row.reward_hunt_marks,

      tracking_required:
        row.tracking_required,

      is_active:
        row.is_active
    });


  return {
    partyHuntId:
      Number(
        row.party_hunt_id
      ),

    partyId:
      Number(row.party_id),

    huntId:
      Number(row.hunt_id),

    acceptedByPlayerId:
      Number(
        row.accepted_by_player_id
      ),

    status:
      String(row.status) as any,

    trackingProgress:
      Number(
        row.tracking_progress
      ),

    trackingRequired:
      Number(
        row.tracking_required
      ),

    targetRevealed:
      Boolean(
        row.target_revealed
      ),

    targetMapX:
      row.target_map_x !== null
        ? Number(row.target_map_x)
        : null,

    targetMapY:
      row.target_map_y !== null
        ? Number(row.target_map_y)
        : null,

    acceptedAt:
      row.accepted_at,

    revealedAt:
      row.revealed_at ??
      null,

    completedAt:
      row.completed_at ??
      null,

    failedAt:
      row.failed_at ??
      null,

    hunt,

    objectives
  };
}


/* =========================================================
   ACCEPT HUNT
========================================================= */

export async function acceptHunt(
  playerId: number,
  huntId: number
): Promise<ActivePartyHunt> {

  const connection =
    await db.getConnection();

  try {

    await connection.beginTransaction();


    /*
     * Lock party membership through the
     * player's membership row.
     */
    const [memberRows]: any =
      await connection.query(
        `
          SELECT
            pm.party_id,

            p.leader_player_id,
            p.status

          FROM party_members pm

          JOIN parties p
            ON p.id = pm.party_id

          WHERE pm.player_id = ?

          LIMIT 1

          FOR UPDATE
        `,
        [playerId]
      );


    if (!memberRows.length) {
      throw new Error(
        "You must be in a party to accept a Hunt."
      );
    }


    const partyId =
      Number(
        memberRows[0].party_id
      );

    const leaderPlayerId =
      Number(
        memberRows[0].leader_player_id
      );


    if (
      leaderPlayerId !==
      playerId
    ) {
      throw new Error(
        "Only the party leader can accept a Hunt."
      );
    }


    if (
      String(
        memberRows[0].status
      ) !== "active"
    ) {
      throw new Error(
        "Your party is not active."
      );
    }


    /*
     * Verify Hunt.
     */
    const [huntRows]: any =
      await connection.query(
        `
          SELECT
            id,
            tracking_required

          FROM hunts

          WHERE id = ?
            AND is_active = 1

          LIMIT 1
        `,
        [huntId]
      );


    if (!huntRows.length) {
      throw new Error(
        "That Hunt is not available."
      );
    }


    /*
     * Only one active Hunt per party.
     */
    const [activeRows]: any =
      await connection.query(
        `
          SELECT id

          FROM party_hunts

          WHERE party_id = ?
            AND status IN (
              'tracking',
              'revealed',
              'engaged'
            )

          LIMIT 1

          FOR UPDATE
        `,
        [partyId]
      );


    if (activeRows.length) {
      throw new Error(
        "Your party already has an active Hunt."
      );
    }


    /*
     * Create shared Hunt instance.
     */
    const [result]: any =
      await connection.query(
        `
          INSERT INTO party_hunts (
            party_id,
            hunt_id,
            accepted_by_player_id,
            status,
            tracking_progress,
            target_revealed
          )
          VALUES (
            ?,
            ?,
            ?,
            'tracking',
            0,
            0
          )
        `,
        [
          partyId,
          huntId,
          playerId
        ]
      );


    const partyHuntId =
      Number(
        result.insertId
      );


    /*
     * Initialize every objective.
     */
    await connection.query(
      `
        INSERT INTO party_hunt_objectives (
          party_hunt_id,
          hunt_objective_id,
          progress_count,
          is_complete
        )

        SELECT
          ?,
          ho.id,
          0,
          0

        FROM hunt_objectives ho

        WHERE ho.hunt_id = ?
      `,
      [
        partyHuntId,
        huntId
      ]
    );


    /*
     * Add current party members as
     * Hunt participants.
     */
    await connection.query(
      `
        INSERT INTO hunt_participants (
          party_hunt_id,
          player_id,
          participated_in_boss,
          reward_claimed
        )

        SELECT
          ?,
          pm.player_id,
          0,
          0

        FROM party_members pm

        WHERE pm.party_id = ?
      `,
      [
        partyHuntId,
        partyId
      ]
    );
/*
 * Spawn this Hunt's investigation
 * clues into the world.
 */
await spawnHuntClues(
  partyHuntId,
  huntId,
  connection
);

    await connection.commit();


    const active =
      await getActivePartyHunt(
        playerId
      );


    if (!active) {
      throw new Error(
        "Hunt was created but could not be loaded."
      );
    }


    return active;

  } catch (err) {

    await connection.rollback();

    throw err;

  } finally {

    connection.release();

  }
}


/* =========================================================
   ABANDON HUNT
========================================================= */

export async function abandonHunt(
  playerId: number
) {

  const party =
    await getPartyByPlayer(
      playerId
    );


  if (!party) {
    throw new Error(
      "You are not in a party."
    );
  }


  if (
    party.leaderPlayerId !==
    playerId
  ) {
    throw new Error(
      "Only the party leader can abandon a Hunt."
    );
  }


  const active =
    await getActivePartyHunt(
      playerId
    );


  if (!active) {
    throw new Error(
      "Your party does not have an active Hunt."
    );
  }


  await query(
    `
      UPDATE party_hunts

      SET status = 'abandoned'

      WHERE id = ?
        AND party_id = ?
    `,
    [
      active.partyHuntId,
      party.id
    ]
  );
}

export async function spawnHuntClues(
  partyHuntId: number,
  huntId: number,
  executor: any = db
) {

  const [clues]: any =
    await executor.query(
      `
        SELECT
          id,
          region_id

        FROM hunt_clues

        WHERE hunt_id = ?

        ORDER BY
          sort_order ASC,
          id ASC
      `,
      [huntId]
    );


  for (const clue of clues || []) {

    /*
     * Pick a random valid tile in the
     * clue's assigned Hunt region.
     *
     * For V1 we only exclude towns.
     * We can later add terrain rules,
     * minimum clue spacing, roads, etc.
     */
    const [tiles]: any =
      await executor.query(
        `
          SELECT
            x,
            y

          FROM world_map

          WHERE region_id = ?
            AND terrain <> 'town'

          ORDER BY RAND()

          LIMIT 1
        `,
        [
          Number(clue.region_id)
        ]
      );


    if (!tiles.length) {

      console.warn(
        "No valid Hunt clue tile found:",
        {
          partyHuntId,
          huntId,
          clueId:
            Number(clue.id),
          regionId:
            Number(clue.region_id)
        }
      );

      continue;
    }


    const tile =
      tiles[0];


    await executor.query(
      `
        INSERT IGNORE INTO
          party_hunt_clues (
            party_hunt_id,
            hunt_clue_id,
            map_x,
            map_y
          )

        VALUES (?, ?, ?, ?)
      `,
      [
        partyHuntId,
        Number(clue.id),
        Number(tile.x),
        Number(tile.y)
      ]
    );

  }

}


/* =========================================================
   INVESTIGATE HUNT CLUE
========================================================= */

export async function investigateHuntClue(
  playerId: number,
  partyHuntClueId: number
) {

  /*
   * First validate and claim the clue.
   *
   * We intentionally commit the clue investigation
   * before calling advanceHuntObjective(), because
   * advanceHuntObjective currently owns its own
   * transaction/connection.
   */
  const connection =
    await db.getConnection();

  let clueResult: any = null;

  try {

    await connection.beginTransaction();


    /* =========================================
       LOAD PLAYER LOCATION
    ========================================= */

    const [playerRows]: any =
      await connection.query(
        `
          SELECT
            map_x,
            map_y

          FROM players

          WHERE id = ?

          LIMIT 1
        `,
        [playerId]
      );


    if (!playerRows.length) {
      throw new Error(
        "Player not found."
      );
    }


    const player =
      playerRows[0];


    /* =========================================
       LOAD + LOCK CLUE

       Also verifies:
       - clue belongs to player's party Hunt
       - Hunt is currently active
       - player is a Hunt participant
    ========================================= */

    const [clueRows]: any =
      await connection.query(
        `
          SELECT
            phc.id AS party_hunt_clue_id,
            phc.party_hunt_id,
            phc.hunt_clue_id,

            phc.map_x,
            phc.map_y,

            phc.is_investigated,

            hc.name,
            hc.description,
            hc.icon,
            hc.tracking_value,

            ph.party_id,
            ph.status

          FROM party_hunt_clues phc

          JOIN hunt_clues hc
            ON hc.id =
               phc.hunt_clue_id

          JOIN party_hunts ph
            ON ph.id =
               phc.party_hunt_id

          JOIN party_members pm
            ON pm.party_id =
               ph.party_id

          JOIN hunt_participants hp
            ON hp.party_hunt_id =
               ph.id
           AND hp.player_id =
               pm.player_id

          WHERE phc.id = ?
            AND pm.player_id = ?
            AND ph.status IN (
              'tracking',
              'revealed',
              'engaged'
            )

          LIMIT 1

          FOR UPDATE
        `,
        [
          partyHuntClueId,
          playerId
        ]
      );


    if (!clueRows.length) {
      throw new Error(
        "That Hunt clue is not available."
      );
    }


    const clue =
      clueRows[0];


    /* =========================================
       ALREADY INVESTIGATED
    ========================================= */

    if (
      Number(
        clue.is_investigated
      ) === 1
    ) {
      throw new Error(
        "Your party has already investigated this clue."
      );
    }


    /* =========================================
       DISTANCE CHECK

       V1 requires standing directly on the clue.
    ========================================= */

    const distance =
      Math.abs(
        Number(player.map_x) -
        Number(clue.map_x)
      ) +
      Math.abs(
        Number(player.map_y) -
        Number(clue.map_y)
      );


    if (distance > 0) {
      throw new Error(
        "You must move onto the clue before investigating it."
      );
    }


    /* =========================================
       CLAIM CLUE
    ========================================= */

    const [updateResult]: any =
      await connection.query(
        `
          UPDATE party_hunt_clues

          SET
            is_investigated = 1,
            investigated_by_player_id = ?,
            investigated_at = NOW()

          WHERE id = ?
            AND is_investigated = 0
        `,
        [
          playerId,
          partyHuntClueId
        ]
      );


    /*
     * Important race protection:
     *
     * Two party members could theoretically
     * click the same clue at nearly the same
     * moment.
     */
    if (
      Number(
        updateResult.affectedRows
      ) !== 1
    ) {
      throw new Error(
        "That clue has already been investigated."
      );
    }


    clueResult = {
      id:
        Number(
          clue.party_hunt_clue_id
        ),

      huntClueId:
        Number(
          clue.hunt_clue_id
        ),

      partyHuntId:
        Number(
          clue.party_hunt_id
        ),

      name:
        String(
          clue.name
        ),

      description:
        String(
          clue.description
        ),

      icon:
        clue.icon ?? null,

      trackingValue:
        Number(
          clue.tracking_value || 0
        ),

      mapX:
        Number(
          clue.map_x
        ),

      mapY:
        Number(
          clue.map_y
        )
    };


    await connection.commit();

  } catch (err) {

    await connection.rollback();

    throw err;

  } finally {

    connection.release();

  }


  /* =========================================
     ADVANCE SHARED HUNT OBJECTIVE
  ========================================= */

  const huntProgress =
    await advanceHuntObjective(
      playerId,
      {
        type: "TRACK",

        /*
         * For now the clue itself simply counts
         * as one TRACK objective increment.
         *
         * Do NOT use the clue's tracking_value
         * here as amount. advanceHuntObjective()
         * already multiplies objective tracking
         * value by the number of increments.
         */
        amount: 1
      }
    );


  return {
    clue:
      clueResult,

    huntProgress
  };
}


/* =========================================================
   ADVANCE HUNT OBJECTIVE
========================================================= */

export async function advanceHuntObjective(
  playerId: number,
  event: HuntProgressEvent
) {

  const connection =
    await db.getConnection();

  try {

    await connection.beginTransaction();


    /* =========================================
       FIND ACTIVE HUNT FOR THIS PLAYER'S PARTY
    ========================================= */

    const [huntRows]: any =
      await connection.query(
        `
          SELECT
            ph.id AS party_hunt_id,
            ph.party_id,
            ph.hunt_id,
            ph.status,
            ph.tracking_progress,

            h.tracking_required

          FROM party_members pm

          JOIN party_hunts ph
            ON ph.party_id = pm.party_id

          JOIN hunts h
            ON h.id = ph.hunt_id

          JOIN hunt_participants hp
            ON hp.party_hunt_id = ph.id
           AND hp.player_id = pm.player_id

          WHERE pm.player_id = ?
            AND ph.status IN (
              'tracking',
              'revealed',
              'engaged'
            )

          ORDER BY ph.accepted_at DESC

          LIMIT 1

          FOR UPDATE
        `,
        [playerId]
      );


    if (!huntRows.length) {

      await connection.rollback();

      return {
        advanced: false,
        reason: "no_active_hunt"
      };
    }


    const hunt =
      huntRows[0];

    const partyHuntId =
      Number(
        hunt.party_hunt_id
      );


    /* =========================================
       FIND MATCHING OBJECTIVE
    ========================================= */

    const params: any[] = [
      partyHuntId,
      event.type
    ];

    let targetConditions = "";


    if (
      event.regionId !== undefined
    ) {

      targetConditions += `
        AND (
          ho.target_region_id IS NULL
          OR ho.target_region_id = ?
        )
      `;

      params.push(
        event.regionId
      );
    }


    if (
      event.creatureId !== undefined
    ) {

      targetConditions += `
        AND (
          ho.target_creature_id IS NULL
          OR ho.target_creature_id = ?
        )
      `;

      params.push(
        event.creatureId
      );
    }


    if (
      event.objectId !== undefined
    ) {

      targetConditions += `
        AND (
          ho.target_object_id IS NULL
          OR ho.target_object_id = ?
        )
      `;

      params.push(
        event.objectId
      );
    }


    const [objectiveRows]: any =
      await connection.query(
        `
          SELECT
            ho.id,
            ho.objective_type,
            ho.required_count,
            ho.tracking_value,

            pho.progress_count,
            pho.is_complete

          FROM party_hunt_objectives pho

          JOIN hunt_objectives ho
            ON ho.id =
               pho.hunt_objective_id

          WHERE pho.party_hunt_id = ?
            AND ho.objective_type = ?
            AND pho.is_complete = 0

            ${targetConditions}

          ORDER BY
            ho.sort_order ASC,
            ho.id ASC

          LIMIT 1

          FOR UPDATE
        `,
        params
      );


    if (!objectiveRows.length) {

      await connection.rollback();

      return {
        advanced: false,
        reason: "no_matching_objective"
      };
    }


    const objective =
      objectiveRows[0];


    const amount =
      Math.max(
        1,
        Number(
          event.amount || 1
        )
      );


    const previousProgress =
      Number(
        objective.progress_count
      );


    const required =
      Number(
        objective.required_count
      );


    const newProgress =
      Math.min(
        required,
        previousProgress + amount
      );


    /*
     * Number of actual increments that
     * counted toward this objective.
     */
    const appliedAmount =
      newProgress -
      previousProgress;


    if (appliedAmount <= 0) {

      await connection.rollback();

      return {
        advanced: false,
        reason: "objective_already_complete"
      };
    }


    const complete =
      newProgress >= required;


    /* =========================================
       UPDATE OBJECTIVE
    ========================================= */

    await connection.query(
      `
        UPDATE party_hunt_objectives

        SET
          progress_count = ?,
          is_complete = ?,
          completed_at =
            CASE
              WHEN ? = 1
              THEN COALESCE(
                completed_at,
                NOW()
              )
              ELSE completed_at
            END

        WHERE party_hunt_id = ?
          AND hunt_objective_id = ?
      `,
      [
        newProgress,
        complete ? 1 : 0,
        complete ? 1 : 0,
        partyHuntId,
        objective.id
      ]
    );


    /* =========================================
       ADD TRACKING PROGRESS

       tracking_value is awarded PER successful
       objective increment.

       Example:
       Kill Timber Wolf 3 times
       tracking_value = 10
       = 30 total tracking.
    ========================================= */

    const trackingGain =
      Number(
        objective.tracking_value || 0
      ) *
      appliedAmount;


    const trackingRequired =
      Number(
        hunt.tracking_required
      );


    const oldTracking =
      Number(
        hunt.tracking_progress
      );


    const newTracking =
      Math.min(
        trackingRequired,
        oldTracking +
        trackingGain
      );


    if (trackingGain > 0) {

      await connection.query(
        `
          UPDATE party_hunts

          SET tracking_progress = ?

          WHERE id = ?
        `,
        [
          newTracking,
          partyHuntId
        ]
      );

    }


/* =========================================
   REVEAL TARGET AT 100%
========================================= */

let targetRevealed = false;

let targetMapX: number | null = null;
let targetMapY: number | null = null;


if (
  newTracking >=
  trackingRequired
) {

  /*
   * Lock the Hunt row again so only the
   * first request can reveal/place the target.
   */
  const [targetRows]: any =
    await connection.query(
      `
        SELECT
          ph.target_revealed,
          ph.target_map_x,
          ph.target_map_y,

          h.region_id,
          h.target_creature_id

        FROM party_hunts ph

        JOIN hunts h
          ON h.id = ph.hunt_id

        WHERE ph.id = ?

        LIMIT 1

        FOR UPDATE
      `,
      [partyHuntId]
    );


  if (targetRows.length) {

    const targetData =
      targetRows[0];


    /*
     * Already revealed previously.
     * Just return its existing location.
     */
    if (
      Number(
        targetData.target_revealed
      ) === 1
    ) {

      targetMapX =
        targetData.target_map_x !== null
          ? Number(
              targetData.target_map_x
            )
          : null;

      targetMapY =
        targetData.target_map_y !== null
          ? Number(
              targetData.target_map_y
            )
          : null;

    } else {

      const targetRegionId =
        targetData.region_id !== null
          ? Number(
              targetData.region_id
            )
          : null;


      if (!targetRegionId) {
        throw new Error(
          "Hunt target has no region assigned."
        );
      }


      /*
       * Pick a valid world tile for the quarry.
       *
       * V1:
       * - same region as Hunt
       * - not a town
       *
       * We can tighten this later.
       */
      const [targetTiles]: any =
        await connection.query(
          `
            SELECT
              x,
              y

            FROM world_map

            WHERE region_id = ?
              AND terrain <> 'town'

            ORDER BY RAND()

            LIMIT 1
          `,
          [targetRegionId]
        );


      if (!targetTiles.length) {
        throw new Error(
          "Unable to find a valid location for the Hunt target."
        );
      }


      targetMapX =
        Number(
          targetTiles[0].x
        );

      targetMapY =
        Number(
          targetTiles[0].y
        );


      /*
       * Reveal the target and permanently
       * assign its world location.
       */
      await connection.query(
        `
          UPDATE party_hunts

          SET
            target_revealed = 1,

            target_map_x = ?,
            target_map_y = ?,

            status =
              CASE
                WHEN status = 'tracking'
                THEN 'revealed'
                ELSE status
              END,

            revealed_at =
              COALESCE(
                revealed_at,
                NOW()
              )

          WHERE id = ?
        `,
        [
          targetMapX,
          targetMapY,
          partyHuntId
        ]
      );


      targetRevealed = true;
    }
  }
}


    await connection.commit();


const progress = {
  advanced: true,

  partyHuntId,

  objectiveId:
    Number(
      objective.id
    ),

  objectiveType:
    String(
      objective.objective_type
    ),

  progressCount:
    newProgress,

  requiredCount:
    required,

  objectiveComplete:
    complete,

  trackingGain,

  trackingProgress:
    newTracking,

  trackingRequired,

  targetRevealed,

  targetMapX,
  targetMapY
};

/*
 * Objective progress is shared party state.
 *
 * Broadcast only AFTER the transaction commits so every
 * client receives a notification for confirmed progress.
 */
publishHuntProgressEvent(
  Number(
    hunt.party_id
  ),
  progress
);

return progress;


  } catch (err) {

    await connection.rollback();

    throw err;

  } finally {

    connection.release();

  }

}