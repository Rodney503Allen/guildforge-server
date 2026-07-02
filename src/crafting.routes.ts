//src/crafting.routes.ts
import express from "express";
import { db } from "./db";
import { addItemWithConn } from "./services/inventoryService";
import { hasInventorySpace } from "./services/inventoryCapacityService";
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

router.get("/crafting/:profession", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;
  const profession = String(req.params.profession || "").toLowerCase();

  const [[player]]: any = await db.query(
    `SELECT name, gold FROM players WHERE id = ? LIMIT 1`,
    [pid]
  );

  if (!player) return res.redirect("/login.html");

  const [rows]: any = await db.query(
    `
    SELECT
      cr.id AS recipeId,
      cr.profession_key,
      cr.station_name,
      cr.output_type,
      cr.output_id,
      cr.output_qty,
      cr.required_level,
      cr.gold_cost,
      cr.craft_time_ms,
      COALESCE(pp.level, 1) AS professionLevel,

      COALESCE(outItem.name, outBase.name) AS outputName,
      COALESCE(outItem.icon, outBase.icon) AS outputIcon,

      ing.id AS ingredientItemId,
      ing.name AS ingredientName,
      cri.quantity AS ingredientQty,
      COALESCE(inv.quantity, 0) AS ownedQty

    FROM crafting_recipes cr
    JOIN professions prof
      ON LOWER(prof.name) = LOWER(cr.profession_key)

    LEFT JOIN player_professions pp
      ON pp.player_id = ?
    AND pp.profession_id = prof.id

    LEFT JOIN items outItem
      ON cr.output_type = 'item'
     AND outItem.id = cr.output_id

    LEFT JOIN item_bases outBase
      ON cr.output_type = 'item_base'
     AND outBase.id = cr.output_id

    JOIN crafting_recipe_ingredients cri
      ON cri.recipe_id = cr.id

    JOIN items ing
      ON ing.id = cri.item_id

    LEFT JOIN (
      SELECT item_id, SUM(quantity) AS quantity
      FROM inventory
      WHERE player_id = ?
        AND equipped = 0
      GROUP BY item_id
    ) inv ON inv.item_id = ing.id

    WHERE cr.profession_key = ?
      AND cr.is_active = 1

    ORDER BY cr.display_order ASC, cr.id ASC, cri.id ASC
    `,
    [pid, pid, profession]
  );

  if (!rows.length) return res.redirect("/workshop");

  const recipes = new Map<number, any>();

  for (const row of rows) {
    const id = Number(row.recipeId);

    if (!recipes.has(id)) {
      recipes.set(id, {
        recipeId: id,
        stationName: row.station_name,
        outputName: row.outputName,
        outputIcon: row.outputIcon,
        outputQty: Number(row.output_qty || 1),
        goldCost: Number(row.gold_cost || 0),
        craftTimeMs: Number(row.craft_time_ms || 1600),
        requiredLevel: Number(row.required_level || 1),
        professionLevel: Number(row.professionLevel || 1),
        ingredients: []
      });
    }

    recipes.get(id).ingredients.push({
      itemId: Number(row.ingredientItemId),
      name: row.ingredientName,
      needed: Number(row.ingredientQty || 1),
      owned: Number(row.ownedQty || 0)
    });
  }

  const recipeList = Array.from(recipes.values());
  const stationName = recipeList[0].stationName;

  const recipeCards = recipeList.map((r: any) => {
    const hasMaterials = r.ingredients.every((i: any) => i.owned >= i.needed);
    const canCraft =
      r.professionLevel >= r.requiredLevel &&
      hasMaterials &&
      Number(player.gold || 0) >= r.goldCost;

    const ingredientHtml = r.ingredients.map((i: any) => `
      <span
        class="${i.owned >= i.needed ? "status good" : "status locked"}"
        data-ingredient-id="${Number(i.itemId)}"
      >
        ${esc(i.name)}: ${i.owned}/${i.needed}
      </span>
    `).join("");

    return `
      <article class="supplier-item" data-recipe-id="${r.recipeId}">
        <div class="supplier-icon">
          <img src="${esc(r.outputIcon || "/icons/items/default.png")}" onerror="this.style.display='none'">
        </div>

        <div class="supplier-main">
          <h3>${esc(r.outputName)}</h3>
          <p>Creates ${r.outputQty}× ${esc(r.outputName)}</p>
          <div class="supplier-meta">
            ${ingredientHtml}
            <span>Cost: ${r.goldCost}g</span>
          </div>
        </div>

        <div class="supplier-action">
          ${
            r.professionLevel < r.requiredLevel
              ? `<span class="status locked">Requires Lv ${r.requiredLevel}</span>`
              : canCraft
                ? `<button class="btn primary" type="button" onclick="startCrafting(${r.recipeId})">Craft</button>`
                : `<span class="status locked">Missing Materials</span>`
          }
        </div>
      </article>
    `;
  }).join("");

  const stationIcons: Record<string, string> = {
    smithing: "🔥",
    carpentry: "🪚",
    alchemy: "🧪"
  };

  const icon = stationIcons[profession] || "⚒️";

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

const sounds = stationSounds[profession] ?? stationSounds.smithing;

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
          <div class="hero-icon">${icon}</div>
          <div>
            <h1>${esc(stationName)}</h1>
            <p>Craft useful equipment and consumables from refined materials.</p>
          </div>
        </div>

        <div class="hero-actions">
          <span class="pill">Gold: <strong>${Number(player.gold || 0)}g</strong></span>
          <a class="btn danger" href="/workshop">Back to Workshop</a>
        </div>
      </header>

      <div class="station-tabs">
        <a class="station-tab" href="/workshop/refining/${esc(profession)}">🔥 Refining</a>
        <a class="station-tab active" href="/workshop/crafting/${esc(profession)}">⚒️ Crafting</a>
      </div>

      <section class="card service-card wide">
        <div class="cardHeader">
          <div class="cardTitle">
            <h2>Available Crafting Recipes</h2>
            <p>Select a recipe to craft an item.</p>
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

  <div id="craftingModal" class="gathering-modal hidden">
    <div class="gathering-modal__card">
      <div class="gathering-modal__icon">${icon}</div>
      <div class="gathering-modal__title">Crafting...</div>
      <div class="gathering-modal__sub">Working materials</div>

      <div class="gathering-progress">
        <div id="craftingProgressFill" class="gathering-progress__fill"></div>
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
async function startCrafting(recipeId) {
  const modal = document.getElementById("craftingModal");
  const fill = document.getElementById("craftingProgressFill");
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
    const res = await fetch("/workshop/craft/" + recipeId, {
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
      const errorMessages = {
        inventory_full: "Your inventory is full.",
        missing_materials: "You are missing required materials.",
        not_enough_gold: "You do not have enough gold.",
        recipe_not_found: "That recipe no longer exists.",
        profession_level_too_low: "Your profession level is too low.",
        profession_not_found: "Profession not found."
      };

      GFToast.show(
        "Crafting Failed",
        errorMessages[data.error] || "Unable to craft item.",
        {
          type: "error",
          durationMs: 2600
        }
      );

      return;
    }

    if (doneSound) {
      doneSound.volume = 0.7;
      doneSound.currentTime = 0;
      doneSound.play().catch(() => {});
    }

    GFToast.show(
      "Crafting Complete",
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

    if (card && Array.isArray(data.ingredients)) {
      let canCraftAgain = true;

      for (const ingredient of data.ingredients) {
        const el = card.querySelector(
          '[data-ingredient-id="' + ingredient.itemId + '"]'
        );

        if (!el) continue;

        el.textContent =
          ingredient.name + ": " + ingredient.remainingQty + "/" + ingredient.neededQty;

        el.className =
          ingredient.remainingQty >= ingredient.neededQty
            ? "status good"
            : "status locked";

        if (ingredient.remainingQty < ingredient.neededQty) {
          canCraftAgain = false;
        }
      }

      const actionEl = card.querySelector(".supplier-action");

      if (!canCraftAgain && actionEl) {
        actionEl.innerHTML = '<span class="status locked">Missing Materials</span>';
      }
    }

  } catch (err) {
    console.error("Crafting failed", err);

    if (modal) modal.classList.add("hidden");

    GFToast.show("Crafting Failed", "Something went wrong.", {
      type: "error",
      durationMs: 2600
    });
  }
}
</script>
</body>
</html>`);
});


router.post("/craft/:recipeId", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;
  const recipeId = Number(req.params.recipeId);

  if (!Number.isFinite(recipeId)) {
    return res.status(400).json({ error: "invalid_recipe" });
  }

  const [[recipe]]: any = await db.query(
    `
    SELECT
      cr.*,
      COALESCE(outItem.name, outBase.name) AS outputName
    FROM crafting_recipes cr
    LEFT JOIN items outItem
      ON cr.output_type = 'item'
     AND outItem.id = cr.output_id
    LEFT JOIN item_bases outBase
      ON cr.output_type = 'item_base'
     AND outBase.id = cr.output_id
    WHERE cr.id = ?
      AND cr.is_active = 1
    LIMIT 1
    `,
    [recipeId]
  );

  if (!recipe) {
    return res.status(404).json({ error: "recipe_not_found" });
  }

const [ingredients]: any = await db.query(
  `
  SELECT item_id, quantity
  FROM crafting_recipe_ingredients
  WHERE recipe_id = ?
  `,
  [recipeId]
);

const space = await hasInventorySpace(pid, Number(recipe.output_qty || 1));

if (!space.hasSpace) {
  return res.status(400).json({ error: "inventory_full" });
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

try {
  await conn.beginTransaction();

    for (const ing of ingredients) {
      const ok = await consumeItemStacks(
        conn,
        pid,
        Number(ing.item_id),
        Number(ing.quantity)
      );

      if (!ok) {
        await conn.rollback();
        return res.status(400).json({ error: "missing_materials" });
      }
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

    if (recipe.output_type === "item") {
      await addItemWithConn(
        conn,
        pid,
        Number(recipe.output_id),
        Number(recipe.output_qty || 1)
      );
    } else if (recipe.output_type === "item_base") {
      const createdItemId = await createItemFromBase(conn, Number(recipe.output_id));

      await addItemWithConn(
        conn,
        pid,
        createdItemId,
        Number(recipe.output_qty || 1)
      );
    }

    const professionResult = await grantProfessionExperience(
      conn,
      pid,
      String(recipe.profession_key),
      Number(recipe.profession_exp || 0)
    );

    await conn.commit();

    const [remainingRows]: any = await conn.query(
  `
  SELECT
    cri.item_id AS itemId,
    ing.name,
    cri.quantity AS neededQty,
    COALESCE(inv.quantity, 0) AS remainingQty
  FROM crafting_recipe_ingredients cri
  JOIN items ing ON ing.id = cri.item_id
  LEFT JOIN (
    SELECT item_id, SUM(quantity) AS quantity
    FROM inventory
    WHERE player_id = ?
      AND equipped = 0
    GROUP BY item_id
  ) inv ON inv.item_id = cri.item_id
  WHERE cri.recipe_id = ?
  ORDER BY cri.id ASC
  `,
  [pid, recipeId]
);

    return res.json({
  success: true,
  outputName: recipe.outputName,
  outputQty: Number(recipe.output_qty || 1),
  professionExp: Number(recipe.profession_exp || 0),
  professionResult,
  ingredients: remainingRows.map((r: any) => ({
    itemId: Number(r.itemId),
    name: String(r.name),
    neededQty: Number(r.neededQty || 1),
    remainingQty: Number(r.remainingQty || 0)
  }))
});
  } catch (err) {
    await conn.rollback();
    console.error("Crafting failed:", err);
    return res.status(500).json({ error: "server_error" });
  } finally {
    conn.release();
  }
});


async function consumeItemStacks(conn: any, playerId: number, itemId: number, qtyNeeded: number) {
  const [stacks]: any = await conn.query(
    `
    SELECT inventory_id, quantity
    FROM inventory
    WHERE player_id = ?
      AND item_id = ?
      AND equipped = 0
    ORDER BY inventory_id ASC
    FOR UPDATE
    `,
    [playerId, itemId]
  );

  let total = 0;
  for (const s of stacks) total += Number(s.quantity || 0);

  if (total < qtyNeeded) return false;

  let remaining = qtyNeeded;

  for (const s of stacks) {
    if (remaining <= 0) break;

    const stackQty = Number(s.quantity || 0);
    const take = Math.min(stackQty, remaining);
    const newQty = stackQty - take;

    if (newQty > 0) {
      await conn.query(
        `UPDATE inventory SET quantity = ? WHERE inventory_id = ?`,
        [newQty, s.inventory_id]
      );
    } else {
      await conn.query(
        `DELETE FROM inventory WHERE inventory_id = ?`,
        [s.inventory_id]
      );
    }

    remaining -= take;
  }

  return true;
}


async function createItemFromBase(conn: any, baseId: number) {
  const [[base]]: any = await conn.query(
    `
    SELECT *
    FROM item_bases
    WHERE id = ?
      AND is_active = 1
    LIMIT 1
    `,
    [baseId]
  );

  if (!base) throw new Error("ITEM_BASE_NOT_FOUND");

  const category = base.slot === "weapon" ? "weapon" : "armor";

  const [result]: any = await conn.query(
    `
    INSERT INTO items
    (
      name, type, slot, rarity,
      attack, defense, agility, vitality, intellect, crit,
      icon, description, value, category, item_type, is_combat
    )
    VALUES
    (?, ?, ?, 'common', ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, 0)
    `,
    [
      base.name,
      base.item_type,
      base.slot,
      Number(base.base_attack || 0),
      Number(base.base_defense || 0),
      base.icon,
      base.description,
      Number(base.sell_value || 0),
      category,
      base.weapon_class || base.armor_weight || base.item_type
    ]
  );

  return Number(result.insertId);
}

export default router;