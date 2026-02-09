import { Router } from "express";
import { db } from "./db";
import { getFinalPlayerStats} from "./services/playerService";


const router = Router();

// =======================
// LOGIN GUARD
// =======================
function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) {
    return res.redirect("/login.html");
  }
  next();
}
function resolveIcon(icon: any) {
  const raw = (icon ?? "").toString().trim();
  if (!raw) return "";
  if (raw.startsWith("http")) return raw;
  // ensure it starts with exactly one leading slash
  return "/" + raw.replace(/^\/+/, "");
}
// =======================
// CHARACTER PAGE
// =======================
router.get("/character", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;
const [[basePlayer]]: any = await db.query(`
  SELECT
    attack,
    defense,
    agility,
    vitality,
    intellect,
    crit
  FROM players
  WHERE id = ?
`, [pid]);

  // ✅ LOAD FINAL STATS (base + gear + derived)
  // 1) Base + gear (no buffs)
const p = await getFinalPlayerStats(pid);
if (!p) return res.redirect("/login.html");

    // XP BAR
    const expToNext = p.level * 50 + p.level * p.level * 50;
    const expPercent = Math.min(
      100,
      Math.floor((p.exper / expToNext) * 100)
    );
type StatKey = "attack" | "defense" | "agility" | "vitality" | "intellect" | "crit";
const STAT_KEYS: StatKey[] = ["attack","defense","agility","vitality","intellect","crit"];

const statBreakdown: Record<
  StatKey,
  {
    base: number;
    gear: number;
    buff: number;
    total: number;
  }
> = {} as Record<
  StatKey,
  {
    base: number;
    gear: number;
    buff: number;
    total: number;
  }
>;

const [[potionCols]]: any = await db.query(
  `SELECT equip_potion_hp_inventory_id AS hpInv,
          equip_potion_sp_inventory_id AS spInv
   FROM players WHERE id=?`,
  [pid]
);

async function loadPotion(invId: number | null, expectedTarget: "hp" | "sp") {
  if (!invId) return null;

  const [[row]]: any = await db.query(
    `
    SELECT
      inv.inventory_id AS inventoryId,
      inv.quantity AS qty,
      i.name,
      i.icon,
      i.type,
      i.effect_target,
      i.is_combat
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ?
      AND inv.player_id = ?
    LIMIT 1
    `,
    [invId, pid]
  );

  if (!row || Number(row.qty) <= 0) return null;
  if (String(row.type) !== "potion") return null;
  if (Number(row.is_combat) !== 1) return null;
  if (String(row.effect_target).toLowerCase() !== expectedTarget) return null;

  return row;
}

const hpPotion = await loadPotion(potionCols?.hpInv ?? null, "hp");
const spPotion = await loadPotion(potionCols?.spInv ?? null, "sp");


// =======================
// EQUIPPED POTIONS (API for combat hotbar)
// =======================
router.get("/api/potions/equipped", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;

  const [[cols]]: any = await db.query(
    `SELECT equip_potion_hp_inventory_id AS hpInv,
            equip_potion_sp_inventory_id AS spInv
     FROM players WHERE id=?`,
    [pid]
  );

  async function loadPotion(invId: number | null, expectedTarget: "hp" | "sp") {
    if (!invId) return null;

    const [[row]]: any = await db.query(
      `
      SELECT
        inv.inventory_id AS inventoryId,
        inv.quantity AS qty,
        i.name,
        i.icon,
        i.type,
        i.effect_target,
        i.is_combat
      FROM inventory inv
      JOIN items i ON i.id = inv.item_id
      WHERE inv.inventory_id = ?
        AND inv.player_id = ?
      LIMIT 1
      `,
      [invId, pid]
    );

    if (!row || Number(row.qty) <= 0) return null;
    if (String(row.type) !== "potion") return null;
    if (Number(row.is_combat) !== 1) return null;
    if (String(row.effect_target).toLowerCase() !== expectedTarget) return null;

    return {
      inventoryId: Number(row.inventoryId),
      qty: Number(row.qty),
      name: row.name,
      icon: row.icon
    };
  }

  const hp = await loadPotion(cols?.hpInv ?? null, "hp");
  const sp = await loadPotion(cols?.spInv ?? null, "sp");

  res.json({ hp, sp });
});

  // ============================
  // EQUIPPED GEAR (display only)
  // ============================
  const [gear]: any = await db.query(`
    SELECT inv.inventory_id AS instance_id, i.*
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.player_id=? 
      AND inv.equipped=1
      AND i.slot IS NOT NULL
  `, [pid]);


  const equipped: any = {};
  gear.forEach((g: any) => (equipped[g.slot] = g));

  const gearBonus: Record<StatKey, number> = {
    attack: 0,
    defense: 0,
    agility: 0,
    vitality: 0,
    intellect: 0,
    crit: 0
  };

  gear.forEach((g: any) => {
    STAT_KEYS.forEach(stat => {
      if (g[stat]) {
        gearBonus[stat] += Number(g[stat]) || 0;
      }
    });
  });



  // ============================
  // BUFFS (display only)
  // ============================
const [buffs]: any = await db.query(`
  SELECT stat, value
  FROM player_buffs
  WHERE player_id = ?
    AND expires_at > NOW()
`, [pid]);

const buffBonus: Record<StatKey, number> = {
  attack: 0,
  defense: 0,
  agility: 0,
  vitality: 0,
  intellect: 0,
  crit: 0
};

buffs.forEach((b: any) => {
  if (STAT_KEYS.includes(b.stat as StatKey)) {
    buffBonus[b.stat as StatKey] += Number(b.value) || 0;
  }
});

STAT_KEYS.forEach((stat) => {
  const base = Number(basePlayer?.[stat]) || 0;
  const gear = gearBonus[stat] || 0;
  const buff = buffBonus[stat] || 0;

  statBreakdown[stat] = {
    base,
    gear,
    buff,
    total: base + gear + buff
  };
});




  // ============================
  // INVENTORY (equipable only)
  // ============================
const [inv]: any = await db.query(`
  SELECT
    i.id AS item_id,
    MIN(CASE WHEN inv.equipped = 0 THEN inv.inventory_id END) AS instance_id,
    SUM(CASE WHEN inv.equipped = 0 THEN inv.quantity ELSE 0 END) AS quantity,
    i.*

  FROM inventory inv
  JOIN items i ON i.id = inv.item_id
  WHERE inv.player_id = ?
  GROUP BY i.id
  HAVING quantity > 0
  ORDER BY
    CASE WHEN i.slot IS NOT NULL THEN 0 ELSE 1 END,
    i.category ASC,
    i.name ASC
`, [pid]);



  // ============================
  // RENDER PAGE
  // ============================
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Guildforge | ${p.name} — Character</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/statpanel.css">
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

  body{
    margin:0;
    position: relative;
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

  /* =========================
     LAYOUT (Left / Center / Right)
     ========================= */
  .page-wrap{
    padding-top: 120px; /* leaves room for statpanel */
    width: min(1240px, 94vw);
    margin: 0 auto;
    display:grid;
    grid-template-columns: 360px 520px 1fr; /* left stats | center paperdoll | right inventory */
    gap: 18px;
    align-items:flex-start;
    position: relative;
    z-index: 1;
  }

  .left-panel{ width:auto; }
  .center-panel{ width:auto; }
  .right-panel{ width:auto; min-width: 0; }

  /* =========================
     SHARED PANEL STYLING
     ========================= */
  .char-box{
    position:relative;
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 14px;

    border: 1px solid rgba(43,52,64,.95);
    background:
      radial-gradient(900px 260px at 18% 0%, rgba(182,75,46,.10), transparent 60%),
      linear-gradient(180deg, rgba(255,255,255,.03), rgba(0,0,0,.20)),
      linear-gradient(180deg, var(--panel), var(--panel2));

    box-shadow: 0 18px 40px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.06);
    overflow: visible; /* important for tooltips */
  }

  .char-box::before{
    content:"";
    position:absolute;
    inset:10px;
    pointer-events:none;
    border: 0;
    border-radius: 10px;
  }

  .char-box h2,
  .char-box h3{
    margin: 0 0 10px;
    font-family: Cinzel, ui-serif, Georgia, "Times New Roman", serif;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--bone);
    text-shadow:
      0 0 10px rgba(182,75,46,.20),
      0 10px 18px rgba(0,0,0,.85);
    position:relative;
    z-index:1;
  }

  .char-box p{
    margin: 6px 0;
    color: rgba(215,219,226,.92);
    font-size: 13px;
    position:relative;
    z-index:1;
  }

  .char-box p i{ color: var(--muted); }

  /* XP bar wrapper (inline styles exist in markup; make them look consistent) */
  .char-box > div[style*="background:#222"]{
    background: rgba(0,0,0,.28) !important;
    border: 1px solid rgba(43,52,64,.95) !important;
    border-radius: 999px !important;
  }
  /* safer: target the inner bar inside the wrapper */
  .char-box > div[style*="background:#222"] > div{
    background: linear-gradient(90deg, rgba(182,75,46,.92), rgba(122,30,30,.88)) !important;
  }

  /* =========================
     STATS ROWS
     ========================= */
  .stat-row{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap: 10px;
    margin: 8px 0;
    position:relative;
    z-index:1;
  }

  .stat-row > span:first-child{
    color: var(--muted);
    font-weight: 800;
    letter-spacing: .6px;
    text-transform: uppercase;
    font-size: 12px;
    min-width: 92px;
  }

  .stat-value{
    font-weight: 900;
    color: rgba(255,255,255,.92);
  }

  .stat-row button{
    width: 34px;
    height: 34px;
    border-radius: 10px;
    border: 1px solid rgba(182,75,46,.55);
    background: linear-gradient(180deg, rgba(182,75,46,.92), rgba(122,30,30,.88));
    color: #f3e7db;
    cursor:pointer;
    font-weight: 900;
    box-shadow: 0 12px 24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.12);
    transition: transform .12s ease, filter .12s ease;
  }
  .stat-row button:hover{ filter: brightness(1.06); transform: translateY(-1px); }
  .stat-row button:active{ transform: translateY(0) scale(.99); }

  /* Return button */
  .return-btn{
    margin-top: 10px;
    padding: 12px 12px;
    width: 100%;

    border-radius: 10px;
    border: 1px solid rgba(43,52,64,.95);
    background: rgba(0,0,0,.18);
    color: #f3e7db;

    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .7px;
    text-transform: uppercase;

    cursor:pointer;
    box-shadow: 0 12px 24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
    transition: transform .12s ease, border-color .12s ease;
  }
  .return-btn:hover{ border-color: rgba(182,75,46,.45); transform: translateY(-1px); }
  .return-btn:active{ transform: translateY(0) scale(.99); }

  /* =========================
     PAPERDOLL (CENTER)
     ========================= */
  .paperdoll{
    position: relative;
    width: min(420px, 100%);
    margin: 0 auto;
    padding: 16px 14px;
    border-radius: 14px;

    border: 1px solid rgba(43,52,64,.95);
    background:
      radial-gradient(700px 500px at 50% 18%, rgba(182,75,46,.08), transparent 60%),
      linear-gradient(180deg, rgba(255,255,255,.02), rgba(0,0,0,.18)),
      linear-gradient(180deg, rgba(14,19,26,.65), rgba(10,15,21,.85));
    box-shadow: inset 0 0 22px rgba(0,0,0,.75);
    overflow: visible;

    --slot: clamp(86px, 10vw, 112px);

    display: grid;
    grid-template-columns: repeat(3, var(--slot));
    grid-template-rows: repeat(4, var(--slot));
    gap: 14px;
    justify-items: center;
    align-items: center;
  }

  /* Make the draggable wrapper fill the square and truly center the image */
  .paperdoll .pd-slot > .tooltip-container{
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
  }

  /* Prevent the wrapper from nudging layout */
  .paperdoll .tooltip-container{
    margin: 0;
    padding: 0;
  }

  .pd-slot{
    width: var(--slot);
    height: var(--slot);
    border-radius: 14px;
    border: 1px solid rgba(43,52,64,.95);
    background: rgba(0,0,0,.22);
    box-shadow: inset 0 0 16px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.05);
    display:grid;
    place-items:center;
    overflow: visible;
    position: relative;
  }

  .pd-slot.dragover{
    outline: 2px dashed rgba(182,75,46,.75);
    box-shadow:
      0 0 0 1px rgba(182,75,46,.12),
      inset 0 0 16px rgba(0,0,0,.85);
  }

  /* Placement */
  .pd-slot.head{ grid-column: 2; grid-row: 1; }
  .pd-slot.chest{ grid-column: 2; grid-row: 2; }
  .pd-slot.weapon{ grid-column: 1; grid-row: 2; }
  .pd-slot.offhand{ grid-column: 3; grid-row: 2; }
  .pd-slot.legs{ grid-column: 2; grid-row: 3; }
  .pd-slot.feet{ grid-column: 2; grid-row: 4; }
  .pd-slot.hands{ grid-column: 1; grid-row: 3; } /* below weapon */

  .pd-img{
    width: 76%;
    height: 76%;
    object-fit: contain;
    image-rendering: pixelated;
    filter: drop-shadow(0 3px 6px rgba(0,0,0,.75));
  }
    
  .pd-empty{
    width: 76%;
    height: 76%;
    opacity: .12;
    border-radius: 12px;
    border: 1px dashed rgba(255,255,255,.18);
  }

  /* =========================
     INVENTORY (RIGHT)
     ========================= */
  .inv-panel-head{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap: 10px;
    margin-bottom: 10px;
    position:relative;
    z-index:1;
  }

  .inv-search{
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid rgba(43,52,64,.95);
    background: rgba(0,0,0,.20);
    color: var(--ink);
    outline: none;
    font-weight: 700;
    letter-spacing: .2px;
    margin-bottom: 10px;
  }
  .inv-search::placeholder{ color: rgba(154,163,175,.75); }

  .inv-grid{
    display:grid;
    grid-template-columns: repeat(auto-fill, 64px);
    gap: 10px;
    position:relative;
    z-index:1;
    overflow: visible;
  }

  .inv-item{
    width: 64px;
    height: 64px;
    border-radius: 12px;
    cursor:pointer;

    border: 1px solid rgba(43,52,64,.95);
    background: rgba(0,0,0,.22);

    box-shadow: inset 0 0 14px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.05);
    display:grid;
    place-items:center;

    position:relative;
    overflow: visible;
  }

  .inv-item img{
    width: 48px;
    height: 48px;
    object-fit: contain;
    image-rendering: pixelated;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,.70));
    display:block;
  }

  .inv-item.equipped{
    outline: 2px solid rgba(182,75,46,.75);
    box-shadow:
      0 0 0 1px rgba(182,75,46,.12),
      0 0 18px rgba(182,75,46,.22),
      inset 0 0 14px rgba(0,0,0,.85);
  }

  .inv-item.not-equipable{ opacity: .92; }
  .inv-item.not-equipable::after{
    content:"";
    position:absolute;
    inset:0;
    border-radius: 12px;
    pointer-events:none;
    box-shadow: inset 0 0 0 999px rgba(0,0,0,.10);
  }

  /* Stack count (shared) */
  .stack-count{
    position:absolute;
    bottom: 4px;
    right: 6px;
    font-size: 12px;
    font-weight: 900;
    color: #f3e7db;
    text-shadow: 0 2px 6px rgba(0,0,0,.9);
    pointer-events:none;
  }

  /* =========================
     TOOLTIP (shared)
     ========================= */
  .tooltip-container{
    position: relative;
    cursor: help;
    z-index: 1;
  }
  .tooltip-container:hover{ z-index: 9999; }
  .tooltip-container:hover .tooltip{ display:block; }

  .tooltip{
    position:absolute;
    left: 50%;
    top: calc(100% + 10px);
    transform: translateX(-50%);
    min-width: 220px;
    max-width: 320px;

    background: rgba(9,12,16,.96);
    border: 1px solid rgba(43,52,64,.95);
    color: rgba(215,219,226,.92);

    padding: 10px;
    border-radius: 12px;
    z-index: 10000;

    box-shadow: 0 22px 60px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.06);
    display:none;
    font-size: 12px;
    line-height: 1.35;
    pointer-events:none;
  }

  .tooltip strong{
    color: var(--bone);
    display:block;
    margin-bottom: 6px;
    letter-spacing: .4px;
    position:relative;
    z-index:1;
  }

  .tooltip .rarity{
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 6px;
    letter-spacing: .6px;
    text-transform: uppercase;
    position:relative;
    z-index:1;
  }

  .tooltip .stat{
    display:block;
    position:relative;
    z-index:1;
  }

  .tooltip hr{
    border: none;
    height: 1px;
    margin: 8px 0;
    background: linear-gradient(90deg, transparent, rgba(182,75,46,.55), transparent);
    opacity: .85;
    position:relative;
    z-index:1;
  }

  /* rarity borders */
  .tooltip.common{ border-color: rgba(201,207,217,.55); }
  .tooltip.uncommon{ border-color: rgba(119,242,154,.55); }
  .tooltip.rare{ border-color: rgba(120,200,255,.55); }
  .tooltip.epic{ border-color: rgba(211,140,255,.55); }
  .tooltip.legendary{ border-color: rgba(255,184,74,.65); }

  /* paperdoll tooltip stacking */
  .paperdoll .tooltip-container{ z-index: 1; }
  .paperdoll .tooltip-container:hover{ z-index: 9999; }

  /* =========================
     POTION BAR
     ========================= */
  .potionbar{
    margin-top: 14px;
    display:grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .potion-slot{
    border: 1px solid rgba(43,52,64,.95);
    border-radius: 12px;
    background: rgba(0,0,0,.22);
    box-shadow: inset 0 0 16px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.05);
    padding: 10px;
    position: relative;
  }

  .potion-title{
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .6px;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
  }

  .potion-inner{
    position: relative;
    height: 64px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,.08);
    background: rgba(0,0,0,.18);
    display:flex;
    align-items:center;
    justify-content:center;
    cursor: pointer;
  }

  .potion-img{
    width: 52px;
    height: 52px;
    object-fit: contain;
    image-rendering: pixelated;
  }

  .potion-empty{
    height: 64px;
    border-radius: 12px;
    border: 1px dashed rgba(255,255,255,.18);
    display:flex;
    align-items:center;
    justify-content:center;
    color: rgba(154,163,175,.75);
    font-weight: 800;
    font-size: 12px;
  }

  /* Responsive */
  @media (max-width: 1100px){
    .page-wrap{
      grid-template-columns: 1fr;
      gap: 14px;
    }
  }
</style>

</head>

<body>

<div id="statpanel-root"></div>

<div class="page-wrap">

  <!-- LEFT PANEL (Character + Stats) -->
  <div class="left-panel">

    <div class="char-box">
      <h2>${p.name}</h2>
      <p>Class: ${p.pclass}</p>
      <p>Level: ${p.level}</p>
      <p>XP: ${p.exper} / ${expToNext}</p>

      <div style="background:#222;border:1px solid gold;height:14px;border-radius:6px;overflow:hidden">
        <div style="width:${expPercent}%;height:100%;background:linear-gradient(to right,#d4af37,#aa8c3c)"></div>
      </div>

      <p style="font-size:12px">${expPercent}% to next level</p>

      <p>Gold: ${p.gold}</p>
      <p class="tooltip-container">
        HP: ${p.hpoints} / ${p.maxhp}
        <span class="tooltip">
          <strong>Max HP</strong>
          Base + Gear + Buffs
        </span>
      </p>

      <p>SP: ${p.spoints} / ${p.maxspoints}</p>
      <p>Crit Chance: ${(p.crit * 100).toFixed(1)}%</p>
    </div>

    <div class="char-box">
      <h3>Stats</h3>
      <p>Unspent Points: <span id="statPoints">${p.stat_points}</span></p>

      ${(STAT_KEYS.filter(s => s !== "crit") as Exclude<StatKey, "crit">[])
        .map((stat) => `
          <div class="stat-row">
            <span>${stat.charAt(0).toUpperCase()+stat.slice(1)}:</span>

            <span class="stat-value tooltip-container" id="${stat}">
              ${(p as any)[stat]}
              <div class="tooltip">
                <strong>${stat.toUpperCase()}</strong>
                <div>Base: ${statBreakdown[stat].base}</div>
                <div>Gear: +${statBreakdown[stat].gear}</div>
                <div>Buffs: +${statBreakdown[stat].buff}</div>
                <hr>
                <div><b>Total: ${statBreakdown[stat].total}</b></div>
              </div>
            </span>

            ${p.stat_points > 0 ? `<button onclick="addStat('${stat}')">+</button>` : ``}
          </div>
        `).join("")}

      <div style="text-align:center">
        <button class="return-btn" onclick="goBack()">⬅ Return</button>
      </div>
    </div>

  </div>

  <!-- CENTER PANEL (Paperdoll) -->
  <div class="center-panel">
    <div class="char-box">
      <h3>Equipped Gear</h3>

      <div class="paperdoll">

        <!-- HEAD -->
        <div class="pd-slot head"
             ondragover="event.preventDefault()"
             ondrop="dropEquip(event, 'head')">
          ${equipped["head"]
            ? `
              <div class="tooltip-container"
                   draggable="true"
                   data-id="${equipped["head"].instance_id}"
                   ondblclick="unequipItem(${equipped["head"].instance_id})">
                <img class="pd-img" src="${resolveIcon(equipped["head"].icon)}" alt="Head"
                     onerror="this.replaceWith(document.createTextNode('📦'))">

                <div class="tooltip ${equipped["head"].rarity}">
                  <strong>${equipped["head"].name}</strong>
                  <div class="rarity">${equipped["head"].rarity.toUpperCase()}</div>
                  ${equipped["head"].attack ? "<span class='stat'>Attack: +" + equipped["head"].attack + "</span>" : ""}
                  ${equipped["head"].defense ? "<span class='stat'>Defense: +" + equipped["head"].defense + "</span>" : ""}
                  ${equipped["head"].agility ? "<span class='stat'>Agility: +" + equipped["head"].agility + "</span>" : ""}
                  ${equipped["head"].vitality ? "<span class='stat'>Vitality: +" + equipped["head"].vitality + "</span>" : ""}
                  ${equipped["head"].intellect ? "<span class='stat'>Intellect: +" + equipped["head"].intellect + "</span>" : ""}
                  ${equipped["head"].crit ? "<span class='stat'>Crit: +" + equipped["head"].crit + "</span>" : ""}
                </div>
              </div>
            `
            : `<div class="pd-empty"></div>`
          }
        </div>

        <!-- CHEST -->
        <div class="pd-slot chest"
             ondragover="event.preventDefault()"
             ondrop="dropEquip(event, 'chest')">
          ${equipped["chest"]
            ? `
              <div class="tooltip-container"
                   draggable="true"
                   data-id="${equipped["chest"].instance_id}"
                   ondblclick="unequipItem(${equipped["chest"].instance_id})">
                <img class="pd-img" src="${resolveIcon(equipped["chest"].icon)}" alt="Chest"
                     onerror="this.replaceWith(document.createTextNode('📦'))">

                <div class="tooltip ${equipped["chest"].rarity}">
                  <strong>${equipped["chest"].name}</strong>
                  <div class="rarity">${equipped["chest"].rarity.toUpperCase()}</div>
                  ${equipped["chest"].attack ? "<span class='stat'>Attack: +" + equipped["chest"].attack + "</span>" : ""}
                  ${equipped["chest"].defense ? "<span class='stat'>Defense: +" + equipped["chest"].defense + "</span>" : ""}
                  ${equipped["chest"].agility ? "<span class='stat'>Agility: +" + equipped["chest"].agility + "</span>" : ""}
                  ${equipped["chest"].vitality ? "<span class='stat'>Vitality: +" + equipped["chest"].vitality + "</span>" : ""}
                  ${equipped["chest"].intellect ? "<span class='stat'>Intellect: +" + equipped["chest"].intellect + "</span>" : ""}
                  ${equipped["chest"].crit ? "<span class='stat'>Crit: +" + equipped["chest"].crit + "</span>" : ""}
                </div>
              </div>
            `
            : `<div class="pd-empty"></div>`
          }
        </div>

        <!-- WEAPON -->
        <div class="pd-slot weapon"
             ondragover="event.preventDefault()"
             ondrop="dropEquip(event, 'weapon')">
          ${equipped["weapon"]
            ? `
              <div class="tooltip-container"
                   draggable="true"
                   data-id="${equipped["weapon"].instance_id}"
                   ondblclick="unequipItem(${equipped["weapon"].instance_id})">
                <img class="pd-img" src="${resolveIcon(equipped["weapon"].icon)}" alt="Weapon"
                     onerror="this.replaceWith(document.createTextNode('📦'))">

                <div class="tooltip ${equipped["weapon"].rarity}">
                  <strong>${equipped["weapon"].name}</strong>
                  <div class="rarity">${equipped["weapon"].rarity.toUpperCase()}</div>
                  ${equipped["weapon"].attack ? "<span class='stat'>Attack: +" + equipped["weapon"].attack + "</span>" : ""}
                  ${equipped["weapon"].defense ? "<span class='stat'>Defense: +" + equipped["weapon"].defense + "</span>" : ""}
                  ${equipped["weapon"].agility ? "<span class='stat'>Agility: +" + equipped["weapon"].agility + "</span>" : ""}
                  ${equipped["weapon"].vitality ? "<span class='stat'>Vitality: +" + equipped["weapon"].vitality + "</span>" : ""}
                  ${equipped["weapon"].intellect ? "<span class='stat'>Intellect: +" + equipped["weapon"].intellect + "</span>" : ""}
                  ${equipped["weapon"].crit ? "<span class='stat'>Crit: +" + equipped["weapon"].crit + "</span>" : ""}
                </div>
              </div>
            `
            : `<div class="pd-empty"></div>`
          }
        </div>

        <!-- OFFHAND -->
        <div class="pd-slot offhand"
             ondragover="event.preventDefault()"
             ondrop="dropEquip(event, 'offhand')">
          ${equipped["offhand"]
            ? `
              <div class="tooltip-container"
                   draggable="true"
                   data-id="${equipped["offhand"].instance_id}"
                   ondblclick="unequipItem(${equipped["offhand"].instance_id})">
                <img class="pd-img" src="${resolveIcon(equipped["offhand"].icon)}" alt="Offhand"
                     onerror="this.replaceWith(document.createTextNode('📦'))">

                <div class="tooltip ${equipped["offhand"].rarity}">
                  <strong>${equipped["offhand"].name}</strong>
                  <div class="rarity">${equipped["offhand"].rarity.toUpperCase()}</div>
                  ${equipped["offhand"].attack ? "<span class='stat'>Attack: +" + equipped["offhand"].attack + "</span>" : ""}
                  ${equipped["offhand"].defense ? "<span class='stat'>Defense: +" + equipped["offhand"].defense + "</span>" : ""}
                  ${equipped["offhand"].agility ? "<span class='stat'>Agility: +" + equipped["offhand"].agility + "</span>" : ""}
                  ${equipped["offhand"].vitality ? "<span class='stat'>Vitality: +" + equipped["offhand"].vitality + "</span>" : ""}
                  ${equipped["offhand"].intellect ? "<span class='stat'>Intellect: +" + equipped["offhand"].intellect + "</span>" : ""}
                  ${equipped["offhand"].crit ? "<span class='stat'>Crit: +" + equipped["offhand"].crit + "</span>" : ""}
                </div>
              </div>
            `
            : `<div class="pd-empty"></div>`
          }
        </div>

        <!-- LEGS -->
        <div class="pd-slot legs"
             ondragover="event.preventDefault()"
             ondrop="dropEquip(event, 'legs')">
          ${equipped["legs"]
            ? `
              <div class="tooltip-container"
                   draggable="true"
                   data-id="${equipped["legs"].instance_id}"
                   ondblclick="unequipItem(${equipped["legs"].instance_id})">
                <img class="pd-img" src="${resolveIcon(equipped["legs"].icon)}" alt="Legs"
                     onerror="this.replaceWith(document.createTextNode('📦'))">

                <div class="tooltip ${equipped["legs"].rarity}">
                  <strong>${equipped["legs"].name}</strong>
                  <div class="rarity">${equipped["legs"].rarity.toUpperCase()}</div>
                  ${equipped["legs"].attack ? "<span class='stat'>Attack: +" + equipped["legs"].attack + "</span>" : ""}
                  ${equipped["legs"].defense ? "<span class='stat'>Defense: +" + equipped["legs"].defense + "</span>" : ""}
                  ${equipped["legs"].agility ? "<span class='stat'>Agility: +" + equipped["legs"].agility + "</span>" : ""}
                  ${equipped["legs"].vitality ? "<span class='stat'>Vitality: +" + equipped["legs"].vitality + "</span>" : ""}
                  ${equipped["legs"].intellect ? "<span class='stat'>Intellect: +" + equipped["legs"].intellect + "</span>" : ""}
                  ${equipped["legs"].crit ? "<span class='stat'>Crit: +" + equipped["legs"].crit + "</span>" : ""}
                </div>
              </div>
            `
            : `<div class="pd-empty"></div>`
          }
        </div>

        <!-- FEET -->
        <div class="pd-slot feet"
             ondragover="event.preventDefault()"
             ondrop="dropEquip(event, 'feet')">
          ${equipped["feet"]
            ? `
              <div class="tooltip-container"
                   draggable="true"
                   data-id="${equipped["feet"].instance_id}"
                   ondblclick="unequipItem(${equipped["feet"].instance_id})">
                <img class="pd-img" src="${resolveIcon(equipped["feet"].icon)}" alt="Feet"
                     onerror="this.replaceWith(document.createTextNode('📦'))">

                <div class="tooltip ${equipped["feet"].rarity}">
                  <strong>${equipped["feet"].name}</strong>
                  <div class="rarity">${equipped["feet"].rarity.toUpperCase()}</div>
                  ${equipped["feet"].attack ? "<span class='stat'>Attack: +" + equipped["feet"].attack + "</span>" : ""}
                  ${equipped["feet"].defense ? "<span class='stat'>Defense: +" + equipped["feet"].defense + "</span>" : ""}
                  ${equipped["feet"].agility ? "<span class='stat'>Agility: +" + equipped["feet"].agility + "</span>" : ""}
                  ${equipped["feet"].vitality ? "<span class='stat'>Vitality: +" + equipped["feet"].vitality + "</span>" : ""}
                  ${equipped["feet"].intellect ? "<span class='stat'>Intellect: +" + equipped["feet"].intellect + "</span>" : ""}
                  ${equipped["feet"].crit ? "<span class='stat'>Crit: +" + equipped["feet"].crit + "</span>" : ""}
                </div>
              </div>
            `
            : `<div class="pd-empty"></div>`
          }
        </div>

        <!-- HANDS -->
        <div class="pd-slot hands"
             ondragover="event.preventDefault()"
             ondrop="dropEquip(event, 'hands')">
          ${equipped["hands"]
            ? `
              <div class="tooltip-container"
                   draggable="true"
                   data-id="${equipped["hands"].instance_id}"
                   ondblclick="unequipItem(${equipped["hands"].instance_id})">
                <img class="pd-img" src="${resolveIcon(equipped["hands"].icon)}" alt="Hands"
                     onerror="this.replaceWith(document.createTextNode('📦'))">

                <div class="tooltip ${equipped["hands"].rarity}">
                  <strong>${equipped["hands"].name}</strong>
                  <div class="rarity">${equipped["hands"].rarity.toUpperCase()}</div>
                  ${equipped["hands"].attack ? "<span class='stat'>Attack: +" + equipped["hands"].attack + "</span>" : ""}
                  ${equipped["hands"].defense ? "<span class='stat'>Defense: +" + equipped["hands"].defense + "</span>" : ""}
                  ${equipped["hands"].agility ? "<span class='stat'>Agility: +" + equipped["hands"].agility + "</span>" : ""}
                  ${equipped["hands"].vitality ? "<span class='stat'>Vitality: +" + equipped["hands"].vitality + "</span>" : ""}
                  ${equipped["hands"].intellect ? "<span class='stat'>Intellect: +" + equipped["hands"].intellect + "</span>" : ""}
                  ${equipped["hands"].crit ? "<span class='stat'>Crit: +" + equipped["hands"].crit + "</span>" : ""}
                </div>
              </div>
            `
            : `<div class="pd-empty"></div>`
          }
        </div>

      </div>
      <div class="potionbar">
  <div class="potion-slot tooltip-container">
    <div class="potion-title">Health Potion</div>

    ${
      hpPotion
        ? `
          <div class="potion-inner" ondblclick="unequipPotion('health')">
            <img class="potion-img" src="${resolveIcon(hpPotion.icon)}" onerror="this.style.display='none'">
            <div class="stack-count">${hpPotion.qty}</div>

            <div class="tooltip">
              <strong>${hpPotion.name}</strong>
              <div class="rarity">EQUIPPED</div>
              <div>Slot: Health</div>
            </div>
          </div>
        `
        : `<div class="potion-empty">Empty</div>`
    }
  </div>

  <div class="potion-slot tooltip-container">
    <div class="potion-title">Mana Potion</div>

    ${
      spPotion
        ? `
          <div class="potion-inner" ondblclick="unequipPotion('mana')">
            <img class="potion-img" src="${resolveIcon(spPotion.icon)}" onerror="this.style.display='none'">
            <div class="stack-count">${spPotion.qty}</div>

            <div class="tooltip">
              <strong>${spPotion.name}</strong>
              <div class="rarity">EQUIPPED</div>
              <div>Slot: Mana</div>
            </div>
          </div>
        `
        : `<div class="potion-empty">Empty</div>`
    }
  </div>
</div>

    </div>
  </div>

  <!-- RIGHT PANEL (All Inventory) -->
  <div class="right-panel">
    <div class="char-box">
      <div class="inv-panel-head">
        <h3 style="margin:0">Inventory</h3>
      </div>

      <input id="invSearch" class="inv-search" placeholder="Search items..." autocomplete="off" />

      <div class="inv-grid"
           ondragover="event.preventDefault()"
           ondrop="dropUnequip(event)">

          ${inv
            .filter((g:any) => !g.equipped)  // ✅ hide equipped items
            .map((g:any) => `
              <div class="inv-item tooltip-container"
                  data-id="${g.instance_id}"
                  data-slot="${g.slot || ""}"
                  data-name="${(g.name || "").toLowerCase()}"
                  draggable="true"
                  ondblclick="${
                  ["weapon","offhand","head","chest","legs","feet","hands"].includes(g.slot)
                    ? `equipItem(${g.instance_id})`
                    : (String(g.type) === "potion" && String(g.effect_target).toLowerCase() === "hp")
                        ? `equipPotion(${g.instance_id}, 'health')`
                        : (String(g.type) === "potion" && String(g.effect_target).toLowerCase() === "sp")
                            ? `equipPotion(${g.instance_id}, 'mana')`
                            : ``
                }"

                >

                <img src="${resolveIcon(g.icon)}" alt=""
                    onerror="this.style.display='none'">

                ${g.quantity > 1 ? `<div class="stack-count">${g.quantity}</div>` : ``}

                <div class="tooltip ${g.rarity}">
                  <strong>${g.name}</strong>
                  <div class="rarity">${(g.rarity || "common").toUpperCase()}</div>

                  ${g.attack ? "<span class='stat'>Attack: +" + g.attack + "</span>" : ""}
                  ${g.defense ? "<span class='stat'>Defense: +" + g.defense + "</span>" : ""}
                  ${g.agility ? "<span class='stat'>Agility: +" + g.agility + "</span>" : ""}
                  ${g.vitality ? "<span class='stat'>Vitality: +" + g.vitality + "</span>" : ""}
                  ${g.intellect ? "<span class='stat'>Intellect: +" + g.intellect + "</span>" : ""}
                  ${g.crit ? "<span class='stat'>Crit: +" + g.crit + "</span>" : ""}

                  ${g.description
                    ? "<div style='margin-top:6px;font-style:italic'>" + g.description + "</div>"
                    : ""}
                </div>

              </div>
            `).join("")}


      </div>
    </div>
  </div>

</div>

<script src="/statpanel.js"></script>

<script>
async function addStat(stat) {
  const res = await fetch("/character/stat", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ stat })
  });
  const data = await res.json();
  if (data.error) return alert(data.error);

  const el = document.getElementById(stat);
  if (el) el.childNodes[0].nodeValue = data.value; // keep tooltip intact
  document.getElementById("statPoints").innerText = data.stat_points;

  if (data.stat_points <= 0) {
    document.querySelectorAll(".stat-row button").forEach(b => b.remove());
  }
}

function goBack() {
  history.length > 1 ? history.back() : location.href="/town";
}
</script>

<script>
let draggedId = null;

document.addEventListener("dragstart", e => {
  const el = e.target.closest("[data-id]");
  if (el) draggedId = el.dataset.id;
});

async function equipItem(id) {
  const res = await fetch("/character/equip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId: id })
  });

  const data = await res.json();
  if (data.error) return alert(data.error);

  location.reload();
}

async function unequipItem(id) {
  const res = await fetch("/character/unequip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId: id })
  });

  const data = await res.json();
  if (data.error) return alert(data.error);

  location.reload();
}
async function equipPotion(inventoryId, slot) {
  const res = await fetch("/character/equip-potion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inventoryId, slot })
  });

  const data = await res.json();
  if (data.error) return alert(data.error);

  location.reload();
}

async function unequipPotion(slot) {
  const res = await fetch("/character/unequip-potion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot })
  });

  const data = await res.json();
  if (data.error) return alert(data.error);

  location.reload();
}

function dropEquip(e, expectedSlot) {
  e.preventDefault();
  if (!draggedId) return;

  fetch("/api/inventory/slot-check/" + draggedId)
    .then(res => res.json())
    .then(data => {
      if (data.slot !== expectedSlot) {
        alert("That item does not belong in this slot.");
        return;
      }
      equipItem(draggedId);
    });
}

function dropUnequip() {
  if (draggedId) unequipItem(draggedId);
}
</script>

<script>
  const searchEl = document.getElementById("invSearch");
  if (searchEl) {
    searchEl.addEventListener("input", () => {
      const q = searchEl.value.trim().toLowerCase();
      document.querySelectorAll(".inv-item").forEach(el => {
        const name = (el.getAttribute("data-name") || "");
        el.style.display = (!q || name.includes(q)) ? "" : "none";
      });
    });
  }
</script>

</body>
</html>

`);
});

// =======================
// STAT SPEND API (UNCHANGED)
// =======================
router.post("/character/stat", requireLogin, async (req, res) => {
  const pid = req.session.playerId;
  const { stat } = req.body;

  const allowed = ["attack","defense","agility","vitality","intellect"];
  if (!allowed.includes(stat)) {
    return res.json({ error: "Invalid stat" });
  }

  const [[player]]: any = await db.query(
    "SELECT stat_points FROM players WHERE id=?",
    [pid]
  );

  if (!player || player.stat_points <= 0) {
    return res.json({ error: "No stat points available" });
  }

  await db.query(`
    UPDATE players
    SET ${stat} = ${stat} + 1,
        stat_points = stat_points - 1
    WHERE id=?
  `, [pid]);

  const [[updated]]: any = await db.query(`
    SELECT ${stat} AS value, stat_points
    FROM players WHERE id=?
  `, [pid]);

  res.json(updated);
});

// =======================
// EQUIP ITEMS
// =======================
router.post("/character/equip", requireLogin, async (req, res) => {
  const pid = req.session.playerId;
  const { inventoryId } = req.body;

  if (!inventoryId) {
    return res.json({ error: "Missing inventoryId" });
  }

  // Get item + slot
const [[row]]: any = await db.query(`
  SELECT
    inv.inventory_id,
    inv.item_id,
    inv.quantity,
    i.slot
  FROM inventory inv
  JOIN items i ON i.id = inv.item_id
  WHERE inv.inventory_id = ?
    AND inv.player_id = ?
`, [inventoryId, pid]);


if (!row || !row.slot) {
  return res.json({ error: "Invalid item" });
}

const ALLOWED_SLOTS = new Set([
  "weapon",
  "offhand",
  "head",
  "chest",
  "legs",
  "feet",
  "hands"
]);

if (!row || !row.slot || !ALLOWED_SLOTS.has(row.slot)) {
  return res.json({ error: "That item cannot be equipped." });
}


// Unequip existing item in same slot
await db.query(`
  UPDATE inventory
  SET equipped = 0
  WHERE player_id = ?
    AND item_id IN (SELECT id FROM items WHERE slot = ?)
`, [pid, row.slot]);

// STACK-AWARE equip
if (row.quantity > 1) {
  // decrement stack
  await db.query(
    "UPDATE inventory SET quantity = quantity - 1 WHERE inventory_id = ?",
    [row.inventory_id]
  );

  // create equipped instance
  await db.query(
    "INSERT INTO inventory (player_id, item_id, quantity, equipped) VALUES (?, ?, 1, 1)",
    [pid, row.item_id]
  );
} else {
  // single item, just equip it
  await db.query(
    "UPDATE inventory SET equipped = 1 WHERE inventory_id = ?",
    [row.inventory_id]
  );
  
}
res.json({ success: true });
});


// =======================
// EQUIP POTIONS (Loadout)
// =======================
router.post("/character/equip-potion", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;
  const slot = String(req.body.slot || "");          // "health" | "mana"
  const inventoryId = Number(req.body.inventoryId);  // inventory.inventory_id

  const expectedTarget =
    slot === "health" ? "hp" :
    slot === "mana" ? "sp" :
    null;

  if (!expectedTarget || !Number.isFinite(inventoryId)) {
    return res.json({ error: "Invalid slot or inventoryId" });
  }

  const [[row]]: any = await db.query(
    `
    SELECT
      inv.inventory_id,
      inv.player_id,
      inv.quantity,
      inv.equipped,
      i.type,
      i.effect_target,
      i.is_combat
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ?
      AND inv.player_id = ?
    LIMIT 1
    `,
    [inventoryId, pid]
  );

  if (!row) return res.json({ error: "Potion not found" });
  if (Number(row.quantity) <= 0) return res.json({ error: "No quantity remaining" });

  // must be a potion
  if (String(row.type) !== "potion") return res.json({ error: "Item is not a potion" });

  // must be usable in combat
  if (Number(row.is_combat) !== 1) return res.json({ error: "Potion is not usable in combat" });

  // must match slot target
  if (String(row.effect_target || "").toLowerCase() !== expectedTarget) {
    return res.json({ error: "Potion doesn't match that slot" });
  }

  // store pointer on players row
  if (slot === "health") {
    await db.query(
      `UPDATE players SET equip_potion_hp_inventory_id=? WHERE id=?`,
      [inventoryId, pid]
    );
  } else {
    await db.query(
      `UPDATE players SET equip_potion_sp_inventory_id=? WHERE id=?`,
      [inventoryId, pid]
    );
  }

  res.json({ success: true });
});

router.post("/character/unequip-potion", requireLogin, async (req, res) => {
  const pid = req.session.playerId as number;
  const slot = String(req.body.slot || "");

  const col =
    slot === "health" ? "equip_potion_hp_inventory_id" :
    slot === "mana" ? "equip_potion_sp_inventory_id" :
    null;

  if (!col) return res.json({ error: "Invalid slot" });

  await db.query(`UPDATE players SET ${col} = NULL WHERE id=?`, [pid]);
  res.json({ success: true });
});







// =======================
// UNEQUIP ITEMS
// =======================
router.post("/character/unequip", requireLogin, async (req, res) => {
  const pid = req.session.playerId;
  const { inventoryId } = req.body;
  if (!inventoryId) return res.json({ error: "Missing inventoryId" });

  const [[row]]: any = await db.query(`
    SELECT inventory_id, item_id, quantity
    FROM inventory
    WHERE inventory_id = ? AND player_id = ? AND equipped = 1
  `, [inventoryId, pid]);

  if (!row) return res.json({ error: "Item not found or not equipped" });

  // Find existing unequipped stack
  const [[stack]]: any = await db.query(`
    SELECT inventory_id, quantity
    FROM inventory
    WHERE player_id = ? AND item_id = ? AND equipped = 0
    LIMIT 1
  `, [pid, row.item_id]);

  if (stack) {
    // merge
    await db.query(
      `UPDATE inventory SET quantity = quantity + ? WHERE inventory_id = ?`,
      [row.quantity, stack.inventory_id]
    );
    // remove equipped row
    await db.query(`DELETE FROM inventory WHERE inventory_id = ?`, [row.inventory_id]);
  } else {
    // no stack exists, just flip equipped off
    await db.query(
      `UPDATE inventory SET equipped = 0 WHERE inventory_id = ? AND player_id = ?`,
      [row.inventory_id, pid]
    );
  }

  res.json({ success: true });
});


export default router;
