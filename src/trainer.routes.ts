import express from "express";
import { db } from "./db";

const router = express.Router();

// =======================
// SPELL TRAINER PAGE
// =======================
router.get("/", async (req, res) => {

  const pid = req.session.playerId;
  if (!pid) return res.redirect("/login.html");

  // Player class, gold, level
  const [[player]]: any = await db.query(
    "SELECT pclass, gold, level FROM players WHERE id=?",
    [pid]
  );

  // Available spells by class
  const [spells]: any = await db.query(
    "SELECT * FROM spells WHERE sclass = ? OR sclass = 'any'",
    [player.pclass]
  );

  // Learned spells
  const [known]: any = await db.query(
    "SELECT spell_id FROM player_spells WHERE player_id=?",
    [pid]
  );

  const knownIds = known.map((s:any)=>s.spell_id);

const rows = spells.map((s:any)=>{

  const learned = knownIds.includes(s.id);
  const canAfford = player.gold >= s.price;
  const meetsLevel = player.level >= s.level;

  let action = "";

  if (learned) {
    action = `<span style="color:lime;">Learned</span>`;
  } else if (!meetsLevel) {
    action = `<span style="color:orange;">Requires level ${s.level}</span>`;
  } else if (!canAfford) {
    action = `<span style="color:red;">Not enough gold</span>`;
  } else {
    action = `<a href="/trainer/learn/${s.id}" class="buy">Learn</a>`;
  }

  return `
    <tr>
      <td>${s.name}</td>
      <td>${s.description}</td>
      <td>${s.price}</td>
      <td>${action}</td>
    </tr>
  `;
}).join("");

res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Spell Trainer</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
<style>

body {
  margin:0;
  padding:0;
  background: radial-gradient(circle at top, #120b06, #030202);
  color: gold;
  font-family: Cinzel, serif;
}

/* PANEL */
.panel {
  width: 680px;
  margin: 80px auto;
  padding: 22px;
  background: linear-gradient(#100700, #040200);
  border: 2px solid gold;
  border-radius: 14px;
  box-shadow: 0 0 20px rgba(255,215,0,.4);
}

/* HEADER */
.panel h2 {
  margin-top: 0;
  margin-bottom: 8px;
  font-size: 26px;
  text-align:center;
}
.panel .sub {
  text-align:center;
  font-size:13px;
  color:#c9b57e;
}

/* SPELL LIST */
.spell {
  display: grid;
  grid-template-columns: 160px 1fr 90px 120px;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid rgba(255,215,0,.2);
}
.spell:has(.locked) {
  opacity: 0.75;
}

/* NAME */
.spell .name {
  font-size: 16px;
  text-align:left;
}

/* DESCRIPTION */
.spell .desc {
  font-size: 13px;
  color: #bbb;
  text-align:left;
}

/* PRICE */
.spell .price {
  font-size: 14px;
  text-align:center;
}

/* ACTIONS */
.learnBtn {
  background: linear-gradient(#4834d4, #1a237e);
  border: 2px solid #a29bfe;
  color: #e0e0ff;
  font-family: Cinzel, serif;
  font-weight: bold;
  cursor: pointer;
  border-radius: 6px;
  padding: 6px 8px;
  text-align:center;
  text-decoration:none;
  display:inline-block;
  transition:0.15s;
}

.learnBtn:hover {
  box-shadow: 0 0 10px #a29bfe;
  transform: scale(1.05);
}

.locked {
  color: red;
  font-size:13px;
  opacity: 0.85;
}
.learned {
  color: lime;
  font-size:13px;
  font-weight:bold;
}

.returnBtn {
  margin-top: 14px;
  width: 100%;
  padding: 8px;
  font-size: 15px;
  background:#6b4226;
  color:white;
  border:2px solid gold;
  cursor:pointer;
  border-radius:6px;
}

.returnBtn:hover {
  box-shadow:0 0 10px gold;
}

</style>
</head>
<body>

<div class="panel">
<h2>Spell Trainer</h2>
<div class="sub">Available spells for the ${player.pclass}</div>

<hr>

${spells.map((s:any)=>{

  const learned = knownIds.includes(s.id);
  const canAfford = player.gold >= s.price;
  const meetsLevel = player.level >= s.level;

  let action = "";

  if (learned) {
    action = `<span class="learned">✅ Mastered</span>`;
  }
  else if (!meetsLevel) {
    action = `<span class="locked">🔒 Level ${s.level} Required</span>`;
  }
  else if (!canAfford) {
    action = `<span class="locked">💸 Insufficient Gold</span>`;
  }
  else {
    action = `<a class="learnBtn" href="/trainer/learn/${s.id}">📜 Train Spell</a>`;
  }

  return `
    <div class="spell">
      <div class="name">${s.name}</div>
      <div class="desc">${s.description || "A mysterious spell..."}</div>
      <div class="price">💰 ${s.price}</div>
      <div>${action}</div>
    </div>
  `;
}).join("")}


<button class="returnBtn" onclick="location.href='/town'">⬅ Return to Town</button>

</div>

</body>
</html>
`);



});


// =======================
// LEARN SPELL
// =======================
router.get("/learn/:id", async (req, res) => {

  const pid = req.session.playerId;
  const sid = Number(req.params.id);

  if (!pid) return res.redirect("/login.html");

const [[player]]: any = await db.query(
  "SELECT gold, level FROM players WHERE id=?",
  [pid]
);


const [[spell]]: any = await db.query(
  "SELECT * FROM spells WHERE id=?",
  [sid]
);

if (!spell) return res.send("Spell not found");

const [[exists]]: any = await db.query(
  "SELECT id FROM player_spells WHERE player_id=? AND spell_id=?",
  [pid, sid]
);

if (exists) return res.redirect("/trainer");

// 🔒 LEVEL CHECK
if (player.level < spell.level) {
  return res.send(`You must be level ${spell.level} to learn this spell.`);
}

if (player.gold < spell.price)
  return res.send("Not enough gold");

  // Pay
  await db.query(
    "UPDATE players SET gold = gold - ? WHERE id=?",
    [spell.price, pid]
  );

  // Learn
  await db.query(
    "INSERT INTO player_spells (player_id, spell_id) VALUES (?, ?)",
    [pid, sid]
  );

  res.redirect("/trainer");
});

export default router;
