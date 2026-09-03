// services/questService.ts
import { db } from "../db";
import { grantExperienceTx } from "./experienceService";

export type QuestObjectiveType =
  | "KILL"
  | "TURN_IN"
  | "INTERACT"
  | "LOCATION"
  | "ENTER_AREA"
  | "DESTROY_OBJECT"
  | "COLLECT"
  | "TALK_TO"
  | "USE_ITEM"
  | "CRAFT"
  | "GATHER"
  | "COMPLETE_ACTIVITY"
  | "EVENT"
  | "REACH_LOCATION";

export type QuestEvent =
  | { type: "CREATURE_KILLED"; creatureId: number; regionName?: string | null; amount?: number }
  | { type: "WORLD_OBJECT_INTERACTED"; worldObjectId: number; objectDefId?: number | null; regionName?: string | null; amount?: number }
  | { type: "WORLD_OBJECT_DESTROYED"; worldObjectId?: number | null; objectDefId?: number | null; regionName?: string | null; amount?: number }
  | { type: "REGION_ENTERED"; regionId?: number | null; regionName: string; amount?: number }
  | { type: "LOCATION_REACHED"; x: number; y: number; regionName?: string | null; locationKey?: string | null; amount?: number }
  | { type: "ITEM_COLLECTED"; itemId: number; amount?: number; source?: string | null }
  | { type: "ITEM_USED"; itemId: number; amount?: number }
  | { type: "ITEM_CRAFTED"; itemId: number; amount?: number; professionId?: number | null }
  | { type: "RESOURCE_GATHERED"; itemId?: number | null; nodeId?: number | null; professionId?: number | null; amount?: number }
  | { type: "NPC_TALKED_TO"; npcId: number; worldObjectId?: number | null; amount?: number }
  | { type: "ACTIVITY_COMPLETED"; activityType: string; activityId?: number | null; regionName?: string | null; success?: boolean; amount?: number }
  | { type: "QUEST_EVENT"; eventKey: string; state?: string | null; amount?: number };

export type QuestProgressUpdate = {
  playerQuestId: number;
  objectiveId: number;
  title: string;
  objectiveText: string | null;
  stepOrder: number;
  progress_count: number;
  required_count: number;
  is_complete: number;
};

export type QuestProgressResult = {
  updatedObjectives: QuestProgressUpdate[];
  completedPlayerQuestIds: number[];
  stageTransitions: Array<{
    playerQuestId: number;
    fromStep: number | null;
    toStep: number | null;
  }>;
};

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
  objectiveType: QuestObjectiveType;
  objective_text: string | null;
  step_order: number;
  is_optional: number;
  is_hidden: number;
  params_json: any;
  isActiveStep: number;
  required_count: number;
  target_item_id: number | null;
  target_item_name: string | null;
  target_item_icon: string | null;
  target_creature_id: number | null;
  target_creature_name: string | null;
  target_creature_icon: string | null;
  target_world_object_id: number | null;
  target_object_def_id: number | null;
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

function parseParams(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

function sameText(a: any, b: any) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

function positiveAmount(value: any, fallback = 1) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function getCurrentRequiredStep(conn: any, playerQuestId: number): Promise<number | null> {
  const [[row]]: any = await conn.query(
    `
      SELECT MIN(o.step_order) AS current_step
      FROM player_quest_objectives pqo
      JOIN quest_objectives o ON o.id = pqo.objective_id
      WHERE pqo.player_quest_id = ?
        AND pqo.is_complete = 0
        AND COALESCE(o.is_optional, 0) = 0
    `,
    [playerQuestId]
  );
  const n = Number(row?.current_step);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function grantInventoryItemTx(conn: any, pid: number, itemId: number, qty: number) {
  qty = positiveAmount(qty);
  const [[existing]]: any = await conn.query(
    `SELECT inventory_id FROM inventory WHERE player_id=? AND item_id=? AND equipped=0 LIMIT 1 FOR UPDATE`,
    [pid, itemId]
  );
  if (existing) {
    await conn.query(`UPDATE inventory SET quantity = quantity + ? WHERE inventory_id=?`, [qty, existing.inventory_id]);
  } else {
    await conn.query(
      `INSERT INTO inventory (player_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0)`,
      [pid, itemId, qty]
    );
  }
}

function objectiveMatchesEvent(o: any, event: QuestEvent): boolean {
  const type = String(o.objectiveType || o.type || "") as QuestObjectiveType;
  const params = parseParams(o.params_json);

  switch (type) {
    case "KILL":
      if (event.type !== "CREATURE_KILLED") return false;
      if (o.target_creature_id != null && Number(o.target_creature_id) !== Number(event.creatureId)) return false;
      if (o.region_name && !sameText(o.region_name, event.regionName)) return false;
      return o.target_creature_id != null || !!o.region_name;

    case "INTERACT":
      if (event.type !== "WORLD_OBJECT_INTERACTED") return false;
      if (o.target_world_object_id != null && Number(o.target_world_object_id) !== Number(event.worldObjectId)) return false;
      if (o.target_object_def_id != null && Number(o.target_object_def_id) !== Number(event.objectDefId)) return false;
      if (o.region_name && !sameText(o.region_name, event.regionName)) return false;
      return o.target_world_object_id != null || o.target_object_def_id != null || !!o.region_name || !!params.eventKey;

    case "DESTROY_OBJECT":
      if (event.type !== "WORLD_OBJECT_DESTROYED") return false;
      if (o.target_world_object_id != null && Number(o.target_world_object_id) !== Number(event.worldObjectId)) return false;
      if (o.target_object_def_id != null && Number(o.target_object_def_id) !== Number(event.objectDefId)) return false;
      if (o.region_name && !sameText(o.region_name, event.regionName)) return false;
      return true;

    case "ENTER_AREA":
      return event.type === "REGION_ENTERED" && (!o.region_name || sameText(o.region_name, event.regionName));

    case "LOCATION":
    case "REACH_LOCATION": {
      if (event.type !== "LOCATION_REACHED") return false;
      if (o.region_name && !sameText(o.region_name, event.regionName)) return false;
      if (params.locationKey && !sameText(params.locationKey, event.locationKey)) return false;
      if (params.x != null && params.y != null) {
        const radius = Math.max(0, Number(params.radius) || 0);
        const dist = Math.abs(Number(event.x) - Number(params.x)) + Math.abs(Number(event.y) - Number(params.y));
        if (dist > radius) return false;
      }
      return true;
    }

    case "COLLECT":
      return event.type === "ITEM_COLLECTED" && Number(o.target_item_id) === Number(event.itemId);

    case "USE_ITEM":
      return event.type === "ITEM_USED" && Number(o.target_item_id) === Number(event.itemId);

    case "CRAFT":
      if (event.type !== "ITEM_CRAFTED") return false;
      if (o.target_item_id != null && Number(o.target_item_id) !== Number(event.itemId)) return false;
      if (params.professionId != null && Number(params.professionId) !== Number(event.professionId)) return false;
      return true;

    case "GATHER":
      if (event.type !== "RESOURCE_GATHERED") return false;
      if (o.target_item_id != null && Number(o.target_item_id) !== Number(event.itemId)) return false;
      if (params.nodeId != null && Number(params.nodeId) !== Number(event.nodeId)) return false;
      if (params.professionId != null && Number(params.professionId) !== Number(event.professionId)) return false;
      return true;

    case "TALK_TO":
      if (event.type !== "NPC_TALKED_TO") return false;
      if (params.npcId != null && Number(params.npcId) !== Number(event.npcId)) return false;
      if (o.target_world_object_id != null && Number(o.target_world_object_id) !== Number(event.worldObjectId)) return false;
      return params.npcId != null || o.target_world_object_id != null;

    case "COMPLETE_ACTIVITY":
      if (event.type !== "ACTIVITY_COMPLETED" || event.success === false) return false;
      if (params.activityType && !sameText(params.activityType, event.activityType)) return false;
      if (params.activityId != null && Number(params.activityId) !== Number(event.activityId)) return false;
      if (o.region_name && !sameText(o.region_name, event.regionName)) return false;
      return true;

    case "EVENT":
      if (event.type !== "QUEST_EVENT") return false;
      if (params.eventKey && !sameText(params.eventKey, event.eventKey)) return false;
      if (params.state && !sameText(params.state, event.state)) return false;
      return !!params.eventKey;

    case "TURN_IN":
      return false;

    default:
      return false;
  }
}

/**
 * Central Quest System 2.0 event entry point.
 * Only objectives in the player's current required step can progress.
 * Objectives sharing a step are active in parallel. Optional objectives do not block stage/quest completion.
 */
export async function advanceQuestObjectives(pid: number, event: QuestEvent): Promise<QuestProgressResult> {
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
        o.type AS objectiveType,
        o.step_order,
        o.required_count,
        o.objective_text,
        o.is_optional,
        o.is_hidden,
        o.target_creature_id,
        o.target_item_id,
        o.target_world_object_id,
        o.target_object_def_id,
        o.region_name,
        o.params_json,
        q.title AS questTitle
      FROM player_quest_objectives pqo
      JOIN quest_objectives o ON o.id = pqo.objective_id
      JOIN player_quests pq ON pq.id = pqo.player_quest_id
      JOIN quests q ON q.id = pq.quest_id
      WHERE pq.player_id = ?
        AND pq.status = 'active'
        AND pqo.is_complete = 0
      ORDER BY pqo.player_quest_id ASC, o.step_order ASC, o.id ASC
      FOR UPDATE
      `,
      [pid]
    );

    const grouped = new Map<number, any[]>();
    for (const row of rows || []) {
      const pqId = Number(row.playerQuestId);
      if (!grouped.has(pqId)) grouped.set(pqId, []);
      grouped.get(pqId)!.push(row);
    }

    const updatedObjectives: QuestProgressUpdate[] = [];
    const completedPlayerQuestIds: number[] = [];
    const stageTransitions: QuestProgressResult["stageTransitions"] = [];

    for (const [playerQuestId, objectives] of grouped) {
      const requiredIncomplete = objectives.filter(r => Number(r.is_optional || 0) === 0);
      const activeStep = requiredIncomplete.length
        ? Math.min(...requiredIncomplete.map(r => Math.max(1, Number(r.step_order) || 1)))
        : null;

      if (activeStep == null) {
        const completedNow = await finalizeQuestIfAllObjectivesComplete(conn, pid, playerQuestId);
        if (completedNow) completedPlayerQuestIds.push(playerQuestId);
        continue;
      }

      const activeObjectives = objectives.filter(r => Math.max(1, Number(r.step_order) || 1) === activeStep);
      let touched = false;

      for (const r of activeObjectives) {
        if (!objectiveMatchesEvent(r, event)) continue;

        const required = Math.max(1, Number(r.required_count) || 1);
        const current = Math.max(0, Number(r.progress_count) || 0);
        const amount = positiveAmount((event as any).amount, 1);
        const next = Math.min(required, current + amount);
        const nowComplete = next >= required ? 1 : 0;

        // Backward compatibility: old INTERACT objectives can grant target_item_id.
        if (r.objectiveType === "INTERACT" && r.target_item_id != null && event.type === "WORLD_OBJECT_INTERACTED") {
          await grantInventoryItemTx(conn, pid, Number(r.target_item_id), amount);
        }

        await conn.query(
          `UPDATE player_quest_objectives SET progress_count=?, is_complete=? WHERE id=?`,
          [next, nowComplete, Number(r.pqoId)]
        );

        updatedObjectives.push({
          playerQuestId,
          objectiveId: Number(r.objectiveId),
          title: String(r.questTitle || "Quest"),
          objectiveText: r.objective_text ? String(r.objective_text) : null,
          stepOrder: activeStep,
          progress_count: next,
          required_count: required,
          is_complete: nowComplete
        });
        touched = true;
      }

      if (!touched) continue;

      const completedNow = await finalizeQuestIfAllObjectivesComplete(conn, pid, playerQuestId);
      if (completedNow) {
        completedPlayerQuestIds.push(playerQuestId);
        stageTransitions.push({ playerQuestId, fromStep: activeStep, toStep: null });
      } else {
        const nextStep = await getCurrentRequiredStep(conn, playerQuestId);
        if (nextStep !== activeStep) {
          stageTransitions.push({ playerQuestId, fromStep: activeStep, toStep: nextStep });
        }
      }
    }

    await conn.commit();
    return { updatedObjectives, completedPlayerQuestIds, stageTransitions };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    try { conn.release(); } catch {}
  }
}

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
      q.id AS questId, q.type, q.title, q.description, q.town_id,
      t.name AS town_name, q.rumor_hint, q.min_level, q.expires_at,
      q.is_repeatable, q.turn_in_location_id, til.name AS turn_in_location_name
    FROM quests q
    LEFT JOIN player_quests pq
      ON pq.quest_id = q.id AND pq.player_id = ?
      AND pq.status IN ('active','completed','claimed','abandoned','expired')
    LEFT JOIN locations t ON t.id = q.town_id
    LEFT JOIN locations til ON til.id = q.turn_in_location_id
    WHERE pq.id IS NULL AND q.is_active = 1
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
    `SELECT id, type, is_active, expires_at, min_level, chain_id, chain_order, is_repeatable
     FROM quests WHERE id=? AND is_active=1 LIMIT 1`,
    [questId]
  );
  if (!q) throw new Error("QUEST_NOT_FOUND");

  const [[player]]: any = await db.query(`SELECT level FROM players WHERE id=? LIMIT 1`, [pid]);
  if (!player) throw new Error("PLAYER_NOT_FOUND");
  if (Number(player.level || 1) < Number(q.min_level || 1)) throw new Error("QUEST_LEVEL_TOO_LOW");

  if (q.type === "bounty" && q.expires_at && new Date(q.expires_at).getTime() <= Date.now()) {
    throw new Error("BOUNTY_EXPIRED");
  }

  // Explicit prerequisites take precedence.
  const [prereqs]: any = await db.query(
    `SELECT required_quest_id, required_status FROM quest_prerequisites WHERE quest_id=? ORDER BY id ASC`,
    [questId]
  );

  if (prereqs?.length) {
    for (const pre of prereqs) {
      const requiredStatus = String(pre.required_status || "claimed");
      const [[done]]: any = await db.query(
        `SELECT status FROM player_quests WHERE player_id=? AND quest_id=? ORDER BY id DESC LIMIT 1`,
        [pid, Number(pre.required_quest_id)]
      );
      if (!done || (requiredStatus === "completed_or_claimed"
        ? !["completed", "claimed"].includes(String(done.status))
        : String(done.status) !== requiredStatus)) {
        throw new Error("QUEST_PREREQUISITE_NOT_MET");
      }
    }
  } else if (q.chain_id != null && Number(q.chain_order || 0) > 1) {
    const [[prev]]: any = await db.query(
      `SELECT id FROM quests WHERE chain_id=? AND chain_order < ? ORDER BY chain_order DESC LIMIT 1`,
      [q.chain_id, q.chain_order]
    );
    if (prev) {
      const [[done]]: any = await db.query(
        `SELECT status FROM player_quests WHERE player_id=? AND quest_id=? ORDER BY id DESC LIMIT 1`,
        [pid, Number(prev.id)]
      );
      if (!done || !["completed", "claimed"].includes(String(done.status))) {
        throw new Error("QUEST_PREREQUISITE_NOT_MET");
      }
    }
  }

  const [ins]: any = await db.query(
    `INSERT INTO player_quests (player_id, quest_id, expires_at, source) VALUES (?, ?, ?, ?)`,
    [pid, questId, q.expires_at ?? null, source]
  );
  const playerQuestId = Number(ins.insertId);

  const [objs]: any = await db.query(`SELECT id FROM quest_objectives WHERE quest_id=? ORDER BY step_order ASC, id ASC`, [questId]);
  for (const o of objs || []) {
    await db.query(
      `INSERT INTO player_quest_objectives (player_quest_id, objective_id, progress_count, is_complete) VALUES (?, ?, 0, 0)`,
      [playerQuestId, o.id]
    );
  }

  return { playerQuestId };
}

export async function getQuestLog(pid: number) {
  await db.query(
    `UPDATE player_quests SET status='expired'
     WHERE player_id=? AND expires_at IS NOT NULL AND expires_at <= NOW()
       AND status IN ('active','completed')`,
    [pid]
  );

  const [rows]: any = await db.query(
    `
    SELECT
      pq.id AS playerQuestId, pq.status, pq.accepted_at, pq.completed_at, pq.claimed_at,
      q.id AS questId, q.type, q.title, q.description, q.dialog_intro, q.dialog_complete,
      q.turn_in_location_id, til.name AS turn_in_location_name,
      o.id AS objectiveId, o.type AS objectiveType, o.objective_text, o.step_order,
      o.is_optional, o.is_hidden, o.params_json, o.required_count,
      o.target_item_id, o.target_creature_id, o.region_name, o.target_world_object_id,
      o.target_object_def_id,
      pqo.progress_count, pqo.is_complete,
      i.name AS target_item_name, i.icon AS target_item_icon,
      c.name AS target_creature_name, c.creatureimage AS target_creature_icon,
      COALESCE(r.gold, 0) AS reward_gold, COALESCE(r.xp, 0) AS reward_xp
    FROM player_quests pq
    JOIN quests q ON q.id = pq.quest_id
    LEFT JOIN locations til ON til.id = q.turn_in_location_id
    JOIN player_quest_objectives pqo ON pqo.player_quest_id = pq.id
    JOIN quest_objectives o ON o.id = pqo.objective_id
    LEFT JOIN items i ON i.id = o.target_item_id
    LEFT JOIN creatures c ON c.id = o.target_creature_id
    LEFT JOIN quest_rewards r ON r.quest_id = q.id
    WHERE pq.player_id=?
    ORDER BY FIELD(pq.status,'active','completed','claimed','abandoned','expired') ASC,
      pq.accepted_at DESC, pq.id DESC, o.step_order ASC, o.id ASC
    `,
    [pid]
  );

  const byQuest = new Map<number, any[]>();
  for (const row of rows || []) {
    const id = Number(row.playerQuestId);
    if (!byQuest.has(id)) byQuest.set(id, []);
    byQuest.get(id)!.push(row);
  }

  const visible: any[] = [];
  for (const questRows of byQuest.values()) {
    const status = String(questRows[0]?.status || "");
    if (status !== "active") {
      for (const row of questRows) visible.push({ ...row, params_json: parseParams(row.params_json), isActiveStep: 0 });
      continue;
    }

    const requiredIncomplete = questRows.filter(r => Number(r.is_complete) === 0 && Number(r.is_optional || 0) === 0);
    const activeStep = requiredIncomplete.length
      ? Math.min(...requiredIncomplete.map(r => Math.max(1, Number(r.step_order) || 1)))
      : null;

    for (const row of questRows) {
      const step = Math.max(1, Number(row.step_order) || 1);
      // Do not leak future stages. Completed prior steps + current step remain visible.
      if (activeStep != null && step > activeStep) continue;
      visible.push({
        ...row,
        params_json: parseParams(row.params_json),
        isActiveStep: activeStep != null && step === activeStep ? 1 : 0
      });
    }
  }

  return visible as QuestLogRow[];
}

/** TURN_IN all-at-once. Items are only removed when this action is submitted. */
export async function turnInAllAtOnce(pid: number, playerQuestId: number) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[pq]]: any = await conn.query(
      `SELECT id, status, quest_id, expires_at FROM player_quests WHERE id=? AND player_id=? LIMIT 1 FOR UPDATE`,
      [playerQuestId, pid]
    );
    if (!pq) throw new Error("PLAYER_QUEST_NOT_FOUND");
    if (pq.status !== "active") throw new Error("QUEST_NOT_ACTIVE");

    if (pq.expires_at && new Date(pq.expires_at).getTime() <= Date.now()) {
      await conn.query(`UPDATE player_quests SET status='expired' WHERE id=? AND player_id=?`, [playerQuestId, pid]);
      throw new Error("QUEST_EXPIRED");
    }

    const activeStep = await getCurrentRequiredStep(conn, playerQuestId);
    const [objectives]: any = await conn.query(
      `
      SELECT pqo.id AS pqoId, pqo.is_complete, o.required_count, o.target_item_id, o.step_order
      FROM player_quest_objectives pqo
      JOIN quest_objectives o ON o.id = pqo.objective_id
      WHERE pqo.player_quest_id=? AND o.type='TURN_IN'
        AND (? IS NULL OR o.step_order=?)
      FOR UPDATE
      `,
      [playerQuestId, activeStep, activeStep]
    );
    if (!objectives?.length) throw new Error("NO_TURNIN_OBJECTIVE");

    let totalRemoved = 0;
    for (const obj of objectives) {
      if (Number(obj.is_complete) === 1) continue;
      const itemId = Number(obj.target_item_id);
      const required = Math.max(1, Number(obj.required_count) || 1);
      if (!itemId) throw new Error("TURNIN_OBJECTIVE_MISSING_ITEM");

      const [invRows]: any = await conn.query(
        `SELECT inventory_id, quantity FROM inventory
         WHERE player_id=? AND item_id=? AND equipped=0 ORDER BY inventory_id ASC FOR UPDATE`,
        [pid, itemId]
      );
      let available = 0;
      for (const r of invRows || []) available += Math.max(0, Number(r.quantity) || 0);
      if (available < required) throw new Error("NOT_ENOUGH_ITEMS");

      let remaining = required;
      for (const r of invRows || []) {
        if (remaining <= 0) break;
        const rowQty = Math.max(0, Number(r.quantity) || 0);
        if (rowQty <= 0) continue;
        const take = Math.min(rowQty, remaining);
        const newQty = rowQty - take;
        if (newQty > 0) {
          await conn.query(`UPDATE inventory SET quantity=? WHERE inventory_id=? AND player_id=?`, [newQty, r.inventory_id, pid]);
        } else {
          await conn.query(`DELETE FROM inventory WHERE inventory_id=? AND player_id=?`, [r.inventory_id, pid]);
        }
        remaining -= take;
        totalRemoved += take;
      }

      await conn.query(`UPDATE player_quest_objectives SET progress_count=?, is_complete=1 WHERE id=?`, [required, obj.pqoId]);
    }

    const completedNow = await finalizeQuestIfAllObjectivesComplete(conn, pid, playerQuestId);
    const nextStep = completedNow ? null : await getCurrentRequiredStep(conn, playerQuestId);
    await conn.commit();
    return { success: true, removed: totalRemoved, completed: completedNow, nextStep };
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
      `SELECT id, status, quest_id FROM player_quests WHERE id=? AND player_id=? LIMIT 1 FOR UPDATE`,
      [playerQuestId, pid]
    );
    if (!pq) throw new Error("PLAYER_QUEST_NOT_FOUND");
    const status = String(pq.status || "");
    if (status === "claimed") throw new Error("ALREADY_CLAIMED");
    if (status !== "completed") throw new Error("QUEST_NOT_COMPLETED");

    const [[rew]]: any = await conn.query(
      `SELECT COALESCE(gold,0) AS gold, COALESCE(xp,0) AS xp FROM quest_rewards WHERE quest_id=? LIMIT 1`,
      [pq.quest_id]
    );
    const gold = Math.max(0, Number(rew?.gold) || 0);
    const xp = Math.max(0, Number(rew?.xp) || 0);
    let levelUp = null;
    if (gold > 0) await conn.query(`UPDATE players SET gold=gold+? WHERE id=?`, [gold, pid]);
    if (xp > 0) {
      const xpResult = await grantExperienceTx(conn, pid, xp);
      levelUp = xpResult.levelUp;
    }
    await conn.query(`UPDATE player_quests SET status='claimed', claimed_at=NOW() WHERE id=? AND player_id=? AND status='completed'`, [playerQuestId, pid]);
    await conn.commit();
    return { success: true, goldGained: gold, expGained: xp, levelUp };
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
      SELECT pq.id AS playerQuestId, pqo.id AS pqoId, o.required_count, o.target_item_id, o.step_order,
        COALESCE((SELECT SUM(inv.quantity) FROM inventory inv
          WHERE inv.player_id=pq.player_id AND inv.item_id=o.target_item_id AND inv.equipped=0), 0) AS have_qty
      FROM player_quests pq
      JOIN player_quest_objectives pqo ON pqo.player_quest_id=pq.id
      JOIN quest_objectives o ON o.id=pqo.objective_id
      WHERE pq.player_id=? AND pq.status='active' AND o.type='TURN_IN'
      FOR UPDATE
      `,
      [pid]
    );

    const stepCache = new Map<number, number | null>();
    for (const r of rows || []) {
      const pqId = Number(r.playerQuestId);
      if (!stepCache.has(pqId)) stepCache.set(pqId, await getCurrentRequiredStep(conn, pqId));
      if (stepCache.get(pqId) !== Math.max(1, Number(r.step_order) || 1)) continue;
      const required = Math.max(1, Number(r.required_count) || 1);
      const have = Math.max(0, Number(r.have_qty) || 0);
      await conn.query(`UPDATE player_quest_objectives SET progress_count=? WHERE id=?`, [Math.min(required, have), Number(r.pqoId)]);
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

async function finalizeQuestIfAllObjectivesComplete(conn: any, pid: number, playerQuestId: number): Promise<boolean> {
  const [[agg]]: any = await conn.query(
    `
    SELECT
      SUM(CASE WHEN COALESCE(o.is_optional,0)=0 THEN 1 ELSE 0 END) AS total_required,
      SUM(CASE WHEN COALESCE(o.is_optional,0)=0 AND pqo.is_complete=1 THEN 1 ELSE 0 END) AS done_required
    FROM player_quest_objectives pqo
    JOIN quest_objectives o ON o.id=pqo.objective_id
    WHERE pqo.player_quest_id=?
    FOR UPDATE
    `,
    [playerQuestId]
  );
  const total = Number(agg?.total_required) || 0;
  const done = Number(agg?.done_required) || 0;
  if (total > 0 && done >= total) {
    const [u]: any = await conn.query(
      `UPDATE player_quests SET status='completed', completed_at=NOW() WHERE id=? AND player_id=? AND status='active'`,
      [playerQuestId, pid]
    );
    return !!u?.affectedRows;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Backward-compatible wrappers. Existing callers can migrate one at a time.
// -----------------------------------------------------------------------------
export async function applyKillProgress(pid: number, creatureId: number, regionName: string | null, amount = 1) {
  return advanceQuestObjectives(pid, { type: "CREATURE_KILLED", creatureId, regionName, amount });
}

export async function applyEnterAreaProgress(pid: number, regionId: number | null) {
  const normalizedRegionId = Number(regionId || 0);
  if (!normalizedRegionId) return { updatedObjectives: [], completedPlayerQuestIds: [], stageTransitions: [] };
  const [[region]]: any = await db.query(`SELECT name FROM regions WHERE id=? LIMIT 1`, [normalizedRegionId]);
  if (!region) return { updatedObjectives: [], completedPlayerQuestIds: [], stageTransitions: [] };
  return advanceQuestObjectives(pid, { type: "REGION_ENTERED", regionId: normalizedRegionId, regionName: String(region.name || "") });
}

export async function applyLocationProgress(pid: number, x: number, y: number, regionName?: string | null, locationKey?: string | null) {
  return advanceQuestObjectives(pid, { type: "LOCATION_REACHED", x, y, regionName, locationKey });
}

export async function applyInteractProgress(pid: number, worldObjectId: number): Promise<any> {
  const conn = await db.getConnection();
  try {
    const [[player]]: any = await conn.query(`SELECT id, map_x, map_y FROM players WHERE id=? LIMIT 1`, [pid]);
    if (!player) throw new Error("PLAYER_NOT_FOUND");
    const [[obj]]: any = await conn.query(
      `SELECT id, name, object_type, region_name, x, y, interaction_radius, is_active, lore_title, lore_text
       FROM world_objects WHERE id=? LIMIT 1`,
      [worldObjectId]
    );
    if (!obj || Number(obj.is_active) !== 1) throw new Error("WORLD_OBJECT_NOT_FOUND");
    const dist = Math.abs(Number(player.map_x) - Number(obj.x)) + Math.abs(Number(player.map_y) - Number(obj.y));
    const radius = Math.max(0, Number(obj.interaction_radius) || 1);
    if (dist > radius) throw new Error("TOO_FAR_AWAY");

    const out = await advanceQuestObjectives(pid, {
      type: "WORLD_OBJECT_INTERACTED",
      worldObjectId,
      objectDefId: null,
      regionName: obj.region_name ?? null
    });

    let loreText = String(obj.lore_text || "");
    if (out.updatedObjectives.length) loreText = "You investigate the area.";
    else if (!loreText) loreText = "The ground looks odd here, but I can't quite explain it.";

    return {
      success: true,
      ...out,
      lore: { title: String(obj.lore_title || obj.name || "Discovery"), text: loreText }
    };
  } finally {
    try { conn.release(); } catch {}
  }
}

export async function applyCollectProgress(pid: number, itemId: number, amount = 1, source?: string | null) {
  return advanceQuestObjectives(pid, { type: "ITEM_COLLECTED", itemId, amount, source });
}

export async function applyUseItemProgress(pid: number, itemId: number, amount = 1) {
  return advanceQuestObjectives(pid, { type: "ITEM_USED", itemId, amount });
}

export async function applyCraftProgress(pid: number, itemId: number, amount = 1, professionId?: number | null) {
  return advanceQuestObjectives(pid, { type: "ITEM_CRAFTED", itemId, amount, professionId });
}

export async function applyGatherProgress(pid: number, data: { itemId?: number | null; nodeId?: number | null; professionId?: number | null; amount?: number }) {
  return advanceQuestObjectives(pid, { type: "RESOURCE_GATHERED", ...data });
}

export async function applyTalkProgress(pid: number, npcId: number, worldObjectId?: number | null) {
  return advanceQuestObjectives(pid, { type: "NPC_TALKED_TO", npcId, worldObjectId });
}

export async function applyActivityProgress(pid: number, activityType: string, activityId?: number | null, regionName?: string | null, amount = 1) {
  return advanceQuestObjectives(pid, { type: "ACTIVITY_COMPLETED", activityType, activityId, regionName, success: true, amount });
}

export async function applyQuestEventProgress(pid: number, eventKey: string, state?: string | null, amount = 1) {
  return advanceQuestObjectives(pid, { type: "QUEST_EVENT", eventKey, state, amount });
}
