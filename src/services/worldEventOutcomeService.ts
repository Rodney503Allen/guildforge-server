// services/worldEventOutcomeService.ts
import { db } from "../db";

import {
  advanceWorldEventPhase,
  completeWorldEvent,
  getActiveWorldEvent
} from "./worldEventService";

import {
  prepareWorldEventOutcomeRewards
} from "./worldEventRewardService";

async function query<T = any>(
  sql: string,
  params: any[] = []
): Promise<T> {
  const [rows] = await db.query(sql, params);
  return rows as T;
}

export type EvaluatedWorldEventOutcome = {
  outcomeId: number;
  phaseId: number;
  name: string;
  description: string | null;
  priority: number;
  outcomeType: string;
  nextPhaseId: number | null;
  influence: number;
};

export type ResolveWorldEventOutcomeResult = {
  resolved: boolean;
  activeEventId: number;
  outcome: EvaluatedWorldEventOutcome | null;
  advancedPhase: boolean;
  completedEvent: boolean;
  reason?: "timer_not_expired" | "no_influence" | "already_resolved";
};

/* =========================================================
   LOAD CURRENT PHASE OUTCOMES + INFLUENCE
========================================================= */

async function getPhaseOutcomes(
  activeEventId: number,
  phaseId: number
): Promise<EvaluatedWorldEventOutcome[]> {
  const rows: any[] = await query(
    `
      SELECT
        weo.id,
        weo.phase_id,
        weo.name,
        weo.description,
        weo.priority,
        weo.next_phase_id,
        weo.outcome_type,

        COALESCE(aweo.influence, 0) AS influence

      FROM world_event_outcomes weo

      LEFT JOIN active_world_event_outcomes aweo
        ON aweo.active_event_id = ?
       AND aweo.outcome_id = weo.id

      WHERE weo.phase_id = ?

      ORDER BY
        influence DESC,
        weo.priority DESC,
        weo.id ASC
    `,
    [activeEventId, phaseId]
  );

  return rows.map((row: any) => ({
    outcomeId: Number(row.id),
    phaseId: Number(row.phase_id),
    name: String(row.name),
    description:
      row.description == null
        ? null
        : String(row.description),
    priority: Number(row.priority || 0),
    outcomeType: String(row.outcome_type || "SUCCESS"),
    nextPhaseId:
      row.next_phase_id == null
        ? null
        : Number(row.next_phase_id),
    influence: Number(row.influence || 0)
  }));
}

/* =========================================================
   EVALUATE CURRENT PHASE
========================================================= */

/**
 * Returns the highest-influence outcome for the current phase.
 *
 * Tie handling is deterministic:
 *   1. Highest influence
 *   2. Highest configured priority
 *   3. Lowest outcome id
 *
 * This function does NOT care whether the timer has expired.
 * Timer enforcement belongs to resolveWorldEventOutcome().
 */
export async function evaluateWorldEventOutcomes(
  activeEventId: number
): Promise<EvaluatedWorldEventOutcome | null> {
  const activeEvent =
    await getActiveWorldEvent(activeEventId);

  if (!activeEvent) {
    throw new Error("Active world event not found.");
  }

  if (activeEvent.status !== "ACTIVE") {
    return null;
  }

  const outcomes =
    await getPhaseOutcomes(
      activeEventId,
      activeEvent.phaseId
    );

  const winner =
    outcomes.find(
      outcome => outcome.influence > 0
    );

  return winner || null;
}

/* =========================================================
   RESOLVE CURRENT PHASE WHEN TIMER EXPIRES
========================================================= */

/**
 * Timer-driven resolution.
 *
 * Phase 1 participation only adds influence. Nothing resolves while the
 * phase timer is still running.
 *
 * Once ends_at <= NOW():
 *   - highest influence wins
 *   - ties use outcome priority, then outcome id
 *   - next_phase_id advances the event
 *   - otherwise the event completes
 *
 * If nobody contributed, the event is left unresolved here. The scheduler
 * may later choose a configured failure/timeout policy if desired.
 */
export async function resolveWorldEventOutcome(
  activeEventId: number
): Promise<ResolveWorldEventOutcomeResult> {
  const rows: any[] = await query(
    `
      SELECT
        id,
        phase_id,
        status,
        ends_at
      FROM active_world_events
      WHERE id = ?
      LIMIT 1
    `,
    [activeEventId]
  );

  const activeEvent = rows[0];

  if (!activeEvent) {
    throw new Error("Active world event not found.");
  }

  if (String(activeEvent.status) !== "ACTIVE") {
    return {
      resolved: false,
      activeEventId,
      outcome: null,
      advancedPhase: false,
      completedEvent: false,
      reason: "already_resolved"
    };
  }

  const timerRows: any[] = await query(
    `
      SELECT
        CASE
          WHEN ends_at IS NOT NULL
           AND ends_at <= NOW()
          THEN 1
          ELSE 0
        END AS expired
      FROM active_world_events
      WHERE id = ?
      LIMIT 1
    `,
    [activeEventId]
  );

  if (!Number(timerRows[0]?.expired || 0)) {
    return {
      resolved: false,
      activeEventId,
      outcome: null,
      advancedPhase: false,
      completedEvent: false,
      reason: "timer_not_expired"
    };
  }

  const outcome =
    await evaluateWorldEventOutcomes(activeEventId);

  if (!outcome) {
    return {
      resolved: false,
      activeEventId,
      outcome: null,
      advancedPhase: false,
      completedEvent: false,
      reason: "no_influence"
    };
  }

  /*
   * Claim the resolution before rewards or phase mutation.
   * Only one concurrent resolver is allowed to move this ACTIVE phase into
   * PHASE_TRANSITION.
   */
  const [claimResult]: any = await db.query(
    `
      UPDATE active_world_events
      SET
        status = 'PHASE_TRANSITION',
        winning_outcome_id = ?
      WHERE id = ?
        AND status = 'ACTIVE'
        AND ends_at IS NOT NULL
        AND ends_at <= NOW()
    `,
    [outcome.outcomeId, activeEventId]
  );

  if (Number(claimResult?.affectedRows || 0) !== 1) {
    return {
      resolved: false,
      activeEventId,
      outcome: null,
      advancedPhase: false,
      completedEvent: false,
      reason: "already_resolved"
    };
  }

  /*
   * Freeze reward eligibility for the winning outcome before changing phase.
   * The reward service is expected to be idempotent via INSERT IGNORE.
   */
  await prepareWorldEventOutcomeRewards(
    activeEventId,
    outcome.outcomeId
  );

  if (outcome.nextPhaseId) {
    await advanceWorldEventPhase(
      activeEventId,
      outcome.nextPhaseId
    );

    return {
      resolved: true,
      activeEventId,
      outcome,
      advancedPhase: true,
      completedEvent: false
    };
  }

  /*
   * completeWorldEvent() previously expected an ACTIVE event. We have already
   * claimed this resolution as PHASE_TRANSITION, so restore ACTIVE immediately
   * before calling the existing completion helper.
   *
   * This keeps the current worldEventService API intact while still preventing
   * two timer workers from resolving the same phase concurrently.
   */
  await query(
    `
      UPDATE active_world_events
      SET status = 'ACTIVE'
      WHERE id = ?
        AND status = 'PHASE_TRANSITION'
        AND winning_outcome_id = ?
    `,
    [activeEventId, outcome.outcomeId]
  );

  await completeWorldEvent(
    activeEventId,
    outcome.outcomeId
  );

  return {
    resolved: true,
    activeEventId,
    outcome,
    advancedPhase: false,
    completedEvent: true
  };
}

/* =========================================================
   LEGACY COMPATIBILITY
========================================================= */

/**
 * Kept temporarily so any forgotten import fails safely rather than
 * restoring immediate progress-based resolution. It now obeys the timer.
 */
export async function resolveWorldEventAfterProgress(
  activeEventId: number
): Promise<ResolveWorldEventOutcomeResult> {
  return resolveWorldEventOutcome(activeEventId);
}
