// routes/interactables.routes.ts
import express from "express";
import { db } from "./db";

const router = express.Router();

function requireLogin(req: any, res: any, next: any) {
  if (!req.session?.playerId) {
    return res.status(401).json({ error: "Not logged in" });
  }
  next();
}

router.post("/world/interact/:id", requireLogin, async (req: any, res) => {
  const playerId = Number(req.session.playerId);
  const worldObjectId = Number(req.params.id);

  if (!Number.isFinite(worldObjectId)) {
    return res.status(400).json({ error: "invalid_world_object_id" });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    // 1) Load world object
    const [[worldObject]]: any = await conn.query(
      `
      SELECT
        id,
        name,
        x,
        y,
        interaction_radius,
        is_active,
        lore_title,
        lore_text
      FROM world_objects
      WHERE id = ?
        AND is_active = 1
      LIMIT 1
      `,
      [worldObjectId]
    );

    if (!worldObject) {
      await conn.rollback();
      return res.status(404).json({ error: "world_object_not_found" });
    }

    // 2) Check player range
    const [[player]]: any = await conn.query(
      `
      SELECT map_x, map_y
      FROM players
      WHERE id = ?
      LIMIT 1
      `,
      [playerId]
    );

    if (!player) {
      await conn.rollback();
      return res.status(404).json({ error: "player_not_found" });
    }

    const dx = Math.abs(Number(player.map_x) - Number(worldObject.x));
    const dy = Math.abs(Number(player.map_y) - Number(worldObject.y));
    const inRange = Math.max(dx, dy) <= Number(worldObject.interaction_radius || 1);

    if (!inRange) {
      await conn.rollback();
      return res.status(400).json({ error: "too_far_away" });
    }

    // 3) Find matching active INTERACT objective
    const [[objective]]: any = await conn.query(
      `
      SELECT
        pq.id AS playerQuestId,
        pq.quest_id AS questId,
        pq.status,

        pqo.id AS playerQuestObjectiveId,
        pqo.progress_count,
        pqo.is_complete AS objective_is_complete,

        qo.id AS questObjectiveId,
        qo.required_count,
        qo.step_order,
        qo.target_item_id,

        i.id AS reward_item_id,
        i.name AS reward_item_name
      FROM player_quests pq
      JOIN player_quest_objectives pqo
        ON pqo.player_quest_id = pq.id
      JOIN quest_objectives qo
        ON qo.id = pqo.quest_objective_id
      LEFT JOIN items i
        ON i.id = qo.target_item_id
      WHERE pq.player_id = ?
        AND pq.status = 'active'
        AND qo.type = 'INTERACT'
        AND qo.target_world_object_id = ?
        AND pqo.is_complete = 0
      ORDER BY pq.id ASC, qo.step_order ASC
      LIMIT 1
      `,
      [playerId, worldObjectId]
    );

    // 4) No active matching quest -> flavor text only
    if (!objective) {
      await conn.commit();
      return res.json({
        success: true,
        lore: {
          title: worldObject.lore_title || worldObject.name || "Discovery",
          text: worldObject.lore_text || "The ground looks odd here, but I can't quite explain it.",
        },
      });
    }

    // 5) Grant quest item
    if (objective.reward_item_id) {
      const [[existingStack]]: any = await conn.query(
        `
        SELECT id, qty
        FROM player_inventory
        WHERE player_id = ?
          AND item_id = ?
        LIMIT 1
        `,
        [playerId, objective.reward_item_id]
      );

      if (existingStack) {
        await conn.query(
          `
          UPDATE player_inventory
          SET qty = qty + 1
          WHERE id = ?
          `,
          [existingStack.id]
        );
      } else {
        await conn.query(
          `
          INSERT INTO player_inventory (player_id, item_id, qty)
          VALUES (?, ?, 1)
          `,
          [playerId, objective.reward_item_id]
        );
      }
    }

    // 6) Complete INTERACT objective
    const nextProgress = Math.min(
      Number(objective.progress_count || 0) + 1,
      Number(objective.required_count || 1)
    );

    const objectiveDone = nextProgress >= Number(objective.required_count || 1) ? 1 : 0;

    await conn.query(
      `
      UPDATE player_quest_objectives
      SET progress_count = ?, is_complete = ?
      WHERE id = ?
      `,
      [nextProgress, objectiveDone, objective.playerQuestObjectiveId]
    );

    // 7) Check whether all quest objectives are now complete
    const [[remaining]]: any = await conn.query(
      `
      SELECT COUNT(*) AS remaining
      FROM player_quest_objectives
      WHERE player_quest_id = ?
        AND is_complete = 0
      `,
      [objective.playerQuestId]
    );

    const questDone = Number(remaining?.remaining || 0) === 0;

    if (questDone) {
      await conn.query(
        `
        UPDATE player_quests
        SET status = 'completed',
            completed_at = NOW()
        WHERE id = ?
          AND status = 'active'
        `,
        [objective.playerQuestId]
      );
    }

    await conn.commit();

    return res.json({
      success: true,
      lore: {
        title: worldObject.lore_title || worldObject.name || "Discovery",
        text: objective.reward_item_name
          ? `You collect ${objective.reward_item_name}.`
          : "You investigate the area.",
      },
      itemGranted: Boolean(objective.reward_item_id),
      itemName: objective.reward_item_name || null,
      progress: nextProgress,
      required: Number(objective.required_count || 1),
      objectiveComplete: objectiveDone === 1,
      questComplete: questDone,
    });
  } catch (err) {
    await conn.rollback();
    console.error("world interact failed:", err);
    return res.status(500).json({ error: "server_error" });
  } finally {
    conn.release();
  }
});

export default router;