// services/tavernService.ts
import { db } from "../db";

/**
 * Returns the next quest in the town's chain that the player has not claimed yet.
 * (Claimed = completed+claimed; also blocks if already active.)
 */
export async function getNextRumorQuest(pid: number, townId: number) {
const [[row]]: any = await db.query(
  `
  SELECT q.*
  FROM quests q
  WHERE q.is_active=1
    AND q.type='quest'
    AND q.town_id=?
    AND q.min_level <= (SELECT level FROM players WHERE id=?)

    -- don't offer quests already accepted/claimed/etc
    AND NOT EXISTS (
      SELECT 1
      FROM player_quests pq
      WHERE pq.player_id=?
        AND pq.quest_id=q.id
        AND pq.status IN ('active','completed','claimed')
    )

    -- ✅ CHAIN GATING
    AND (
      q.chain_id IS NULL
      OR (
        -- only allow the "next" quest in the chain based on claimed progress
        q.chain_order = (
          SELECT COALESCE(MAX(qc.chain_order), 0) + 1
          FROM player_quests pqc
          JOIN quests qc ON qc.id = pqc.quest_id
          WHERE pqc.player_id=?
            AND pqc.status='claimed'
            AND qc.chain_id = q.chain_id
        )
        -- and prevent taking multiple steps at once
        AND NOT EXISTS (
          SELECT 1
          FROM player_quests pqx
          JOIN quests qx ON qx.id = pqx.quest_id
          WHERE pqx.player_id=?
            AND qx.chain_id = q.chain_id
            AND pqx.status IN ('active','completed')
        )
      )
    )

  ORDER BY
    CASE WHEN q.chain_id IS NULL THEN 1 ELSE 0 END,
    q.chain_id ASC,
    q.chain_order ASC,
    q.id ASC
  LIMIT 1
  `,
  [townId, pid, pid, pid, pid]
);


  if (!row) return null;

  // objectives preview (support KILL + TURN_IN)
  const [objs]: any = await db.query(
    `
    SELECT o.type, o.required_count, o.target_item_id, o.target_creature_id, o.region_name
    FROM quest_objectives o
    WHERE o.quest_id=?
    ORDER BY o.id ASC
    `,
    [row.id]
  );

  const kill = (objs || []).find((o: any) => o.type === "KILL" && o.target_creature_id);
  const turnIn = (objs || []).find((o: any) => o.type === "TURN_IN" && o.target_item_id);

  let targetItem = null;
  if (turnIn?.target_item_id) {
    const [[item]]: any = await db.query(
      `SELECT id, name, icon, rarity FROM items WHERE id=? LIMIT 1`,
      [turnIn.target_item_id]
    );
    if (item) targetItem = item;
  }

  let targetCreature = null;
  if (kill?.target_creature_id) {
    const [[c]]: any = await db.query(
      `SELECT id, name, level, rarity FROM creatures WHERE id=? LIMIT 1`,
      [kill.target_creature_id]
    );
    if (c) targetCreature = c;
  }

  return {
    questId: Number(row.id),
    title: row.title,
    description: row.description ?? "",
    dialogIntro: row.dialog_intro ?? "",
    dialogComplete: row.dialog_complete ?? "",
    chainId: row.chain_id ?? null,
    chainOrder: row.chain_order ?? null,
    objectivePreview: kill
      ? { type: "KILL", required: Number(kill.required_count), creature: targetCreature, regionHint: kill.region_name ?? null }
      : turnIn
      ? { type: "TURN_IN", required: Number(turnIn.required_count), item: targetItem, regionHint: turnIn.region_name ?? null }
      : null
  };
}

