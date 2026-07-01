// src/services/gatheringService.ts
import { db } from "../db";
import { hasInventorySpace } from "./inventoryCapacityService";
import { addItemWithConn, DEFAULT_MAX_STACK_SIZE } from "./inventoryService";

type GatherResult = {
  success: true;
  nodeName: string;
  professionName: string;
  gatherTimeMs: number;
  xpGained: number;
  gatheredItems: {
    itemId: number;
    name: string;
    quantity: number;
  }[];
  leveledUp?: boolean;
  newLevel?: number;
  levelsGained?: number;
};

async function countNewGatheringSlots(
  conn: any,
  playerId: number,
  rewards: GatherResult["gatheredItems"]
) {
  if (!rewards.length) return 0;

  const neededByItem = new Map<number, number>();

  for (const reward of rewards) {
    const itemId = Number(reward.itemId);
    const qty = Math.max(1, Number(reward.quantity || 1));

    if (!itemId) continue;

    neededByItem.set(itemId, (neededByItem.get(itemId) || 0) + qty);
  }

  let newSlotsNeeded = 0;

  for (const [itemId, qtyNeeded] of neededByItem) {
    const [stackRows]: any = await conn.query(
      `
      SELECT quantity
      FROM inventory
      WHERE player_id = ?
        AND item_id = ?
        AND player_item_id IS NULL
        AND equipped = 0
        AND randid IS NULL
        AND durability IS NULL
      ORDER BY inventory_id ASC
      FOR UPDATE
      `,
      [playerId, itemId]
    );

    let remaining = qtyNeeded;

    for (const stack of stackRows) {
      const currentQty = Math.max(0, Number(stack.quantity || 0));
      const room = Math.max(0, DEFAULT_MAX_STACK_SIZE - currentQty);

      if (room <= 0) continue;

      const addedToExisting = Math.min(room, remaining);
      remaining -= addedToExisting;

      if (remaining <= 0) break;
    }

    if (remaining > 0) {
      newSlotsNeeded += Math.ceil(remaining / DEFAULT_MAX_STACK_SIZE);
    }
  }

  return newSlotsNeeded;
}

function professionToolColumn(professionName: string) {
  switch (professionName.toLowerCase()) {
    case "mining":
      return "equip_tool_mining_inventory_id";
    case "herbalism":
      return "equip_tool_herbalism_inventory_id";
    case "woodcutting":
      return "equip_tool_woodcutting_inventory_id";
    default:
      return null;
  }
}

function professionToolType(professionName: string) {
  switch (professionName.toLowerCase()) {
    case "mining":
      return "mining_tool";
    case "herbalism":
      return "herbalism_tool";
    case "woodcutting":
      return "woodcutting_tool";
    default:
      return null;
  }
}

function professionXpNeeded(level: number) {
  return Math.floor(50 + level * level * 25);
}


export async function gatherNode(playerId: number, spawnedNodeId: number): Promise<GatherResult> {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [playerRows]: any = await conn.query(
      `SELECT id, map_x, map_y,
              equip_tool_mining_inventory_id,
              equip_tool_herbalism_inventory_id,
              equip_tool_woodcutting_inventory_id
       FROM players
       WHERE id = ?
       FOR UPDATE`,
      [playerId]
    );

    if (!playerRows.length) {
      throw new Error("player_not_found");
    }

    const player = playerRows[0];

    const [nodeRows]: any = await conn.query(
      `
      SELECT
        srn.id AS spawnedNodeId,
        srn.map_x,
        srn.map_y,
        srn.remaining_uses,

        rn.id AS nodeId,
        rn.name AS nodeName,
        rn.required_level,
        rn.base_xp,
        rn.base_gather_time_ms,

        p.id AS professionId,
        p.name AS professionName,

        a.xp_multiplier,
        a.yield_multiplier
      FROM spawned_resource_nodes srn
      JOIN resource_nodes rn ON rn.id = srn.node_id
      JOIN professions p ON p.id = rn.profession_id
      LEFT JOIN resource_node_affixes a ON a.id = srn.affix_id
      WHERE srn.id = ?
        AND srn.player_id = ?
        AND srn.remaining_uses > 0
        AND (srn.despawns_at IS NULL OR srn.despawns_at > NOW())
      FOR UPDATE
      `,
      [spawnedNodeId, playerId]
    );

    if (!nodeRows.length) {
      throw new Error("node_not_found_or_expired");
    }

    const node = nodeRows[0];

    const distance =
      Math.abs(Number(player.map_x) - Number(node.map_x)) +
      Math.abs(Number(player.map_y) - Number(node.map_y));

    if (distance > 0) {
      throw new Error("too_far_from_node");
    }

    const toolColumn = professionToolColumn(node.professionName);
    const requiredToolType = professionToolType(node.professionName);

    if (!toolColumn || !requiredToolType) {
      throw new Error("invalid_profession_tool_type");
    }

    const equippedToolInventoryId = player[toolColumn];

    if (!equippedToolInventoryId) {
      throw new Error("missing_gathering_tool");
    }

    const [toolRows]: any = await conn.query(
      `
      SELECT
        inv.inventory_id,
        inv.player_id,
        inv.item_id,
        i.name,
        i.item_type
      FROM inventory inv
      JOIN items i ON i.id = inv.item_id
      WHERE inv.inventory_id = ?
        AND inv.player_id = ?
        AND i.item_type = ?
      LIMIT 1
      `,
      [equippedToolInventoryId, playerId, requiredToolType]
    );

    if (!toolRows.length) {
      throw new Error("invalid_gathering_tool");
    }

    const [professionRows]: any = await conn.query(
      `
      SELECT level, experience
      FROM player_professions
      WHERE player_id = ? AND profession_id = ?
      FOR UPDATE
      `,
      [playerId, node.professionId]
    );

    let professionLevel = 1;
    let professionExperience = 0;

    if (!professionRows.length) {
      await conn.query(
        `
        INSERT INTO player_professions
        (player_id, profession_id, level, experience, is_specialized)
        VALUES (?, ?, 1, 0, 0)
        `,
        [playerId, node.professionId]
      );
    } else {
      professionLevel = Number(professionRows[0].level);
      professionExperience = Number(professionRows[0].experience);
    }

    if (professionLevel < Number(node.required_level)) {
      throw new Error("profession_level_too_low");
    }

    const [dropRows]: any = await conn.query(
      `
      SELECT
        rnd.item_id,
        rnd.min_quantity,
        rnd.max_quantity,
        rnd.drop_chance,
        i.name AS itemName
      FROM resource_node_drops rnd
      JOIN items i ON i.id = rnd.item_id
      WHERE rnd.node_id = ?
      `,
      [node.nodeId]
    );

    const gatheredItems: GatherResult["gatheredItems"] = [];
    const yieldMultiplier = Number(node.yield_multiplier ?? 1);

    for (const drop of dropRows) {
      if (Math.random() <= Number(drop.drop_chance)) {
        const min = Number(drop.min_quantity);
        const max = Number(drop.max_quantity);
        const baseQty = Math.floor(Math.random() * (max - min + 1)) + min;
        const quantity = Math.max(1, Math.floor(baseQty * yieldMultiplier));

        gatheredItems.push({
          itemId: Number(drop.item_id),
          name: drop.itemName,
          quantity,
        });
      }
    }

    const slotsNeeded = await countNewGatheringSlots(conn, playerId, gatheredItems);
    const space = await hasInventorySpace(playerId, slotsNeeded);

    if (!space.hasSpace) {
      throw new Error(`inventory_full:${space.used}:${space.capacity}`);
    }

    for (const item of gatheredItems) {
      await addItemWithConn(conn, playerId, item.itemId, item.quantity);
    }

    let xpGained = Math.floor(Number(node.base_xp) * Number(node.xp_multiplier ?? 1));
    professionExperience += xpGained;

    let levelsGained = 0;

    while (professionExperience >= professionXpNeeded(professionLevel)) {
      professionExperience -= professionXpNeeded(professionLevel);
      professionLevel += 1;
      levelsGained += 1;
    }

    await conn.query(
      `
      UPDATE player_professions
      SET level = ?, experience = ?
      WHERE player_id = ? AND profession_id = ?
      `,
      [professionLevel, professionExperience, playerId, node.professionId]
    );

    await conn.query(
      `
      UPDATE spawned_resource_nodes
      SET remaining_uses = remaining_uses - 1
      WHERE id = ?
      `,
      [spawnedNodeId]
    );

    await conn.query(
      `
      DELETE FROM spawned_resource_nodes
      WHERE id = ? AND remaining_uses <= 0
      `,
      [spawnedNodeId]
    );

    await conn.commit();

    return {
      success: true,
      nodeName: node.nodeName,
      professionName: node.professionName,
      gatherTimeMs: Number(node.base_gather_time_ms || 1800),
      xpGained,
      gatheredItems,
      ...(levelsGained > 0
        ? {
            leveledUp: true,
            newLevel: professionLevel,
            levelsGained,
          }
        : {}),
    }
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}