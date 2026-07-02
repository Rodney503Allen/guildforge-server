//src/refining.routes.ts
import express from "express";
import { db } from "./db";
import { addItemWithConn } from "./services/inventoryService";
import { grantProfessionExperience } from "./services/professionExperienceService";

const router = express.Router();

function requireLogin(req: any, res: any, next: any) {
  if (!req.session || !req.session.playerId) return res.redirect("/login.html");
  next();
}

function esc(input: any) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

router.post("/refine/:recipeId", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;
  const recipeId = Number(req.params.recipeId);

  if (!Number.isFinite(recipeId)) {
    return res.status(400).json({ error: "invalid_recipe" });
  }

  const [[recipe]]: any = await db.query(
    `
    SELECT
      rr.*,
      inputItem.name AS inputName,
      outputItem.name AS outputName
    FROM refining_recipes rr
    JOIN items inputItem ON inputItem.id = rr.input_item_id
    JOIN items outputItem ON outputItem.id = rr.output_item_id
    WHERE rr.id = ?
      AND rr.is_active = 1
    LIMIT 1
    `,
    [recipeId]
  );

  if (!recipe) {
    return res.status(404).json({ error: "recipe_not_found" });
  }

  const [[professionRow]]: any = await db.query(
  `
  SELECT
    p.id,
    COALESCE(pp.level, 1) AS professionLevel
  FROM professions p
  LEFT JOIN player_professions pp
    ON pp.profession_id = p.id
   AND pp.player_id = ?
  WHERE LOWER(p.name) = LOWER(?)
  LIMIT 1
  `,
  [pid, recipe.profession_key]
);

if (!professionRow) {
  return res.status(400).json({ error: "profession_not_found" });
}

if (Number(professionRow.professionLevel || 1) < Number(recipe.required_level || 1)) {
  return res.status(400).json({ error: "profession_level_too_low" });
}

  const conn = await db.getConnection();

  let professionResult: any = null;

  try {
    await conn.beginTransaction();

    const [[inputStack]]: any = await conn.query(
      `
      SELECT inventory_id, quantity
      FROM inventory
      WHERE player_id = ?
        AND item_id = ?
        AND equipped = 0
      ORDER BY inventory_id ASC
      LIMIT 1
      FOR UPDATE
      `,
      [pid, recipe.input_item_id]
    );

    if (!inputStack || Number(inputStack.quantity || 0) < Number(recipe.input_qty || 1)) {
      await conn.rollback();
      return res.status(400).json({ error: "missing_materials" });
    }

    const [goldUpdate]: any = await conn.query(
      `
      UPDATE players
      SET gold = gold - ?
      WHERE id = ?
        AND gold >= ?
      `,
      [Number(recipe.gold_cost || 0), pid, Number(recipe.gold_cost || 0)]
    );

    if (!goldUpdate?.affectedRows) {
      await conn.rollback();
      return res.status(400).json({ error: "not_enough_gold" });
    }

    const remainingQty = Number(inputStack.quantity) - Number(recipe.input_qty);

    if (remainingQty > 0) {
      await conn.query(
        `
        UPDATE inventory
        SET quantity = ?
        WHERE inventory_id = ?
        `,
        [remainingQty, inputStack.inventory_id]
      );
    } else {
      await conn.query(
        `
        DELETE FROM inventory
        WHERE inventory_id = ?
        `,
        [inputStack.inventory_id]
      );
    }

    await addItemWithConn(
      conn,
      pid,
      Number(recipe.output_item_id),
      Number(recipe.output_qty || 1)
    );

professionResult = await grantProfessionExperience(
  conn,
  pid,
  String(recipe.profession_key),
  Number(recipe.profession_exp || 0)
);



    await conn.commit();
    } catch (err) {
      await conn.rollback();
      console.error("Refining failed:", err);
      return res.status(500).json({ error: "server_error" });
    } finally {
    conn.release();
  }

return res.json({
  success: true,
  outputName: recipe.outputName,
  outputQty: Number(recipe.output_qty || 1),
  inputName: recipe.inputName,
  inputQty: Number(recipe.input_qty || 1),
  professionExp: Number(recipe.profession_exp || 0),
  professionResult
});
});



router.get("/refining/:profession", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;
  const profession = String(req.params.profession || "").toLowerCase();
  const successItem = String(req.query.success || "");
  const successQty = Number(req.query.qty || 0);

  const [[player]]: any = await db.query(
    `
    SELECT name, gold
    FROM players
    WHERE id = ?
    LIMIT 1
    `,
    [pid]
  );

  if (!player) return res.redirect("/login.html");

  const [recipes]: any = await db.query(
    `
    SELECT
      rr.id AS recipeId,
      rr.profession_key,
      rr.station_name,
      rr.input_qty,
      rr.output_qty,
      rr.required_level,
      rr.gold_cost,
      rr.profession_exp,
      COALESCE(pp.level, 1) AS professionLevel,

      inputItem.name AS inputName,
      inputItem.icon AS inputIcon,

      outputItem.name AS outputName,
      outputItem.icon AS outputIcon,

      COALESCE(inv.quantity, 0) AS ownedInputQty
    FROM refining_recipes rr
    JOIN professions prof
      ON LOWER(prof.name) = LOWER(rr.profession_key)

    LEFT JOIN player_professions pp
      ON pp.player_id = ?
    AND pp.profession_id = prof.id
    JOIN items inputItem ON inputItem.id = rr.input_item_id
    JOIN items outputItem ON outputItem.id = rr.output_item_id
    LEFT JOIN (
      SELECT item_id, SUM(quantity) AS quantity
      FROM inventory
      WHERE player_id = ?
        AND equipped = 0
      GROUP BY item_id
    ) inv ON inv.item_id = rr.input_item_id
    WHERE rr.profession_key = ?
      AND rr.is_active = 1
    ORDER BY rr.display_order ASC, rr.id ASC
    `,
    [pid, pid, profession]
  );

  if (!recipes.length) return res.redirect("/workshop");
  

  const stationName = recipes[0].station_name;

  const recipeCards = recipes.map((r: any) => {
    const owned = Number(r.ownedInputQty || 0);
    const needed = Number(r.input_qty || 1);
    const professionLevel = Number(r.professionLevel || 1);
    const requiredLevel = Number(r.required_level || 1);

    const canRefine =
      professionLevel >= requiredLevel &&
      owned >= needed &&
      Number(player.gold || 0) >= Number(r.gold_cost || 0);

    return `
      <article
        class="supplier-item"
        data-recipe-id="${Number(r.recipeId)}"
        data-owned="${owned}"
        data-needed="${needed}"
      >
        <div class="supplier-icon">
          <img src="${esc(r.outputIcon || "/icons/items/default.png")}" onerror="this.style.display='none'">
        </div>

        <div class="supplier-main">
          <h3>${esc(r.outputName)}</h3>
          <p>${needed}x ${esc(r.inputName)} → ${Number(r.output_qty || 1)}x ${esc(r.outputName)}</p>
          <div class="supplier-meta">
            <span class="owned-count">Owned: ${owned}/${needed}</span>
            <span>Cost: ${Number(r.gold_cost || 0)}g</span>
            <span>Lv ${Number(r.required_level || 1)}</span>
          </div>
        </div>

        <div class="supplier-action">
          ${
            professionLevel < requiredLevel
              ? `<span class="status locked">Requires Lv ${requiredLevel}</span>`
              : canRefine
                ? `<button class="btn primary" type="button" onclick="startRefining(${Number(r.recipeId)})">Refine</button>`
                : `<span class="status locked">Missing Materials</span>`
          }
        </div>
      </article>
    `;
  }).join("");

  

const stationSounds: Record<string, { work: string; done: string }> = {
  smithing: {
    work: "/sounds/crafting/smelting.ogg",
    done: "/sounds/crafting/smelting-done.ogg"
  },
  carpentry: {
    work: "/sounds/crafting/milling.ogg",
    done: "/sounds/crafting/milling-done.ogg"
  },
  alchemy: {
    work: "/sounds/crafting/distilling.ogg",
    done: "/sounds/crafting/distilling-done.ogg"
  }
};

const stationIcons: Record<string, string> = {
  smithing: "🔥",
  carpentry: "🪚",
  alchemy: "🧪"
};

const stationIcon =
  stationIcons[profession] ??
  "⚒️";

const sounds =
  stationSounds[profession] ??
  stationSounds.smithing;

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800&display=swap" rel="stylesheet">
  <title>Guildforge | ${esc(stationName)}</title>
  <link rel="stylesheet" href="/statpanel.css">
  <link rel="stylesheet" href="/workshop.css">
  <link rel="stylesheet" href="/ui/toast.css">
  <script defer src="/statpanel.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

<main class="workshop-page">
  <section class="workshop-shell">
    <header class="workshop-hero">
      <div class="hero-title">
        <div class="hero-icon">${stationIcon}</div>
        <div>
          <h1>${esc(stationName)}</h1>
          <p>Refine raw materials into usable crafting components.</p>
        </div>
      </div>

      <div class="hero-actions">
        <span class="pill">Gold: <strong>${Number(player.gold || 0)}g</strong></span>
        <a class="btn danger" href="/workshop">Back to Workshop</a>
      </div>
    </header>

    <div class="station-tabs">
      <a class="station-tab active" href="/workshop/refining/${esc(profession)}">
        🔥 Refining
      </a>

      <a class="station-tab" href="/workshop/crafting/${esc(profession)}">
        ⚒️ Crafting
      </a>
    </div>

    <section class="card service-card wide">
      <div class="cardHeader">
        <div class="cardTitle">
          <h2>Available Refining Recipes</h2>
          <p>Select a recipe to process your materials.</p>
        </div>
        <span class="badge good">Available</span>
      </div>

      <div class="cardBody">
        <div class="supplier-list">
          ${recipeCards}
        </div>
      </div>
    </section>
  </section>
</main>

<div id="refiningModal" class="gathering-modal hidden">
  <div class="gathering-modal__card">
    <div class="gathering-modal__icon">🔥</div>
    <div class="gathering-modal__title">Refining...</div>
    <div class="gathering-modal__sub">Processing materials</div>

    <div class="gathering-progress">
      <div id="refiningProgressFill" class="gathering-progress__fill"></div>
    </div>
  </div>
</div>

<script src="/ui/toast.js"></script>

<audio
  id="workAudio"
  preload="auto"
  src="${sounds.work}">
</audio>

<audio
  id="doneAudio"
  preload="auto"
  src="${sounds.done}">
</audio>

<audio
  id="professionLevelAudio"
  preload="auto"
  src="/sounds/profession-level.ogg">
</audio>

<script>
async function startRefining(recipeId) {
  const modal = document.getElementById("refiningModal");
  const fill = document.getElementById("refiningProgressFill");
  const workSound = document.getElementById("workAudio");
  const doneSound = document.getElementById("doneAudio");
  const card = document.querySelector('[data-recipe-id="' + recipeId + '"]');

  const durationMs = 1600;

  if (modal && fill) {
    modal.classList.remove("hidden");
    fill.style.transition = "none";
    fill.style.width = "0%";

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fill.style.transition = "width " + durationMs + "ms linear";
        fill.style.width = "100%";
      }); 
    });
  }

  if (workSound) {
    workSound.volume = 0.6;
    workSound.currentTime = 0;
    workSound.play().catch(() => {});
  }

  await new Promise(resolve => setTimeout(resolve, durationMs));

  try {
    const res = await fetch("/workshop/refine/" + recipeId, {
      method: "POST",
      credentials: "include"
    });

    const data = await res.json();

    if (workSound) {
      workSound.pause();
      workSound.currentTime = 0;
    }

    if (modal) modal.classList.add("hidden");

    if (!res.ok || !data.success) {
      GFToast.show(
        "Refining Failed",
        data.error || "Unable to refine materials.",
        { type: "error", durationMs: 2600 }
      );
      return;
    }

    if (doneSound) {
      doneSound.volume = 0.7;
      doneSound.currentTime = 0;
      doneSound.play().catch(() => {});
    }

    GFToast.show(
      "Refining Complete",
      "Created " + data.outputQty + "× " + data.outputName + ". +" + data.professionExp + " XP.",
      { type: "success", durationMs: 2600 }
    );

    if (data.professionResult?.leveledUp) {
  const levelSound = document.getElementById("professionLevelAudio");

  if (levelSound) {
    levelSound.volume = 0.8;
    levelSound.currentTime = 0;
    levelSound.play().catch(() => {});
  }

  GFToast.show(
    data.professionResult.professionName + " Level Up!",
    "Reached level " + data.professionResult.newLevel + ".",
    {
      type: "success",
      durationMs: 3600
    }
  );
}

    if (card) {
      const ownedEl = card.querySelector(".owned-count");
      const actionEl = card.querySelector(".supplier-action");

      const oldOwned = Number(card.dataset.owned || 0);
      const needed = Number(card.dataset.needed || 1);
      const newOwned = Math.max(0, oldOwned - Number(data.inputQty || 1));

      card.dataset.owned = String(newOwned);

      if (ownedEl) {
        ownedEl.textContent = "Owned: " + newOwned + "/" + needed;
      }

      if (newOwned < needed && actionEl) {
        actionEl.innerHTML = '<span class="status locked">Missing Materials</span>';
      }
    }

  } catch (err) {
    console.error("Refining failed", err);

    if (modal) modal.classList.add("hidden");

    GFToast.show(
      "Refining Failed",
      "Something went wrong.",
      { type: "error", durationMs: 2600 }
    );
  }
}
</script>
</body>
</html>`);


});

export default router;