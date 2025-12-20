// player.routes.ts
import express from "express";
import { db } from "./db";

const router = express.Router();

// =======================
// CURRENT USER DATA
// =======================
router.get("/me", async (req, res) => {
  const pid = (req.session as any).playerId;

  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const [[player]]: any = await db.query(`
    SELECT
      p.id,
      p.name,
      p.pclass,
      p.level,
      p.exper,
      p.location,
      p.attack,
      p.defense,
      p.agility,
      p.vitality,
      p.intellect,
      p.crit,
      p.hpoints,
      p.maxhp,
      p.spoints,
      p.maxspoints,
      p.gold,
      p.stat_points,
      g.name AS guild_name,
      gm.guild_rank
    FROM players p
    LEFT JOIN guild_members gm ON gm.player_id = p.id
    LEFT JOIN guilds g ON g.id = gm.guild_id
    WHERE p.id = ?
  `, [pid]);

  console.log("ME ROUTE PLAYER:", player); // debug log

  res.json(player);
});

// =======================
// PLAYER HP
// =======================
router.get("/api/player/hp", async (req, res) => {

  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({});

  const [[player]]: any = await db.query(`
    SELECT hpoints, maxhp FROM players WHERE id=?
  `,[pid]);

  res.json({
    current: player.hpoints,
    max: player.maxhp,
    percent: Math.floor((player.hpoints / player.maxhp) * 100)
  });

});

// =======================
// PROFILE PAGE (OPTIONAL FUTURE)
// =======================
router.get("/profile", async (req, res) => {

  const pid = req.session.playerId;
  if (!pid) return res.redirect("/login.html");

  const [[player]]: any = await db.query(`
    SELECT name, pclass, level, exper, gold
    FROM players WHERE id=?
  `,[pid]);

  if (!player)
    return res.redirect("/");

  res.send(`
    <h2>${player.name}</h2>
    <p>Class: ${player.pclass}</p>
    <p>Level: ${player.level}</p>
    <p>XP: ${player.exper}</p>
    <p>Gold: ${player.gold}</p>
    <a href="/">Back</a>
  `);
});

export default router;
