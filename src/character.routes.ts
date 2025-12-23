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

  // ============================
  // EQUIPPED GEAR (display only)
  // ============================
  const [gear]: any = await db.query(`
    SELECT inv.inventory_id AS instance_id, i.*
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.player_id=? AND inv.equipped=1
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
    SELECT inv.inventory_id AS instance_id, inv.equipped, i.*
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.player_id=? AND i.slot IS NOT NULL
  `, [pid]);

  // ============================
  // RENDER PAGE
  // ============================
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>${p.name} — Character</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/statpanel.css">
  <style>
    body {
      background:#08080d;
      color:#f5e6b2;
      font-family:Cinzel, serif;
      margin:0;
    }
    .page-wrap {
      padding-top:120px;
      width:90%;
      max-width:1100px;
      margin:auto;
      display:flex;
      gap:25px;
    }
    .left-panel { width:350px; }
    .right-panel { flex:1; }
    .char-box {
      border:1px solid gold;
      background:rgba(0,0,0,.85);
      padding:14px;
      border-radius:12px;
      margin-bottom:20px;
    }
    .stat-row {
      display:flex;
      justify-content:space-between;
      margin:6px 0;
    }
    .stat-row button {
      background:gold;
      border:none;
      border-radius:4px;
      cursor:pointer;
      font-weight:bold;
    }
    .return-btn {
      margin-top:12px;
      padding:10px 22px;
      font-family:Cinzel, serif;
      background:linear-gradient(#d4af37,#8d6b1f);
      border:2px solid gold;
      border-radius:10px;
      cursor:pointer;
    }
    .return-btn:hover {
      background:gold;
      box-shadow:0 0 12px rgba(255,215,100,.8);
    }
    .gear-grid {
      display:grid;
      grid-template-columns:repeat(2,1fr);
      gap:12px;
    }
    .gear-slot {
      border:1px solid #aa8c3c;
      background:rgba(20,14,6,.9);
      border-radius:8px;
      padding:8px;
      text-align:center;
      min-height:95px;
    }
    .inv-grid {
      display:grid;
      grid-template-columns:repeat(auto-fill,64px);
      gap:10px;
    }
    .inv-item {
      width:64px;
      height:64px;
      border:2px solid #aa8c3c;
      background:radial-gradient(circle,#1a140b 40%,#060300);
      border-radius:10px;
      cursor:pointer;
      text-align:center;
    }
    .tooltip-container {
    position: relative;
    cursor: help;
  }


    .tooltip {
      position:absolute;
      min-width:180px;
      background:#111;
      border:1px solid gold;
      color:#f5d27d;
      padding:8px;
      border-radius:8px;
      z-index:9999;
      font-size:12px;
      box-shadow:0 0 10px rgba(255,215,0,.6);
      display:none;
    }

    .tooltip strong { color:gold; display:block; margin-bottom:4px; }
    .tooltip .rarity { font-size:11px; margin-bottom:4px; }
    .tooltip .stat { display:block; }

    .tooltip.common{border-color:#bbb}
    .tooltip.uncommon{border-color:#44cc55}
    .tooltip.rare{border-color:#4aa3ff}
    .tooltip.epic{border-color:#b84aff}
    .tooltip.legendary{border-color:#ff9933}

    .tooltip-container:hover .tooltip { display:block; }

    .gear-slot.dragover { outline:2px dashed gold; }
    .inv-item.equipped { outline:2px solid gold; }
.stack-count {
  position: absolute;
  bottom: 4px;
  right: 6px;
  font-size: 12px;
  font-weight: bold;
  color: gold;
  text-shadow: 0 0 3px black;
  pointer-events: none;
}


  </style>
</head>

<body>

<div id="statpanel-root"></div>

<div class="page-wrap">

  <!-- LEFT PANEL -->
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
          <span class="stat-value tooltip-container">
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

  <!-- RIGHT PANEL -->
  <div class="right-panel">
<div class="char-box">
  <h3>Equipped Gear</h3>

  <div class="gear-grid">
    ${["weapon","offhand","head","chest","legs","feet","hands"].map(slot => `
      <div class="gear-slot"
           ondragover="event.preventDefault()"
           ondrop="dropEquip(event, '${slot}')">

        <strong>${slot.toUpperCase()}</strong><br>

        ${equipped[slot]
          ? `
            <div class="tooltip-container"
                 draggable="true"
                 data-id="${equipped[slot].instance_id}"
                 ondblclick="unequipItem(${equipped[slot].instance_id})">

              <img src="/icons/${equipped[slot].icon}" width="48">

              <div class="tooltip ${equipped[slot].rarity}">
                <strong>${equipped[slot].name}</strong>
                <div class="rarity">${equipped[slot].rarity.toUpperCase()}</div>

                ${equipped[slot].attack ? "<span class='stat'>Attack: +" + equipped[slot].attack + "</span>" : ""}
                ${equipped[slot].defense ? "<span class='stat'>Defense: +" + equipped[slot].defense + "</span>" : ""}
                ${equipped[slot].agility ? "<span class='stat'>Agility: +" + equipped[slot].agility + "</span>" : ""}
                ${equipped[slot].vitality ? "<span class='stat'>Vitality: +" + equipped[slot].vitality + "</span>" : ""}
                ${equipped[slot].intellect ? "<span class='stat'>Intellect: +" + equipped[slot].intellect + "</span>" : ""}
                ${equipped[slot].crit ? "<span class='stat'>Crit: +" + equipped[slot].crit + "</span>" : ""}
              </div>
            </div>
          `
          : "<em>Empty</em>"
        }

      </div>
    `).join("")}
  </div>
</div>

<div class="char-box">
  <h3>Equipment Inventory</h3>

  <div class="inv-grid"
       ondragover="event.preventDefault()"
       ondrop="dropUnequip(event)">

    ${inv.map((g:any) => `
      <div class="inv-item tooltip-container ${g.equipped ? "equipped" : ""}"
           data-id="${g.instance_id}"
           data-slot="${g.slot}"
           draggable="true"
           ondblclick="equipItem(${g.instance_id})">

        <img src="/icons/${g.icon}" width="48">

        <div class="tooltip ${g.rarity}">
          <strong>${g.name}</strong>
          <div class="rarity">${g.rarity.toUpperCase()}</div>

          ${g.attack ? "<span class='stat'>Attack: +" + g.attack + "</span>" : ""}
          ${g.defense ? "<span class='stat'>Defense: +" + g.defense + "</span>" : ""}
          ${g.agility ? "<span class='stat'>Agility: +" + g.agility + "</span>" : ""}
          ${g.vitality ? "<span class='stat'>Vitality: +" + g.vitality + "</span>" : ""}
          ${g.intellect ? "<span class='stat'>Intellect: +" + g.intellect + "</span>" : ""}
          ${g.crit ? "<span class='stat'>Crit: +" + g.crit + "</span>" : ""}

          ${g.description
            ? "<div style='margin-top:6px;font-style:italic'>" + g.description + "</div>"
            : ""}

          ${g.quantity > 1
            ? "<div class='stack-count'>" + g.quantity + "</div>"
            : ""}
        </div>

      </div>
    `).join("")}

  </div>
</div>
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
  document.getElementById(stat).innerText = data.value;
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

  location.reload(); // simple + safe for now
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
// UNEQUIP ITEMS
// =======================
router.post("/character/unequip", requireLogin, async (req, res) => {
  const pid = req.session.playerId;
  const { inventoryId } = req.body;

  if (!inventoryId) {
    return res.json({ error: "Missing inventoryId" });
  }

  await db.query(`
    UPDATE inventory
    SET equipped = 0
    WHERE inventory_id = ? AND player_id = ?
  `, [inventoryId, pid]);

  res.json({ success: true });
});

export default router;
