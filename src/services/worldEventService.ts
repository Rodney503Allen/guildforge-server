// services/worldEventService.ts
import { db } from "../db";
import {
  spawnWorldEventPhase,
  removeWorldEventPhaseSpawns,
  removeAllWorldEventSpawns
} from "./worldEventSpawnService";

/**
 * Promise wrapper matching the existing Guildforge service pattern.
 */
async function query<T = any>(
  sql: string,
  params: any[] = []
): Promise<T> {
  const [rows] = await db.query(sql, params);
  return rows as T;
}

export type ActiveWorldEvent = {
  id: number;
  eventId: number;
  phaseId: number;
  regionId: number;
  status: string;
  startedAt: Date | string;
  endsAt: Date | string;
  winningOutcomeId: number | null;
  completedAt: Date | string | null;

  eventName: string;
  eventDescription: string | null;

  phaseNumber: number;
  phaseName: string;
  phaseDescription: string | null;
  durationMinutes: number;

  objectives: ActiveWorldEventObjective[];
};

export type ActiveWorldEventObjective = {
  objectiveId: number;
  objectiveKey: string;
  objectiveType: string;
  targetId: number | null;
  targetAmount: number;
  currentAmount: number;
  description: string;
  completedAt: Date | string | null;
};

/* =========================================================
   GET ACTIVE EVENT FOR REGION
========================================================= */

export async function getActiveEventForRegion(
  regionId: number
): Promise<ActiveWorldEvent | null> {

  const rows: any[] = await query(
    `
      SELECT
        awe.id,
        awe.event_id,
        awe.phase_id,
        awe.region_id,
        awe.status,
        awe.started_at,
        awe.ends_at,
        awe.winning_outcome_id,
        awe.completed_at,

        we.name AS event_name,
        we.description AS event_description,

        wep.phase_number,
        wep.name AS phase_name,
        wep.description AS phase_description,
        wep.duration_minutes

      FROM active_world_events awe

      JOIN world_events we
        ON we.id = awe.event_id

      JOIN world_event_phases wep
        ON wep.id = awe.phase_id

      WHERE awe.region_id = ?
        AND awe.status IN (
          'ACTIVE',
          'PHASE_TRANSITION'
        )

      ORDER BY awe.started_at DESC

      LIMIT 1
    `,
    [regionId]
  );

  if (!rows.length) {
    return null;
  }

  return buildActiveEvent(rows[0]);
}

/* =========================================================
   GET ACTIVE EVENT BY ID
========================================================= */

export async function getActiveWorldEvent(
  activeEventId: number
): Promise<ActiveWorldEvent | null> {

  const rows: any[] = await query(
    `
      SELECT
        awe.id,
        awe.event_id,
        awe.phase_id,
        awe.region_id,
        awe.status,
        awe.started_at,
        awe.ends_at,
        awe.winning_outcome_id,
        awe.completed_at,

        we.name AS event_name,
        we.description AS event_description,

        wep.phase_number,
        wep.name AS phase_name,
        wep.description AS phase_description,
        wep.duration_minutes

      FROM active_world_events awe

      JOIN world_events we
        ON we.id = awe.event_id

      JOIN world_event_phases wep
        ON wep.id = awe.phase_id

      WHERE awe.id = ?

      LIMIT 1
    `,
    [activeEventId]
  );

  if (!rows.length) {
    return null;
  }

  return buildActiveEvent(rows[0]);
}

/* =========================================================
   LOAD ACTIVE OBJECTIVES
========================================================= */

export async function getActiveObjectives(
  activeEventId: number
): Promise<ActiveWorldEventObjective[]> {

  const rows: any[] = await query(
    `
      SELECT
        weo.id AS objective_id,
        weo.objective_key,
        weo.objective_type,
        weo.target_id,
        weo.target_amount,
        weo.description,

        aweo.current_amount,
        aweo.completed_at

      FROM active_world_event_objectives aweo

      JOIN world_event_objectives weo
        ON weo.id = aweo.objective_id

      WHERE aweo.active_event_id = ?

      ORDER BY weo.id ASC
    `,
    [activeEventId]
  );

  return rows.map(row => ({
    objectiveId:
      Number(row.objective_id),

    objectiveKey:
      String(row.objective_key),

    objectiveType:
      String(row.objective_type),

    targetId:
      row.target_id == null
        ? null
        : Number(row.target_id),

    targetAmount:
      Number(row.target_amount),

    currentAmount:
      Number(row.current_amount || 0),

    description:
      String(row.description),

    completedAt:
      row.completed_at ?? null,
  }));
}

/* =========================================================
   BUILD ACTIVE EVENT
========================================================= */

async function buildActiveEvent(
  row: any
): Promise<ActiveWorldEvent> {

  const activeEventId =
    Number(row.id);

  const objectives =
    await getActiveObjectives(
      activeEventId
    );

  return {
    id: activeEventId,

    eventId:
      Number(row.event_id),

    phaseId:
      Number(row.phase_id),

    regionId:
      Number(row.region_id),

    status:
      String(row.status),

    startedAt:
      row.started_at,

    endsAt:
      row.ends_at,

    winningOutcomeId:
      row.winning_outcome_id == null
        ? null
        : Number(
            row.winning_outcome_id
          ),

    completedAt:
      row.completed_at ?? null,

    eventName:
      String(row.event_name),

    eventDescription:
      row.event_description == null
        ? null
        : String(
            row.event_description
          ),

    phaseNumber:
      Number(row.phase_number),

    phaseName:
      String(row.phase_name),

    phaseDescription:
      row.phase_description == null
        ? null
        : String(
            row.phase_description
          ),

    durationMinutes:
      Number(row.duration_minutes),

    objectives,
  };
}

/* =========================================================
   CREATE ACTIVE OBJECTIVES
========================================================= */

export async function createActiveObjectives(
  activeEventId: number,
  phaseId: number
): Promise<void> {

  await query(
    `
      INSERT INTO active_world_event_objectives (
        active_event_id,
        objective_id,
        current_amount,
        completed_at
      )

      SELECT
        ?,
        weo.id,
        0,
        NULL

      FROM world_event_objectives weo

      WHERE weo.phase_id = ?

      ON DUPLICATE KEY UPDATE
        current_amount =
          current_amount
    `,
    [
      activeEventId,
      phaseId
    ]
  );
}

/* =========================================================
   CREATE ACTIVE OUTCOME INFLUENCE ROWS
========================================================= */

/**
 * Initialize the current phase's regional influence meters.
 *
 * Every outcome begins at 0 influence. Personal track completion later
 * increments exactly one of these rows through worldEventProgressService.
 *
 * INSERT IGNORE keeps this safe if startup/phase initialization is retried.
 */
export async function createActiveOutcomeInfluenceRows(
  activeEventId: number,
  phaseId: number
): Promise<void> {

  await query(
    `
      INSERT IGNORE INTO active_world_event_outcomes (
        active_event_id,
        outcome_id,
        influence
      )

      SELECT
        ?,
        weo.id,
        0

      FROM world_event_outcomes weo

      WHERE weo.phase_id = ?
    `,
    [
      activeEventId,
      phaseId
    ]
  );
}

/* =========================================================
   START WORLD EVENT
========================================================= */

export async function startWorldEvent(
  eventId: number
): Promise<ActiveWorldEvent> {

  const eventRows: any[] =
    await query(
      `
        SELECT
          we.id,
          we.region_id,
          we.is_enabled,

          wep.id AS phase_id,
          wep.duration_minutes

        FROM world_events we

        JOIN world_event_phases wep
          ON wep.event_id = we.id
         AND wep.phase_number = 1

        WHERE we.id = ?

        LIMIT 1
      `,
      [eventId]
    );

  if (!eventRows.length) {
    throw new Error(
      "World event not found or has no phase 1."
    );
  }

  const event =
    eventRows[0];

  if (
    Number(event.is_enabled) !== 1
  ) {
    throw new Error(
      "That world event is disabled."
    );
  }

  const regionId =
    Number(event.region_id);

  const existing =
    await getActiveEventForRegion(
      regionId
    );

  if (existing) {
    throw new Error(
      "That region already has an active world event."
    );
  }

  /*
   * Check the event-specific cooldown
   * against the last completed run.
   */
  const cooldownRows: any[] =
    await query(
      `
        SELECT
          weh.ended_at,
          we.cooldown_minutes,

          DATE_ADD(
            weh.ended_at,
            INTERVAL we.cooldown_minutes MINUTE
          ) AS available_at,

          DATE_ADD(
            weh.ended_at,
            INTERVAL we.cooldown_minutes MINUTE
          ) > NOW() AS on_cooldown

        FROM world_events we

        JOIN world_event_history weh
          ON weh.event_id = we.id

        WHERE we.id = ?

        ORDER BY weh.ended_at DESC

        LIMIT 1
      `,
      [eventId]
    );

  if (
    cooldownRows.length &&
    Number(
      cooldownRows[0].on_cooldown
    ) === 1
  ) {
    throw new Error(
      "That world event is still on cooldown."
    );
  }

  const phaseId =
    Number(event.phase_id);

  const durationMinutes =
    Number(
      event.duration_minutes
    );

  /*
   * The project's existing services use
   * db.query() directly rather than a
   * transaction helper. If creation of
   * objectives fails, we explicitly remove
   * the newly created active event so we
   * cannot leave an orphaned event behind.
   */
  const result: any =
    await query(
      `
        INSERT INTO active_world_events (
          event_id,
          phase_id,
          region_id,
          status,
          started_at,
          ends_at,
          winning_outcome_id,
          completed_at
        )
        VALUES (
          ?,
          ?,
          ?,
          'ACTIVE',
          NOW(),
          DATE_ADD(
            NOW(),
            INTERVAL ? MINUTE
          ),
          NULL,
          NULL
        )
      `,
      [
        eventId,
        phaseId,
        regionId,
        durationMinutes
      ]
    );

  const activeEventId =
    Number(result.insertId);

  try {

    await createActiveObjectives(
      activeEventId,
      phaseId
    );

    await createActiveOutcomeInfluenceRows(
      activeEventId,
      phaseId
    );

    await spawnWorldEventPhase(
      activeEventId,
      phaseId
    );

  } catch (err) {

    await query(
      `
        DELETE FROM active_world_events
        WHERE id = ?
      `,
      [activeEventId]
    );

    throw err;
  }

  const activeEvent =
    await getActiveWorldEvent(
      activeEventId
    );

  if (!activeEvent) {
    throw new Error(
      "World event started but could not be loaded."
    );
  }

  return activeEvent;
}

/* =========================================================
   ADVANCE EVENT PHASE
========================================================= */

export async function advanceWorldEventPhase(
  activeEventId: number,
  nextPhaseId: number
): Promise<ActiveWorldEvent> {

  const eventRows: any[] =
    await query(
      `
        SELECT
          awe.id,
          awe.event_id,
          awe.phase_id AS current_phase_id,
          awe.status,

          wep.id AS phase_id,
          wep.duration_minutes

        FROM active_world_events awe

        JOIN world_event_phases wep
          ON wep.id = ?
         AND wep.event_id =
             awe.event_id

        WHERE awe.id = ?
          AND awe.status IN (
            'ACTIVE',
            'PHASE_TRANSITION'
          )

        LIMIT 1
      `,
      [
        nextPhaseId,
        activeEventId
      ]
    );

  if (!eventRows.length) {
    throw new Error(
      "The next world event phase is invalid."
    );
  }

  const nextPhase =
    eventRows[0];

  /*
   * Remove any physical content left behind by the previous phase
   * before switching the active event to the new phase.
   */
  await removeWorldEventPhaseSpawns(
    activeEventId,
    Number(nextPhase.current_phase_id)
  );

  /*
   * Clear the previous phase's active
   * objective rows. Player contribution
   * history remains untouched.
   */
  await query(
    `
      DELETE FROM active_world_event_objectives
      WHERE active_event_id = ?
    `,
    [activeEventId]
  );

  await query(
    `
      UPDATE active_world_events

      SET
        phase_id = ?,
        status = 'ACTIVE',
        started_at = NOW(),
        ends_at = DATE_ADD(
          NOW(),
          INTERVAL ? MINUTE
        ),
        winning_outcome_id = NULL,
        completed_at = NULL

      WHERE id = ?
    `,
    [
      nextPhaseId,
      Number(
        nextPhase.duration_minutes
      ),
      activeEventId
    ]
  );

  try {

    await createActiveObjectives(
      activeEventId,
      nextPhaseId
    );

    await createActiveOutcomeInfluenceRows(
      activeEventId,
      nextPhaseId
    );

    await spawnWorldEventPhase(
      activeEventId,
      nextPhaseId
    );

  } catch (err) {

    /*
     * Mark it as transition instead of
     * pretending the phase is playable
     * without objectives.
     */
    await query(
      `
        UPDATE active_world_events
        SET status =
          'PHASE_TRANSITION'
        WHERE id = ?
      `,
      [activeEventId]
    );

    throw err;
  }

  const activeEvent =
    await getActiveWorldEvent(
      activeEventId
    );

  if (!activeEvent) {
    throw new Error(
      "World event phase advanced but could not be loaded."
    );
  }

  return activeEvent;
}

/* =========================================================
   COMPLETE WORLD EVENT
========================================================= */

export async function completeWorldEvent(
  activeEventId: number,
  outcomeId: number
): Promise<void> {

  const rows: any[] =
    await query(
      `
        SELECT
          awe.id,
          awe.event_id,
          awe.phase_id,
          awe.region_id,
          awe.started_at,

          weo.id AS outcome_id,
          weo.outcome_type

        FROM active_world_events awe

        JOIN world_event_outcomes weo
          ON weo.id = ?
         AND weo.phase_id =
             awe.phase_id

        WHERE awe.id = ?
          AND awe.status IN (
            'ACTIVE',
            'PHASE_TRANSITION'
          )

        LIMIT 1
      `,
      [
        outcomeId,
        activeEventId
      ]
    );

  if (!rows.length) {
    throw new Error(
      "World event outcome is invalid."
    );
  }

  const event =
    rows[0];

  await query(
    `
      UPDATE active_world_events

      SET
        status = 'COMPLETED',
        winning_outcome_id = ?,
        completed_at = NOW()

      WHERE id = ?
    `,
    [
      outcomeId,
      activeEventId
    ]
  );

  await removeAllWorldEventSpawns(
    activeEventId
  );

  await query(
    `
      INSERT INTO world_event_history (
        event_id,
        region_id,
        winning_outcome_id,
        started_at,
        ended_at,
        final_status
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        NOW(),
        'COMPLETED'
      )
    `,
    [
      Number(event.event_id),
      Number(event.region_id),
      outcomeId,
      event.started_at
    ]
  );
}

/* =========================================================
   EXPIRE WORLD EVENT
========================================================= */

export async function expireWorldEvent(
  activeEventId: number
): Promise<void> {

  const rows: any[] =
    await query(
      `
        SELECT
          id,
          event_id,
          region_id,
          started_at,
          status

        FROM active_world_events

        WHERE id = ?
          AND status IN (
            'ACTIVE',
            'PHASE_TRANSITION'
          )

        LIMIT 1
      `,
      [activeEventId]
    );

  if (!rows.length) {
    return;
  }

  const event =
    rows[0];

  await query(
    `
      UPDATE active_world_events

      SET
        status = 'FAILED',
        completed_at = NOW()

      WHERE id = ?
    `,
    [activeEventId]
  );

  await removeAllWorldEventSpawns(
    activeEventId
  );

  await query(
    `
      INSERT INTO world_event_history (
        event_id,
        region_id,
        winning_outcome_id,
        started_at,
        ended_at,
        final_status
      )
      VALUES (
        ?,
        ?,
        NULL,
        ?,
        NOW(),
        'FAILED'
      )
    `,
    [
      Number(event.event_id),
      Number(event.region_id),
      event.started_at
    ]
  );
}

/* =========================================================
   GET EXPIRED ACTIVE EVENTS
========================================================= */

export async function getExpiredWorldEvents():
Promise<number[]> {

  const rows: any[] =
    await query(
      `
        SELECT id

        FROM active_world_events

        WHERE status = 'ACTIVE'
          AND ends_at <= NOW()

        ORDER BY ends_at ASC
      `
    );

  return rows.map(
    row => Number(row.id)
  );
}
