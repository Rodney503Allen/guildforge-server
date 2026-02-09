import express from "express";
import bcrypt from "bcryptjs";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";

const router = express.Router();

// =======================
// LOGIN
// =======================
router.post("/login", async (req, res) => {

  const { name, password } = req.body;

  if (!name || !password)
    return res.json({ error: "Missing login fields" });

  const [rows]: any = await db.query(
    "SELECT * FROM players WHERE name=? LIMIT 1",
    [name]
  );

  const player = rows[0];

  if (!player)
    return res.json({ error: "Invalid username" });

  const valid = await bcrypt.compare(password, player.password);

  if (!valid)
    return res.json({ error: "Invalid password" });

  req.session.playerId = player.id;


  // ✅ Store session
(req.session as any).playerId = player.id;

// ✅ Check where the player last was
const [[location]]: any = await db.query(`
  SELECT *
  FROM locations
  WHERE map_x = ? AND map_y = ?
`, [player.map_x, player.map_y]);

// ✅ Decide redirect
let redirect = "/world";

if (player.dead === 1 || player.hpoints <= 0) {
  redirect = "/death";
}
else if (location) {
  redirect = location.redirect_url || `/town`;
}

// ✅ Respond with redirect route
res.json({ success: true, redirect });

});


// =======================
// REGISTER
// =======================
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, confirm, pclass } = req.body;

    if (!name || !password || !confirm || !pclass) {
      return res.json({ error: "Missing fields" });
    }

    if (password !== confirm) {
      return res.json({ error: "Passwords do not match" });
    }

    const [[existing]]: any = await db.query(
      "SELECT id FROM players WHERE name=? LIMIT 1",
      [name]
    );

    if (existing) {
      return res.json({ error: "Username already taken" });
    }

    // Pull FULL base stats from classes
    const [[base]]: any = await db.query(
      `
      SELECT
        name,
        archetype,
        attack,
        defense,
        agility,
        vitality,
        intellect,
        crit,
        hpoints,
        spoints
      FROM classes
      WHERE name=?
      LIMIT 1
      `,
      [pclass]
    );

    if (!base) {
      return res.json({ error: "Invalid class" });
    }

    const hash = await bcrypt.hash(password, 10);

const [result]: any = await db.query(
  `
  INSERT INTO players
  (
    name,
    email,
    password,
    level,
    exper,

    attack,
    defense,
    agility,
    vitality,
    intellect,
    crit,

    hpoints,
    maxhp,
    spoints,
    maxspoints,

    gold,
    pclass,
    location
  )
  VALUES
  (
    ?, ?, ?, 1, 0,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    100, ?, 'Crocania'
  )
  `,
  [
    name,
    email || null,
    hash,

    base.attack,
    base.defense,
    base.agility,
    base.vitality,
    base.intellect,
    base.crit,

    base.hpoints,
    base.hpoints,
    base.spoints,
    base.spoints,

    pclass
  ]
);

    const playerId = result.insertId;

    const p = await getFinalPlayerStats(playerId);
    if (!p) throw new Error("Failed to compute stats for new player");

    // full resources on creation
    await db.query(
      `UPDATE players
      SET hpoints = ?, spoints = ?
      WHERE id = ?`,
      [p.maxhp, p.maxspoints, playerId]
    );




    res.json({ success: true });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});



// =======================
// LOGOUT
// =======================
router.post("/logout", (req, res) => {

  req.session.destroy(err => {
    if (err) {
      return res.json({ error: "Logout failed" });
    }

    res.clearCookie("connect.sid");
    res.json({ success: true });
  });

});

export default router;
