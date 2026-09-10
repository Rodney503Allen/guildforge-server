// services/worldEventSchedulerService.ts
import { db } from "../db";

import {
  getExpiredWorldEvents,
  expireWorldEvent,
  startWorldEvent
} from "./worldEventService";

import {
  resolveWorldEventOutcome
} from "./worldEventOutcomeService";

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

export type WorldEventSchedulerResult = {
  expiredEventIds: number[];
  startedEvents: Array<{
    regionId: number;
    eventId: number;
    activeEventId: number;
    eventName: string;
  }>;
};

/* =========================================================
   RESOLVE / EXPIRE DUE EVENTS
========================================================= */

/**
 * Handles every ACTIVE world event whose ends_at has passed.
 *
 * - If players contributed, the normal outcome resolver decides the winner,
 *   creates reward eligibility, and either advances the event or completes it.
 *
 * - If nobody contributed, there is no winning outcome. In that case the
 *   event expires as FAILED so the region cannot become permanently blocked
 *   by an old ACTIVE event.
 */
export async function expireDueWorldEvents():
Promise<number[]> {

  const expiredIds =
    await getExpiredWorldEvents();

  const handledIds: number[] = [];

  for (const activeEventId of expiredIds) {
    try {
      const resolution =
        await resolveWorldEventOutcome(
          activeEventId
        );

      if (resolution.resolved) {
        handledIds.push(
          activeEventId
        );

        console.log(
          `[WorldEvents] Resolved event ${activeEventId}:`,
          {
            outcome:
              resolution.outcome?.name ?? null,
            influence:
              resolution.outcome?.influence ?? 0,
            advancedPhase:
              resolution.advancedPhase,
            completedEvent:
              resolution.completedEvent
          }
        );

        continue;
      }

      /*
       * An expired event with no influence has no winner.
       * Fail it cleanly so it does not stay ACTIVE forever.
       */
      if (
        resolution.reason ===
        "no_influence"
      ) {
        await expireWorldEvent(
          activeEventId
        );

        handledIds.push(
          activeEventId
        );

        console.log(
          `[WorldEvents] Event ${activeEventId} expired with no participation.`
        );

        continue;
      }

      /*
       * already_resolved can happen harmlessly if another scheduler/tick
       * resolved the event first. timer_not_expired should be rare because
       * getExpiredWorldEvents() already filters by ends_at.
       */
      console.log(
        `[WorldEvents] Expired event ${activeEventId} was not changed:`,
        resolution.reason
      );

    } catch (err) {
      console.error(
        `Failed to process expired world event ${activeEventId}:`,
        err
      );
    }
  }

  return handledIds;
}

/* =========================================================
   PICK ONE GLOBAL EVENT
========================================================= */

/**
 * Returns one weighted-random eligible event across ALL regions.
 *
 * Eligibility rules:
 * - enabled
 * - its own cooldown has elapsed
 * - its region does not currently have an ACTIVE event
 *
 * We currently start only ONE world event globally per hour.
 */
export async function pickRandomGlobalWorldEvent() {

  const rows: any[] =
    await query(
      `
        SELECT
          we.id,
          we.name,
          we.region_id,
          we.weight,
          we.cooldown_minutes,

          MAX(weh.ended_at)
            AS last_ended_at

        FROM world_events we

        LEFT JOIN world_event_history weh
          ON weh.event_id = we.id

        WHERE
          we.is_enabled = 1

          AND NOT EXISTS (
            SELECT 1
            FROM active_world_events awe
            WHERE awe.region_id = we.region_id
              AND awe.status IN (
                'ACTIVE',
                'PHASE_TRANSITION'
              )
          )

        GROUP BY
          we.id,
          we.name,
          we.region_id,
          we.weight,
          we.cooldown_minutes

        HAVING
          last_ended_at IS NULL
          OR DATE_ADD(
            last_ended_at,
            INTERVAL we.cooldown_minutes MINUTE
          ) <= NOW()

        ORDER BY
          we.id ASC
      `
    );

  if (!rows.length) {
    return null;
  }

  const candidates =
    rows.map(row => ({
      eventId:
        Number(row.id),

      eventName:
        String(row.name),

      regionId:
        Number(row.region_id),

      weight:
        Math.max(
          1,
          Number(
            row.weight || 1
          )
        )
    }));

  const totalWeight =
    candidates.reduce(
      (sum, event) =>
        sum + event.weight,
      0
    );

  let roll =
    Math.random() *
    totalWeight;

  for (const event of candidates) {
    roll -= event.weight;

    if (roll <= 0) {
      return event;
    }
  }

  return candidates[
    candidates.length - 1
  ];
}

/* =========================================================
   GLOBAL HOURLY START GUARD
========================================================= */

/**
 * True only when this scheduler tick is allowed to start the
 * ONE global world event for the current hour.
 *
 * Rules:
 * - only at minute 0
 * - do not start if an event is already ACTIVE / transitioning anywhere
 * - do not start a second event during the same clock hour, even if the
 *   first event happened to resolve very quickly or the server restarted
 */
export async function shouldStartGlobalWorldEvent(
  now: Date = new Date()
): Promise<boolean> {

  if (now.getMinutes() !== 0) {
    return false;
  }

  const [activeRows]: any =
    await db.query(
      `
        SELECT id

        FROM active_world_events

        WHERE status IN (
          'ACTIVE',
          'PHASE_TRANSITION'
        )

        LIMIT 1
      `
    );

  if (activeRows.length) {
    return false;
  }

  /*
   * Prevent a duplicate hourly launch after a server restart during
   * minute 00. active_world_events retains resolved event rows, so
   * started_at gives us a durable "already launched this hour" guard.
   */
  const [startedThisHourRows]: any =
    await db.query(
      `
        SELECT id

        FROM active_world_events

        WHERE started_at >=
          DATE_FORMAT(
            NOW(),
            '%Y-%m-%d %H:00:00'
          )

          AND started_at <
          DATE_ADD(
            DATE_FORMAT(
              NOW(),
              '%Y-%m-%d %H:00:00'
            ),
            INTERVAL 1 HOUR
          )

        LIMIT 1
      `
    );

  return startedThisHourRows.length === 0;
}

/* =========================================================
   START ONE GLOBAL HOURLY EVENT
========================================================= */

export async function startEligibleGlobalWorldEvent(
  now: Date = new Date()
) {
  const startedEvents:
    WorldEventSchedulerResult["startedEvents"] =
    [];

  const shouldStart =
    await shouldStartGlobalWorldEvent(
      now
    );

  if (!shouldStart) {
    return startedEvents;
  }

  const selected =
    await pickRandomGlobalWorldEvent();

  if (!selected) {
    console.log(
      "[WorldEvents] No eligible world event available for this hour."
    );

    return startedEvents;
  }

  try {
    const activeEvent =
      await startWorldEvent(
        selected.eventId
      );

    startedEvents.push({
      regionId:
        selected.regionId,

      eventId:
        selected.eventId,

      activeEventId:
        activeEvent.id,

      eventName:
        activeEvent.eventName
    });

    console.log(
      `[WorldEvents] Started hourly event "${activeEvent.eventName}" in region ${selected.regionId} as active event ${activeEvent.id}.`
    );

  } catch (err) {
    console.error(
      `Failed to start hourly world event ${selected.eventId}:`,
      err
    );
  }

  return startedEvents;
}

/* =========================================================
   RUN SCHEDULER TICK
========================================================= */

export async function runWorldEventSchedulerTick(
  now: Date = new Date()
): Promise<WorldEventSchedulerResult> {

  /*
   * Resolve old events first. That frees a region before the same tick
   * evaluates whether a new event should begin there.
   */
  const expiredEventIds =
    await expireDueWorldEvents();

  const startedEvents =
    await startEligibleGlobalWorldEvent(
      now
    );

  return {
    expiredEventIds,
    startedEvents
  };
}

/* =========================================================
   START SCHEDULER LOOP
========================================================= */

let schedulerTimer:
  ReturnType<typeof setInterval> |
  null =
  null;

let schedulerRunning =
  false;

/**
 * Starts the scheduler loop.
 *
 * Call this exactly once from the main server bootstrap.
 */
export function startWorldEventScheduler() {

  if (schedulerTimer) {
    return;
  }

  const runTick =
    async () => {

      /*
       * Prevent overlapping ticks if a DB call takes longer than the
       * scheduler interval.
       */
      if (schedulerRunning) {
        return;
      }

      schedulerRunning =
        true;

      try {
        const result =
          await runWorldEventSchedulerTick();

        if (
          result.expiredEventIds.length ||
          result.startedEvents.length
        ) {
          console.log(
            "[WorldEvents] Scheduler tick:",
            result
          );
        }

      } catch (err) {
        console.error(
          "[WorldEvents] Scheduler tick failed:",
          err
        );

      } finally {
        schedulerRunning =
          false;
      }
    };

  /*
   * Immediately process stale/expired events when Guildforge boots.
   */
  void runTick();

  /*
   * Then check once per minute.
   */
  schedulerTimer =
    setInterval(
      runTick,
      60_000
    );

  console.log(
    "[WorldEvents] Scheduler started."
  );
}

/* =========================================================
   STOP SCHEDULER LOOP
========================================================= */

export function stopWorldEventScheduler() {

  if (!schedulerTimer) {
    return;
  }

  clearInterval(
    schedulerTimer
  );

  schedulerTimer =
    null;

  console.log(
    "[WorldEvents] Scheduler stopped."
  );
}
