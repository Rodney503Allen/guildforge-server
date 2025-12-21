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
import chatRoutes from "./chat.routes";
import characterRoutes from "./character.routes";
import combatRoutes from "./combat.routes";
import spellRoutes from "./spell.routes";

import { db } from "./db";

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use(chatRoutes);
app.use(characterRoutes);
app.use(combatRoutes);
app.use(spellRoutes);

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
app.get("/", (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  return res.redirect("/town");
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
// LOGOUT
// =======================
app.get("/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Logout error:", err);
      return res.redirect("/");
    }

    // Clear cookie explicitly
    res.clearCookie("connect.sid");

    // Send player back to login screen
    res.redirect("/login.html");
  });
});







// =======================
// START
// =======================
app.listen(PORT,()=>{
  console.log("Guildforge engine running at http://localhost:3000");
});
