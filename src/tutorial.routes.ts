// tutorial.routes.ts
import { Router } from "express";
import { getTutorialState, skipTutorial } from "./services/tutorialService";
const router = Router();
function requireLogin(req:any,res:any,next:any){ if(!req.session?.playerId) return res.status(401).json({error:"Not logged in"}); next(); }
router.get("/api/tutorial", requireLogin, async (req:any,res) => { try { const state=await getTutorialState(Number(req.session.playerId)); if(!state) return res.status(404).json({error:"Player not found"}); return res.json(state); } catch(err){ console.error("GET TUTORIAL STATE FAILED:",err); return res.status(500).json({error:"Could not load tutorial state"}); } });
router.post("/api/tutorial/skip", requireLogin, async (req:any,res) => { try { await skipTutorial(Number(req.session.playerId)); return res.json({success:true}); } catch(err){ console.error("SKIP TUTORIAL FAILED:",err); return res.status(500).json({error:"Could not skip tutorial"}); } });
export default router;
