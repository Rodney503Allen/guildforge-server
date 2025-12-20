import express from "express";
import { db } from "./db";

const router = express.Router();

// =======================
// FETCH WORLD CHAT
// =======================
router.get("/api/chat/world", async (req, res) => {
  const [rows]: any = await db.query(`
    SELECT id, player_name, message, created_at
    FROM world_chat
    ORDER BY id DESC
    LIMIT 50
  `);

  res.json(rows.reverse());
});

// =======================
// POST WORLD MESSAGE
// =======================
router.post("/api/chat/world", async (req, res) => {
  const pid = (req.session as any).playerId;
  const { message } = req.body;

  if (!pid) return res.json({ error: "Not logged in" });
  if (!message || !message.trim()) return res.json({ error: "Empty message" });

  const [[player]]: any = await db.query(
    "SELECT name FROM players WHERE id=?",
    [pid]
  );

  await db.query(`
    INSERT INTO world_chat (player_id, player_name, message)
    VALUES (?, ?, ?)
  `, [pid, player.name, message.substring(0, 240)]);

  res.json({ success: true });
});

export default router;
