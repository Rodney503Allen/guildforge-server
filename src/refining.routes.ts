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
    .replace(/\"/g, "&quot;")
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
      inputItem2.name AS inputName2,
      outputItem.name AS outputName
    FROM refining_recipes rr
    JOIN items inputItem ON inputItem.id = rr.input_item_id
    LEFT JOIN items inputItem2 ON inputItem2.id = rr.input_item_id_2
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

    const input1Id = Number(recipe.input_item_id);
    const input1Qty = Number(recipe.input_qty || 1);
    const input2Id = recipe.input_item_id_2 ? Number(recipe.input_item_id_2) : null;
    const input2Qty = input2Id ? Number(recipe.input_qty_2 || 0) : 0;

    const hasInput1 = await hasEnoughItem(conn, pid, input1Id, input1Qty);
    if (!hasInput1) {
      await conn.rollback();
      return res.status(400).json({ error: "missing_materials" });
    }

    if (input2Id && input2Qty > 0) {
      const hasInput2 = await hasEnoughItem(conn, pid, input2Id, input2Qty);
      if (!hasInput2) {
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

    const consumedInput1 = await consumeItemStacks(conn, pid, input1Id, input1Qty);
    if (!consumedInput1) {
      await conn.rollback();
      return res.status(400).json({ error: "missing_materials" });
    }

    if (input2Id && input2Qty > 0) {
      const consumedInput2 = await consumeItemStacks(conn, pid, input2Id, input2Qty);
      if (!consumedInput2) {
        await conn.rollback();
        return res.status(400).json({ error: "missing_materials" });
      }
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

  const [[updatedPlayer]]: any = await db.query(
    `
      SELECT gold
      FROM players
      WHERE id = ?
      LIMIT 1
    `,
    [pid]
  );

  const inputIds = [
    Number(recipe.input_item_id),
    ...(recipe.input_item_id_2 && Number(recipe.input_qty_2 || 0) > 0
      ? [Number(recipe.input_item_id_2)]
      : [])
  ];

  const [inventoryRows]: any = await db.query(
    `
      SELECT
        item_id,
        COALESCE(SUM(quantity), 0) AS quantity
      FROM inventory
      WHERE player_id = ?
        AND equipped = 0
        AND item_id IN (?)
      GROUP BY item_id
    `,
    [pid, inputIds]
  );

  const ownedByItem = new Map<number, number>();

  for (const row of inventoryRows || []) {
    ownedByItem.set(
      Number(row.item_id),
      Number(row.quantity || 0)
    );
  }

  return res.json({
    success: true,
    outputName: recipe.outputName,
    outputQty: Number(recipe.output_qty || 1),
    professionExp: Number(recipe.profession_exp || 0),
    professionResult,
    gold: Number(updatedPlayer?.gold || 0),
    inputs: [
      {
        itemId: Number(recipe.input_item_id),
        name: recipe.inputName,
        quantity: Number(recipe.input_qty || 1),
        owned: ownedByItem.get(Number(recipe.input_item_id)) || 0
      },
      ...(recipe.input_item_id_2 && Number(recipe.input_qty_2 || 0) > 0
        ? [{
            itemId: Number(recipe.input_item_id_2),
            name: recipe.inputName2,
            quantity: Number(recipe.input_qty_2 || 0),
            owned: ownedByItem.get(Number(recipe.input_item_id_2)) || 0
          }]
        : [])
    ]
  });
});

router.get("/refining/:profession", requireLogin, async (req: any, res: any) => {
  const pid = req.session.playerId as number;
  const profession = String(req.params.profession || "").toLowerCase();

  const [[player]]: any = await db.query(
    `SELECT name, gold FROM players WHERE id = ? LIMIT 1`,
    [pid]
  );

  if (!player) return res.redirect("/login.html");

  const [recipes]: any = await db.query(
    `
    SELECT
      rr.id AS recipeId,
      rr.profession_key,
      rr.station_name,
      rr.input_item_id,
      rr.input_qty,
      rr.input_item_id_2,
      rr.input_qty_2,
      rr.output_qty,
      rr.required_level,
      rr.gold_cost,
      rr.profession_exp,
      COALESCE(pp.level, 1) AS professionLevel,
      inputItem.name AS inputName,
      inputItem.icon AS inputIcon,
      inputItem2.name AS inputName2,
      inputItem2.icon AS inputIcon2,
      outputItem.name AS outputName,
      outputItem.icon AS outputIcon,
      COALESCE(inv1.quantity, 0) AS ownedInputQty,
      COALESCE(inv2.quantity, 0) AS ownedInputQty2
    FROM refining_recipes rr
    JOIN professions prof
      ON LOWER(prof.name) = LOWER(rr.profession_key)
    LEFT JOIN player_professions pp
      ON pp.player_id = ?
     AND pp.profession_id = prof.id
    JOIN items inputItem ON inputItem.id = rr.input_item_id
    LEFT JOIN items inputItem2 ON inputItem2.id = rr.input_item_id_2
    JOIN items outputItem ON outputItem.id = rr.output_item_id
    LEFT JOIN (
      SELECT item_id, SUM(quantity) AS quantity
      FROM inventory
      WHERE player_id = ? AND equipped = 0
      GROUP BY item_id
    ) inv1 ON inv1.item_id = rr.input_item_id
    LEFT JOIN (
      SELECT item_id, SUM(quantity) AS quantity
      FROM inventory
      WHERE player_id = ? AND equipped = 0
      GROUP BY item_id
    ) inv2 ON inv2.item_id = rr.input_item_id_2
    WHERE rr.profession_key = ?
      AND rr.is_active = 1
    ORDER BY rr.display_order ASC, rr.id ASC
    `,
    [pid, pid, pid, profession]
  );

  if (!recipes.length) return res.redirect("/workshop");

  const stationName = recipes[0].station_name;

  const recipeCards = recipes.map((r: any) => {
    const owned1 = Number(r.ownedInputQty || 0);
    const needed1 = Number(r.input_qty || 1);
    const hasSecondInput = Boolean(r.input_item_id_2) && Number(r.input_qty_2 || 0) > 0;
    const owned2 = Number(r.ownedInputQty2 || 0);
    const needed2 = Number(r.input_qty_2 || 0);
    const professionLevel = Number(r.professionLevel || 1);
    const requiredLevel = Number(r.required_level || 1);

    const hasMaterials = owned1 >= needed1 && (!hasSecondInput || owned2 >= needed2);
    const canRefine = professionLevel >= requiredLevel && hasMaterials && Number(player.gold || 0) >= Number(r.gold_cost || 0);

    const materialText = hasSecondInput
      ? `${needed1}x ${esc(r.inputName)} + ${needed2}x ${esc(r.inputName2)} → ${Number(r.output_qty || 1)}x ${esc(r.outputName)}`
      : `${needed1}x ${esc(r.inputName)} → ${Number(r.output_qty || 1)}x ${esc(r.outputName)}`;

    const ownedText = hasSecondInput
      ? `<span data-owned-item-id="${Number(r.input_item_id)}">${esc(r.inputName)}: <strong class="owned-count">${owned1}</strong>/${needed1}</span><span data-owned-item-id="${Number(r.input_item_id_2)}">${esc(r.inputName2)}: <strong class="owned-count">${owned2}</strong>/${needed2}</span>`
      : `<span data-owned-item-id="${Number(r.input_item_id)}">${esc(r.inputName)}: <strong class="owned-count">${owned1}</strong>/${needed1}</span>`;

    return `
      <article
        class="supplier-item"
        data-recipe-id="${Number(r.recipeId)}"
        data-input-item-id="${Number(r.input_item_id)}"
        data-input-item-id-2="${r.input_item_id_2 ? Number(r.input_item_id_2) : ""}"
        data-needed="${needed1}"
        data-needed-2="${needed2}"
        data-gold-cost="${Number(r.gold_cost || 0)}"
        data-required-level="${requiredLevel}"
      >
        <div class="supplier-icon">
          <img src="${esc(r.outputIcon || "/icons/items/default.png")}" onerror="this.style.display='none'">
        </div>
        <div class="supplier-main">
          <h3>${esc(r.outputName)}</h3>
          <p>${materialText}</p>
          <div class="supplier-meta">
            ${ownedText}
            <span>Cost: ${Number(r.gold_cost || 0)}g</span>
            <span>Lv ${requiredLevel}</span>
          </div>
        </div>
        <div class="supplier-action">
          ${
            professionLevel < requiredLevel
              ? `<span class="status locked">Requires Lv ${requiredLevel}</span>`
              : Number(player.gold || 0) < Number(r.gold_cost || 0)
                ? `<span class="status locked">Not Enough Gold</span>`
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

  const stationIcon = stationIcons[profession] ?? "⚒️";
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
          <div class="hero-icon">${stationIcon}</div>
          <div>
            <h1>${esc(stationName)}</h1>
            <p>Refine raw materials into usable crafting components.</p>
          </div>
        </div>
        <div class="hero-actions">
          <span class="pill">Gold: <strong id="refiningGold">${Number(player.gold || 0)}g</strong></span>
          <a class="btn danger" href="/workshop">Back to Workshop</a>
        </div>
      </header>
      <div class="station-tabs">
        <a class="station-tab active" href="/workshop/refining/${esc(profession)}">🔥 Refining</a>
        <a class="station-tab" href="/workshop/crafting/${esc(profession)}">⚒️ Crafting</a>
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
          <div class="supplier-list">${recipeCards}</div>
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
  <audio id="workAudio" preload="auto" src="${sounds.work}"></audio>
  <audio id="doneAudio" preload="auto" src="${sounds.done}"></audio>
  <audio id="professionLevelAudio" preload="auto" src="/sounds/profession-level.ogg"></audio>

  <script>
  let refiningBusy = false;

  function updateRefiningUI(data) {
    const gold =
      Number(data.gold || 0);

    const goldEl =
      document.getElementById("refiningGold");

    if (goldEl) {
      goldEl.textContent =
        gold + "g";
    }

    const ownedByItem =
      new Map();

    for (const input of data.inputs || []) {
      ownedByItem.set(
        Number(input.itemId),
        Number(input.owned || 0)
      );
    }

    document
      .querySelectorAll(".supplier-item")
      .forEach(card => {
        const input1Id =
          Number(
            card.dataset.inputItemId ||
            0
          );

        const input2Id =
          Number(
            card.dataset.inputItemId2 ||
            0
          );

        const needed1 =
          Number(
            card.dataset.needed ||
            1
          );

        const needed2 =
          Number(
            card.dataset.needed2 ||
            0
          );

        const goldCost =
          Number(
            card.dataset.goldCost ||
            0
          );

        const requiredLevel =
          Number(
            card.dataset.requiredLevel ||
            1
          );

        const professionLevel =
          Number(
            data.professionResult?.newLevel ||
            data.professionResult?.level ||
            1
          );

        /*
         * Only counts returned by this refine are known to have
         * changed. Leave unrelated material counts untouched.
         */
        for (
          const materialEl of
          card.querySelectorAll(
            "[data-owned-item-id]"
          )
        ) {
          const itemId =
            Number(
              materialEl.dataset.ownedItemId ||
              0
            );

          if (!ownedByItem.has(itemId)) {
            continue;
          }

          const countEl =
            materialEl.querySelector(
              ".owned-count"
            );

          if (countEl) {
            countEl.textContent =
              String(
                ownedByItem.get(itemId)
              );
          }
        }

        const readOwned =
          (itemId) => {
            if (!itemId) {
              return 0;
            }

            const materialEl =
              card.querySelector(
                '[data-owned-item-id="' +
                itemId +
                '"]'
              );

            const countEl =
              materialEl?.querySelector(
                ".owned-count"
              );

            return Number(
              countEl?.textContent ||
              0
            );
          };

        const owned1 =
          readOwned(input1Id);

        const owned2 =
          input2Id
            ? readOwned(input2Id)
            : 0;

        const hasMaterials =
          owned1 >= needed1 &&
          (
            !input2Id ||
            owned2 >= needed2
          );

        const actionEl =
          card.querySelector(
            ".supplier-action"
          );

        if (!actionEl) {
          return;
        }

        if (
          professionLevel <
          requiredLevel
        ) {
          actionEl.innerHTML =
            '<span class="status locked">' +
            'Requires Lv ' +
            requiredLevel +
            '</span>';

          return;
        }

        if (gold < goldCost) {
          actionEl.innerHTML =
            '<span class="status locked">' +
            'Not Enough Gold' +
            '</span>';

          return;
        }

        if (!hasMaterials) {
          actionEl.innerHTML =
            '<span class="status locked">' +
            'Missing Materials' +
            '</span>';

          return;
        }

        const recipeId =
          Number(
            card.dataset.recipeId ||
            0
          );

        actionEl.innerHTML =
          '<button ' +
          'class="btn primary" ' +
          'type="button" ' +
          'onclick="startRefining(' +
          recipeId +
          ')">' +
          'Refine' +
          '</button>';
      });
  }

  async function startRefining(recipeId) {
    if (refiningBusy) return;
    refiningBusy = true;

    const modal = document.getElementById("refiningModal");
    const fill = document.getElementById("refiningProgressFill");
    const workSound = document.getElementById("workAudio");
    const doneSound = document.getElementById("doneAudio");
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
        refiningBusy = false;
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
        { type: "success", durationMs: 2200 }
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
          { type: "success", durationMs: 3000 }
        );
      }

      updateRefiningUI(data);
      refiningBusy = false;
    } catch (err) {
      console.error("Refining failed", err);

      if (workSound) {
        workSound.pause();
        workSound.currentTime = 0;
      }

      if (modal) modal.classList.add("hidden");

      GFToast.show(
        "Refining Failed",
        "Something went wrong.",
        { type: "error", durationMs: 2600 }
      );

      refiningBusy = false;
    }
  }
  </script>
</body>
</html>`);
});

async function hasEnoughItem(
  conn: any,
  playerId: number,
  itemId: number,
  qtyNeeded: number
) {
  if (!itemId || qtyNeeded <= 0) return true;

  const [[row]]: any = await conn.query(
    `
    SELECT COALESCE(SUM(quantity), 0) AS total
    FROM inventory
    WHERE player_id = ?
      AND item_id = ?
      AND equipped = 0
    `,
    [playerId, itemId]
  );

  return Number(row?.total || 0) >= qtyNeeded;
}

async function consumeItemStacks(
  conn: any,
  playerId: number,
  itemId: number,
  qtyNeeded: number
) {
  if (!itemId || qtyNeeded <= 0) return true;

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

export default router;
