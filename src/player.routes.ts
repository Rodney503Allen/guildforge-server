import express from "express";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";
import { getActiveBuffs } from "./services/buffService";

const router = express.Router();

router.get("/me", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ error: "Not logged in" });

    const p = await getFinalPlayerStats(pid);
    if (!p) return res.json(null);

res.json({
  id: p.id,
  name: p.name,
  pclass: p.pclass,
  archetype: p.archetype,
  level: p.level,
  exper: p.exper,
  location: p.location,

  attack: p.attack,
  defense: p.defense,
  agility: p.agility,
  vitality: p.vitality,
  intellect: p.intellect,
  crit: p.crit,

  hpoints: p.hpoints,
  maxhp: p.maxhp,
  spoints: p.spoints,
  maxspoints: p.maxspoints,

  spellPower: p.spellPower,
  dodgeChance: p.dodgeChance,

  gold: p.gold,
  stat_points: p.stat_points,

  guild_name: p.guild_name,
  guild_rank: p.guild_rank,
  portrait_url: p.portrait_url,
  guild_banner: p.guild_banner,

  // OPTIONAL: buffs for UI only
  buffs: (await getActiveBuffs(pid)).map(b => ({
    stat: b.stat,
    value: b.value,
    expires_at: b.expires_at
  }))
});


  } catch (err) {
    console.error("ME ROUTE ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
  
});

// =======================
// GET AVAILABLE CLASSES
// =======================
router.get("/api/classes", async (req, res) => {
  try {
    const [classes]: any = await db.query(`
      SELECT id, name
      FROM classes
      ORDER BY name ASC
    `);

    res.json(classes);
  } catch (err) {
    console.error("❌ CLASS LOAD FAILED:", err);
    res.status(500).json([]);
  }
});


// =======================
// PLAYER HP
// =======================
router.get("/api/player/hp", async (req, res) => {
  try {
    const pid = (req.session as any)?.playerId;
    if (!pid) return res.status(401).json({});

    const p = await getFinalPlayerStats(pid);
    if (!p) return res.status(404).json({});

    res.json({
      current: p.hpoints,
      max: p.maxhp,
      percent: Math.floor((p.hpoints / p.maxhp) * 100)
    });
  } catch (err) {
    console.error("HP ROUTE ERROR:", err);
    res.status(500).json({});
  }
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
