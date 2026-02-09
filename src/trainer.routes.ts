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
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Guildforge | Class Trainer</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">

  <style>
    :root{
      --bg0:#07090c;
      --bg1:#0b0f14;
      --panel:#0e131a;
      --panel2:#0a0f15;

      --ink:#d7dbe2;
      --muted:#9aa3af;

      --iron:#2b3440;
      --ember:#b64b2e;
      --blood:#7a1e1e;
      --bone:#c9b89a;

      --shadow: rgba(0,0,0,.60);
      --frame: rgba(255,255,255,.04);
      --glass: rgba(0,0,0,.18);
    }

    *{ box-sizing:border-box; }

    html, body{
      margin:0;
      padding:0;
      color: var(--ink);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;

      background:
        radial-gradient(1100px 600px at 18% 0%, rgba(182,75,46,.12), transparent 60%),
        radial-gradient(900px 500px at 82% 10%, rgba(122,30,30,.08), transparent 55%),
        linear-gradient(180deg, var(--bg1), var(--bg0));
    }

    /* grit overlay */
    body::before{
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      opacity:.10;
      background:
        repeating-linear-gradient(0deg, rgba(255,255,255,.04) 0 1px, transparent 1px 3px),
        repeating-linear-gradient(90deg, rgba(0,0,0,.25) 0 2px, transparent 2px 7px);
      mix-blend-mode: overlay;
    }

    .wrap{
      width: min(980px, 94vw);
      margin: 0 auto;
      padding: 18px 0 28px;
    }

    .panel{
      position:relative;
      margin: 80px auto 0;
      padding: 18px;
      border-radius: 12px;

      border: 1px solid rgba(43,52,64,.95);
      background:
        radial-gradient(900px 260px at 18% 0%, rgba(182,75,46,.12), transparent 60%),
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.20)),
        linear-gradient(180deg, var(--panel), var(--panel2));

      box-shadow: 0 18px 40px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.06);
    }

    .panel::before{
      content:"";
      position:absolute;
      inset:10px;
      pointer-events:none;
      border: 0;
      border-radius: 10px;
    }

    .head{
      position:relative;
      z-index:1;
      display:flex;
      align-items:flex-end;
      justify-content:space-between;
      gap: 14px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(43,52,64,.85);
      margin-bottom: 12px;
    }

    .title{
      text-align:left;
    }

    .title h2{
      margin:0;
      font-family: Cinzel, ui-serif, Georgia, "Times New Roman", serif;
      letter-spacing: 2.2px;
      text-transform: uppercase;
      color: var(--bone);
      font-size: 22px;
      text-shadow:
        0 0 10px rgba(182,75,46,.20),
        0 10px 18px rgba(0,0,0,.85);
    }

    .sub{
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: .6px;
      text-transform: uppercase;
    }

    .pill{
      display:inline-flex;
      align-items:center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      color: var(--ink);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .6px;
      text-transform: uppercase;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
      white-space: nowrap;
    }

    /* List */
    .list{
      position:relative;
      z-index:1;
      display:flex;
      flex-direction:column;
      gap: 10px;
      margin-top: 12px;
    }

    .spell{
      position:relative;
      border-radius: 12px;
      border: 1px solid rgba(43,52,64,.95);
      background:
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.22)),
        linear-gradient(180deg, var(--panel), var(--panel2));
      box-shadow: 0 16px 34px rgba(0,0,0,.60), inset 0 1px 0 rgba(255,255,255,.06);

      padding: 12px;
      display:grid;
      grid-template-columns: 1.1fr 2.2fr auto auto;
      gap: 12px;
      align-items:center;
    }

    .name{
      font-weight: 900;
      letter-spacing: .3px;
      color: var(--bone);
      text-transform: uppercase;
      font-size: 13px;
      text-align:left;
    }

    .desc{
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      text-align:left;
    }

    .price{
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .6px;
      text-transform: uppercase;
      padding: 6px 8px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
      white-space: nowrap;
      text-align:center;
      color: var(--ink);
      min-width: 92px;
    }

    /* Status labels */
    .locked{
      color: #ffd6d6;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .3px;
      text-transform: uppercase;
      padding: 6px 8px;
      border-radius: 10px;
      border: 1px solid rgba(122,30,30,.65);
      background: rgba(0,0,0,.18);
      white-space: nowrap;
      text-align:center;
      min-width: 160px;
    }

    .learned{
      color: #d9ffe6;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .3px;
      text-transform: uppercase;
      padding: 6px 8px;
      border-radius: 10px;
      border: 1px solid rgba(70, 180, 120, .55);
      background: rgba(0,0,0,.18);
      white-space: nowrap;
      text-align:center;
      min-width: 160px;
    }

    /* Learn button (anchor) */
    .learnBtn{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      text-decoration:none;

      border-radius: 10px;
      border: 1px solid rgba(182,75,46,.55);
      background: linear-gradient(180deg, rgba(182,75,46,.92), rgba(122,30,30,.88));
      color: #f3e7db;

      padding: 10px 12px;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .7px;
      text-transform: uppercase;

      cursor:pointer;
      box-shadow: 0 14px 28px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.12);
      transition: transform .12s ease, filter .12s ease;
      min-width: 160px;
      white-space: nowrap;
    }

    .learnBtn:hover{
      filter: brightness(1.06);
      transform: translateY(-1px);
    }

    .learnBtn:active{
      transform: translateY(0) scale(.99);
    }

    .returnBtn{
      width:100%;
      margin-top: 14px;
      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      color: #f3e7db;

      padding: 12px;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .7px;
      text-transform: uppercase;

      cursor:pointer;
      box-shadow: 0 12px 24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
      transition: transform .12s ease, border-color .12s ease;
    }

    .returnBtn:hover{
      border-color: rgba(182,75,46,.45);
      transform: translateY(-1px);
    }

    /* Responsive */
    @media (max-width: 860px){
      .spell{
        grid-template-columns: 1fr;
        gap: 8px;
        align-items:start;
      }
      .price, .locked, .learned, .learnBtn{
        min-width: unset;
        width: 100%;
      }
      .price{ text-align:left; }
    }
  </style>
</head>

<body>
  <div id="statpanel-root"></div>

  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>

  <div class="wrap">
    <div class="panel">
      <div class="head">
        <div class="title">
          <h2>Spell Trainer</h2>
          <div class="sub">Available spells for the ${player.pclass}</div>
        </div>
        <div class="pill">📜 Trainer</div>
      </div>

      <div class="list">
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
            action = `<a class="learnBtn" href="/trainer/learn/${s.id}">Train Spell</a>`;
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
      </div>

      <button class="returnBtn" onclick="location.href='/town'">Return to Town</button>
    </div>
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
