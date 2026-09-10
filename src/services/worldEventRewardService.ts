// services/worldEventRewardService.ts
import { db } from "../db";

async function query<T = any>(sql: string, params: any[] = []): Promise<T> {
  const [rows] = await db.query(sql, params);
  return rows as T;
}

export type WorldEventRewardSource = "PERSONAL" | "OUTCOME";

export type WorldEventRewardDefinition = {
  rewardType: string;
  rewardId: number | null;
  amount: number;
};

export type PlayerWorldEventRewardState = {
  activeEventId: number;
  outcomeId: number;
  outcomeName: string;
  rewardSource: WorldEventRewardSource;
  claimed: boolean;
  claimedAt: Date | string | null;
  rewards: WorldEventRewardDefinition[];
};

export type ClaimWorldEventRewardsResult = {
  claimed: boolean;
  activeEventId: number;
  outcomeId: number;
  rewardSource: WorldEventRewardSource;
  gold: number;
  exp: number;
};

async function validateOutcomeForActiveEvent(
  activeEventId: number,
  outcomeId: number
): Promise<void> {
  const rows: any[] = await query(
    `
      SELECT awe.id
      FROM active_world_events awe
      JOIN world_event_outcomes weo
        ON weo.id = ?
       AND weo.phase_id IN (
         SELECT id
         FROM world_event_phases
         WHERE event_id = awe.event_id
       )
      WHERE awe.id = ?
      LIMIT 1
    `,
    [outcomeId, activeEventId]
  );

  if (!rows.length) {
    throw new Error("World event reward outcome is invalid.");
  }
}

export async function createPersonalWorldEventRewardEligibility(
  activeEventId: number
): Promise<number> {
  const result: any = await query(
    `
      INSERT IGNORE INTO player_world_event_rewards (
        active_event_id,
        player_id,
        outcome_id,
        reward_source,
        claimed,
        claimed_at
      )
      SELECT
        pwes.active_event_id,
        pwes.player_id,
        pwes.chosen_outcome_id,
        'PERSONAL',
        0,
        NULL
      FROM player_world_event_state pwes
      JOIN active_world_events awe
        ON awe.id = pwes.active_event_id
      JOIN world_event_outcomes chosen
        ON chosen.id = pwes.chosen_outcome_id
       AND chosen.phase_id = awe.phase_id
      WHERE pwes.active_event_id = ?
        AND pwes.phase_id = awe.phase_id
        AND pwes.chosen_outcome_id IS NOT NULL
        AND pwes.committed_at IS NOT NULL
    `,
    [activeEventId]
  );

  return Number(result.affectedRows || 0);
}

export async function createOutcomeWorldEventRewardEligibility(
  activeEventId: number,
  winningOutcomeId: number
): Promise<number> {
  await validateOutcomeForActiveEvent(activeEventId, winningOutcomeId);

  const result: any = await query(
    `
      INSERT IGNORE INTO player_world_event_rewards (
        active_event_id,
        player_id,
        outcome_id,
        reward_source,
        claimed,
        claimed_at
      )
      SELECT
        pwes.active_event_id,
        pwes.player_id,
        ?,
        'OUTCOME',
        0,
        NULL
      FROM player_world_event_state pwes
      JOIN active_world_events awe
        ON awe.id = pwes.active_event_id
      JOIN world_event_outcomes chosen
        ON chosen.id = pwes.chosen_outcome_id
       AND chosen.phase_id = awe.phase_id
      WHERE pwes.active_event_id = ?
        AND pwes.phase_id = awe.phase_id
        AND pwes.chosen_outcome_id IS NOT NULL
        AND pwes.committed_at IS NOT NULL
    `,
    [winningOutcomeId, activeEventId]
  );

  return Number(result.affectedRows || 0);
}

export async function getWorldEventOutcomeRewards(
  outcomeId: number
): Promise<WorldEventRewardDefinition[]> {
  const rows: any[] = await query(
    `
      SELECT reward_type, reward_id, amount
      FROM world_event_rewards
      WHERE outcome_id = ?
      ORDER BY id ASC
    `,
    [outcomeId]
  );

  return rows.map(row => ({
    rewardType: String(row.reward_type).toUpperCase(),
    rewardId: row.reward_id == null ? null : Number(row.reward_id),
    amount: Number(row.amount || 0),
  }));
}

export async function getPlayerWorldEventRewards(
  activeEventId: number,
  playerId: number
): Promise<PlayerWorldEventRewardState[]> {
  const rows: any[] = await query(
    `
      SELECT
        pwer.active_event_id,
        pwer.outcome_id,
        pwer.reward_source,
        pwer.claimed,
        pwer.claimed_at,
        weo.name AS outcome_name
      FROM player_world_event_rewards pwer
      JOIN world_event_outcomes weo
        ON weo.id = pwer.outcome_id
      WHERE pwer.active_event_id = ?
        AND pwer.player_id = ?
      ORDER BY
        CASE WHEN pwer.reward_source = 'PERSONAL' THEN 0 ELSE 1 END,
        pwer.id ASC
    `,
    [activeEventId, playerId]
  );

  const rewards: PlayerWorldEventRewardState[] = [];

  for (const row of rows) {
    const outcomeId = Number(row.outcome_id);

    rewards.push({
      activeEventId: Number(row.active_event_id),
      outcomeId,
      outcomeName: String(row.outcome_name),
      rewardSource: String(row.reward_source).toUpperCase() as WorldEventRewardSource,
      claimed: Number(row.claimed) === 1,
      claimedAt: row.claimed_at ?? null,
      rewards: await getWorldEventOutcomeRewards(outcomeId),
    });
  }

  return rewards;
}

export async function claimWorldEventReward(
  activeEventId: number,
  playerId: number,
  outcomeId: number,
  rewardSource: WorldEventRewardSource
): Promise<ClaimWorldEventRewardsResult> {
  const normalized = String(rewardSource).toUpperCase();

  if (normalized !== "PERSONAL" && normalized !== "OUTCOME") {
    throw new Error("Invalid world event reward source.");
  }

  const source = normalized as WorldEventRewardSource;

  const eligibilityRows: any[] = await query(
    `
      SELECT id, claimed
      FROM player_world_event_rewards
      WHERE active_event_id = ?
        AND player_id = ?
        AND outcome_id = ?
        AND reward_source = ?
      LIMIT 1
    `,
    [activeEventId, playerId, outcomeId, source]
  );

  if (!eligibilityRows.length) {
    throw new Error("You are not eligible for that world event reward.");
  }

  if (Number(eligibilityRows[0].claimed) === 1) {
    throw new Error("That world event reward has already been claimed.");
  }

  const rewardRows = await getWorldEventOutcomeRewards(outcomeId);

  if (!rewardRows.length) {
    throw new Error("That world event outcome has no rewards.");
  }

  const unsupported = rewardRows.filter(
    reward => reward.rewardType !== "GOLD" && reward.rewardType !== "EXP"
  );

  if (unsupported.length) {
    throw new Error(
      `Unsupported world event reward type: ${unsupported[0].rewardType}`
    );
  }

  const gold = rewardRows
    .filter(reward => reward.rewardType === "GOLD")
    .reduce((total, reward) => total + reward.amount, 0);

  const exp = rewardRows
    .filter(reward => reward.rewardType === "EXP")
    .reduce((total, reward) => total + reward.amount, 0);

  const result: any = await query(
    `
      UPDATE players p
      JOIN player_world_event_rewards pwer
        ON pwer.player_id = p.id
      SET
        p.gold = p.gold + ?,
        p.exper = p.exper + ?,
        pwer.claimed = 1,
        pwer.claimed_at = NOW()
      WHERE p.id = ?
        AND pwer.active_event_id = ?
        AND pwer.outcome_id = ?
        AND pwer.reward_source = ?
        AND pwer.claimed = 0
    `,
    [gold, exp, playerId, activeEventId, outcomeId, source]
  );

  if (!Number(result.affectedRows)) {
    throw new Error("That world event reward could not be claimed.");
  }

  return {
    claimed: true,
    activeEventId,
    outcomeId,
    rewardSource: source,
    gold,
    exp,
  };
}

export async function prepareWorldEventOutcomeRewards(
  activeEventId: number,
  winningOutcomeId: number
) {
  await validateOutcomeForActiveEvent(activeEventId, winningOutcomeId);

  // Must happen BEFORE advancing the phase, because eligibility is scoped
  // to the phase that just resolved.
  const personalEligiblePlayers =
    await createPersonalWorldEventRewardEligibility(activeEventId);

  const outcomeEligiblePlayers =
    await createOutcomeWorldEventRewardEligibility(
      activeEventId,
      winningOutcomeId
    );

  const outcomeRewards =
    await getWorldEventOutcomeRewards(winningOutcomeId);

  return {
    activeEventId,
    winningOutcomeId,
    personalEligiblePlayers,
    outcomeEligiblePlayers,
    outcomeRewards,
  };
}
