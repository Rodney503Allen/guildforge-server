import { Router } from "express";
import { db } from "./db";

const router = Router();



// ========================
// LOGIN GUARD
// ========================
function requireLogin(req:any,res:any,next:any) {
  if(!req.session || !req.session.playerId) {
    return res.redirect("/login.html");
  }
  next();
}

// ========================
// EQUIPMENT PAGE
// ========================
router.get("/equipment", requireLogin, async (req,res)=>{

  const pid = req.session.playerId;

  // Player base stats
  const [[player]]: any = await db.execute(`
    SELECT name, attack, defense, agility, vitality, intellect, crit
    FROM players WHERE id=?
  `,[pid]);

// Load equipped gear from inventory
const [gear]: any = await db.execute(`
  SELECT
    inv.inventory_id AS instance_id,
    i.*
  FROM inventory inv
  JOIN items i ON i.id = inv.item_id
  WHERE inv.player_id = ? AND inv.equipped = 1
`, [pid]);



  // Map gear by slot
  const equipped:any = {};
  gear.forEach((g:any)=> equipped[g.slot] = g );

  // Totals
  const total = {
    attack: player.attack,
    defense: player.defense,
    agility: player.agility,
    vitality: player.vitality,
    intellect: player.intellect,
    crit: player.crit
  };

  for(const g of gear) {
    total.attack   += g.attack;
    total.defense  += g.defense;
    total.agility  += g.agility;
    total.vitality += g.vitality;
    total.intellect+= g.intellect;
    total.crit     += g.crit;
  }

  const SLOT_LABELS:any = {
    weapon: "Weapon",
    head: "Helmet",
    chest: "Chest",
    legs: "Leggings",
    feet: "Boots",
    hands: "Gloves",
    offhand: "Off-Hand"
  };

const renderSlot = (slot:string)=>{
  const item = equipped[slot];
  return `
    <div class="gear-slot"
     ondragover="event.preventDefault()"
     ondrop="dropEquip(event, '${slot}')">

      <strong>${SLOT_LABELS[slot]}</strong>
      ${
        item
          ? `<div class="tooltip-container">
             <img src="/icons/${item.icon}" width="40">
             <div>${item.name}</div>

  <div class="tooltip ${item.rarity}">
    <strong>${item.name}</strong>
    <div class="rarity">${item.rarity.toUpperCase()}</div>
    ${item.attack ? `<span class="stat">Attack: +${item.attack}</span>` : ""}
    ${item.defense ? `<span class="stat">Defense: +${item.defense}</span>` : ""}
    ${item.agility ? `<span class="stat">Agility: +${item.agility}</span>` : ""}
    ${item.vitality ? `<span class="stat">Vitality: +${item.vitality}</span>` : ""}
    ${item.intellect ? `<span class="stat">Intellect: +${item.intellect}</span>` : ""}
    ${item.crit ? `<span class="stat">Crit: +${item.crit}</span>` : ""}
    ${item.description ? `<div style="margin-top:6px;font-style:italic">${item.description}</div>` : ""}
  </div>
</div>

             <a href="/equipment/unequip/${item.instance_id}">Unequip</a>`
          : `<em>Empty</em>`
      }
    </div>
  `;
};
// Load ALL equipment items in inventory
const [inventory]: any = await db.execute(`
  SELECT
    inv.inventory_id AS instance_id,
    inv.equipped,
    i.*
  FROM inventory inv
  JOIN items i ON i.id = inv.item_id
  WHERE inv.player_id = ? AND i.slot IS NOT NULL
`, [pid]);


res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Guildforge — Equipment</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/statpanel.css">
<style>

body { background:#050509; color:#f5e6b2; font-family:Cinzel,serif; margin:0; }
a { color:gold; text-decoration:none; }

.container {
  display:flex;
  min-height:100vh;
}

/* =========================
   LEFT: EQUIPMENT
========================= */
.equipment-panel {
  width:700px;
  margin:40px;
  padding:20px;
  border:1px solid gold;
  background:rgba(0,0,0,.75);
  border-radius:12px;
}

h2 { text-align:center; margin-bottom:20px; }

/* Equipment grid */
.gear-grid {
  display:grid;
  grid-template-columns: 1fr 1fr;
  gap:12px;
}

.gear-slot {
  border:1px solid #aa8c3c;
  border-radius:8px;
  padding:10px;
  background:rgba(20,15,5,.9);
  text-align:center;
  min-height:88px;
}

.gear-slot:hover {
  box-shadow: 0 0 8px gold;
}

.gear-slot strong {
  display:block;
  font-size:14px;
  margin-bottom:4px;
}

.gear-slot img {
  display:block;
  margin:6px auto;
}

.gear-slot a {
  font-size:12px;
  display:inline-block;
  margin-top:4px;
}

/* =======================
   RIGHT: STATS + INVENTORY
======================= */
.side-panel {
  margin:40px;
  flex:1;
}

.stats-box {
  border:1px solid gold;
  background:rgba(0,0,0,.8);
  border-radius:12px;
  padding:15px;
  margin-bottom:20px;
}

.stats-box h3 {
  border-bottom:1px solid gold;
  margin-bottom:10px;
  padding-bottom:5px;
}

.stats-box p {
  line-height:1.8;
  font-size:14px;
}

/* Inventory table */
.inv-box {
  border:1px solid gold;
  background:rgba(0,0,0,.8);
  border-radius:12px;
  padding:10px;
}

.inv-box table {
  width:100%;
  border-collapse:collapse;
}

.inv-box th, .inv-box td {
  border-bottom:1px solid rgba(255,255,255,.1);
  padding:6px;
  font-size:13px;
  text-align:left;
}

.inv-box tr:hover { background:rgba(255,215,0,.1); }

button {
  background:black;
  border:1px solid gold;
  color:gold;
  padding:4px 8px;
  cursor:pointer;
}

button:hover { background:#222; }

.return {
  display:block;
  text-align:center;
  margin-top:20px;
}
/* =========================
   TOOLTIP SYSTEM
========================= */
.tooltip-container {
  position: relative;
  display: inline-block;
}

.tooltip {
  position: absolute;
  min-width: 180px;
  background: #111;
  border: 1px solid gold;
  color: #f5d27d;
  padding: 8px;
  border-radius: 8px;
  z-index: 9999;
  font-size: 12px;
  box-shadow: 0 0 10px rgba(255,215,0,.6);
  display: none;
}

.tooltip strong {
  color: gold;
  display: block;
  margin-bottom: 4px;
}

.tooltip .rarity {
  font-size: 11px;
  margin-bottom: 4px;
}

.tooltip .stat {
  display: block;
}

.tooltip.common    { border-color: #bbb; }
.tooltip.uncommon  { border-color: #44cc55; }
.tooltip.rare      { border-color: #4aa3ff; }
.tooltip.epic      { border-color: #b84aff; }
.tooltip.legendary { border-color: #ff9933; }
.tooltip-container:hover .tooltip {
  display: block;
}
.inv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 64px);
  gap: 10px;
  justify-content: start;
  padding: 6px;
}

.inv-item {
  width: 64px;
  height: 64px;
  border: 2px solid #aa8c3c;
  background: radial-gradient(circle, #1a140b 40%, #060300);
  border-radius: 10px;
  text-align: center;
  cursor: pointer;
  position: relative;
}

.inv-item img {
  width: 48px;
  height: 48px;
  margin-top: 8px;
  pointer-events: none;
}

.inv-item:hover {
  box-shadow: 0 0 8px gold;
}

.inv-item.equipped {
  outline: 2px solid gold;
}
  .gear-slot.dragover {
  outline: 2px dashed gold;
}

</style>
</head>

<body>

<div class="container">

<!-- =========================
     EQUIPMENT GRID
========================= -->

<div class="equipment-panel">

<h2>${player.name}'s Equipment</h2>

<div class="gear-grid">

${renderSlot("weapon")}
${renderSlot("offhand")}
${renderSlot("head")}
${renderSlot("chest")}
${renderSlot("legs")}
${renderSlot("feet")}
${renderSlot("hands")}

</div>

<a class="return" href="/">Return to Town</a>
</div>

<!-- =========================
     RIGHT SIDE
========================= -->

<div class="side-panel">

<div class="stats-box">
<h3>Total Stats</h3>
<p>
Attack: ${total.attack}<br>
Defense: ${total.defense}<br>
Agility: ${total.agility}<br>
Vitality: ${total.vitality}<br>
Intellect: ${total.intellect}<br>
Crit: ${total.crit}
</p>
</div>

<div class="inv-box">
<h3>Equipment Inventory</h3>

<div class="inv-grid">
${
  inventory.map((g:any)=>`
    <div class="inv-item tooltip-container"
         data-id="${g.instance_id}"
         data-slot="${g.slot}"
         draggable="true"
         ondblclick="equipItem(${g.instance_id})">

      <img src="/icons/${g.icon}" title="" />

      <div class="tooltip ${g.rarity}">
        <strong>${g.name}</strong>
        <div class="rarity">${g.rarity.toUpperCase()}</div>
        ${g.attack ? `<span class="stat">Attack: +${g.attack}</span>` : ""}
        ${g.defense ? `<span class="stat">Defense: +${g.defense}</span>` : ""}
        ${g.agility ? `<span class="stat">Agility: +${g.agility}</span>` : ""}
        ${g.vitality ? `<span class="stat">Vitality: +${g.vitality}</span>` : ""}
        ${g.intellect ? `<span class="stat">Intellect: +${g.intellect}</span>` : ""}
        ${g.crit ? `<span class="stat">Crit: +${g.crit}</span>` : ""}
        ${g.description ? `<div style="margin-top:6px;font-style:italic">${g.description}</div>` : ""}
      </div>

    </div>
  `).join("")
}
</div>
</div>


<script>
fetch("/statpanel.html")
  .then(res => res.text())
  .then(html => {
    document.body.insertAdjacentHTML("afterbegin", html);
    loadStatPanel();
  });
</script>
<script>
function equipItem(id) {
  window.location.href = "/equipment/equip/" + id;
}
</script>
<script>
let draggedId = null;

document.querySelectorAll(".inv-item").forEach(el => {
  el.addEventListener("dragstart", e => {
    draggedId = e.target.dataset.id;
  });
});

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

      window.location.href = "/equipment/equip/" + draggedId;

    });
}
</script>

</body>
</html>
`);

});

router.get("/equipment/equip/:id", requireLogin, async (req,res)=>{

  const pid = req.session.playerId;
  const invId = parseInt(req.params.id);

  console.log("EQUIP CLICK:", invId, "PLAYER:", pid);

  // Get item slot
  const [[row]]: any = await db.execute(`
    SELECT inv.inventory_id, i.slot
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ? AND inv.player_id = ?
  `,[invId,pid]);

  console.log("ITEM FOUND:", row);

  if(!row) return res.send("Item not found.");
  if(!row.slot) return res.send("Item has no slot.");

  // Unequip same slot
  await db.execute(`
    UPDATE inventory
    SET equipped = 0
    WHERE player_id = ?
      AND item_id IN (SELECT id FROM items WHERE slot = ?)
  `,[pid,row.slot]);

  // Equip selected
  await db.execute(`
    UPDATE inventory
    SET equipped = 1
    WHERE inventory_id = ?
  `,[invId]);

  res.redirect("/equipment");
});



router.get("/equipment/unequip/:id", requireLogin, async (req,res)=>{

  const pid = req.session.playerId;
  const invId = parseInt(req.params.id);

  await db.execute(`
    UPDATE inventory
    SET equipped = 0
    WHERE inventory_id = ? AND player_id = ?
  `,[invId,pid]);

  res.redirect("/equipment");
});


export default router;