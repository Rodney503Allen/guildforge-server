import express from "express";
import { db } from "./db";

const router = express.Router();


// =======================
// WORLD MAP
// =======================
router.get("/", (req, res) => {

  if (!req.session.playerId) return res.redirect("/login.html");

  res.send(`
    <h2>World Map</h2>

    <div style="font-family:Arial; margin:20px;">
      <a href="/travel/go/Crocania">🏰 Crocania</a><br>
      <a href="/travel/go/Fordale Woods">🌲 Fordale Woods</a><br>
      <a href="/travel/go/Nightfall Marsh">🌫 Nightfall Marsh</a><br>
      <a href="/travel/go/Blackstone Keep">🗿 Blackstone Keep</a><br>
    </div>

    <a href="/">⬅ Return</a>
  `);
});


// =======================
// TRAVEL ACTION
// =======================
router.get("/go/:zone", async (req, res) => {

  const pid = req.session.playerId;
  if (!pid) return res.redirect("/login.html");

  const zone = req.params.zone;

  await db.query(
    "UPDATE players SET location=? WHERE id=?",
    [zone, pid]
  );

  res.send(`
    <h2>✈ Traveling...</h2>
    <p>You arrive at <b>${zone}</b>.</p>
    <a href="/">Enter Area</a>
  `);
});

export default router;
