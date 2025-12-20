console.log("✅ THIS FILE IS ACTIVE: combat.routes.ts");
console.log("PATH:", __filename);

import express from "express";
import { db } from "./db";
import { resolveDamage } from "./combatService";
import { getPlayerWithEquipment } from "./services/playerService";

console.log("🔥 COMBAT ROUTES LOADED");
console.log("FILE PATH:", __filename);

const router = express.Router();

// =========================
// COMBAT PAGE UI
// =========================
router.get("/combat", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");
  console.log("✅ /combat route hit");
  const p = await getPlayerWithEquipment(pid);
  console.log("⚔ COMBAT STATS USED:", {
  attack: p.attack,
  defense: p.defense,
  agility: p.agility,
  vitality: p.vitality,
  crit: p.crit
  
});



  let [[e]]: any = await db.query(
    `
    SELECT pc.id AS battle_id, pc.hp, c.*
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.player_id = ? LIMIT 1
  `,
    [pid]
  );

  if (!e) {
    const [[c]]: any = await db.query(
      "SELECT * FROM creatures ORDER BY RAND() LIMIT 1"
    );

    await db.query(
      "INSERT INTO player_creatures (player_id, creature_id, hp) VALUES (?, ?, ?)",
      [pid, c.id, c.maxhp]
    );

    const [[n]]: any = await db.query(
      `
      SELECT pc.id AS battle_id, pc.hp, c.*
      FROM player_creatures pc
      JOIN creatures c ON c.id = pc.creature_id
      WHERE pc.player_id = ? LIMIT 1
    `,
      [pid]
    );

    e = n;
  }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Arena</title>
  <link rel="stylesheet" href="/statpanel.css">
  <link rel="stylesheet" href="/combat.css">
  <script src="/statpanel.js"></script>
</head>

<body>

<div id="statpanel-root"></div>

<div class="combat-container">

<h2>⚔ Arena</h2>

<div class="fighter">
  <b>${p.name}</b> HP:
  <span id="pText">${p.hpoints}</span> / ${p.maxhp}
</div>

<div class="fighter">
  <b>${e.name}</b> HP:
  <span id="eText">${e.hp}</span> / ${e.maxhp}
</div>

<div id="log"></div>

<div class="actions">
  <button onclick="attack()">⚔ Attack</button>
  <button onclick="spells()">🔮 Spells</button>
  <button onclick="items()">🎒 Items</button>
  <button onclick="flee()">🏃 Flee</button>
</div>

<script>
const battleId = ${e.battle_id};
</script>

<script src="/combat.js"></script>

</div>
</body>
</html>`);
});

// =========================
// ATTACK
// =========================
router.post("/api/combat/attack", async (req, res) => {
  console.log("🔥 ATTACK ROUTE HIT");
  const pid = (req.session as any).playerId;
    const p = await getPlayerWithEquipment(pid);
    console.log("EQUIPPED CHECK:", p);
  const { battleId } = req.body;
  console.log("⚔ COMBAT STATS:", {
  attack: p.attack,
  defense: p.defense,
  vitality: p.vitality,
  crit: p.crit,
  maxhp: p.maxhp
});


  if (!pid) return res.json({ error: "Not logged in" });

  
  const [[e]]: any = await db.query(
    `
    SELECT c.defense, c.attack
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.id=?
  `,
    [battleId]
  );

  if (!e) {
    console.log("No enemy found in ATTACK for battleId", battleId);
    return res.json({ dead: true });
  }

  const pHit = Math.max(1, Math.floor(p.attack * 1.2 - e.defense * 0.7));
  const retaliation = Math.max(1, Math.floor(e.attack * 1.1 - p.defense * 0.6));

  console.log("ATTACK: pHit =", pHit, "retaliation =", retaliation);

const result = await resolveDamage({
  pid,
  battleId,
  damage: pHit,
  crit: p.crit,
});


  let playerHP = p.hpoints;

  // Enemy hits back if alive
  if (!result.dead) {
    await db.query(
      "UPDATE players SET hpoints = GREATEST(0, hpoints - ?) WHERE id=?",
      [retaliation, pid]
    );

    const [[updatedPlayer]]: any = await db.query(
      "SELECT hpoints, maxhp FROM players WHERE id=?",
      [pid]
    );
    playerHP = updatedPlayer.hpoints;

    if (playerHP <= 0) {
      await db.query("DELETE FROM player_creatures WHERE id=?", [battleId]);
      console.log("Player died from retaliation");
      return res.json({ playerDead: true, retaliation });
    }
  } else {
    // Enemy dead, reload player hp to return to client
    const [[updatedPlayer]]: any = await db.query(
      "SELECT hpoints, maxhp FROM players WHERE id=?",
      [pid]
    );
    playerHP = updatedPlayer.hpoints;
  }

  res.json({
    ...result,
    retaliation: result.dead ? 0 : retaliation,
    playerHP,
    maxHP: p.maxhp,
  });
});

// =========================
// FLEE
// =========================
router.post("/api/combat/flee", async (req, res) => {
  const pid = (req.session as any).playerId;

  await db.query("DELETE FROM player_creatures WHERE player_id=?", [pid]);
  res.json({ fled: true });
});

// =========================
// SPELL LIST
// =========================
router.get("/api/combat/spells", async (req, res) => {
  const pid = (req.session as any).playerId;

  const [spells]: any = await db.query(
    `
    SELECT s.id, s.name, s.cost, s.damage
    FROM player_spells ps
    JOIN spells s ON s.id = ps.spell_id
    WHERE ps.player_id = ?
  `,
    [pid]
  );

  res.json(spells);
});

// =========================
// CAST SPELL
// =========================
router.post("/api/combat/cast", async (req, res) => {
  const pid = (req.session as any).playerId;
  const { spellId, battleId } = req.body;

  if (!pid) return res.json({ error: "Not logged in" });

  console.log("CAST route called. PID:", pid, "battleId:", battleId, "spellId:", spellId);

  const [[spell]]: any = await db.query(
    "SELECT cost, damage FROM spells WHERE id=?",
    [spellId]
  );
  if (!spell) return res.json({ error: "Spell not found" });

  // Check SP
  const [[player]]: any = await db.query(
    "SELECT spoints FROM players WHERE id=?",
    [pid]
  );
  if (player.spoints < spell.cost) {
    return res.json({ error: "Not enough SP" });
  }

  const dmg = spell.damage || 10;
  console.log("CAST: damage =", dmg);

  const result = await resolveDamage({
    pid,
    battleId,
    damage: dmg,
    spendSP: spell.cost,
  });

  res.json(result);
});

// =========================
// ITEMS (IN-COMBAT VIEW)
// =========================
router.get("/api/combat/items", async (req, res) => {
  const pid = (req.session as any).playerId;

  const [items]: any = await db.query(
    `
    SELECT
      pi.id,
      i.name,
      pi.quantity
    FROM player_items pi
    JOIN items i ON i.id = pi.item_id
    WHERE pi.player_id = ?
  `,
    [pid]
  );

  res.json(items);
});

// =========================
// USE ITEM (IN COMBAT)
// =========================
router.post("/api/combat/use", async (req, res) => {
  const pid = (req.session as any).playerId;
  const { randid } = req.body;

  if (!pid) return res.json({ error: "Not logged in" });

  const [[row]]: any = await db.query(
    `
    SELECT
      pi.quantity,
      i.type,
      i.value
    FROM player_items pi
    JOIN items i ON i.id = pi.item_id
    WHERE pi.id = ? AND pi.player_id = ?
  `,
    [randid, pid]
  );

  if (!row) return res.json({ error: "Item not found." });

  // Decrement / delete stack
  if (row.quantity > 1) {
    await db.query(
      `
      UPDATE player_items
      SET quantity = quantity - 1
      WHERE id = ?
    `,
      [randid]
    );
  } else {
    await db.query(
      `
      DELETE FROM player_items
      WHERE id = ?
    `,
      [randid]
    );
  }

  if (row.type === "potion") {
    await db.query(
      `
      UPDATE players
      SET hpoints = LEAST(maxhp, hpoints + ?)
      WHERE id = ?
    `,
      [row.value || 20, pid]
    );

    const [[player]]: any = await db.query(
      "SELECT hpoints, maxhp FROM players WHERE id=?",
      [pid]
    );

    return res.json({
      used: true,
      itemType: row.type,
      value: row.value || 20,
      hp: player.hpoints,
      maxhp: player.maxhp,
    });
  } else {
    return res.json({ error: "Item cannot be used in combat." });
  }
});

export default router;
