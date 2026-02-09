import express from "express";
import { db } from "./db";

const router = express.Router();
console.log("✅ TOWN ROUTES FILE LOADED");

// =======================
// TOWN UI
// =======================
router.get("/town", async (req, res) => {

  const pid = (req.session as any).playerId;
  if (!pid) return res.redirect("/login.html");

  // =======================
  // LOAD PLAYER POSITION
  // =======================
  const [[player]]: any = await db.query(`
    SELECT map_x, map_y
    FROM players
    WHERE id = ?
  `, [pid]);

  // =======================
  // FIND LOCATION AT TILE
  // =======================
  const [[town]]: any = await db.query(`
    SELECT *
    FROM locations
    WHERE map_x = ? AND map_y = ?
    LIMIT 1
  `, [player.map_x, player.map_y]);

  if (!town) {
    return res.send(`
      <html>
      <body style="background:#050509;color:gold;font-family:Cinzel,serif;text-align:center;padding-top:100px">
        <h2>No town here.</h2>
        <a style="color:gold" href="/world">Return to World</a>
      </body>
      </html>
    `);
  }

  // =======================
  // LOAD TOWN SERVICES
  // =======================
  const [services]: any = await db.query(`
    SELECT *
    FROM location_services
    WHERE location_id = ?
    ORDER BY display_order ASC, name ASC
  `, [town.id]);

  // =======================
  // RENDER LINKS
  // =======================
  const buttons = services.map((s: any) => `
    <a class="service" href="${s.route}">
      <span class="icon">${s.icon || "🏛"}</span>
      <span class="label">${s.name}</span>
    </a>
  `).join("");

  // =======================
  // PAGE OUTPUT
  // =======================
res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Guildforge | ${town.name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">

  <style>
    /* =========================
       TOWN PAGE — Grit Iron/Ember Theme
       (Inline CSS so route stays self-contained)
       ========================= */

    :root{
      --bg0:#07090c;
      --bg1:#0b0f14;
      --panel:#0e131a;
      --panel2:#0a0f15;

      --ink:#d7dbe2;
      --muted:#9aa3af;

      --iron:#2b3440;
      --iron2:#1b232d;

      --ember:#b64b2e;
      --blood:#7a1e1e;
      --bone:#c9b89a;

      --shadow: rgba(0,0,0,.60);
      --frame: rgba(255,255,255,.04);
      --glass: rgba(0,0,0,.18);
    }

    *{ box-sizing:border-box; }

    body{
      margin:0;
      color: var(--ink);
      font-family: Cinzel, ui-serif, Georgia, "Times New Roman", serif;
      text-align: center;

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

    /* A centered “console” layout so it feels like the new UI */
    .wrap{
      width: min(980px, 94vw);
      margin: 0 auto;
      padding: 22px 0 28px;
      display:flex;
      flex-direction:column;
      gap: 14px;
    }

    .panel{
      position:relative;
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

    h2{
      margin: 0 0 6px;
      letter-spacing: 2.6px;
      text-transform: uppercase;
      color: var(--bone);
      text-shadow:
        0 0 10px rgba(182,75,46,.20),
        0 10px 18px rgba(0,0,0,.85);
      font-size: 22px;
      position:relative;
      z-index:1;
    }

    .desc{
      margin: 0 auto 12px;
      max-width: 680px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
      position:relative;
      z-index:1;
    }

    .rule{
      height: 1px;
      border: none;
      margin: 14px 0;
      background: linear-gradient(90deg, transparent, rgba(182,75,46,.65), transparent);
      opacity: .85;
      position:relative;
      z-index:1;
    }

    /* Services grid: feels like building tiles */
    .services{
      display:grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 6px;
      position:relative;
      z-index:1;
    }

    .service{
      display:flex;
      align-items:center;
      justify-content:flex-start;
      gap: 10px;

      padding: 12px;
      border-radius: 10px;

      background:
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.20)),
        linear-gradient(180deg, var(--panel), var(--panel2));

      border: 1px solid rgba(43,52,64,.95);
      color: var(--ink);
      text-decoration: none;

      box-shadow: 0 16px 34px rgba(0,0,0,.60), inset 0 1px 0 rgba(255,255,255,.06);
      transition: transform .12s ease, border-color .12s ease, filter .12s ease;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    }

    .service:hover{
      border-color: rgba(182,75,46,.55);
      transform: translateY(-2px);
      filter: brightness(1.03);
      box-shadow:
        0 0 0 1px rgba(182,75,46,.10),
        0 20px 44px rgba(0,0,0,.75),
        inset 0 1px 0 rgba(255,255,255,.06);
    }

    .icon{
      width: 44px;
      height: 44px;
      display:grid;
      place-items:center;

      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.22);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.06);

      font-size: 18px;
      flex: 0 0 auto;
    }

    .label{
      font-weight: 900;
      letter-spacing: .4px;
      color: var(--bone);
      text-transform: uppercase;
      font-size: 13px;
      line-height: 1.1;
    }

    .empty{
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: var(--muted);
      font-size: 13px;
      padding: 10px 0;
      position:relative;
      z-index:1;
    }

    /* Return link */
    .leave{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap: 8px;

      margin-top: 6px;
      padding: 10px 12px;

      border-radius: 10px;
      border: 1px solid rgba(43,52,64,.95);
      background: rgba(0,0,0,.18);
      color: #f3e7db;
      text-decoration:none;

      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: .6px;
      text-transform: uppercase;

      box-shadow: 0 12px 24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
      transition: transform .12s ease, border-color .12s ease;
      position:relative;
      z-index:1;
    }

    .leave:hover{
      border-color: rgba(182,75,46,.45);
      transform: translateY(-1px);
    }

    /* World chat: same theme language + keep IDs */
    #worldChat{
      width: min(980px, 94vw);
      margin: 0 auto 26px;
      padding: 12px;

      border-radius: 12px;
      border: 1px solid rgba(43,52,64,.95);
      background:
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.22)),
        linear-gradient(180deg, var(--panel), var(--panel2));

      box-shadow: 0 18px 40px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.06);
      position: relative;
      color: var(--ink);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      text-align: left;
    }

    #worldChat::before{
      content:"";
      position:absolute;
      inset:10px;
      pointer-events:none;
      border: 0;
      border-radius: 10px;
    }

    #chatTitle{
      text-align:center;
      font-weight: 900;
      letter-spacing: .8px;
      text-transform: uppercase;
      color: var(--bone);
      margin-bottom: 10px;
      position:relative;
      z-index:1;
    }

    #chatLog{
      height: 160px;
      overflow-y: auto;

      background: rgba(0,0,0,.30);
      border: 1px solid rgba(43,52,64,.95);
      border-radius: 10px;

      padding: 10px;
      font-size: 12px;
      line-height: 1.35;

      box-shadow: inset 0 0 12px rgba(0,0,0,.85);
      position:relative;
      z-index:1;
    }

    .chatLine{ margin-bottom: 6px; color: rgba(215,219,226,.92); }
    .chatName{ color: rgba(160,220,255,.95); font-weight: 900; }

    #chatInput{
      width: 100%;
      margin-top: 10px;
      padding: 10px 12px;

      background: rgba(0,0,0,.22);
      border: 1px solid rgba(43,52,64,.95);
      border-radius: 10px;

      color: var(--ink);
      outline: none;

      box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
      position:relative;
      z-index:1;
    }

    #chatInput:focus{
      border-color: rgba(182,75,46,.55);
      box-shadow:
        0 0 0 1px rgba(182,75,46,.10),
        inset 0 1px 0 rgba(255,255,255,.05);
    }

    /* Responsive */
    @media (max-width: 900px){
      .services{ grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 520px){
      .services{ grid-template-columns: 1fr; }
      h2{ font-size: 18px; letter-spacing: 2px; }
      .panel{ padding: 16px; }
    }

  </style>
</head>
<body>

  <div id="statpanel-root"></div>

  <div class="wrap">
    <div class="panel">
      <h2>${town.name}</h2>
      <div class="desc">${town.description || "A place of faith, shelter, and fate."}</div>

      <hr class="rule">

      <div class="services">
        ${buttons || `<div class="empty"><i>No services available yet.</i></div>`}
      </div>

      <hr class="rule">

      <a class="leave" href="/world">🌍 Return to World</a>
    </div>
  </div>

  <div id="worldChat">
    <div id="chatTitle">🌍 World Chat</div>
    <div id="chatLog"></div>
    <input id="chatInput" placeholder="Say something..." maxlength="240" />
  </div>

  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>
  <script src="/world-chat.js"></script>
</body>
</html>
`);


});

export default router;
