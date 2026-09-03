// src/crafting.routes.ts
import express from "express";
import { db } from "./db";
import { addItemWithConn } from "./services/inventoryService";
import { hasInventorySpace } from "./services/inventoryCapacityService";
import { grantProfessionExperience } from "./services/professionExperienceService";
import { rollCraftingQuality, type CraftingQualityRoll } from "./services/craftingQualityService";
import { rollCraftedEquipmentAffixes } from "./services/craftingAffixService";
import {
  getAvailableCraftingCatalysts,
  validateAndConsumeCraftingCatalyst,
  type AppliedCraftingCatalyst
} from "./services/craftingCatalystService";

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

function safeJson(value: any) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
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
      cr.quality_difficulty,
      cr.gold_cost,
      cr.profession_exp,
      cr.craft_time_ms,
      cr.display_order,
      COALESCE(pp.level, 1) AS professionLevel,

      COALESCE(outItem.name, outBase.name) AS outputName,
      COALESCE(outItem.icon, outBase.icon) AS outputIcon,
      COALESCE(outItem.description, outBase.description) AS outputDescription,

      outBase.slot AS outputSlot,
      outBase.item_type AS outputItemType,
      outBase.armor_weight AS outputArmorWeight,
      outBase.weapon_class AS outputWeaponClass,
      outBase.base_attack AS outputBaseAttack,
      outBase.base_defense AS outputBaseDefense,

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
        outputType: row.output_type,
        outputId: Number(row.output_id),
        outputName: row.outputName,
        outputIcon: row.outputIcon,
        outputDescription: row.outputDescription || "",
        outputQty: Number(row.output_qty || 1),
        goldCost: Number(row.gold_cost || 0),
        professionExp: Number(row.profession_exp || 0),
        craftTimeMs: Number(row.craft_time_ms || 1600),
        requiredLevel: Number(row.required_level || 1),
        qualityDifficulty: Number(row.quality_difficulty || 0),
        professionLevel: Number(row.professionLevel || 1),
        slot: row.outputSlot || null,
        itemType: row.outputItemType || null,
        armorWeight: row.outputArmorWeight || null,
        weaponClass: row.outputWeaponClass || null,
        baseAttack: Number(row.outputBaseAttack || 0),
        baseDefense: Number(row.outputBaseDefense || 0),
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

  const recipeList = Array.from(recipes.values()).map((r: any) => {
    const hasMaterials = r.ingredients.every((i: any) => i.owned >= i.needed);
    const unlocked = r.professionLevel >= r.requiredLevel;
    const canAffordGold = Number(player.gold || 0) >= r.goldCost;

    return {
      ...r,
      unlocked,
      hasMaterials,
      canAffordGold,
      canCraft: unlocked && hasMaterials && canAffordGold
    };
  });

  const stationName = recipeList[0].stationName;
  const professionLevel = Number(recipeList[0].professionLevel || 1);
  const unlockedCount = recipeList.filter((r: any) => r.unlocked).length;
  const craftableCount = recipeList.filter((r: any) => r.canCraft).length;
  const lockedCount = recipeList.length - unlockedCount;

  const catalystData = await getAvailableCraftingCatalysts({
    conn: db,
    playerId: pid,
    professionKey: profession,
    professionLevel
  });

  const sortedRecipes = [...recipeList].sort((a: any, b: any) => {
    if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
    if (a.canCraft !== b.canCraft) return a.canCraft ? -1 : 1;
    if (a.requiredLevel !== b.requiredLevel) return a.requiredLevel - b.requiredLevel;
    return a.recipeId - b.recipeId;
  });

  const recipeRows = sortedRecipes.map((r: any) => {
    const state = !r.unlocked ? "locked" : r.canCraft ? "ready" : "missing";
    const stateLabel = !r.unlocked
      ? `Lv ${r.requiredLevel}`
      : r.canCraft
        ? "Ready"
        : "Missing";

    return `
      <button
        class="craft-recipe-row ${r.unlocked ? "" : "is-locked"}"
        type="button"
        data-recipe-id="${r.recipeId}"
        data-state="${state}"
        ${r.unlocked ? "" : 'data-locked="true" hidden'}
      >
        <span class="craft-recipe-icon">
          <img src="${esc(r.outputIcon || "/icons/items/default.png")}" alt="" onerror="this.style.display='none'">
        </span>

        <span class="craft-recipe-copy">
          <strong>${esc(r.outputName)}</strong>
          <small>Profession Lv ${r.requiredLevel}</small>
        </span>

        <span class="craft-recipe-state ${state}">${esc(stateLabel)}</span>
      </button>
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
  <link rel="stylesheet" href="/crafting.css">
  <link rel="stylesheet" href="/ui/toast.css">
  <script defer src="/statpanel.js"></script>
</head>

<body>
  <div id="statpanel-root"></div>

  <main class="workshop-page">
    <section class="workshop-shell frame-host">
      <span class="frame-border main" aria-hidden="true"></span>

      <header class="workshop-hero">
        <div class="hero-title">
          <div class="hero-icon">${icon}</div>
          <div>
            <h1>${esc(stationName)}</h1>
            <p>${esc(profession)} Lv ${professionLevel} • Select a recipe to review materials and craft.</p>
          </div>
        </div>

        <div class="hero-actions">
          <span class="pill">Level: <strong>${professionLevel}</strong></span>
          <span class="pill">Gold: <strong id="craftGold">${Number(player.gold || 0)}g</strong></span>
          <a class="btn danger" href="/workshop">Back to Workshop</a>
        </div>

        <span class="hero-divider-center" aria-hidden="true"></span>
      </header>

      <div class="station-tabs">
        <a class="station-tab" href="/workshop/refining/${esc(profession)}">🔥 Refining</a>
        <a class="station-tab active" href="/workshop/crafting/${esc(profession)}">⚒️ Crafting</a>
      </div>

      <div class="crafting-layout">
        <section class="card crafting-list-card frame-host">
          <span class="frame-border panel" aria-hidden="true"></span>

          <div class="cardHeader">
            <div class="cardTitle">
              <h2>Recipes</h2>
              <p><span id="visibleRecipeCount">${unlockedCount}</span> unlocked • ${craftableCount} ready</p>
            </div>

            <button
              id="toggleLockedRecipes"
              class="craft-lock-toggle"
              type="button"
              aria-pressed="false"
              ${lockedCount ? "" : "hidden"}
            >
              Show Locked (${lockedCount})
            </button>
          </div>

          <div class="cardBody crafting-list-body">
            <div class="craft-recipe-list" id="craftRecipeList">
              ${recipeRows || `<div class="empty">No recipes are available.</div>`}
            </div>
          </div>
        </section>

        <aside class="card crafting-detail-card frame-host">
          <span class="frame-border panel" aria-hidden="true"></span>

          <div class="cardHeader compact">
            <div class="cardTitle">
              <h2>Recipe Details</h2>
              <p id="detailAvailability">Select a recipe.</p>
            </div>
          </div>

          <div class="cardBody">
            <div class="craft-detail-hero">
              <div class="craft-detail-icon">
                <img id="detailIcon" src="/icons/items/default.png" alt="">
              </div>

              <div class="craft-detail-heading">
                <span id="detailKicker" class="craft-detail-kicker">Recipe</span>
                <h2 id="detailName">Select a Recipe</h2>
                <p id="detailDescription">Choose a recipe from the list to review its requirements.</p>
              </div>
            </div>

            <div class="craft-detail-stats" id="detailStats"></div>

            <section class="craft-material-panel">
              <div class="craft-section-heading">
                <h3>Materials</h3>
                <span id="detailCost"></span>
              </div>
              <div id="detailIngredients" class="craft-material-list"></div>
            </section>

            <section id="craftCatalystPanel" class="craft-catalyst-panel" hidden>
              <div class="craft-section-heading">
                <div>
                  <h3>Optional Catalyst</h3>
                  <p>Consume one catalyst to influence this equipment craft.</p>
                </div>
                <span id="catalystHint">Optional</span>
              </div>

              <div class="craft-catalyst-control">
                <select id="craftCatalystSelect" class="craft-catalyst-select">
                  <option value="">No Catalyst</option>
                </select>
                <div id="craftCatalystDescription" class="craft-catalyst-description">
                  Craft normally without consuming a catalyst.
                </div>
              </div>
            </section>

            <div class="craft-detail-footer">
              <div class="craft-detail-reward">
                <span>Crafting XP</span>
                <strong id="detailXp">+0 XP</strong>
              </div>

              <button id="detailCraftButton" class="btn primary craft-main-button" type="button" disabled>
                Select Recipe
              </button>
            </div>
          </div>
        </aside>
      </div>
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

  <audio id="workAudio" preload="auto" src="${sounds.work}"></audio>
  <audio id="doneAudio" preload="auto" src="${sounds.done}"></audio>
  <audio id="professionLevelAudio" preload="auto" src="/sounds/profession-level.ogg"></audio>

  <script>
    const recipeData = ${safeJson(sortedRecipes)};
    const catalystData = ${safeJson(catalystData)};
    let currentGold = ${Number(player.gold || 0)};
    let selectedRecipeId = null;
    let showLockedRecipes = false;

    const listEl = document.getElementById("craftRecipeList");
    const detailIcon = document.getElementById("detailIcon");
    const detailName = document.getElementById("detailName");
    const detailDescription = document.getElementById("detailDescription");
    const detailKicker = document.getElementById("detailKicker");
    const detailStats = document.getElementById("detailStats");
    const detailIngredients = document.getElementById("detailIngredients");
    const detailCost = document.getElementById("detailCost");
    const detailXp = document.getElementById("detailXp");
    const detailAvailability = document.getElementById("detailAvailability");
    const detailCraftButton = document.getElementById("detailCraftButton");
    const lockedToggle = document.getElementById("toggleLockedRecipes");
    const catalystPanel = document.getElementById("craftCatalystPanel");
    const catalystSelect = document.getElementById("craftCatalystSelect");
    const catalystDescription = document.getElementById("craftCatalystDescription");
    const catalystHint = document.getElementById("catalystHint");

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function getRecipe(recipeId) {
      return recipeData.find(r => Number(r.recipeId) === Number(recipeId));
    }

    function refreshComputedState(recipe) {
      recipe.unlocked = Number(recipe.professionLevel) >= Number(recipe.requiredLevel);
      recipe.hasMaterials = recipe.ingredients.every(i => Number(i.owned) >= Number(i.needed));
      recipe.canAffordGold = currentGold >= Number(recipe.goldCost || 0);
      recipe.canCraft = recipe.unlocked && recipe.hasMaterials && recipe.canAffordGold;
    }

    function getRecipeState(recipe) {
      if (!recipe.unlocked) return "locked";
      if (recipe.canCraft) return "ready";
      return "missing";
    }

    function renderStats(recipe) {
      const stats = [
        ["Required Level", recipe.requiredLevel],
        ["Craft Time", (Number(recipe.craftTimeMs || 0) / 1000).toFixed(1) + "s"]
      ];

      if (recipe.outputType === "item_base") {
        if (recipe.slot) stats.push(["Slot", String(recipe.slot)]);
        if (recipe.weaponClass) stats.push(["Weapon", String(recipe.weaponClass)]);
        if (recipe.armorWeight) stats.push(["Armor", String(recipe.armorWeight)]);
        if (Number(recipe.baseAttack) > 0) stats.push(["Base Attack", recipe.baseAttack]);
        if (Number(recipe.baseDefense) > 0) stats.push(["Base Defense", recipe.baseDefense]);
      }

      if (Number(recipe.qualityDifficulty || 0) > 0) {
        stats.push(["Quality Difficulty", recipe.qualityDifficulty]);
      }

      return stats.map(([label, value]) =>
        '<div class="craft-stat-box">' +
          '<span>' + escapeHtml(label) + '</span>' +
          '<strong>' + escapeHtml(value) + '</strong>' +
        '</div>'
      ).join("");
    }

    function getCatalyst(itemId) {
      return catalystData.find(c => Number(c.itemId) === Number(itemId));
    }

    function catalystEffectText(catalyst) {
      if (!catalyst) return "Craft normally without consuming a catalyst.";

      if (String(catalyst.effectKey) === "quality_weight_bonus") {
        return "+" + Number(catalyst.effectValue || 0) +
          "% weight to all unlocked non-Base crafting quality tiers.";
      }

      return catalyst.description || "Applies a special crafting effect.";
    }

    function refreshCatalystOptions(recipe) {
      if (!catalystPanel || !catalystSelect) return;

      const supportsCatalyst = recipe && recipe.outputType === "item_base";
      catalystPanel.hidden = !supportsCatalyst;

      if (!supportsCatalyst) {
        catalystSelect.value = "";
        return;
      }

      const previousValue = catalystSelect.value;
      catalystSelect.innerHTML = '<option value="">No Catalyst</option>';

      for (const catalyst of catalystData) {
        const option = document.createElement("option");
        option.value = String(catalyst.itemId);
        option.disabled = Number(catalyst.ownedQty || 0) <= 0;
        option.textContent = catalyst.name +
          " (Owned: " + Number(catalyst.ownedQty || 0) + ")" +
          (option.disabled ? " — None Available" : "");
        catalystSelect.appendChild(option);
      }

      const stillValid = previousValue &&
        catalystData.some(c =>
          String(c.itemId) === previousValue && Number(c.ownedQty || 0) > 0
        );

      catalystSelect.value = stillValid ? previousValue : "";
      refreshCatalystDescription();
    }

    function refreshCatalystDescription() {
      if (!catalystSelect || !catalystDescription) return;

      const catalyst = catalystSelect.value
        ? getCatalyst(Number(catalystSelect.value))
        : null;

      catalystDescription.textContent = catalystEffectText(catalyst);

      if (catalystHint) {
        catalystHint.textContent = catalyst
          ? "Uses 1× " + catalyst.name
          : "Optional";
      }
    }

    catalystSelect?.addEventListener("change", refreshCatalystDescription);

    function selectRecipe(recipeId) {
      const recipe = getRecipe(recipeId);
      if (!recipe) return;

      selectedRecipeId = Number(recipe.recipeId);
      refreshComputedState(recipe);

      document.querySelectorAll(".craft-recipe-row").forEach(row => {
        row.classList.toggle(
          "is-selected",
          Number(row.dataset.recipeId) === selectedRecipeId
        );
      });

      detailIcon.src = recipe.outputIcon || "/icons/items/default.png";
      detailName.textContent = recipe.outputName || "Recipe";
      detailDescription.textContent =
        recipe.outputDescription || "Craft this item from refined materials.";
      detailKicker.textContent =
        recipe.outputType === "item_base" ? "Equipment Recipe" : "Crafting Recipe";
      detailStats.innerHTML = renderStats(recipe);
      refreshCatalystOptions(recipe);

      detailIngredients.innerHTML = recipe.ingredients.map(i => {
        const enough = Number(i.owned) >= Number(i.needed);

        return (
          '<div class="craft-material-row ' + (enough ? "has-material" : "missing-material") + '">' +
            '<span>' + escapeHtml(i.name) + '</span>' +
            '<strong>' + Number(i.owned) + '/' + Number(i.needed) + '</strong>' +
          '</div>'
        );
      }).join("");

      detailCost.textContent = Number(recipe.goldCost || 0) > 0
        ? Number(recipe.goldCost) + "g"
        : "No gold cost";

      detailXp.textContent = "+" + Number(recipe.professionExp || 0) + " XP";

      if (!recipe.unlocked) {
        detailAvailability.textContent =
          "Locked • Requires profession level " + recipe.requiredLevel;
        detailCraftButton.disabled = true;
        detailCraftButton.textContent = "Locked";
      } else if (!recipe.hasMaterials) {
        detailAvailability.textContent = "Unlocked • Missing materials";
        detailCraftButton.disabled = true;
        detailCraftButton.textContent = "Missing Materials";
      } else if (!recipe.canAffordGold) {
        detailAvailability.textContent = "Unlocked • Not enough gold";
        detailCraftButton.disabled = true;
        detailCraftButton.textContent = "Need " + recipe.goldCost + "g";
      } else {
        detailAvailability.textContent = "Ready to craft";
        detailCraftButton.disabled = false;
        detailCraftButton.textContent = "Craft " + recipe.outputName;
      }

      detailCraftButton.dataset.recipeId = String(recipe.recipeId);
    }

    function refreshRecipeRows() {
      let visible = 0;

      recipeData.forEach(recipe => {
        refreshComputedState(recipe);

        const row = document.querySelector(
          '.craft-recipe-row[data-recipe-id="' + recipe.recipeId + '"]'
        );

        if (!row) return;

        const locked = !recipe.unlocked;
        row.hidden = locked && !showLockedRecipes;

        if (!row.hidden) visible++;

        const state = getRecipeState(recipe);
        row.dataset.state = state;
        row.classList.toggle("is-locked", locked);

        const stateEl = row.querySelector(".craft-recipe-state");
        if (stateEl) {
          stateEl.className = "craft-recipe-state " + state;
          stateEl.textContent = locked
            ? "Lv " + recipe.requiredLevel
            : recipe.canCraft
              ? "Ready"
              : "Missing";
        }
      });

      const visibleCount = document.getElementById("visibleRecipeCount");
      if (visibleCount) visibleCount.textContent = String(visible);

      if (selectedRecipeId) selectRecipe(selectedRecipeId);
    }

    listEl?.addEventListener("click", event => {
      const row = event.target.closest(".craft-recipe-row");
      if (!row) return;
      selectRecipe(Number(row.dataset.recipeId));
    });

    lockedToggle?.addEventListener("click", () => {
      showLockedRecipes = !showLockedRecipes;
      lockedToggle.setAttribute("aria-pressed", showLockedRecipes ? "true" : "false");
      lockedToggle.textContent = showLockedRecipes
        ? "Hide Locked"
        : "Show Locked (${lockedCount})";
      refreshRecipeRows();
    });

    detailCraftButton?.addEventListener("click", () => {
      const recipeId = Number(detailCraftButton.dataset.recipeId);
      if (Number.isFinite(recipeId)) startCrafting(recipeId);
    });

    async function startCrafting(recipeId) {
      const recipe = getRecipe(recipeId);
      if (!recipe) return;

      refreshComputedState(recipe);
      if (!recipe.canCraft) {
        selectRecipe(recipeId);
        return;
      }

      const modal = document.getElementById("craftingModal");
      const fill = document.getElementById("craftingProgressFill");
      const workSound = document.getElementById("workAudio");
      const doneSound = document.getElementById("doneAudio");
      const durationMs = Number(recipe.craftTimeMs || 1600);

      detailCraftButton.disabled = true;
      detailCraftButton.textContent = "Crafting...";

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
        const catalystItemId =
          recipe.outputType === "item_base" && catalystSelect?.value
            ? Number(catalystSelect.value)
            : null;

        const response = await fetch("/workshop/craft/" + recipeId, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ catalystItemId })
        });

        const data = await response.json();

        if (workSound) {
          workSound.pause();
          workSound.currentTime = 0;
        }

        if (modal) modal.classList.add("hidden");

        if (!response.ok || !data.success) {
          const errorMessages = {
            inventory_full: "Your inventory is full.",
            missing_materials: "You are missing required materials.",
            not_enough_gold: "You do not have enough gold.",
            recipe_not_found: "That recipe no longer exists.",
            profession_level_too_low: "Your profession level is too low.",
            profession_not_found: "Profession not found.",
            invalid_catalyst: "That catalyst cannot be used for this craft.",
            missing_catalyst: "You no longer have that catalyst.",
            catalyst_not_supported: "Catalysts can only be used on equipment crafts."
          };

          GFToast.show(
            "Crafting Failed",
            errorMessages[data.error] || "Unable to craft item.",
            { type: "error", durationMs: 2600 }
          );

          selectRecipe(recipeId);
          return;
        }

        if (doneSound) {
          doneSound.volume = 0.7;
          doneSound.currentTime = 0;
          doneSound.play().catch(() => {});
        }

        const qualityLabel = data.craftingQuality?.quality
          ? String(data.craftingQuality.quality)
              .replace(/_/g, " ")
              .replace(/\b\w/g, c => c.toUpperCase())
          : null;

        const catalystSuffix = data.catalyst?.name
          ? " Catalyst: " + data.catalyst.name + "."
          : "";

        GFToast.show(
          qualityLabel ? qualityLabel + " Craft!" : "Crafting Complete",
          qualityLabel
            ? "Created a " + qualityLabel + " " + data.outputName + ". +" + data.professionExp + " XP." + catalystSuffix
            : "Created " + data.outputQty + "× " + data.outputName + ". +" + data.professionExp + " XP." + catalystSuffix,
          { type: "success", durationMs: qualityLabel ? 3200 : 2600 }
        );

        if (Number(recipe.goldCost || 0) > 0) {
          currentGold = Math.max(0, currentGold - Number(recipe.goldCost || 0));
          const goldEl = document.getElementById("craftGold");
          if (goldEl) goldEl.textContent = currentGold + "g";
        }

        if (Array.isArray(data.ingredients)) {
          for (const updated of data.ingredients) {
            recipeData.forEach(candidate => {
              candidate.ingredients.forEach(ingredient => {
                if (Number(ingredient.itemId) === Number(updated.itemId)) {
                  ingredient.owned = Number(updated.remainingQty || 0);
                }
              });
            });
          }
        }

        if (data.catalyst?.itemId) {
          const catalyst = getCatalyst(Number(data.catalyst.itemId));
          if (catalyst) {
            catalyst.ownedQty = Number(data.catalyst.remainingQty || 0);
          }
        }

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
            { type: "success", durationMs: 3600 }
          );

          recipeData.forEach(candidate => {
            candidate.professionLevel = Number(data.professionResult.newLevel);
          });
        }

        refreshRecipeRows();
      } catch (error) {
        console.error("Crafting failed", error);

        if (workSound) {
          workSound.pause();
          workSound.currentTime = 0;
        }

        if (modal) modal.classList.add("hidden");

        GFToast.show("Crafting Failed", "Something went wrong.", {
          type: "error",
          durationMs: 2600
        });

        selectRecipe(recipeId);
      }
    }

    refreshRecipeRows();

    const firstVisibleRecipe = recipeData.find(r => r.unlocked) || recipeData[0];
    if (firstVisibleRecipe) selectRecipe(firstVisibleRecipe.recipeId);
  </script>
</body>
</html>`);
});

router.post("/craft/:recipeId", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;
  const recipeId = Number(req.params.recipeId);
  const requestedCatalystItemId = Number(req.body?.catalystItemId || 0);

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
    COALESCE(pp.level, 1) AS professionLevel,
    COALESCE(pp.is_specialized, 0) AS isSpecialized
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

    let craftingQuality: CraftingQualityRoll | null = null;
    let appliedCatalyst: AppliedCraftingCatalyst | null = null;

    if (requestedCatalystItemId > 0 && recipe.output_type !== "item_base") {
      await conn.rollback();
      return res.status(400).json({ error: "catalyst_not_supported" });
    }

    if (requestedCatalystItemId > 0) {
      try {
        appliedCatalyst = await validateAndConsumeCraftingCatalyst({
          conn,
          playerId: pid,
          catalystItemId: requestedCatalystItemId,
          professionKey: String(recipe.profession_key),
          professionLevel: Number(professionRow.professionLevel || 1)
        });
      } catch (error: any) {
        await conn.rollback();

        if (String(error?.message) === "MISSING_CATALYST") {
          return res.status(400).json({ error: "missing_catalyst" });
        }

        if (String(error?.message) === "INVALID_CATALYST") {
          return res.status(400).json({ error: "invalid_catalyst" });
        }

        throw error;
      }
    }

    if (recipe.output_type === "item") {
      await addItemWithConn(
        conn,
        pid,
        Number(recipe.output_id),
        Number(recipe.output_qty || 1)
      );
    } else if (recipe.output_type === "item_base") {
      craftingQuality = await rollCraftingQuality({
        conn,
        professionLevel: Number(professionRow.professionLevel || 1),
        isSpecialized: Number(professionRow.isSpecialized || 0) === 1,
        recipeRequiredLevel: Number(recipe.required_level || 1),
        qualityDifficulty: Number(recipe.quality_difficulty || 0),
        qualityWeightBonuses: appliedCatalyst?.qualityWeightBonuses || {}
      });

      const playerItemId = await createPlayerItemFromBase(
        conn,
        pid,
        Number(recipe.output_id),
        recipeId,
        craftingQuality
      );

      await conn.query(
        `
        INSERT INTO inventory
          (player_id, player_item_id, item_id, quantity, equipped)
        VALUES
          (?, ?, NULL, 1, 0)
        `,
        [pid, playerItemId]
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

    let catalystRemainingQty: number | null = null;

    if (appliedCatalyst) {
      const [[catalystInventory]]: any = await conn.query(
        `
        SELECT COALESCE(SUM(quantity), 0) AS quantity
        FROM inventory
        WHERE player_id = ?
          AND item_id = ?
          AND equipped = 0
        `,
        [pid, appliedCatalyst.itemId]
      );

      catalystRemainingQty = Number(catalystInventory?.quantity || 0);
    }

    return res.json({
  success: true,
  outputName: recipe.outputName,
  outputQty: Number(recipe.output_qty || 1),
  professionExp: Number(recipe.profession_exp || 0),
  professionResult,
  craftingQuality: craftingQuality
    ? {
        quality: craftingQuality.craftQuality,
        rarity: craftingQuality.rarity,
        chancePercent: craftingQuality.chancePercent,
        pool: craftingQuality.pool
      }
    : null,
  catalyst: appliedCatalyst
    ? {
        itemId: appliedCatalyst.itemId,
        name: appliedCatalyst.name,
        effectKey: appliedCatalyst.effectKey,
        effectValue: appliedCatalyst.effectValue,
        remainingQty: catalystRemainingQty
      }
    : null,
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


async function createPlayerItemFromBase(
  conn: any,
  playerId: number,
  baseId: number,
  recipeId: number | undefined,
  qualityRoll: CraftingQualityRoll
) {
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

  const itemLevel = Number(base.required_level || 1);

  const affixes = await rollCraftedEquipmentAffixes({
    conn,
    baseItemId: baseId,
    itemLevel,
    rarity: qualityRoll.rarity
  });

  const qualityLabels: Record<string, string> = {
    base: "",
    crafted: "Crafted",
    forged: "Forged",
    tempered: "Tempered",
    masterworked: "Masterworked"
  };

  const qualityLabel = qualityLabels[qualityRoll.craftQuality] || "";
  const generatedName = qualityLabel
    ? `${qualityLabel} ${base.name}`
    : base.name;

  const [result]: any = await conn.query(
    `
    INSERT INTO player_items
      (
        player_id,
        item_base_id,
        name,
        item_level,
        rarity,
        craft_quality,
        is_equipped,
        is_claimed,
        roll_json,
        source_type,
        source_id
      )
    VALUES
      (?, ?, ?, ?, ?, ?, 0, 1, ?, 'crafting', ?)
    `,
    [
      playerId,
      baseId,
      generatedName,
      itemLevel,
      qualityRoll.rarity,
      qualityRoll.craftQuality,
      affixes.length ? JSON.stringify(affixes) : null,
      recipeId ?? null
    ]
  );

  return Number(result.insertId);
}

export default router;