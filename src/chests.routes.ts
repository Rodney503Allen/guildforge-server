// routes/chests.routes.ts
import express from "express";
import { getPendingChest, openChest, claimChest } from "./services/chestService";

const router = express.Router();

router.get("/api/chests/pending", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ ok: false, error: "Not logged in" });

  const chest = await getPendingChest(Number(pid));
  return res.json({ ok: true, chest });
});

router.post("/api/chests/:id/open", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ ok: false, error: "Not logged in" });

  const chestId = Number(req.params.id);
  const result = await openChest(Number(pid), chestId);

  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

router.post("/api/chests/:id/claim", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ ok: false, error: "Not logged in" });

  const chestId = Number(req.params.id);
  const result = await claimChest(Number(pid), chestId);

  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

export default router;
