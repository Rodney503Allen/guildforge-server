//src/gathering.routes.ts
import express from "express";
import { db } from "./db";
import { gatherNode } from "./services/gatheringService";

const router = express.Router();

function requireLoginApi(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) {
    return res.status(401).json({ error: "not_logged_in" });
  }
  next();
}

// =======================
// GET NEARBY RESOURCE NODES
// =======================
router.get("/api/gathering/nearby", requireLoginApi, async (req, res) => {
  const playerId = Number((req.session as any).playerId);

  try {
    const [playerRows]: any = await db.query(
      `SELECT map_x, map_y FROM players WHERE id = ?`,
      [playerId]
    );

    if (!playerRows.length) {
      return res.status(404).json({ error: "player_not_found" });
    }

    const player = playerRows[0];
    const range = 2;

    const [nodes]: any = await db.query(
      `
      SELECT
        srn.id AS spawnedNodeId,
        srn.map_x,
        srn.map_y,
        srn.remaining_uses,
        srn.despawns_at,

        rn.id AS nodeId,
        rn.name AS nodeName,
        rn.description,
        rn.required_level,
        rn.base_gather_time_ms,
        rn.base_xp,
        rn.rarity,

        p.id AS professionId,
        p.name AS professionName,

        a.id AS affixId,
        a.name AS affixName,
        a.description AS affixDescription,
        a.xp_multiplier,
        a.yield_multiplier,
        a.rare_drop_bonus
      FROM spawned_resource_nodes srn
      JOIN resource_nodes rn ON rn.id = srn.node_id
      JOIN professions p ON p.id = rn.profession_id
      LEFT JOIN resource_node_affixes a ON a.id = srn.affix_id
      WHERE srn.player_id = ?
        AND srn.remaining_uses > 0
        AND (srn.despawns_at IS NULL OR srn.despawns_at > NOW())
        AND srn.map_x BETWEEN ? AND ?
        AND srn.map_y BETWEEN ? AND ?
      ORDER BY ABS(srn.map_x - ?) + ABS(srn.map_y - ?) ASC
      `,
      [
        playerId,
        player.map_x - range,
        player.map_x + range,
        player.map_y - range,
        player.map_y + range,
        player.map_x,
        player.map_y,
        ]
    );

    res.json({
      playerLocation: {
        x: player.map_x,
        y: player.map_y,
      },
      range,
      nodes,
    });
  } catch (err) {
    console.error("GET /api/gathering/nearby error:", err);
    res.status(500).json({ error: "failed_to_load_nearby_nodes" });
  }
});

// =======================
// GATHER RESOURCE NODE
// =======================
router.post("/api/gathering/gather/:spawnedNodeId", requireLoginApi, async (req, res) => {
  const playerId = Number((req.session as any).playerId);
  const spawnedNodeId = Number(req.params.spawnedNodeId);

  if (!spawnedNodeId) {
    return res.status(400).json({ error: "invalid_node_id" });
  }

  try {
    const result = await gatherNode(playerId, spawnedNodeId);
    res.json(result);
  } catch (err: any) {
    const message = String(err?.message || "failed_to_gather_node");

    const status =
        message === "player_not_found" ? 404 :
        message === "node_not_found_or_expired" ? 404 :
        message === "too_far_from_node" ? 400 :
        message === "inventory_full" ? 400 :
        message === "missing_gathering_tool" ? 403 :
        message === "invalid_gathering_tool" ? 403 :
        message === "profession_level_too_low" ? 403 :
        message === "invalid_profession_tool_type" ? 500 :
        500;

    res.status(status).json({ error: message });
  }
  
});

export default router;