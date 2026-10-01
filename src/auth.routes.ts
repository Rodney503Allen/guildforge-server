//src/auth.routes.ts
import express from "express";
import bcrypt from "bcryptjs";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";
import { generateLootFromBaseItem } from "./services/lootGenerator";

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
      "SELECT id FROM players WHERE name = ? LIMIT 1",
      [name]
    );

    if (existing) {
      return res.json({ error: "Username already taken" });
    }

    const [[base]]: any = await db.query(
      `
        SELECT
          id,
          name,
          attack,
          defense,
          agility,
          vitality,
          intellect,
          crit,
          hpoints,
          spoints
        FROM classes
        WHERE name = ?
          AND is_active = 1
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
          skill_points,
          pclass,
          class_id,
          location
        )
        VALUES
        (
          ?, ?, ?, 1, 0,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          100, 1, ?, ?, 'Port Haven'
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

        base.name,
        base.id
      ]
    );

    const playerId = result.insertId;

    const p = await getFinalPlayerStats(playerId);

    if (!p) {
      throw new Error("Failed to compute stats for new player");
    }

    await db.query(
      `
        UPDATE players
        SET hpoints = ?,
            spoints = ?
        WHERE id = ?
      `,
      [p.maxhp, p.maxspoints, playerId]
    );

    // =======================
    // STARTER KIT
    // =======================
    // Give every new player a claimed, unequipped level-1 Base
    // Primitive Hatchet. Using the normal loot generator keeps
    // starter equipment in the same player_items format as all
    // other generated equipment.
    const starterWeapon = await generateLootFromBaseItem({
      playerId,
      baseItemId: 61,       // Primitive Hatchet
      itemLevel: 1,
      sourceType: "starter",
      sourceId: null,
      isClaimed: true,
      rarityOverride: "base"
    });

    if (!starterWeapon) {
      throw new Error("Failed to create starter Primitive Hatchet");
    }

    // Link the generated Primitive Hatchet into the player's inventory.
    // Generated equipment uses player_item_id rather than item_id.
    // Keep it unequipped so the tutorial can teach equipment assignment.
    await db.query(
      `
        INSERT INTO inventory (
          player_id,
          item_id,
          player_item_id,
          quantity,
          equipped
        )
        VALUES (?, NULL, ?, 1, 0)
      `,
      [
        playerId,
        starterWeapon.playerItemId
      ]
    );

    // Give the player five Small Health Potions.
    // They intentionally begin unequipped so the tutorial can
    // teach the player how to assign/equip a potion.
    await db.query(
      `
        INSERT INTO inventory (
          player_id,
          item_id,
          quantity,
          equipped
        )
        VALUES (?, ?, ?, 0)
      `,
      [
        playerId,
        1, // Small Health Potion
        5
      ]
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
