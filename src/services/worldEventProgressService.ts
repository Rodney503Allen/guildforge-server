// services/worldEventProgressService.ts
import { db } from "../db";

async function query<T = any>(
  sql: string,
  params: any[] = []
): Promise<T> {
  const [rows] = await db.query(sql, params);
  return rows as T;
}

export type WorldEventProgressType =
  | "KILL"
  | "GATHER"
  | "CRAFT"
  | "INTERACT"
  | "HUNT"
  | "DUNGEON"
  | "EXPLORE"
  | "DELIVER";

export type RecordWorldEventProgressInput = {
  playerId: number;
  regionId: number;
  type: WorldEventProgressType | string;
  targetId?: number | null;
  amount?: number;
};

export type WorldEventProgressUpdate = {
  activeEventId: number;
  eventId: number;
  phaseId: number;
  regionId: number;

  objectiveId: number;
  objectiveKey: string;
  objectiveType: string;

  targetId: number | null;
  targetAmount: number;

  previousAmount: number;
  currentAmount: number;
  addedAmount: number;

  objectiveCompleted: boolean;
  objectiveJustCompleted: boolean;

  committed: boolean;
  committedOutcomeId: number | null;
  influenceAdded: number;
};

export type WorldEventProgressResult = {
  matched: boolean;
  activeEventId: number | null;
  updates: WorldEventProgressUpdate[];

  committed: boolean;
  committedOutcomeId: number | null;
};

/* =========================================================
   FIND MATCHING ACTIVE OBJECTIVES
========================================================= */

async function getMatchingObjectives(
  regionId: number,
  type: string,
  targetId: number | null
) {
  const rows: any[] =
    await query(
      `
        SELECT
          awe.id AS active_event_id,
          awe.event_id,
          awe.phase_id,
          awe.region_id,

          weo.id AS objective_id,
          weo.objective_key,
          weo.objective_type,
          weo.target_id,
          weo.target_amount,

          wor.outcome_id

        FROM active_world_events awe

        JOIN world_event_objectives weo
          ON weo.phase_id =
             awe.phase_id

        LEFT JOIN world_event_outcome_requirements wor
          ON wor.objective_id =
             weo.id

        WHERE awe.region_id = ?
          AND awe.status = 'ACTIVE'
          AND awe.ends_at > NOW()

          AND UPPER(
            weo.objective_type
          ) = ?

          AND (
            weo.target_id IS NULL
            OR weo.target_id = ?
          )

        ORDER BY
          weo.id ASC,
          wor.outcome_id ASC
      `,
      [
        regionId,
        type,
        targetId
      ]
    );

  return rows;
}

/* =========================================================
   PLAYER EVENT STATE
========================================================= */

async function ensurePlayerEventState(
  activeEventId: number,
  playerId: number,
  phaseId: number
) {
  await query(
    `
      INSERT INTO
        player_world_event_state (
          active_event_id,
          player_id,
          phase_id,
          chosen_outcome_id,
          committed_at
        )
      VALUES (
        ?,
        ?,
        ?,
        NULL,
        NULL
      )

      ON DUPLICATE KEY UPDATE
        player_id = VALUES(player_id)
    `,
    [
      activeEventId,
      playerId,
      phaseId
    ]
  );
}

async function getPlayerEventState(
  activeEventId: number,
  playerId: number,
  phaseId: number
) {
  const rows: any[] =
    await query(
      `
        SELECT
          chosen_outcome_id,
          committed_at

        FROM player_world_event_state

        WHERE active_event_id = ?
          AND player_id = ?
          AND phase_id = ?

        LIMIT 1
      `,
      [
        activeEventId,
        playerId,
        phaseId
      ]
    );

  if (!rows.length) {
    return {
      chosenOutcomeId: null,
      committedAt: null
    };
  }

  return {
    chosenOutcomeId:
      rows[0].chosen_outcome_id == null
        ? null
        : Number(
            rows[0].chosen_outcome_id
          ),

    committedAt:
      rows[0].committed_at
  };
}

/* =========================================================
   PERSONAL OBJECTIVE PROGRESS
========================================================= */

async function ensurePlayerObjective(
  activeEventId: number,
  playerId: number,
  objectiveId: number
) {
  await query(
    `
      INSERT INTO
        player_world_event_objectives (
          active_event_id,
          player_id,
          objective_id,
          current_amount,
          completed_at
        )
      VALUES (
        ?,
        ?,
        ?,
        0,
        NULL
      )

      ON DUPLICATE KEY UPDATE
        objective_id =
          VALUES(objective_id)
    `,
    [
      activeEventId,
      playerId,
      objectiveId
    ]
  );
}

async function getPlayerObjective(
  activeEventId: number,
  playerId: number,
  objectiveId: number
) {
  const rows: any[] =
    await query(
      `
        SELECT
          current_amount,
          completed_at

        FROM
          player_world_event_objectives

        WHERE active_event_id = ?
          AND player_id = ?
          AND objective_id = ?

        LIMIT 1
      `,
      [
        activeEventId,
        playerId,
        objectiveId
      ]
    );

  return rows[0] || null;
}

/* =========================================================
   COMMIT PLAYER TO ONE OUTCOME
========================================================= */

async function commitPlayerOutcome(
  activeEventId: number,
  playerId: number,
  phaseId: number,
  outcomeId: number
) {
  /*
   * The state update is the lock.
   *
   * Only a player who is still uncommitted can win this UPDATE.
   * This protects against two objective-completion requests arriving
   * at nearly the same time.
   */
  const commitResult: any =
    await query(
      `
        UPDATE player_world_event_state

        SET
          chosen_outcome_id = ?,
          committed_at = NOW()

        WHERE active_event_id = ?
          AND player_id = ?
          AND phase_id = ?
          AND chosen_outcome_id IS NULL
          AND committed_at IS NULL
      `,
      [
        outcomeId,
        activeEventId,
        playerId,
        phaseId
      ]
    );

  if (
    !Number(
      commitResult.affectedRows
    )
  ) {
    const state =
      await getPlayerEventState(
        activeEventId,
        playerId,
        phaseId
      );

    return {
      committedNow: false,
      chosenOutcomeId:
        state.chosenOutcomeId
    };
  }

  /*
   * A successful commitment contributes exactly one regional
   * influence point to the selected outcome.
   */
  await query(
    `
      INSERT INTO
        active_world_event_outcomes (
          active_event_id,
          outcome_id,
          influence
        )
      VALUES (
        ?,
        ?,
        1
      )

      ON DUPLICATE KEY UPDATE
        influence =
          influence + 1
    `,
    [
      activeEventId,
      outcomeId
    ]
  );

  return {
    committedNow: true,
    chosenOutcomeId:
      outcomeId
  };
}

/* =========================================================
   RECORD WORLD EVENT PROGRESS
========================================================= */

/**
 * Universal entry point for world-event progress.
 *
 * Progress is PERSONAL during influence phases:
 *
 * player action
 *   -> player_world_event_objectives
 *   -> personal track reaches its target
 *   -> player commits to that track's outcome
 *   -> active_world_event_outcomes +1 influence
 *
 * Once committed, that player can no longer advance another track
 * for the same active event.
 */
export async function recordWorldEventProgress(
  input: RecordWorldEventProgressInput
): Promise<WorldEventProgressResult> {

  const playerId =
    Number(input.playerId);

  const regionId =
    Number(input.regionId);

  const type =
    String(input.type || "")
      .trim()
      .toUpperCase();

  const targetId =
    input.targetId == null
      ? null
      : Number(input.targetId);

  const requestedAmount =
    Math.floor(
      Number(
        input.amount ?? 1
      )
    );

  if (
    !Number.isInteger(playerId) ||
    playerId <= 0
  ) {
    throw new Error(
      "Invalid player for world event progress."
    );
  }

  if (
    !Number.isInteger(regionId) ||
    regionId <= 0
  ) {
    throw new Error(
      "Invalid region for world event progress."
    );
  }

  if (!type) {
    throw new Error(
      "World event progress type is required."
    );
  }

  if (
    !Number.isFinite(requestedAmount) ||
    requestedAmount <= 0
  ) {
    throw new Error(
      "World event progress amount must be positive."
    );
  }

  if (
    targetId != null &&
    (
      !Number.isInteger(targetId) ||
      targetId <= 0
    )
  ) {
    throw new Error(
      "Invalid world event progress target."
    );
  }

  const matches =
    await getMatchingObjectives(
      regionId,
      type,
      targetId
    );

  if (!matches.length) {
    return {
      matched: false,
      activeEventId: null,
      updates: [],
      committed: false,
      committedOutcomeId: null
    };
  }

  const updates:
    WorldEventProgressUpdate[] =
    [];

  let resultCommitted = false;
  let resultCommittedOutcomeId:
    number | null = null;

  /*
   * A region should only have one active event, but keep the state
   * initialization scoped to each returned active event so this service
   * remains safe if that rule changes later.
   */
  const initializedEventPhases =
    new Set<string>();

  for (const row of matches) {

    const activeEventId =
      Number(
        row.active_event_id
      );

    const objectiveId =
      Number(
        row.objective_id
      );

    const outcomeId =
      row.outcome_id == null
        ? null
        : Number(
            row.outcome_id
          );

    const targetAmount =
      Number(
        row.target_amount
      );

    const phaseId =
      Number(
        row.phase_id
      );

    const eventPhaseKey =
      `${activeEventId}:${phaseId}`;

    if (
      !initializedEventPhases.has(
        eventPhaseKey
      )
    ) {
      await ensurePlayerEventState(
        activeEventId,
        playerId,
        phaseId
      );

      initializedEventPhases.add(
        eventPhaseKey
      );
    }

    /*
     * A committed player is finished contributing to this active event.
     * Other objective types must no longer progress.
     */
    const playerState =
      await getPlayerEventState(
        activeEventId,
        playerId,
        phaseId
      );

    if (
      playerState.chosenOutcomeId != null ||
      playerState.committedAt != null
    ) {
      resultCommitted = true;
      resultCommittedOutcomeId =
        playerState.chosenOutcomeId;

      continue;
    }

    await ensurePlayerObjective(
      activeEventId,
      playerId,
      objectiveId
    );

    const before =
      await getPlayerObjective(
        activeEventId,
        playerId,
        objectiveId
      );

    if (!before) {
      continue;
    }

    const previousAmount =
      Number(
        before.current_amount || 0
      );

    if (
      before.completed_at != null ||
      previousAmount >= targetAmount
    ) {
      continue;
    }

    const remaining =
      Math.max(
        0,
        targetAmount -
        previousAmount
      );

    const addedAmount =
      Math.min(
        requestedAmount,
        remaining
      );

    if (addedAmount <= 0) {
      continue;
    }

    /*
     * Increment only this player's objective.
     */
    const updateResult: any =
      await query(
        `
          UPDATE
            player_world_event_objectives pweo

          JOIN active_world_events awe
            ON awe.id =
               pweo.active_event_id

          JOIN world_event_objectives weo
            ON weo.id =
               pweo.objective_id

          SET
            pweo.current_amount =
              LEAST(
                weo.target_amount,
                pweo.current_amount + ?
              )

          WHERE
            pweo.active_event_id = ?
            AND pweo.player_id = ?
            AND pweo.objective_id = ?

            AND awe.status = 'ACTIVE'
            AND awe.ends_at > NOW()

            AND pweo.completed_at IS NULL
            AND pweo.current_amount <
                weo.target_amount

            AND NOT EXISTS (
              SELECT 1
              FROM player_world_event_state pwes
              WHERE
                pwes.active_event_id =
                  pweo.active_event_id
                AND pwes.player_id =
                  pweo.player_id
                AND pwes.phase_id =
                  awe.phase_id
                AND (
                  pwes.chosen_outcome_id IS NOT NULL
                  OR pwes.committed_at IS NOT NULL
                )
            )
        `,
        [
          addedAmount,
          activeEventId,
          playerId,
          objectiveId
        ]
      );

    if (
      !Number(
        updateResult.affectedRows
      )
    ) {
      continue;
    }

    /*
     * Mark this player's track complete only after the authoritative
     * stored amount reaches the target.
     */
    await query(
      `
        UPDATE
          player_world_event_objectives pweo

        JOIN world_event_objectives weo
          ON weo.id =
             pweo.objective_id

        JOIN active_world_events awe
          ON awe.id =
             pweo.active_event_id

        SET
          pweo.completed_at =
            COALESCE(
              pweo.completed_at,
              NOW()
            )

        WHERE
          pweo.active_event_id = ?
          AND pweo.player_id = ?
          AND pweo.objective_id = ?

          AND awe.status = 'ACTIVE'
          AND awe.ends_at > NOW()

          AND pweo.completed_at IS NULL
          AND pweo.current_amount >=
              weo.target_amount
      `,
      [
        activeEventId,
        playerId,
        objectiveId
      ]
    );

    /*
     * Keep the existing contribution table as an analytics/reward ledger.
     * It no longer drives regional objective completion.
     */
    await query(
      `
        INSERT INTO
          player_world_event_contributions (
            active_event_id,
            player_id,
            objective_id,
            amount,
            last_contribution_at
          )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          NOW()
        )

        ON DUPLICATE KEY UPDATE
          amount =
            amount + VALUES(amount),

          last_contribution_at =
            NOW()
      `,
      [
        activeEventId,
        playerId,
        objectiveId,
        addedAmount
      ]
    );

    const after =
      await getPlayerObjective(
        activeEventId,
        playerId,
        objectiveId
      );

    if (!after) {
      continue;
    }

    const currentAmount =
      Number(
        after.current_amount || 0
      );

    const objectiveCompleted =
      after.completed_at != null ||
      currentAmount >= targetAmount;

    const objectiveJustCompleted =
      previousAmount < targetAmount &&
      objectiveCompleted;

    let committedNow = false;
    let committedOutcomeId:
      number | null = null;

    /*
     * A completed track commits the player to exactly one outcome.
     *
     * Phase 1 outcome objectives must map to an outcome through
     * world_event_outcome_requirements. If no mapping exists, the objective
     * can still complete, but it will not cast regional influence.
     *
     * This also leaves room for later phase/boss objectives that should not
     * behave like a Phase 1 vote.
     */
    if (
      objectiveJustCompleted &&
      outcomeId != null
    ) {
      const commitment =
        await commitPlayerOutcome(
          activeEventId,
          playerId,
          phaseId,
          outcomeId
        );

      committedNow =
        commitment.committedNow;

      committedOutcomeId =
        commitment.chosenOutcomeId;

      if (
        committedOutcomeId != null
      ) {
        resultCommitted = true;
        resultCommittedOutcomeId =
          committedOutcomeId;
      }
    }

    updates.push({
      activeEventId,

      eventId:
        Number(row.event_id),

      phaseId:
        Number(row.phase_id),

      regionId:
        Number(row.region_id),

      objectiveId,

      objectiveKey:
        String(
          row.objective_key
        ),

      objectiveType:
        String(
          row.objective_type
        ),

      targetId:
        row.target_id == null
          ? null
          : Number(
              row.target_id
            ),

      targetAmount,

      previousAmount,
      currentAmount,
      addedAmount,

      objectiveCompleted,
      objectiveJustCompleted,

      committed:
        committedNow,

      committedOutcomeId,

      influenceAdded:
        committedNow ? 1 : 0
    });

    /*
     * If this request completed a track and committed the player, do not
     * allow another matching objective in the same request to progress.
     */
    if (committedNow) {
      break;
    }
  }

  return {
    matched:
      updates.length > 0,

    activeEventId:
      updates.length
        ? updates[0].activeEventId
        : Number(
            matches[0]
              .active_event_id
          ),

    updates,

    committed:
      resultCommitted,

    committedOutcomeId:
      resultCommittedOutcomeId
  };
}

/* =========================================================
   GET PLAYER CONTRIBUTION / PERSONAL TRACKS
========================================================= */

export async function getPlayerWorldEventContribution(
  activeEventId: number,
  playerId: number
) {

  const stateRows: any[] =
    await query(
      `
        SELECT
          pwes.chosen_outcome_id,
          pwes.committed_at,
          weo.name AS chosen_outcome_name

        FROM player_world_event_state pwes

        JOIN active_world_events awe
          ON awe.id =
             pwes.active_event_id
         AND awe.phase_id =
             pwes.phase_id

        LEFT JOIN world_event_outcomes weo
          ON weo.id =
             pwes.chosen_outcome_id

        WHERE
          pwes.active_event_id = ?
          AND pwes.player_id = ?

        LIMIT 1
      `,
      [
        activeEventId,
        playerId
      ]
    );

  const objectiveRows: any[] =
    await query(
      `
        SELECT
          weo.id AS objective_id,
          weo.objective_key,
          weo.objective_type,
          weo.description,
          weo.target_amount,

          COALESCE(
            pweo.current_amount,
            0
          ) AS current_amount,

          pweo.completed_at,

          wor.outcome_id

        FROM active_world_events awe

        JOIN world_event_objectives weo
          ON weo.phase_id =
             awe.phase_id

        LEFT JOIN
          player_world_event_objectives pweo
          ON pweo.active_event_id =
             awe.id
         AND pweo.player_id = ?
         AND pweo.objective_id =
             weo.id

        LEFT JOIN
          world_event_outcome_requirements wor
          ON wor.objective_id =
             weo.id

        WHERE
          awe.id = ?

        ORDER BY
          weo.id ASC
      `,
      [
        playerId,
        activeEventId
      ]
    );

  const influenceRows: any[] =
    await query(
      `
        SELECT
          weo.id AS outcome_id,
          weo.name AS outcome_name,
          COALESCE(
            aweo.influence,
            0
          ) AS influence

        FROM active_world_events awe

        JOIN world_event_outcomes weo
          ON weo.phase_id =
            awe.phase_id

        LEFT JOIN
          active_world_event_outcomes aweo
          ON aweo.active_event_id =
             awe.id
         AND aweo.outcome_id =
             weo.id

        WHERE
          awe.id = ?

        ORDER BY
          weo.id ASC
      `,
      [
        activeEventId
      ]
    );

  const state =
    stateRows[0] || null;

  const chosenOutcomeId =
    state?.chosen_outcome_id == null
      ? null
      : Number(
          state.chosen_outcome_id
        );

  const objectives =
    objectiveRows.map(row => ({
      objectiveId:
        Number(
          row.objective_id
        ),

      objectiveKey:
        String(
          row.objective_key
        ),

      objectiveType:
        String(
          row.objective_type
        ),

      description:
        String(
          row.description
        ),

      targetAmount:
        Number(
          row.target_amount || 0
        ),

      currentAmount:
        Number(
          row.current_amount || 0
        ),

      completedAt:
        row.completed_at,

      outcomeId:
        row.outcome_id == null
          ? null
          : Number(
              row.outcome_id
            )
    }));

  const totalContribution =
    objectives.reduce(
      (
        total,
        objective
      ) =>
        total +
        objective.currentAmount,
      0
    );

  const influence =
    influenceRows.map(row => ({
      outcomeId:
        Number(
          row.outcome_id
        ),

      outcomeName:
        String(
          row.outcome_name
        ),

      influence:
        Number(
          row.influence || 0
        )
    }));

  return {
    activeEventId,
    playerId,

    committed:
      chosenOutcomeId != null,

    chosenOutcomeId,

    chosenOutcomeName:
      state?.chosen_outcome_name == null
        ? null
        : String(
            state.chosen_outcome_name
          ),

    committedAt:
      state?.committed_at ?? null,

    totalContribution,
    objectives,
    influence
  };
}
