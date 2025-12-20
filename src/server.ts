import express from "express";
import session from "express-session";

import shopRoutes from "./shop.routes";
import authRoutes from "./auth.routes";
import playerRoutes from "./player.routes";
import trainerRoutes from "./trainer.routes";
import churchRoutes from "./church.routes";
import travelRoutes from "./travel.routes";
import equipmentRoutes from "./equipment.routes";
import guildRoutes from "./guild.routes";
import worldRoutes from "./world.routes";
import townRoutes from "./town.routes";
import inventoryRoutes from "./inventory.routes";
import combatRoutes from "./combat.routes";
import chatRoutes from "./chat.routes";



import { db } from "./db";

const app = express();
const PORT = 3000;


// =======================
// MIDDLEWARE
// =======================
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: "guildforge_secret_change_me",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.use(shopRoutes);
app.use(equipmentRoutes);
app.use(guildRoutes);
app.use("/api", authRoutes);
app.use(playerRoutes);
app.use("/trainer", trainerRoutes);
app.use("/church", churchRoutes);
app.use("/travel", travelRoutes);
app.use(worldRoutes);
app.use(townRoutes);
app.use(inventoryRoutes);
app.use(combatRoutes);
app.use(chatRoutes);


// =======================
// GLOBAL DEATH CHECK
// =======================
app.use(async (req, res, next) => {

  // Ignore static files
  if (
    req.path.startsWith("/public") ||
    req.path.endsWith(".css") ||
    req.path.endsWith(".js") ||
    req.path.endsWith(".png") ||
    req.path.endsWith(".jpg") ||
    req.path.endsWith(".ico")
  ) {
    return next();
  }

  // Allow routes that handle death / login
  const allowed = [
    "/login.html",
    "/auth/login",
    "/auth/register",
    "/church",
    "/death"
  ];

  if (allowed.some(path => req.path.startsWith(path))) {
    return next();
  }

  // Must be logged in
  const pid = (req.session as any).playerId;
  if (!pid) return next();

  // Fetch health
  const [[life]]: any = await db.query(
    "SELECT hpoints FROM players WHERE id=?",
    [pid]
  );

  // Force church if dead
  if (life && life.hpoints <= 0) {
    return res.redirect("/death");
  }

  next();
});


// =======================
// TEST ROUTE
// =======================
app.get("/api/test", (req, res) => {
  res.json({ status: "API OK" });
});

// =======================
// MAIN PAGE
// =======================
app.get("/", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  const [[player]]: any = await db.query(
    "SELECT name,level,pclass,location,gold FROM players WHERE id=?",
    [pid]
    
  );
if (player.location === "world") {
  return res.redirect("/world");
}

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Guildforge</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
<style>
body { background:#050509; color:#f5e6b2; font-family:Cinzel,serif; text-align:center; }
a { display:block; margin:10px; color:gold; font-size:18px; text-decoration:none; }
.panel { width:420px; margin:80px auto; padding:20px; border:1px solid gold; background:rgba(0,0,0,.7); border-radius:10px; }
</style>
</head>
<body>
<div id="statpanel-root"></div>
<div class="panel">
<h2>${player.name}</h2>
<p>${player.pclass} – Level ${player.level}</p>
<p>Location: ${player.location}</p>
<p>Gold: ${player.gold}</p>
<a href="/equipment" class="char-btn">Equipment</a>
<hr>

<a href="/world">🌍 World Map</a>
<a href="/inventory">🎒 Inventory</a>
<a href="/quests">📜 Quest Log</a>
<a href="/church">⛪ Sanctuary of Light</a>
<a href="/combat">⚔ Arena</a>
${player.location !== "world" ? `
  <a href="/shop">Shop</a>
  <a href="/trainer">Spell Trainer</a>
` : ""}

</div>

</body>
<link rel="stylesheet" href="/statpanel.css">
<script src="/statpanel.js"></script>
<script>
<script src="/world-chat.js"></script>


</html>
`);
});


// =======================
// INVENTORY
// =======================
app.get("/inventory", async (req,res)=>{
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  const [items]:any = await db.query(
    "SELECT name,type,rarity FROM inventory WHERE player_id=?",
    [pid]
  );

  const rows = items.map((i:any)=>`
    <tr><td>${i.name}</td><td>${i.type}</td><td>${i.rarity}</td></tr>
  `).join("");

  res.send(`
<h2>Inventory</h2>
<table border=1>${rows || "<tr><td colspan=3>Empty</td></tr>"}</table>
<a href="/">Return</a>
`);
});

// =======================
// QUEST LOG
// =======================
app.get("/quests", async(req,res)=>{
  const pid = (req.session as any).playerId;
  const [rows]:any = await db.query(`
    SELECT q.title,pq.status
    FROM player_quests pq
    JOIN quests q ON q.id=pq.quest_id
    WHERE pq.player_id=?`, [pid]
  );
  res.send(`<h2>Quest Log</h2>` + rows.map((q:any)=>`${q.title} - ${q.status}<br>`).join("") + `<a href="/">Return</a>`);
});
// =======================
// LEVEL UP
// =======================
app.get("/levelup", async (req,res)=>{
  const pid = (req.session as any).playerId;
  if(!pid) return res.redirect("/login.html");

  const [[player]]:any = await db.query(`
    SELECT level, stat_points, attack, defense, agility, vitality, intellect
    FROM players WHERE id=?
  `,[pid]);

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Level Up</title>
<link rel="stylesheet" href="/levelup.css">
</head>
<body>

<h2>LEVEL UP</h2>
<p>Points available: ${player.stat_points}</p>

<form method="POST" action="/levelup">
<table>
<tr><td>Attack</td><td>${player.attack} <button name="stat" value="attack">+</button></td></tr>
<tr><td>Defense</td><td>${player.defense} <button name="stat" value="defense">+</button></td></tr>
<tr><td>Agility</td><td>${player.agility} <button name="stat" value="agility">+</button></td></tr>
<tr><td>Vitality</td><td>${player.vitality} <button name="stat" value="vitality">+</button></td></tr>
<tr><td>Intellect</td><td>${player.intellect} <button name="stat" value="intellect">+</button></td></tr>
</table>

<br>
<a href="/">Done</a>
</form>

</body>
</html>
`);
});

app.post("/levelup", async (req,res)=>{
  const pid = (req.session as any).playerId;
  const { stat } = req.body;

  if(!["attack","defense","agility","vitality","intellect"].includes(stat))
    return res.send("Invalid stat.");

  const [[player]]:any = await db.query("SELECT stat_points FROM players WHERE id=?", [pid]);

  if (player.stat_points <= 0) return res.send("No stat points available.");

  await db.query(`
    UPDATE players
    SET ${stat} = ${stat} + 1,
        stat_points = stat_points - 1
    WHERE id=?
  `,[pid]);

  res.redirect("/levelup");
});

// =======================
// DEATH SCREEN
// =======================
app.get("/death", async (req, res) => {

  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  // Do NOT restore HP here
  // Only clear battle
  await db.query("DELETE FROM player_creatures WHERE player_id=?", [pid]);

  // Move player to church but KEEP HP=0
  await db.query(`
    UPDATE players
    SET location = 'Sanctuary of Light'
    WHERE id=?
  `, [pid]);

  res.sendFile(process.cwd() + "/public/death.html");
});








// =======================
// START
// =======================
app.listen(PORT,()=>{
  console.log("Guildforge engine running at http://localhost:3000");
});
