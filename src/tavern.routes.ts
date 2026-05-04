// routes/tavern.routes.ts
import { Router } from "express";
import { getAvailableRumorQuests } from "./services/tavernService";

const router = Router();

// Listen for rumors
router.get("/tavern/:townId/rumor", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ ok: false, error: "Not logged in" });

    const townId = Number(req.params.townId);
    if (!Number.isFinite(townId)) {
      return res.status(400).json({ ok: false, error: "Invalid townId" });
    }

    const quests = await getAvailableRumorQuests(pid, townId);

    return res.json({
      ok: true,
      quests
    });
  } catch (err) {
    console.error("🔥 rumor endpoint error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default router;