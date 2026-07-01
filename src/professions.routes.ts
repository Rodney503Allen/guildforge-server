import express from "express";
import path from "path";
import { db } from "./db";

const router = express.Router();

function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) return res.redirect("/login.html");
  next();
}

function requireLoginApi(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) {
    return res.status(401).json({ error: "not_logged_in" });
  }
  next();
}

function professionXpNeeded(level: number) {
  return Math.floor(50 + level * level * 25);
}

function toolColumnForProfession(name: string) {
  switch (String(name || "").toLowerCase()) {
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

// =======================
// PROFESSIONS PAGE
// =======================
router.get("/professions", requireLogin, async (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "professions.html"));
});

// =======================
// PROFESSIONS SUMMARY API
// =======================
router.get("/api/professions/summary", requireLoginApi, async (req, res) => {
  const pid = Number((req.session as any).playerId);

  try {
    const [professionRows]: any = await db.query(`
      SELECT
        p.id,
        p.name,
        p.type,
        p.description,
        COALESCE(pp.level, 1) AS level,
        COALESCE(pp.experience, 0) AS experience,
        COALESCE(pp.is_specialized, 0) AS isSpecialized
      FROM professions p
      LEFT JOIN player_professions pp
        ON pp.profession_id = p.id
       AND pp.player_id = ?
      ORDER BY
        CASE p.type
          WHEN 'gathering' THEN 1
          WHEN 'crafting' THEN 2
          ELSE 3
        END,
        p.name ASC
    `, [pid]);

    const [playerRows]: any = await db.query(
      `
      SELECT
        equip_tool_mining_inventory_id,
        equip_tool_herbalism_inventory_id,
        equip_tool_woodcutting_inventory_id
      FROM players
      WHERE id = ?
      `,
      [pid]
    );

    const player = playerRows[0] || {};

    const professions = [];

    for (const p of professionRows) {
      const level = Number(p.level || 1);
      const toolColumn = toolColumnForProfession(p.name);
      let tool = null;

      if (toolColumn && player[toolColumn]) {
        const [toolRows]: any = await db.query(
          `
          SELECT
            inv.inventory_id,
            i.id AS itemId,
            i.name,
            i.icon,
            i.item_type
          FROM inventory inv
          JOIN items i ON i.id = inv.item_id
          WHERE inv.inventory_id = ?
            AND inv.player_id = ?
          LIMIT 1
          `,
          [player[toolColumn], pid]
        );

        tool = toolRows[0] || null;
      }

      const [nodeRows]: any = await db.query(
        `
        SELECT
          id,
          name,
          description,
          required_level AS requiredLevel,
          rarity,
          base_xp AS baseXp,
          base_gather_time_ms AS baseGatherTimeMs
        FROM resource_nodes
        WHERE profession_id = ?
          AND required_level <= ?
        ORDER BY required_level ASC, name ASC
        `,
        [p.id, level]
      );

      professions.push({
        id: Number(p.id),
        name: p.name,
        type: p.type,
        description: p.description,
        level,
        experience: Number(p.experience || 0),
        xpNeeded: professionXpNeeded(level),
        isSpecialized: Number(p.isSpecialized || 0) === 1,
        tool,
        nodes: nodeRows,
      });
    }

    res.json({ professions });
  } catch (err) {
    console.error("GET /api/professions/summary error:", err);
    res.status(500).json({ error: "failed_to_load_professions" });
  }
});

export default router;