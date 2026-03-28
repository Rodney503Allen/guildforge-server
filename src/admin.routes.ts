import express from "express";
import { db } from "./db";

const router = express.Router();

function requireLogin(req: any, res: any, next: any) {
  if (!req.session?.playerId) return res.status(401).redirect("/login.html");
  next();
}

async function requireAdmin(req: any, res: any, next: any) {
  const pid = Number(req.session?.playerId);
  if (!pid) return res.status(401).redirect("/login.html");

  const [[row]]: any = await db.query(
    `SELECT is_admin FROM players WHERE id=? LIMIT 1`,
    [pid]
  );

  if (!row || Number(row.is_admin) !== 1) {
    return res.status(403).send("Forbidden");
  }

  next();
}

// =======================
// Admin Picker Page
// =======================
router.get("/admin", requireLogin, requireAdmin, (req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <title>Guildforge | Admin</title>
  <link rel="stylesheet" href="/admin.css">
  <script defer src="/admin.js"></script>
</head>
<body>
  <div id="statpanel-root"></div>

  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> Admin Console</div>
        <div class="sub">Create new game data safely.</div>
      </div>
      <div class="nav">
        <a class="btn" href="/town">Return</a>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Create</h2>
            <p>Choose what type of data you want to add.</p>
          </div>
          <span class="badge warn">Restricted</span>
        </div>

        <div class="cardBody">
          <div class="picker">
            <button class="pick" data-go="/admin/items/new">
              <div class="pickIcon">🎒</div>
              <div class="pickText">
                <strong>Item</strong>
                <span>Create gear, materials, quest items, consumables.</span>
              </div>
            </button>

            <button class="pick" data-go="/admin/creatures/new">
              <div class="pickIcon">🐺</div>
              <div class="pickText">
                <strong>Creature</strong>
                <span>Spawn pools, stats, terrain, rarity, loot.</span>
              </div>
            </button>

            <button class="pick" data-go="/admin/quests/new">
              <div class="pickIcon">📜</div>
              <div class="pickText">
                <strong>Quest</strong>
                <span>Quests, objectives, rewards, chains.</span>
              </div>
            </button>
          </div>

          <div class="note">
            Tip: Start with Items so quests and loot tables can reference real IDs.
          </div>
        </div>
      </section>
    </div>
  </div>

  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>
</body>
</html>`);
});

// =======================
// Item Form Page
// =======================
router.get("/admin/items/new", requireLogin, requireAdmin, (req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <title>Guildforge | Admin | New Item</title>
  <link rel="stylesheet" href="/admin.css">
  <script defer src="/admin-items.js"></script>
</head>
<body>
  <div id="statpanel-root"></div>

  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> New Item</div>
        <div class="sub">Insert a new row into <code>items</code>.</div>
      </div>
      <div class="nav">
        <a class="btn" href="/admin">Back</a>
        <a class="btn" href="/town">Return</a>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Item Details</h2>
            <p>Keep names unique and icons consistent.</p>
          </div>
          <span class="badge good">Create</span>
        </div>

        <div class="cardBody">
          <form id="itemForm" class="form">
            <div class="row">
              <label>
                <span>Name</span>
                <input name="name" required maxlength="50" placeholder="Carrion Feather" />
              </label>

              <label>
                <span>Category</span>
                <select name="category">
                  <option value="misc">misc</option>
                  <option value="quest">quest</option>
                  <option value="material">material</option>
                  <option value="consumable">consumable</option>
                  <option value="weapon">weapon</option>
                  <option value="armor">armor</option>
                  <option value="scroll">scroll</option>
                </select>
              </label>
            </div>

            <div class="row">
              <label>
                <span>Slot</span>
                <select name="slot" required>
                  <option value="none">none</option>
                  <option value="weapon">weapon</option>
                  <option value="offhand">offhand</option>
                  <option value="head">head</option>
                  <option value="chest">chest</option>
                  <option value="legs">legs</option>
                  <option value="feet">feet</option>
                  <option value="hands">hands</option>
                </select>
              </label>

              <label>
                <span>Rarity</span>
                <select name="rarity">
                  <option value="common">common</option>
                  <option value="uncommon">uncommon</option>
                  <option value="rare">rare</option>
                  <option value="epic">epic</option>
                  <option value="legendary">legendary</option>
                </select>
              </label>
            </div>

            <div class="row">
              <label>
                <span>Icon Path</span>
                <input name="icon" maxlength="100" placeholder="/icons/items/carrion_feather.png" />
              </label>

              <label>
                <span>Value (gold)</span>
                <input name="value" type="number" min="0" value="0" />
              </label>
            </div>

            <label>
              <span>Description</span>
              <textarea name="description" rows="3" placeholder="A dark feather pulled from a scavenger crow…"></textarea>
            </label>

            <div class="divider"></div>

            <div class="formSectionTitle">Stats (optional)</div>
            <div class="row">
              <label><span>Attack</span><input name="attack" type="number" value="0" /></label>
              <label><span>Defense</span><input name="defense" type="number" value="0" /></label>
              <label><span>Agility</span><input name="agility" type="number" value="0" /></label>
            </div>
            <div class="row">
              <label><span>Vitality</span><input name="vitality" type="number" value="0" /></label>
              <label><span>Intellect</span><input name="intellect" type="number" value="0" /></label>
              <label><span>Crit</span><input name="crit" type="number" step="0.01" value="0" /></label>
            </div>

            <div class="divider"></div>

            <div class="row">
              <label>
                <span>Type (optional)</span>
                <input name="type" maxlength="20" placeholder="feather" />
              </label>

              <label>
                <span>Item Type (optional)</span>
                <input name="item_type" maxlength="32" placeholder="quest_drop" />
              </label>
            </div>

            <div class="row">
              <label>
                <span>Effect Type (optional)</span>
                <input name="effect_type" maxlength="50" placeholder="heal" />
              </label>

              <label>
                <span>Effect Value (optional)</span>
                <input name="effect_value" type="number" value="0" />
              </label>
            </div>

            <div class="row">
              <label>
                <span>Effect Target (optional)</span>
                <input name="effect_target" maxlength="50" placeholder="self" />
              </label>

              <label>
                <span>Combat Item?</span>
                <select name="is_combat">
                  <option value="1">Yes</option>
                  <option value="0">No</option>
                </select>
              </label>
            </div>

            <div class="row actions">
              <button class="btn" type="button" id="btnPreview">Preview JSON</button>
              <button class="btn primary" type="submit">Create Item</button>
            </div>

            <pre class="out" id="out" hidden></pre>
          </form>
        </div>
      </section>
    </div>
  </div>

  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>
</body>
</html>`);
});
// =======================
// Creature Form Page
// =======================
router.get("/admin/creatures/new", requireLogin, requireAdmin, (req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap" rel="stylesheet">
  <title>Guildforge | Admin | New Creature</title>
  <link rel="stylesheet" href="/admin.css">
  <script defer src="/admin-creatures.js"></script>
</head>
<body>
  <div id="statpanel-root"></div>

  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> New Creature</div>
        <div class="sub">Insert a new row into <code>creatures</code> and assign loot.</div>
      </div>
      <div class="nav">
        <a class="btn" href="/admin">Back</a>
        <a class="btn" href="/town">Return</a>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Creature Details</h2>
            <p>All fields from the <code>creatures</code> schema.</p>
          </div>
          <span class="badge good">Create</span>
        </div>

        <div class="cardBody">
          <form id="creatureForm" class="form">

            <div class="row">
              <label>
                <span>Name</span>
                <input name="name" required maxlength="21" placeholder="Ashwood Wolf" />
              </label>

              <label>
                <span>Level</span>
                <input name="level" type="number" min="1" value="1" required />
              </label>
            </div>

            <div class="row">
              <label><span>Attack</span><input name="attack" type="number" min="0" value="1" required /></label>
              <label><span>Defense</span><input name="defense" type="number" min="0" value="0" required /></label>
              <label><span>Max HP</span><input name="maxhp" type="number" min="1" value="10" required /></label>
            </div>

            <div class="row">
              <label><span>EXP</span><input name="exper" type="number" min="0" value="5" required /></label>
              <label><span>Agility</span><input name="agility" type="number" min="0" value="0" /></label>
              <label><span>Crit (0–1)</span><input name="crit" type="number" step="0.01" min="0" max="1" value="0" /></label>
            </div>

            <div class="row">
              <label>
                <span>Attack Speed (ms)</span>
                <input name="attack_speed" type="number" min="250" value="1500" />
              </label>

              <label>
                <span>Min Level (spawn)</span>
                <input name="min_level" type="number" min="1" value="1" />
              </label>

              <label>
                <span>Max Level (spawn)</span>
                <input name="max_level" type="number" min="1" value="999" />
              </label>
            </div>

            <div class="row">
              <label>
                <span>Terrain</span>
                <select name="terrain">
                  <option value="any">any</option>
                  <option value="plains">plains</option>
                  <option value="forest">forest</option>
                  <option value="mountain">mountain</option>
                  <option value="swamp">swamp</option>
                  <option value="ruins">ruins</option>
                </select>
              </label>

              <label>
                <span>Rarity</span>
                <select name="rarity">
                  <option value="common">common</option>
                  <option value="uncommon">uncommon</option>
                  <option value="rare">rare</option>
                  <option value="elite">elite</option>
                </select>
              </label>

              <label>
                <span>Base Spawn Chance</span>
                <input name="base_spawn_chance" type="number" step="0.01" min="0" value="0.2" />
              </label>
            </div>

            <label>
              <span>Description</span>
              <input name="description" maxlength="255" placeholder="A starving predator prowling the Ashwood…" />
            </label>

            <div class="row">
              <label>
                <span>Creature Image (path)</span>
                <input name="creatureimage" maxlength="255" placeholder="images/creatures/ashwood_wolf.png" />
              </label>

              <label>
                <span>Image (optional)</span>
                <input name="image" maxlength="255" placeholder="/images/creatures/ashwood_wolf.png" />
              </label>
            </div>

            <div class="row actions">
              <button class="btn" type="button" id="btnCreaturePreview">Preview JSON</button>
              <button class="btn primary" type="submit">Create Creature</button>
            </div>

            <pre class="out" id="outCreature" hidden></pre>
          </form>

          <div class="divider"></div>

          <div class="note">
            After creating the creature, you can attach loot drops below.
          </div>

          <section id="lootPanel" class="card" style="margin-top:14px; display:none;">
            <div class="cardHeader">
              <div class="cardTitle">
                <h2>Creature Loot</h2>
                <p>Add rows to <code>creature_loot_items</code>.</p>
              </div>
              <span class="badge">Loot</span>
            </div>

            <div class="cardBody">
              <div class="row">
                <label style="flex:2;">
                  <span>Item Search</span>
                  <input id="lootItemSearch" placeholder="Search items by name…" />
                </label>

                <label style="flex:1;">
                  <span>Pick Item</span>
                  <select id="lootItemSelect"></select>
                </label>
              </div>

              <div class="row">
                <label><span>Drop Chance</span><input id="lootDropChance" type="number" step="0.01" min="0" value="0.10" /></label>
                <label><span>Min Qty</span><input id="lootMinQty" type="number" min="1" value="1" /></label>
                <label><span>Max Qty</span><input id="lootMaxQty" type="number" min="1" value="1" /></label>
              </div>

              <div class="row">
                <label><span>Min Level</span><input id="lootMinLevel" type="number" min="1" placeholder="(optional)" /></label>
                <label><span>Max Level</span><input id="lootMaxLevel" type="number" min="1" placeholder="(optional)" /></label>
                <div style="display:flex; align-items:flex-end;">
                  <button class="btn primary" id="btnAddLoot" type="button">Add Loot Row</button>
                </div>
              </div>

              <div class="divider"></div>
              <div id="lootRows"></div>
            </div>
          </section>

        </div>
      </section>
    </div>
  </div>

  <link rel="stylesheet" href="/statpanel.css">
  <script src="/statpanel.js"></script>
</body>
</html>`);
});
// =======================
// Quest Form Page
// =======================
router.get("/admin/quests/new", requireLogin, requireAdmin, async (req, res) => {

  const [towns]: any = await db.query(`
    SELECT id, name
    FROM locations
    ORDER BY name
  `);

  const townOptions = (towns || [])
    .map((t:any)=>`<option value="${t.id}">${t.name}</option>`)
    .join("");

  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Guildforge | Admin | New Quest</title>
<link rel="stylesheet" href="/admin.css">
<script defer src="/admin-quests.js"></script>
</head>

<body>

<div class="wrap">

<div class="topbar">
  <div class="brand">
    <div class="title">New Quest</div>
    <div class="sub">Insert a row into <code>quests</code></div>
  </div>

  <div class="nav">
    <a class="btn" href="/admin">Back</a>
    <a class="btn" href="/town">Return</a>
  </div>
</div>

<section class="card">

<div class="cardHeader">
  <div class="cardTitle">
    <h2>Quest Details</h2>
    <p>Create a quest entry.</p>
  </div>
</div>

<div class="cardBody">

<form id="questForm" class="form">

<div class="row">

<label>
<span>Type</span>
<select name="type">
<option value="quest">quest</option>
<option value="bounty">bounty</option>
</select>
</label>

<label>
<span>Title</span>
<input name="title" required maxlength="80"/>
</label>

</div>


<label>
<span>Description</span>
<textarea name="description" rows="3"></textarea>
</label>

<label>
<span>Intro Dialog</span>
<textarea name="dialog_intro" rows="3"></textarea>
</label>

<label>
<span>Completion Dialog</span>
<textarea name="dialog_complete" rows="3"></textarea>
</label>

<label>
<span>Rumor Hint</span>
<input name="rumor_hint"/>
</label>


<div class="row">

<label>
<span>Minimum Level</span>
<input name="min_level" type="number" value="1"/>
</label>

<label>
<span>Town</span>
<select name="town_id">
${townOptions}
</select>
</label>

</div>


<div class="row">

<label>
<span>Repeatable</span>
<select name="is_repeatable">
<option value="0">No</option>
<option value="1">Yes</option>
</select>
</label>

<label>
<span>Active</span>
<select name="is_active">
<option value="1">Yes</option>
<option value="0">No</option>
</select>
</label>

</div>

<div class="row">

<label>
<span>Chain ID</span>
<input name="chain_id" type="number"/>
</label>

<label>
<span>Chain Order</span>
<input name="chain_order" type="number"/>
</label>

</div>

<div class="row">

<label>
<span>Turn In Location ID</span>
<input name="turn_in_location_id" type="number"/>
</label>

<label>
<span>Expires At</span>
<input name="expires_at" type="datetime-local"/>
</label>

</div>


<div class="row actions">
<button class="btn primary" type="submit">Create Quest</button>
</div>

</form>

</div>
</section>
</div>
</body>
</html>
`);
});
// =======================
// Quest Objectives Page
// =======================
router.get("/admin/quests/:questId/objectives", requireLogin, requireAdmin, async (req, res) => {
  try {
    const questId = Number(req.params.questId);

    const [[quest]]: any = await db.query(
      `SELECT id, title FROM quests WHERE id = ? LIMIT 1`,
      [questId]
    );

    if (!quest) {
      return res.status(404).send("Quest not found");
    }

    const [creatures]: any = await db.query(`
      SELECT id, name
      FROM creatures
      ORDER BY name ASC
    `);

    const [items]: any = await db.query(`
      SELECT id, name
      FROM items
      WHERE item_type = 'quest_item'
      ORDER BY name ASC
    `);

    const creatureOptions = (creatures || [])
      .map((c: any) => `<option value="${c.id}">${c.name}</option>`)
      .join("");

    const itemOptions = (items || [])
      .map((i: any) => `<option value="${i.id}">${i.name}</option>`)
      .join("");

    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Guildforge | Admin | Quest Objectives</title>
  <link rel="stylesheet" href="/admin.css">
  <script defer src="/admin-objectives.js"></script>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div class="title"><span class="sigil"></span> Quest Objectives</div>
        <div class="sub">Quest: <code>${quest.title}</code></div>
      </div>
      <div class="nav">
        <a class="btn" href="/admin">Back</a>
        <a class="btn" href="/town">Return</a>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Add Objective</h2>
            <p>Attach kill or turn-in requirements to this quest.</p>
          </div>
          <span class="badge good">Objective</span>
        </div>

        <div class="cardBody">
          <form id="objectiveForm" class="form">
            <input type="hidden" name="quest_id" value="${questId}" />

            <div class="row">
              <label>
                <span>Objective Type</span>
                <select name="type" id="objectiveType">
                  <option value="KILL">KILL</option>
                  <option value="TURN_IN">TURN_IN</option>
                </select>
              </label>

              <label>
                <span>Required Count</span>
                <input name="required_count" type="number" min="1" value="5" />
              </label>
            </div>

            <div class="row" id="creatureRow">
              <label style="flex:1;">
                <span>Target Creature</span>
                <select name="target_creature_id">
                  <option value="">-- select creature --</option>
                  ${creatureOptions}
                </select>
              </label>
            </div>

            <div class="row" id="itemRow" style="display:none;">
              <label style="flex:1;">
                <span>Target Item</span>
                <select name="target_item_id">
                  <option value="">-- select item --</option>
                  ${itemOptions}
                </select>
              </label>
            </div>

            <div class="row">
              <label style="flex:1;">
                <span>Region Name (optional)</span>
                <input name="region_name" maxlength="64" placeholder="Coastal Lowlands" />
              </label>
            </div>

            <div class="row actions">
              <button class="btn primary" type="submit">Add Objective</button>
            </div>

            <pre class="out" id="outObjective" hidden></pre>
          </form>

          <div class="divider"></div>

          <div class="note">
            Add one or more objectives to complete the quest setup.
          </div>
        </div>
      </section>
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error("Failed to load objective page:", err);
    res.status(500).send("Failed to load objectives page.");
  }
});
// =======================
// Quest Rewards Page
// =======================
router.get(
"/admin/quests/:questId/rewards",
requireLogin,
requireAdmin,
async (req,res)=>{

const questId = Number(req.params.questId);

const [[quest]]:any = await db.query(
`SELECT id,title FROM quests WHERE id=? LIMIT 1`,
[questId]
);

if(!quest) return res.status(404).send("Quest not found");

const [items]:any = await db.query(`
SELECT id,name,rarity
FROM items
ORDER BY name
`);

const itemOptions = items
.map((i:any)=>`<option value="${i.id}">${i.name}</option>`)
.join("");

res.send(`

<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Quest Rewards</title>
<link rel="stylesheet" href="/admin.css">
<script defer src="/admin-rewards.js"></script>
</head>

<body>

<div class="wrap">

<div class="topbar">
<div class="brand">
<div class="title">Quest Rewards</div>
<div class="sub">${quest.title}</div>
</div>

<div class="nav">
<a class="btn" href="/admin">Back</a>
<a class="btn" href="/town">Return</a>
</div>
</div>

<section class="card">

<div class="cardHeader">
<h2>Reward Setup</h2>
</div>

<div class="cardBody">

<form id="rewardForm">

<input type="hidden" name="quest_id" value="${questId}">

<div class="row">

<label>
<span>Gold Reward</span>
<input name="gold" type="number" value="0">
</label>

<label>
<span>XP Reward</span>
<input name="xp" type="number" value="0">
</label>

</div>

<div class="divider"></div>

<div class="formSectionTitle">Item Rewards</div>

<div class="row">

<label style="flex:2;">
<span>Item</span>
<select id="rewardItemSelect">
<option value="">-- none --</option>
${itemOptions}
</select>
</label>

<label>
<span>Qty</span>
<input id="rewardItemQty" type="number" value="1" min="1">
</label>

<div style="display:flex;align-items:flex-end;">
<button type="button" class="btn" id="btnAddRewardItem">
Add Item
</button>
</div>

</div>

<div id="rewardItems"></div>

<div class="row actions">
<button class="btn primary" type="submit">
Save Rewards
</button>
</div>

</form>

</div>
</section>

</div>

</body>
</html>

`);

});



// =======================
// API: Insert Item
// =======================
router.post("/admin/api/items", requireLogin, requireAdmin, express.json(), async (req, res) => {
  const b = req.body || {};

  const cleanStr = (v: any, max = 255) => String(v ?? "").trim().slice(0, max);
  const cleanNum = (v: any, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const payload = {
    name: cleanStr(b.name, 50),
    type: cleanStr(b.type, 20) || null,
    slot: cleanStr(b.slot, 16) || "none",
    rarity: cleanStr(b.rarity, 16) || "common",
    attack: cleanNum(b.attack, 0),
    defense: cleanNum(b.defense, 0),
    agility: cleanNum(b.agility, 0),
    vitality: cleanNum(b.vitality, 0),
    intellect: cleanNum(b.intellect, 0),
    crit: cleanNum(b.crit, 0),
    icon: cleanStr(b.icon, 100) || null,
    description: cleanStr(b.description, 5000) || null,
    value: cleanNum(b.value, 0),
    category: cleanStr(b.category, 16) || "misc",
    item_type: cleanStr(b.item_type, 32) || null,
    effect_type: cleanStr(b.effect_type, 50) || null,
    effect_value: cleanNum(b.effect_value, 0),
    effect_target: cleanStr(b.effect_target, 50) || null,
    location: cleanStr(b.location, 50) || "Crocania",
    is_combat: cleanNum(b.is_combat, 1) ? 1 : 0
  };

  if (!payload.name) return res.status(400).json({ error: "name_required" });

  const [result]: any = await db.query(
    `
    INSERT INTO items
    (name, type, slot, rarity, attack, defense, agility, vitality, intellect, crit,
     icon, description, value, category, item_type, effect_type, effect_value, effect_target,
     location, is_combat)
    VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
     ?, ?, ?, ?, ?, ?, ?, ?,
     ?, ?)
    `,
    [
      payload.name, payload.type, payload.slot, payload.rarity,
      payload.attack, payload.defense, payload.agility, payload.vitality, payload.intellect, payload.crit,
      payload.icon, payload.description, payload.value, payload.category, payload.item_type,
      payload.effect_type, payload.effect_value, payload.effect_target,
      payload.location, payload.is_combat
    ]
  );

  return res.json({ ok: true, id: Number(result.insertId), item: payload });
});
// =======================
// API: Insert Creature
// =======================
router.post("/admin/api/creatures", requireLogin, requireAdmin, express.json(), async (req, res) => {
  const b = req.body || {};

  const cleanStr = (v: any, max = 255) => String(v ?? "").trim().slice(0, max);
  const cleanNum = (v: any, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const payload = {
    name: cleanStr(b.name, 21),
    attack: cleanNum(b.attack, 0),
    defense: cleanNum(b.defense, 0),
    exper: cleanNum(b.exper, 0),
    level: cleanNum(b.level, 1),
    maxhp: cleanNum(b.maxhp, 1),

    creatureimage: cleanStr(b.creatureimage, 255) || "images/default_creature.png",
    image: cleanStr(b.image, 255) || null,
    description: cleanStr(b.description, 255) || null,

    attack_speed: cleanNum(b.attack_speed, 1500),
    min_level: cleanNum(b.min_level, 1),
    max_level: cleanNum(b.max_level, 999),

    terrain: cleanStr(b.terrain, 32) || "any",
    rarity: cleanStr(b.rarity, 16) || "common",
    base_spawn_chance: cleanNum(b.base_spawn_chance, 0.2),

    agility: cleanNum(b.agility, 0),
    crit: cleanNum(b.crit, 0),
  };

  if (!payload.name) return res.status(400).json({ error: "name_required" });

  const [result]: any = await db.query(
    `
    INSERT INTO creatures
    (name, attack, defense, exper, level, maxhp,
     creatureimage, image, description,
     attack_speed, min_level, max_level,
     terrain, rarity, base_spawn_chance,
     agility, crit)
    VALUES
    (?, ?, ?, ?, ?, ?,
     ?, ?, ?,
     ?, ?, ?,
     ?, ?, ?,
     ?, ?)
    `,
    [
      payload.name, payload.attack, payload.defense, payload.exper, payload.level, payload.maxhp,
      payload.creatureimage, payload.image, payload.description,
      payload.attack_speed, payload.min_level, payload.max_level,
      payload.terrain, payload.rarity, payload.base_spawn_chance,
      payload.agility, payload.crit
    ]
  );

  return res.json({ ok: true, id: Number(result.insertId), creature: payload });
});

// =======================
// API: Insert Quest
// =======================
router.post(
"/admin/api/quests",
requireLogin,
requireAdmin,
express.json(),
async (req,res)=>{

const b = req.body || {};

const cleanStr = (v:any,max=255)=>String(v??"").trim().slice(0,max);
const cleanNum = (v:any,fb=0)=>{
const n = Number(v);
return Number.isFinite(n)?n:fb;
};

const payload = {

type: cleanStr(b.type,16) || "quest",

title: cleanStr(b.title,80),

description: cleanStr(b.description,5000)||null,

dialog_intro: cleanStr(b.dialog_intro,5000)||null,

dialog_complete: cleanStr(b.dialog_complete,5000)||null,

rumor_hint: cleanStr(b.rumor_hint,255)||null,

min_level: cleanNum(b.min_level,1),

is_active: cleanNum(b.is_active,1)?1:0,

is_repeatable: cleanNum(b.is_repeatable,0)?1:0,

chain_id: b.chain_id ? Number(b.chain_id) : null,

chain_order: b.chain_order ? Number(b.chain_order) : null,

town_id: b.town_id ? Number(b.town_id) : null,

expires_at: b.expires_at || null,

turn_in_location_id: b.turn_in_location_id
  ? Number(b.turn_in_location_id)
  : null
};

if(!payload.title)
return res.status(400).json({error:"title_required"});


const [result]:any = await db.query(

`
INSERT INTO quests
(type,title,description,dialog_intro,dialog_complete,rumor_hint,
min_level,is_active,is_repeatable,
chain_id,chain_order,town_id,expires_at,turn_in_location_id)

VALUES
(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`,

[
payload.type,
payload.title,
payload.description,
payload.dialog_intro,
payload.dialog_complete,
payload.rumor_hint,

payload.min_level,
payload.is_active,
payload.is_repeatable,

payload.chain_id,
payload.chain_order,
payload.town_id,
payload.expires_at,
payload.turn_in_location_id
]

);

res.json({ok:true,id:result.insertId});

});
// =======================
// API: Insert Quest Objective
// =======================
router.post(
  "/admin/api/objectives",
  requireLogin,
  requireAdmin,
  express.json(),
  async (req, res) => {
    try {
      const b = req.body || {};

      const cleanStr = (v: any, max = 255) => String(v ?? "").trim().slice(0, max);
      const cleanNum = (v: any, fallback = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
      };
      const cleanNullableNum = (v: any) => {
        if (v === null || v === undefined || String(v).trim() === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      const payload = {
        quest_id: cleanNum(b.quest_id, 0),
        type: cleanStr(b.type, 16),
        required_count: cleanNum(b.required_count, 1),
        target_creature_id: cleanNullableNum(b.target_creature_id),
        target_item_id: cleanNullableNum(b.target_item_id),
        region_name: cleanStr(b.region_name, 64) || null,
        params_json: null
      };

      if (!payload.quest_id) {
        return res.status(400).json({ error: "quest_id_required" });
      }

      if (!["KILL", "TURN_IN"].includes(payload.type)) {
        return res.status(400).json({ error: "bad_type" });
      }

      if (payload.type === "KILL" && !payload.target_creature_id) {
        return res.status(400).json({ error: "target_creature_required" });
      }

      if (payload.type === "TURN_IN" && !payload.target_item_id) {
        return res.status(400).json({ error: "target_item_required" });
      }

      const [result]: any = await db.query(
        `
        INSERT INTO quest_objectives
        (quest_id, type, required_count, target_creature_id, target_item_id, region_name, params_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          payload.quest_id,
          payload.type,
          payload.required_count,
          payload.target_creature_id,
          payload.target_item_id,
          payload.region_name,
          payload.params_json
        ]
      );

      return res.json({ ok: true, id: Number(result.insertId) });
    } catch (err) {
      console.error("Failed to create objective:", err);
      return res.status(500).json({ error: "server_error" });
    }
  }
);
// =======================
// API: Insert Quest Rewards
// =======================
router.post(
"/admin/api/quest-rewards",
requireLogin,
requireAdmin,
express.json(),
async (req,res)=>{

const b = req.body || {};

const cleanNum = (v:any,fb=0)=>{
const n = Number(v);
return Number.isFinite(n)?n:fb;
};

const payload = {

quest_id: cleanNum(b.quest_id,0),

gold: cleanNum(b.gold,0),

xp: cleanNum(b.xp,0),

items_json: b.items_json ? JSON.stringify(b.items_json) : null

};

if(!payload.quest_id)
return res.status(400).json({error:"quest_id_required"});

await db.query(
`
INSERT INTO quest_rewards
(quest_id,gold,xp,items_json)
VALUES (?,?,?,?)
`,
[
payload.quest_id,
payload.gold,
payload.xp,
payload.items_json
]
);

res.json({ok:true});

});















router.get("/admin/api/items/search", requireLogin, requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const like = `%${q}%`;

  const [rows]: any = await db.query(
    `
    SELECT id, name, rarity, icon
    FROM items
    WHERE (? = '' OR name LIKE ?)
    ORDER BY name ASC
    LIMIT 50
    `,
    [q, like]
  );

  res.json({ ok: true, items: rows || [] });
});

router.post("/admin/api/creatures/:creatureId/loot", requireLogin, requireAdmin, express.json(), async (req, res) => {
  const creatureId = Number(req.params.creatureId);
  const b = req.body || {};

  const n = (v: any, fb: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : fb;
  };

  const itemId = n(b.item_id, 0);
  if (!creatureId || !itemId) return res.status(400).json({ error: "bad_ids" });

  const dropChance = Math.max(0, n(b.drop_chance, 0.1));
  const minQty = Math.max(1, n(b.min_qty, 1));
  const maxQty = Math.max(minQty, n(b.max_qty, minQty));

  const minLevel = b.min_level == null || b.min_level === "" ? null : Math.max(1, n(b.min_level, 1));
  const maxLevel = b.max_level == null || b.max_level === "" ? null : Math.max(1, n(b.max_level, 999));

  const [result]: any = await db.query(
    `
    INSERT INTO creature_loot_items
    (creature_id, item_id, drop_chance, min_qty, max_qty, min_level, max_level)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [creatureId, itemId, dropChance, minQty, maxQty, minLevel, maxLevel]
  );

  res.json({ ok: true, id: Number(result.insertId) });
});

router.get("/admin/api/creatures/:creatureId/loot", requireLogin, requireAdmin, async (req, res) => {
  const creatureId = Number(req.params.creatureId);

  const [rows]: any = await db.query(
    `
    SELECT cli.id, cli.item_id, i.name AS item_name, i.rarity AS item_rarity,
           cli.drop_chance, cli.min_qty, cli.max_qty, cli.min_level, cli.max_level
    FROM creature_loot_items cli
    JOIN items i ON i.id = cli.item_id
    WHERE cli.creature_id = ?
    ORDER BY cli.drop_chance DESC, i.name ASC
    `,
    [creatureId]
  );

  res.json({ ok: true, rows: rows || [] });
});

router.delete("/admin/api/creature-loot/:id", requireLogin, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await db.query(`DELETE FROM creature_loot_items WHERE id=? LIMIT 1`, [id]);
  res.json({ ok: true });
});

export default router;
