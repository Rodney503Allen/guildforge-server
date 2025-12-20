import express from "express";
import { db } from "./db";
import { getPlayerWithEquipment } from "./services/playerService";

const router = express.Router();
const directions:any = {
  north: [0,-1],
  south: [0,1],
  west: [-1,0],
  east: [1,0]
};

// =======================
// WORLD VIEW
// =======================
router.get("/world", async (req,res)=>{
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  const [guilds]:any = await db.query("SELECT id,name FROM guilds");
  const guildMap:any = {};
  guilds.forEach((g:any)=>guildMap[g.id]=g.name);

  const [[player]]:any = await db.query("SELECT map_x,map_y FROM players WHERE id=?", [pid]);

const minX = player.map_x - 3;
const maxX = player.map_x + 3;
const minY = player.map_y - 3;
const maxY = player.map_y + 3;


  const [tiles]:any = await db.query(`
    SELECT * 
    FROM world_map
    WHERE x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
  `,[minX,maxX,minY,maxY]);

  const [[enemy]]: any = await db.query(`
    SELECT pc.id, pc.hp, c.*
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.player_id=? LIMIT 1
  `, [pid]);

  interface WorldTile {
    x: number;
    y: number;
    terrain: string;
    region_name: string;
    controlling_guild_id?: number;
  }

  const currentTile = tiles.find(
    (t: WorldTile) => t.x === player.map_x && t.y === player.map_y
  );

  

  const tileMap:any = {};
  tiles.forEach((t:any)=> tileMap[`${t.x},${t.y}`] = t);

  let location = null;

if (currentTile.location_id) {
  const [[loc]]: any = await db.query(`
    SELECT id, name FROM locations WHERE id = ?
  `, [currentTile.location_id]);

  location = loc || null;
}
  res.send(`
<html>
<head>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&display=swap" rel="stylesheet">

<style>
html, body {
  width: 100%;
  height: 100%;
  margin: 0;
}

body {
  background:#0a0a0f;
  color:#f5e1a4;
  font-family: Cinzel, serif;

  display: flex;
  flex-direction: column;
  align-items: center;   /* centers horizontally */
}


.world-title { font-size:24px; margin-bottom:10px; }
.coords { font-size:14px; color:#999; }

.grid {
  display:grid;
  grid-template-columns:repeat(7, 70px);
  gap:4px;
  justify-content:center;
  margin: 0 auto;
  width: fit-content;
    margin-left: auto;
  margin-right: auto;
}

.tile {
  width:70px;
  height:70px;
  border:2px solid #222;
  border-radius:6px;
  position:relative;
  font-size:10px;
  box-shadow: inset 0 0 8px #000;
}

.tile.player {
  outline:3px solid gold;
  box-shadow: 0 0 10px gold;
}

.owner {
  position:absolute;
  top:2px;
  left:2px;
  right:2px;
  background:#000;
  color:gold;
  font-size:9px;
}

.region {
  position:absolute;
  bottom:2px;
  left:2px;
  right:2px;
  font-size:9px;
}


.plains {
  background-image: url("/images/map_tiles/plains.png");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.forest {
  background-image: url("/images/map_tiles/forest.png");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.mountain {
  background-image: url("/images/map_tiles/mountain.png");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.swamp {
  background-image: url("/images/map_tiles/swamp.png");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.town {
  background-image: url("/images/map_tiles/town.png");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.castle {
  background-image: url("/images/map_tiles/castle.png");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}  
.desert {
  background-image: url("/images/map_tiles/desert.png");
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
} 



#statpanel-root { max-width:420px; margin:12px auto; }

#statpanel {
  background: linear-gradient(#100800, #050200);
  border: 2px solid gold;
  border-radius:10px;
}

.combat-actions button {
  width:100%;
  padding:8px;
  background:black;
  color:darkred;
  border:1px solid darkred;
}
.world-layout {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: 20px;

  width: fit-content;
  margin: 10px auto;
}

.world-left {
  display: flex;
  flex-direction: column;
}

.world-right {
  width: 260px;
  display: flex;
  flex-direction: column;

}
#statpanel-root {
  position: relative;
  z-index: 5;
}
#worldUI {
  position: relative;
  left: 0;
  transform: none;
    display: flex;
  justify-content: center;
  width: 100%;
}

.movement-grid {
  margin: 0 auto;
  text-align: center;
}

#combatAnchor {
  width: fit-content;
  margin: 0 auto;
  transform: translateX(130px);
}

.world-layout {
  justify-content: center;
  margin-left: auto;
  margin-right: auto;
}

#enterBox {
  text-align: center;
  margin: 8px 0;
}
  /* ✨ WORLD MAP FANTASY FRAME ✨ */
#Grid {
  padding: 14px;
  background: linear-gradient(135deg, #2a1f12, #0b0703);
  border: 4px solid #c9a44c;
  border-radius: 14px;

  box-shadow:
    inset 0 0 25px rgba(255, 215, 128, 0.15),
    0 0 24px rgba(255, 190, 90, 0.35),
    0 0 6px rgba(255, 255, 255, 0.15);

  position: relative;
}

/* GLOW RUNE EFFECT */
#Grid::before {
  content: "";
  position: absolute;
  inset: -10px;
  border-radius: 18px;
  background:
    linear-gradient(45deg,
      rgba(255,215,150,.15),
      rgba(255,170,60,.0),
      rgba(255,215,150,.15)
    );

  pointer-events: none;
}

/* MAP LABEL STYLE */
.world-title {
  font-size: 26px;
  color: gold;
  text-shadow: 0 0 12px rgba(255,215,140,.5);
}

</style>
</head>

<body>
<div class="world-title">World Map</div>
<div class="coords">Position: (${player.map_x}, ${player.map_y})</div>


<div id="worldUI" class="world-layout">
<div id="combatAnchor">
    <div class="grid" id="Grid">
${Array.from({length:7}).map((_,row)=>{
  const y = minY + row;
  return Array.from({length:7}).map((_,col)=>{
    const x = minX + col;
    const t = tileMap[`${x},${y}`];
    if (!t) return `<div class="tile">Void</div>`;

    const owner = t.controlling_guild_id ? guildMap[t.controlling_guild_id] || "Unknown" : "Neutral";
    const isPlayer = (x === player.map_x && y === player.map_y);

    return `<div class="tile ${t.terrain} ${isPlayer?'player':''}">
      <div class="owner">${owner}</div>
      <div class="region">${t.region_name}</div>
    </div>`;
    
  }).join("");
}).join("")}
</div> <!-- grid -->
</div <!-- Combat Anchor -->

    <div class="world-right">
      <div id="statpanel-root"></div>
    </div>

</div> <!-- world-layout -->

<script>
window.worldEnemy = ${JSON.stringify(enemy || null)};
</script>

<link rel="stylesheet" href="/statpanel.css">
<script src="/statpanel.js"></script>

<script>
fetch("/statpanel.html")
  .then(r => r.text())
  .then(html => {
    document.getElementById("statpanel-root").innerHTML = html;
  });
</script>

<script src="/world-combat.js"></script>
<script src="/world-chat.js"></script>
</body>
</html>
`);
});


// =======================
// FLEE FROM COMBAT
// =======================
router.post("/api/world/flee", async (req, res) => {
  const pid = (req.session as any).playerId;
  await db.query("DELETE FROM player_creatures WHERE player_id=?", [pid]);
  res.json({ success: true });
});


// =======================
// MOVE
// =======================
router.get("/world/move/:dir", async (req, res) => {

  const pid = (req.session as any).playerId;
  const { dir } = req.params;

  if (!directions[dir]) return res.json({ success:false });

  const [[activeEnemy]]: any = await db.query(
    "SELECT id FROM player_creatures WHERE player_id=?",
    [pid]
  );
  if (activeEnemy) return res.json({ success:false, reason:"combat" });

  const [[player]]: any = await db.query("SELECT map_x,map_y FROM players WHERE id=?", [pid]);
  const [dx,dy] = directions[dir];

  const newX = player.map_x + dx;
  const newY = player.map_y + dy;

  const [[tile]]: any = await db.query(
    "SELECT * FROM world_map WHERE x=? AND y=?",
    [newX,newY]
  );


  if (!tile) return res.json({ success:false });

  await db.query("UPDATE players SET map_x=?, map_y=? WHERE id=?", [newX,newY,pid]);

  const [[playerStats]]: any = await db.query("SELECT level FROM players WHERE id=?", [pid]);

  if (Math.random() < 0.28) {
    const [candidates]:any = await db.query(`
      SELECT * FROM creatures
      WHERE (terrain=? OR terrain='any' OR terrain IS NULL)
        AND min_level<=?
        AND max_level>=?
      ORDER BY base_spawn_chance DESC LIMIT 8
    `,[tile.terrain,playerStats.level,playerStats.level]);

    for (const enemy of candidates) {

      const rarityWeight:any = {
        common:1, rare:0.35, elite:0.15, boss:0.05, legendary:0.02
      };

      let weight = rarityWeight[enemy.rarity] || 0.1;
      if (enemy.terrain === tile.terrain) weight *= 1.25;

      if (Math.random() < enemy.base_spawn_chance * weight) {

        await db.query(`
          INSERT INTO player_creatures (player_id, creature_id, hp)
          VALUES (?,?,?)
        `,[pid,enemy.id,enemy.maxhp]);

        break;
      }
    }
  }
let location = null;

if (tile.location_id) {
  const [[loc]]: any = await db.query(`
    SELECT id, name FROM locations WHERE id = ?
  `, [tile.location_id]);

  location = loc || null;
}

  

// =================================================
// =================================================
// LOAD NEW ENEMY
const [[newEnemy]]: any = await db.query(`
  SELECT pc.id, pc.hp, c.*
  FROM player_creatures pc
  JOIN creatures c ON c.id = pc.creature_id
  WHERE pc.player_id=? LIMIT 1
`, [pid]);

// =================================================
// FIRST STRIKE
// =================================================
if (newEnemy) {

  const enemyAttack = Number(newEnemy.attack || 1);

  const enemyDamage = Math.max(1,
    Math.floor(enemyAttack * 0.8)
  );

  await db.query(`
    UPDATE players
    SET hpoints = GREATEST(0, hpoints - ?)
    WHERE id = ?
  `, [enemyDamage, pid]);

  newEnemy.firstStrike = enemyDamage;
}
// ✅ SEND RESPONSE (ONCE!)
res.json({
  success: true,
  enemy: newEnemy || null,
  location: location || null,
  map_x: newX,
  map_y: newY
});
});

// =================================================
// ENTER LOCATION
// =================================================
router.get("/world/enter/:locationId", async (req, res) => {

  const pid = (req.session as any).playerId;
  const locationId = req.params.locationId;

  if (!pid) {
    return res.json({ success: false, error: "Not logged in." });
  }

  // Load player position
  const [[player]]: any = await db.query(`
    SELECT map_x, map_y
    FROM players
    WHERE id = ?
  `, [pid]);

  // Load location by ID
  const [[location]]: any = await db.query(`
    SELECT *
    FROM locations
    WHERE id = ?
  `, [locationId]);

  if (!location) {
    return res.json({ success:false, error: "Location not found." });
  }

  // Make sure player is standing on it
  if (
    location.map_x !== player.map_x ||
    location.map_y !== player.map_y
  ) {
    return res.json({ success:false, error: "You are not at this location." });
  }

  // ✅ SUCCESS — Redirect to town
  return res.json({
    success: true,
    redirect: `/town/`
  });

});
// =======================
// ENEMY AUTO ATTACK API
// =======================
router.post("/api/world/enemy-attack", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.json({ stop: true });

  // Load enemy attached to this player
  const [[enemy]]: any = await db.query(`
    SELECT pc.id, pc.hp, c.attack, c.name
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.player_id = ?
    LIMIT 1
  `, [pid]);

  if (!enemy) {
    return res.json({
      stop: true,
      log: "🛑 Combat ended."
    });
  }

  // Basic damage formula
  const raw = Number(enemy.attack || 1);
  const damage = Math.max(1, Math.floor(raw * 0.75));

  // Apply to player
  await db.query(`
    UPDATE players
    SET hpoints = GREATEST(0, hpoints - ?)
    WHERE id = ?
  `, [damage, pid]);

  const [[player]]: any = await db.query(
    "SELECT hpoints, maxhp FROM players WHERE id = ?",
    [pid]
  );

  if (player.hpoints <= 0) {
    return res.json({
      dead: true,
      stop: true,
      log: `☠ ${enemy.name} hits you for ${damage}. You were slain.`,
      playerHP: player.hpoints
    });
  }

  return res.json({
    log: `👹 ${enemy.name} hits you for ${damage} damage.`,
    playerHP: player.hpoints
  });
});


// =======================
// PARTIAL MAP REFRESH
// =======================
router.get("/world/partial", async (req, res) => {

  const pid = (req.session as any).playerId;

  const [[player]]: any = await db.query("SELECT map_x, map_y FROM players WHERE id=?", [pid]);

  const minX = player.map_x-3, maxX = player.map_x+3;
  const minY = player.map_y-3, maxY = player.map_y+3;

  const [tiles]:any = await db.query(`
    SELECT * FROM world_map
    WHERE x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
  `,[minX,maxX,minY,maxY]);

  const [guilds]:any = await db.query("SELECT id,name FROM guilds");
  const guildMap:any = {};
  guilds.forEach((g:any)=> guildMap[g.id]=g.name);

  const tileMap:any = {};
  tiles.forEach((t:any)=> tileMap[`${t.x},${t.y}`]=t);

  const html = `
<div class="grid" id="Grid">
${
Array.from({length:7}).map((_,row)=>{
  const y = minY + row;
  return Array.from({length:7}).map((_,col)=>{
    const x = minX + col;
    const t = tileMap[`${x},${y}`];
    if (!t) return '<div class="tile">Void</div>';

    const owner = t.controlling_guild_id ? guildMap[t.controlling_guild_id] : "Neutral";
    const isPlayer = (x===player.map_x && y===player.map_y);

    return `<div class="tile ${t.terrain} ${isPlayer?'player':''}">
      <div class="owner">${owner}</div>
      <div class="region">${t.region_name}</div>
    </div>`;

  }).join("");
}).join("")
}
</div>`;

  res.send(html);
});


// =======================
// COMBAT API + LOOT (CLEAN & FIXED)
// =======================
router.post("/api/world/combat", async (req, res) => {

  const pid = (req.session as any).playerId;
  const { spellId, damage = 0 } = req.body;

  if (!pid) return res.status(401).json({ error: "Not logged in" });

  // ============================
  // LOAD PLAYER
  // ============================
const p = await getPlayerWithEquipment(pid);

  // ============================
  // LOAD ENEMY (IF EXISTS)
  // ============================
  const [[enemy]]: any = await db.query(`
    SELECT pc.id, pc.hp, c.exper, c.name
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.player_id=? LIMIT 1
  `, [pid]);

  // ============================
  // IF SPELL CAST
  // ============================
  if (spellId) {

    const [[spell]]: any = await db.query(`
      SELECT *
      FROM spells
      WHERE id = ?
    `, [spellId]);

    if (!spell) return res.json({ error: "Spell not found." });
    if (p.spoints < spell.scost) return res.json({ error: "Not enough SP." });

    // ============================
    // COMBAT SPELLS
    // ============================
    if (spell.is_combat) {

      if (!enemy) return res.json({ error: "No enemy to target." });

      const dmg = spell.svalue;
      const newHP = enemy.hp - dmg;

      await db.query(`
        UPDATE players SET spoints = spoints - ?
        WHERE id=?
      `, [spell.scost, pid]);

      // ✅ ENEMY DEAD
      if (newHP <= 0) {

        const exp = enemy.exper || 20;
        const gold = Math.floor(Math.random() * 20) + 10;
        const loot = await dropRandomItem(pid);

        await db.query(`
          UPDATE players SET exper = exper + ?, gold = gold + ?
          WHERE id=?
        `, [exp, gold, pid]);

        await db.query("DELETE FROM player_creatures WHERE id=?", [enemy.id]);

        return res.json({
          dead: true,
          log: `🔥 ${spell.name} obliterates ${enemy.name}!`,
          loot, gold, exp
        });
      }

      // ✅ DAMAGE ONLY
      await db.query("UPDATE player_creatures SET hp=? WHERE id=?", [newHP, enemy.id]);

      return res.json({
        log: `✨ ${spell.name} hits for ${dmg} damage.`,
        enemyHP: newHP
      });
    }

    // ============================
    // NON-COMBAT SPELLS (HEALS)
    // ============================
    if (spell.type === "heal") {

      const healed = spell.svalue;

      await db.query(`
        UPDATE players
        SET spoints = spoints - ?,
            hpoints = LEAST(maxhp, hpoints + ?)
        WHERE id=?
      `, [spell.scost, healed, pid]);

      const [[newState]]: any = await db.query(`
        SELECT hpoints FROM players WHERE id=?
      `, [pid]);

      return res.json({
        log: `💚 ${spell.name} restores ${healed} HP.`,
        playerHP: newState.hpoints
      });
    }

    return res.json({ error: "Spell has no effect." });
  }

  // ============================
  // NORMAL MELEE ATTACK
  // ============================
  if (!enemy)
    return res.json({ dead: true });

  let isCrit = false;

  let finalDamage = Math.max(1, Math.floor(p.attack * 1.1));

  if (Math.random() < p.crit) {
    finalDamage = Math.floor(finalDamage * 1.5);
    isCrit = true;
  }

const newHP = enemy.hp - finalDamage;


  if (newHP <= 0) {

    const exp = enemy.exper || 20;
    const gold = Math.floor(Math.random() * 15) + 5;
    const loot = await dropRandomItem(pid);

    await db.query(`
      UPDATE players
      SET exper = exper + ?, gold = gold + ?
      WHERE id=?
    `, [exp, gold, pid]);

    await db.query("DELETE FROM player_creatures WHERE id=?", [enemy.id]);

    return res.json({
      dead: true,
      exp,
      gold,
      loot,
      pHit: finalDamage,
      pCrit: isCrit,
      enemyHP: 0
    });

  }

  await db.query("UPDATE player_creatures SET hp=? WHERE id=?", [newHP, enemy.id]);

return res.json({
  dead: false,
  enemyHP: newHP,
  pHit: finalDamage,
  pCrit: isCrit
});
});

// =======================
// USE ITEM (INVENTORY) - FINAL FIX
// =======================
router.post("/api/combat/use-item", async (req, res) => {
  try {

    const pid = (req.session as any).playerId;
    const { randid } = req.body;

    if (!pid) return res.json({ error: "Not logged in" });

    // ✅ LOAD INVENTORY ITEM + MASTER ITEM DATA
    const [[item]]: any = await db.query(`
      SELECT
        inv.inventory_id,
        inv.quantity,
        i.name,
        i.category,
        i.effect_type,
        i.effect_value,
        i.effect_target,
        i.is_combat
      FROM inventory inv
      JOIN items i ON i.id = inv.item_id
      WHERE inv.inventory_id = ?
      AND inv.player_id = ?
      LIMIT 1
    `, [randid, pid]);

    if (!item) return res.json({ error: "Item not found." });

    let log = "";
    const update: any = {};

    // ONLY CONSUMABLE ITEMS ARE USABLE
    if (item.category !== "consumable") {
      return res.json({ error: "Item cannot be used." });
    }

    // NORMALIZE STRINGS
    const effect = (item.effect_type || "").toLowerCase().trim();
    const targetRaw = (item.effect_target || "").toLowerCase().trim();

    const target =
      targetRaw === "hp"    ? "hpoints" :
      targetRaw === "mp"    ? "spoints" :
      targetRaw === "mana" ? "spoints" :
      targetRaw === "health" ? "hpoints" :
      targetRaw;

    const amount = Number(item.effect_value || 0);

    // ===== POTIONS =====
    if (effect === "heal") {

      // HP POTION
      if (target === "hpoints") {

        await db.query(`
          UPDATE players
          SET hpoints = LEAST(maxhp, hpoints + ?)
          WHERE id = ?
        `, [amount, pid]);

        const [[player]]: any = await db.query(`
          SELECT hpoints FROM players WHERE id = ?
        `, [pid]);

        update.playerHP = player.hpoints;
        log = `🧪 You used ${item.name} and healed ${amount} HP.`;

      }

      // MANA POTION
      else if (target === "spoints") {

        await db.query(`
          UPDATE players
          SET spoints = LEAST(maxspoints, spoints + ?)
          WHERE id = ?
        `, [amount, pid]);

        const [[player]]: any = await db.query(`
          SELECT spoints FROM players WHERE id = ?
        `, [pid]);

        update.playerSP = player.spoints;
        log = `🔮 You used ${item.name} and restored ${amount} SP.`;

      }

      else {
        console.error("❌ BAD TARGET:", item.effect_target);
        return res.json({ error: "Invalid potion target." });
      }

    } else {
      return res.json({ error: "Consumable has no effect." });
    }

    // ===== CONSUME ITEM =====
    if (item.quantity > 1) {
      await db.query(`
        UPDATE inventory
        SET quantity = quantity - 1
        WHERE inventory_id = ?
      `, [item.inventory_id]);
    } else {
      await db.query(`
        DELETE FROM inventory
        WHERE inventory_id = ?
      `, [item.inventory_id]);
    }

    return res.json({ success: true, log, ...update });

  } catch (err) {
    console.error("🔥 USE ITEM CRASH:", err);
    return res.status(500).json({ error: "Item failed" });
  }
});








// =======================
// GET PLAYER SPELLS
// =======================
router.get("/api/combat/spells", async (req, res) => {

  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json([]);

  // ✅ For now, return ALL spells (later we can restrict by class & level)
  const [spells]: any = await db.query(`
    SELECT *
    FROM spells
    ORDER BY level ASC
  `);

  res.json(spells);
});

 // =======================
// GET PLAYER INVENTORY
// =======================
router.get("/api/combat/items", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json([]);

const [items]: any = await db.query(`
  SELECT 
    inv.inventory_id AS randid,
    inv.quantity,
    inv.durability,
    i.name,
    i.type,
    i.category,
    i.effect_type,
    i.effect_value,
    i.description,
    i.icon,
    i.is_combat
  FROM inventory inv
  JOIN items i ON i.id = inv.item_id
  WHERE inv.player_id = ?
  AND inv.quantity > 0
`, [pid]);

res.json(items);

  } catch (err: any) {
    console.error("🔥 INVENTORY FETCH CRASH:", err);
    res.status(500).json({ error: "Inventory lookup failed" });
  }
});

// =======================
// LOOT SYSTEM
// =======================
async function dropRandomItem(pid:number) {

  if (Math.random() > 0.25) return null;

  const types = ["junk","potion"];
  const tier = Math.random();

  if (tier > 0.9) types.push("weapon","armor","treasure");
  else if (tier > 0.6) types.push("weapon","armor");

  const [loot]:any = await db.query(`
    SELECT id,name FROM items
    WHERE type IN (${types.map(()=>"?").join(",")})
    ORDER BY RAND()
    LIMIT 1
  `, types);

  if (!loot.length) return null;

  const item = loot[0];

const [[existing]]: any = await db.query(`
  SELECT inventory_id, quantity
  FROM inventory
  WHERE player_id = ?
  AND item_id = ?
  LIMIT 1
`, [pid, item.id]);

if (existing) {
  await db.query(`
    UPDATE inventory
    SET quantity = quantity + 1
    WHERE inventory_id = ?
  `, [existing.inventory_id]);
} else {
  await db.query(`
    INSERT INTO inventory (player_id, item_id, quantity)
    VALUES (?, ?, 1)
  `, [pid, item.id]);
}


  return item.name;
}

// =======================
// ENTER LOCATION (TOWN / CASTLE PAGE)
// =======================
router.get("/world/location", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  // Load player position
  const [[player]]: any = await db.query(
    "SELECT map_x, map_y FROM players WHERE id=?",
    [pid]
  );

  // Find current location at that tile
  const [[location]]: any = await db.query(`
    SELECT *
    FROM locations
    WHERE map_x = ? AND map_y = ?
    LIMIT 1
  `, [player.map_x, player.map_y]);

  if (!location) {
    return res.send("<h2>Nothing exists here.</h2><a href='/world'>Return</a>");
  }

  // Display simple menu (we'll improve next)
  res.send(`
    <html>
    <body style="background:#000;color:gold;font-family:serif;text-align:center">
      <h1>${location.name}</h1>
      <p>${location.description || "A place of interest."}</p>

      <br>

      <button onclick="location.href='/world'">Leave</button>

      <hr>

      <h3>Buildings:</h3>
      <div>${location.type}</div>

    </body>

    </html>
  `);
});

//LEGACY MAP COLORS
//.forest { background:#174d2c;}
//.mountain { background:#555; }
//.plains { background:#937b37; }
//.swamp { background:#2f3f2f; }
//.town { background:#1f254d; }
//.castle { background:#3a2a44; }

export default router;