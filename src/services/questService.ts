// services/questService.ts
import { db } from "../db";
import { grantExperienceTx } from "./experienceService";

export type QuestLogRow = {
  playerQuestId: number;
  status: string;
  accepted_at: string;
  completed_at: string | null;
  claimed_at: string | null;

  questId: number;
  type: "quest" | "bounty";
  title: string;
  description: string | null;
  dialog_intro: string | null;
  dialog_complete: string | null;

  objectiveId: number;
  objectiveType: "KILL" | "TURN_IN" | "INTERACT" | "LOCATION" | "ENTER_AREA";
  required_count: number;
  target_item_id: number | null;
  target_item_name: string | null;
  target_item_icon: string | null;
  target_creature_id: number | null;
  target_creature_name: string | null;
  target_creature_icon: string | null;
  target_world_object_id: number | null;
  region_name: string | null;

  progress_count: number;
  is_complete: number;

  reward_gold: number;
  reward_xp: number;

  turn_in_location_id: number | null;
  turn_in_location_name: string | null;
};

export type RumorQuestRow = {
  questId: number;
  type: "quest" | "bounty";
  title: string;
  description: string | null;
  town_id: number | null;
  town_name: string | null;
  rumor_hint: string | null;
  min_level: number;
  expires_at: string | null;
  is_repeatable: number;
  turn_in_location_id: number | null;
  turn_in_location_name: string | null;
  is_locked: number;
};

export async function getJournalQuests(pid: number) {
  const accepted = await getQuestLog(pid);

  const active = accepted.filter(r => r.status === "active");
  const completed = accepted.filter(r => r.status === "completed");
  const claimed = accepted.filter(r => r.status === "claimed");

  const [[p]]: any = await db.query(`SELECT level FROM players WHERE id=? LIMIT 1`, [pid]);
  const playerLevel = Number(p?.level || 1);

  const [rumors]: any = await db.query(
    `
    SELECT
      q.id AS questId,
      q.type,
      q.title,
      q.description,
      q.town_id,
      t.name AS town_name,
      q.rumor_hint,
      q.min_level,
      q.expires_at,
      q.is_repeatable,
      q.turn_in_location_id,
      til.name AS turn_in_location_name
    FROM quests q
    LEFT JOIN player_quests pq
      ON pq.quest_id = q.id
     AND pq.player_id = ?
     AND pq.status IN ('active','completed','claimed','abandoned','expired')
    LEFT JOIN locations t
      ON t.id = q.town_id
    LEFT JOIN locations til
      ON til.id = q.turn_in_location_id
    WHERE pq.id IS NULL
      AND q.is_active = 1
    ORDER BY q.min_level ASC, q.id ASC
    `,
    [pid]
  );

  const rumorsWithLock = (rumors || []).map((r: any) => ({
    ...r,
    is_locked: playerLevel < Number(r.min_level || 1) ? 1 : 0,
  })) as (RumorQuestRow & { is_locked: number })[];

  return { active, completed, claimed, rumors: rumorsWithLock };
}

export async function acceptQuest(
  pid: number,
  questId: number,
  source: "tavern" | "bounty_board" = "tavern"
) {
  const [[q]]: any = await db.query(
    `SELECT id, type, is_active, expires_at FROM quests WHERE id=? AND is_active=1 LIMIT 1`,
    [questId]
  );
  if (!q) throw new Error("QUEST_NOT_FOUND");

  if (q.type === "bounty" && q.expires_at && new Date(q.expires_at).getTime() <= Date.now()) {
    throw new Error("BOUNTY_EXPIRED");
  }

  const [ins]: any = await db.query(
    `INSERT INTO player_quests (player_id, quest_id, expires_at, source)
     VALUES (?, ?, ?, ?)`,
    [pid, questId, q.expires_at ?? null, source]
  );

  const playerQuestId = Number(ins.insertId);

  const [objs]: any = await db.query(
    `SELECT id FROM quest_objectives WHERE quest_id=?`,
    [questId]
  );

  for (const o of objs || []) {
    await db.query(
      `INSERT INTO player_quest_objectives (player_quest_id, objective_id, progress_count, is_complete)
       VALUES (?, ?, 0, 0)`,
      [playerQuestId, o.id]
    );
  }

  return { playerQuestId };
}

export async function getQuestLog(pid: number) {
  await db.query(
    `UPDATE player_quests
     SET status='expired'
     WHERE player_id=?
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()
       AND status IN ('active','completed')`,
    [pid]
  );

  const [rows]: any = await db.query(
    `
    SELECT
      pq.id AS playerQuestId,
      pq.status,
      pq.accepted_at,
      pq.completed_at,
      pq.claimed_at,

      q.id AS questId,
      q.type,
      q.title,
      q.description,
      q.dialog_intro,
      q.dialog_complete,
      q.turn_in_location_id,

      til.name AS turn_in_location_name,

      o.id AS objectiveId,
      o.type AS objectiveType,
      o.required_count,
      o.target_item_id,
      o.target_creature_id,
      o.region_name,
      o.target_world_object_id,

      pqo.progress_count,
      pqo.is_complete,

      i.name AS target_item_name,
      i.icon AS target_item_icon,

      c.name AS target_creature_name,
      c.creatureimage AS target_creature_icon,

      COALESCE(r.gold, 0) AS reward_gold,
      COALESCE(r.xp, 0) AS reward_xp

    FROM player_quests pq
    JOIN quests q ON q.id = pq.quest_id
    LEFT JOIN locations til ON til.id = q.turn_in_location_id
    JOIN player_quest_objectives pqo ON pqo.player_quest_id = pq.id
    JOIN quest_objectives o ON o.id = pqo.objective_id
    LEFT JOIN items i ON i.id = o.target_item_id
    LEFT JOIN creatures c ON c.id = o.target_creature_id
    LEFT JOIN quest_rewards r ON r.quest_id = q.id
    WHERE pq.player_id=?
    ORDER BY
      FIELD(pq.status,'active','completed','claimed','abandoned','expired') ASC,
      pq.accepted_at DESC,
      pq.id DESC,
      o.id ASC
    `,
    [pid]
  );

  return (rows || []) as QuestLogRow[];
}

/**
 * TURN_IN all-at-once:
 * - Player must have ALL required items available (unequipped) before we remove any
 * - Removes exactly required_count
 * - Marks objective complete and quest complete
 */
export async function turnInAllAtOnce(pid: number, playerQuestId: number) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[pq]]: any = await conn.query(
      `SELECT id, status, quest_id, expires_at
       FROM player_quests
       WHERE id=? AND player_id=?
       LIMIT 1
       FOR UPDATE`,
      [playerQuestId, pid]
    );
    if (!pq) throw new Error("PLAYER_QUEST_NOT_FOUND");
    if (pq.status !== "active") throw new Error("QUEST_NOT_ACTIVE");
    if (pq.expires_at && new Date(pq.expires_at).getTime() <= Date.now()) {
      throw new Error("QUEST_EXPIRED");
    }

    const [[obj]]: any = await conn.query(
      `
      SELECT
        pqo.id AS pqoId,
        pqo.progress_count,
        pqo.is_complete,
        o.required_count,
        o.target_item_id
      FROM player_quest_objectives pqo
      JOIN quest_objectives o ON o.id = pqo.objective_id
      WHERE pqo.player_quest_id=?
        AND o.type='TURN_IN'
      LIMIT 1
      FOR UPDATE
      `,
      [playerQuestId]
    );
    if (!obj) throw new Error("NO_TURNIN_OBJECTIVE");
    if (Number(obj.is_complete) === 1) throw new Error("ALREADY_COMPLETE");

    const itemId = Number(obj.target_item_id);
    const required = Math.max(1, Number(obj.required_count) || 1);

    const [invRows]: any = await conn.query(
      `
      SELECT inventory_id, quantity
      FROM inventory
      WHERE player_id=?
        AND item_id=?
        AND equipped=0
      ORDER BY inventory_id ASC
      FOR UPDATE
      `,
      [pid, itemId]
    );

    let available = 0;
    for (const r of invRows || []) {
      available += Math.max(0, Number(r.quantity) || 0);
    }

    if (available < required) throw new Error("NOT_ENOUGH_ITEMS");

    let remaining = required;
    for (const r of invRows || []) {
      if (remaining <= 0) break;

      const rowQty = Math.max(0, Number(r.quantity) || 0);
      if (rowQty <= 0) continue;

      const take = Math.min(rowQty, remaining);
      const newQty = rowQty - take;

      if (newQty > 0) {
        await conn.query(
          `UPDATE inventory SET quantity=? WHERE inventory_id=? AND player_id=?`,
          [newQty, r.inventory_id, pid]
        );
      } else {
        await conn.query(
          `DELETE FROM inventory WHERE inventory_id=? AND player_id=?`,
          [r.inventory_id, pid]
        );
      }

      remaining -= take;
    }

    await conn.query(
      `
      UPDATE player_quest_objectives
      SET progress_count = ?, is_complete = 1
      WHERE id = ?
      `,
      [required, obj.pqoId]
    );

    const completedNow = await finalizeQuestIfAllObjectivesComplete(conn, pid, playerQuestId);

    let gold = 0;
    let xp = 0;
    let claimed = false;
    let levelUp = null;

    if (completedNow) {
      const [[rew]]: any = await conn.query(
        `SELECT COALESCE(gold,0) AS gold, COALESCE(xp,0) AS xp
         FROM quest_rewards
         WHERE quest_id=? LIMIT 1`,
        [pq.quest_id]
      );

      gold = Math.max(0, Number(rew?.gold) || 0);
      xp = Math.max(0, Number(rew?.xp) || 0);

      if (gold > 0) {
        await conn.query(
          `UPDATE players
           SET gold = gold + ?
           WHERE id = ?`,
          [gold, pid]
        );
      }

      if (xp > 0) {
        const xpResult = await grantExperienceTx(conn, pid, xp);
        levelUp = xpResult.levelUp;
      }

      await conn.query(
        `UPDATE player_quests
         SET status='claimed', claimed_at=NOW()
         WHERE id=? AND player_id=? AND status='completed'`,
        [playerQuestId, pid]
      );

      claimed = true;
    }

    await conn.commit();

    return {
      success: true,
      removed: required,
      goldGained: gold,
      expGained: xp,
      claimed,
      levelUp
    };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}

export async function claimQuestRewards(pid: number, playerQuestId: number) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[pq]]: any = await conn.query(
      `SELECT id, status, quest_id
       FROM player_quests
       WHERE id=? AND player_id=?
       LIMIT 1
       FOR UPDATE`,
      [playerQuestId, pid]
    );

    if (!pq) throw new Error("PLAYER_QUEST_NOT_FOUND");

    const status = String(pq.status || "");
    if (status === "claimed") throw new Error("ALREADY_CLAIMED");
    if (status !== "completed") throw new Error("QUEST_NOT_COMPLETED");

    const [[rew]]: any = await conn.query(
      `SELECT COALESCE(gold,0) AS gold, COALESCE(xp,0) AS xp
       FROM quest_rewards
       WHERE quest_id=? LIMIT 1`,
      [pq.quest_id]
    );

    const gold = Math.max(0, Number(rew?.gold) || 0);
    const xp = Math.max(0, Number(rew?.xp) || 0);

    let levelUp = null;

    if (gold > 0) {
      await conn.query(
        `UPDATE players
         SET gold = gold + ?
         WHERE id = ?`,
        [gold, pid]
      );
    }

    if (xp > 0) {
      const xpResult = await grantExperienceTx(conn, pid, xp);
      levelUp = xpResult.levelUp;
    }

    await conn.query(
      `UPDATE player_quests
       SET status='claimed', claimed_at=NOW()
       WHERE id=? AND player_id=? AND status='completed'`,
      [playerQuestId, pid]
    );

    await conn.commit();
    return {
      success: true,
      goldGained: gold,
      expGained: xp,
      levelUp
    };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}

export async function syncTurnInObjectivesFromInventory(pid: number) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows]: any = await conn.query(
      `
      SELECT
        pq.id AS playerQuestId,
        pqo.id AS pqoId,
        pqo.is_complete,
        o.required_count,
        o.target_item_id,
        COALESCE((
          SELECT SUM(inv.quantity)
          FROM inventory inv
          WHERE inv.player_id = pq.player_id
            AND inv.item_id = o.target_item_id
            AND inv.equipped = 0
        ), 0) AS have_qty
      FROM player_quests pq
      JOIN player_quest_objectives pqo ON pqo.player_quest_id = pq.id
      JOIN quest_objectives o ON o.id = pqo.objective_id
      WHERE pq.player_id = ?
        AND pq.status = 'active'
        AND o.type = 'TURN_IN'
      FOR UPDATE
      `,
      [pid]
    );

    for (const r of rows || []) {
      const required = Math.max(1, Number(r.required_count) || 1);
      const have = Math.max(0, Number(r.have_qty) || 0);
      const next = Math.min(required, have);

      // IMPORTANT:
      // For TURN_IN objectives, inventory sync should reflect progress,
      // but should NOT mark the objective complete.
      // Completion only happens when the items are actually removed.
      await conn.query(
        `
        UPDATE player_quest_objectives
        SET progress_count = ?
        WHERE id = ?
        `,
        [next, Number(r.pqoId)]
      );
    }

    await conn.commit();
    return { success: true, updated: (rows || []).length };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}

async function finalizeQuestIfAllObjectivesComplete(
  conn: any,
  pid: number,
  playerQuestId: number
): Promise<boolean> {
  const [[agg]]: any = await conn.query(
    `
    SELECT COUNT(*) AS total, SUM(is_complete) AS done
    FROM player_quest_objectives
    WHERE player_quest_id = ?
    FOR UPDATE
    `,
    [playerQuestId]
  );

  const total = Number(agg?.total) || 0;
  const done = Number(agg?.done) || 0;

  if (total > 0 && done >= total) {
    const [u]: any = await conn.query(
      `
      UPDATE player_quests
      SET status='completed', completed_at=NOW()
      WHERE id=? AND player_id=? AND status='active'
      `,
      [playerQuestId, pid]
    );
    return !!u?.affectedRows;
  }

  return false;
}

export async function applyInteractProgress(
  pid: number,
  worldObjectId: number
): Promise<{
  success: boolean;
  updatedObjectives: Array<{
    playerQuestId: number;
    objectiveId: number;
    title: string;
    progress_count: number;
    required_count: number;
  }>;
  completedPlayerQuestIds: number[];
  lore: null | {
    title: string;
    text: string;
  };
}> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[player]]: any = await conn.query(
      `
      SELECT id, map_x, map_y
      FROM players
      WHERE id=?
      LIMIT 1
      FOR UPDATE
      `,
      [pid]
    );
    if (!player) throw new Error("PLAYER_NOT_FOUND");

    const [[obj]]: any = await conn.query(
      `
      SELECT
        id,
        name,
        object_type,
        region_name,
        x,
        y,
        interaction_radius,
        is_active,
        lore_title,
        lore_text
      FROM world_objects
      WHERE id=?
      LIMIT 1
      FOR UPDATE
      `,
      [worldObjectId]
    );

    if (!obj || Number(obj.is_active) !== 1) {
      throw new Error("WORLD_OBJECT_NOT_FOUND");
    }

    const px = Number(player.map_x);
    const py = Number(player.map_y);
    const ox = Number(obj.x);
    const oy = Number(obj.y);
    const radius = Math.max(0, Number(obj.interaction_radius) || 1);

    const dist = Math.abs(px - ox) + Math.abs(py - oy);
    if (dist > radius) {
      throw new Error("TOO_FAR_AWAY");
    }

    const [rows]: any = await conn.query(
      `
      SELECT
        pqo.id AS pqoId,
        pqo.player_quest_id AS playerQuestId,
        pqo.progress_count,
        pqo.is_complete,

        o.id AS objectiveId,
        o.required_count,
        o.target_item_id,

        q.title AS questTitle,

        i.name AS target_item_name
      FROM player_quest_objectives pqo
      JOIN quest_objectives o ON o.id = pqo.objective_id
      JOIN player_quests pq ON pq.id = pqo.player_quest_id
      JOIN quests q ON q.id = pq.quest_id
      LEFT JOIN items i ON i.id = o.target_item_id
      WHERE pq.player_id = ?
        AND pq.status = 'active'
        AND o.type = 'INTERACT'
        AND o.target_world_object_id = ?
      FOR UPDATE
      `,
      [pid, worldObjectId]
    );

    const updatedObjectives: Array<{
      playerQuestId: number;
      objectiveId: number;
      title: string;
      progress_count: number;
      required_count: number;
    }> = [];

    const touchedQuestIds = new Set<number>();

    let grantedItemName: string | null = null;
    let hadMatchingObjective = false;
    let hadIncompleteObjective = false;

    for (const r of rows || []) {
      hadMatchingObjective = true;

      if (Number(r.is_complete) === 1) continue;
      hadIncompleteObjective = true;

      const required = Math.max(1, Number(r.required_count) || 1);
      const next = Math.min(required, Number(r.progress_count || 0) + 1);
      const nowComplete = next >= required ? 1 : 0;

      const targetItemId = Number(r.target_item_id || 0);
      if (targetItemId > 0) {
        const [[existingStack]]: any = await conn.query(
          `
          SELECT inventory_id, quantity
          FROM inventory
          WHERE player_id = ?
            AND item_id = ?
            AND equipped = 0
          LIMIT 1
          FOR UPDATE
          `,
          [pid, targetItemId]
        );

        if (existingStack) {
          await conn.query(
            `
            UPDATE inventory
            SET quantity = quantity + 1
            WHERE inventory_id = ?
            `,
            [existingStack.inventory_id]
          );
        } else {
          await conn.query(
            `
            INSERT INTO inventory (player_id, item_id, quantity, equipped)
            VALUES (?, ?, 1, 0)
            `,
            [pid, targetItemId]
          );
        }

        grantedItemName = String(r.target_item_name || "the item");
      }

      await conn.query(
        `
        UPDATE player_quest_objectives
        SET progress_count = ?, is_complete = ?
        WHERE id = ?
        `,
        [next, nowComplete, Number(r.pqoId)]
      );

      updatedObjectives.push({
        playerQuestId: Number(r.playerQuestId),
        objectiveId: Number(r.objectiveId),
        title: String(r.questTitle || "Quest"),
        progress_count: next,
        required_count: required
      });

      touchedQuestIds.add(Number(r.playerQuestId));
    }

    const completedPlayerQuestIds: number[] = [];

    for (const pqId of touchedQuestIds) {
      const completedNow = await finalizeQuestIfAllObjectivesComplete(conn, pid, pqId);
      if (completedNow) completedPlayerQuestIds.push(pqId);
    }

    await conn.commit();

    let loreText = String(obj.lore_text || "");

    if (hadIncompleteObjective) {
      loreText = grantedItemName
        ? `You collect ${grantedItemName}.`
        : "You investigate the area.";
    } else if (hadMatchingObjective) {
      loreText = "You have already collected enough here.";
    } else if (!loreText) {
      loreText = "The ground looks odd here, but I can't quite explain it.";
    }

    return {
      success: true,
      updatedObjectives,
      completedPlayerQuestIds,
      lore: {
        title: String(obj.lore_title || obj.name || "Discovery"),
        text: loreText
      }
    };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}

export async function applyEnterAreaProgress(
  pid: number,
  regionId: number | null
): Promise<{
  updatedObjectives: Array<{
    playerQuestId: number;
    objectiveId: number;
    title: string;
    progress_count: number;
    required_count: number;
  }>;
  completedPlayerQuestIds: number[];
}> {
  const normalizedRegionId = Number(regionId || 0);
  if (!normalizedRegionId) {
    return { updatedObjectives: [], completedPlayerQuestIds: [] };
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows]: any = await conn.query(
      `
      SELECT
        pqo.id AS pqoId,
        pqo.player_quest_id AS playerQuestId,
        pqo.progress_count,
        pqo.is_complete,
        o.id AS objectiveId,
        o.required_count,
        o.region_name,
        q.title AS questTitle
      FROM player_quest_objectives pqo
      JOIN quest_objectives o ON o.id = pqo.objective_id
      JOIN player_quests pq ON pq.id = pqo.player_quest_id
      JOIN quests q ON q.id = pq.quest_id
      JOIN regions r ON r.id = ?
      WHERE pq.player_id = ?
        AND pq.status = 'active'
        AND o.type = 'ENTER_AREA'
        AND TRIM(COALESCE(o.region_name, '')) = TRIM(COALESCE(r.name, ''))
      FOR UPDATE
      `,
      [normalizedRegionId, pid]
    );

    if (!rows || rows.length === 0) {
      await conn.commit();
      return { updatedObjectives: [], completedPlayerQuestIds: [] };
    }

    const updatedObjectives: Array<{
      playerQuestId: number;
      objectiveId: number;
      title: string;
      progress_count: number;
      required_count: number;
    }> = [];

    const touchedQuestIds = new Set<number>();

    for (const r of rows) {
      if (Number(r.is_complete) === 1) continue;

      const pqoId = Number(r.pqoId);
      const playerQuestId = Number(r.playerQuestId);
      const objectiveId = Number(r.objectiveId);
      const required = Math.max(1, Number(r.required_count) || 1);
      const current = Math.max(0, Number(r.progress_count) || 0);

      const next = Math.min(required, current + 1);
      const nowComplete = next >= required ? 1 : 0;

      await conn.query(
        `
        UPDATE player_quest_objectives
        SET progress_count = ?, is_complete = ?
        WHERE id = ?
        `,
        [next, nowComplete, pqoId]
      );

      updatedObjectives.push({
        playerQuestId,
        objectiveId,
        title: String(r.questTitle || "Quest"),
        progress_count: next,
        required_count: required
      });

      touchedQuestIds.add(playerQuestId);
    }

    const completedPlayerQuestIds: number[] = [];

    for (const pqId of touchedQuestIds) {
      const completedNow = await finalizeQuestIfAllObjectivesComplete(conn, pid, pqId);
      if (completedNow) completedPlayerQuestIds.push(Number(pqId));
    }

    await conn.commit();
    return { updatedObjectives, completedPlayerQuestIds };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}

export async function applyKillProgress(
  pid: number,
  creatureId: number,
  regionName: string | null,
  amount = 1
): Promise<{
  updatedObjectives: Array<{
    playerQuestId: number;
    objectiveId: number;
    title: string;
    progress_count: number;
    required_count: number;
  }>;
  completedPlayerQuestIds: number[];
}> {
  amount = Math.max(1, Math.floor(amount));
  creatureId = Number(creatureId);
  regionName = regionName ? String(regionName).trim() : null;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows]: any = await conn.query(
      `
      SELECT
        pqo.id AS pqoId,
        pqo.player_quest_id AS playerQuestId,
        pqo.progress_count,
        pqo.is_complete,
        o.id AS objectiveId,
        o.required_count,
        o.target_creature_id,
        o.region_name,
        q.title AS questTitle
      FROM player_quest_objectives pqo
      JOIN quest_objectives o ON o.id = pqo.objective_id
      JOIN player_quests pq ON pq.id = pqo.player_quest_id
      JOIN quests q ON q.id = pq.quest_id
      WHERE pq.player_id = ?
        AND pq.status = 'active'
        AND o.type = 'KILL'
        AND (
          (o.target_creature_id IS NOT NULL AND o.region_name IS NULL AND o.target_creature_id = ?)
          OR
          (o.target_creature_id IS NULL AND o.region_name IS NOT NULL AND TRIM(o.region_name) = TRIM(?))
          OR
          (o.target_creature_id = ? AND o.region_name IS NOT NULL AND TRIM(o.region_name) = TRIM(?))
        )
      FOR UPDATE
      `,
      [pid, creatureId, regionName, creatureId, regionName]
    );

    if (!rows || rows.length === 0) {
      await conn.commit();
      return { updatedObjectives: [], completedPlayerQuestIds: [] };
    }

    const updatedObjectives: Array<{
      playerQuestId: number;
      objectiveId: number;
      title: string;
      progress_count: number;
      required_count: number;
    }> = [];

    const touchedQuestIds = new Set<number>();

    for (const r of rows) {
      const pqoId = Number(r.pqoId);
      const playerQuestId = Number(r.playerQuestId);
      const objectiveId = Number(r.objectiveId);
      const required = Math.max(1, Number(r.required_count) || 1);
      const current = Math.max(0, Number(r.progress_count) || 0);

      if (Number(r.is_complete) === 1) continue;

      const next = Math.min(required, current + amount);
      const nowComplete = next >= required ? 1 : 0;

      await conn.query(
        `
        UPDATE player_quest_objectives
        SET progress_count = ?, is_complete = ?
        WHERE id = ?
        `,
        [next, nowComplete, pqoId]
      );

      updatedObjectives.push({
        playerQuestId,
        objectiveId,
        title: String(r.questTitle || "Quest"),
        progress_count: next,
        required_count: required
      });

      touchedQuestIds.add(playerQuestId);
    }

    const completedPlayerQuestIds: number[] = [];

    for (const pqId of touchedQuestIds) {
      const completedNow = await finalizeQuestIfAllObjectivesComplete(conn, pid, pqId);
      if (completedNow) completedPlayerQuestIds.push(Number(pqId));
    }

    await conn.commit();
    return { updatedObjectives, completedPlayerQuestIds };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}