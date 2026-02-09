// src/combat.routes.ts
import { Router } from "express";
import { db } from "./db";
import { resolveAttack } from "./services/combatEngine";
import { getFinalPlayerStats } from "./services/playerService";
import { handleCreatureKill } from "./services/killService";
import { getCreatureDebuffTotals } from "./services/creatureDebuffService";

const router = Router();
const playerAttackCooldowns = new Map<number, number>();
const enemyAttackCooldowns = new Map<number, number>();

async function useInventoryItemInCombat(pid: number, invId: number) {
  // Fetch inventory row + item data (must belong to this player)
  const [[row]]: any = await db.query(
    `
    SELECT
      inv.inventory_id,
      inv.player_id,
      inv.quantity,
      inv.equipped,
      i.id AS item_id,
      i.name,
      i.type,
      i.category,
      i.is_combat,
      i.effect_type,
      i.effect_value,
      i.effect_target
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ?
      AND inv.player_id = ?
    LIMIT 1
    `,
    [invId, pid]
  );

  if (!row) return { error: "Item not found", status: 404 };
  if (Number(row.quantity) <= 0) return { error: "No quantity remaining", status: 400 };
  if (Number(row.equipped) === 1 && String(row.type) !== "potion") {
  return { error: "Cannot use equipped items", status: 400 };
  }

  // Combat-usable checks
  if (Number(row.is_combat) !== 1) return { error: "Item cannot be used in combat", status: 400 };
  if (!row.effect_type) return { error: "Item has no effect", status: 400 };

  // Use final/computed stats so max values match the game UI
  const player = await getFinalPlayerStats(pid);
  if (!player) return { error: "Player not found", status: 404 };

  let hp = Number(player.hpoints) || 0;
  const maxhp = Number(player.maxhp) || 0;
  let sp = Number(player.spoints) || 0;
  const maxsp = Number(player.maxspoints) || 0;

  const target = String(row.effect_target || "").toLowerCase();
  const val = Number(row.effect_value) || 0;

  let log = `🧪 You used ${row.name}.`;
  let changedHP = false;
  let changedSP = false;

  if (target === "hp" || target === "hpoints" || target === "health") {
    const before = hp;
    hp = Math.min(maxhp, hp + val);
    const gained = hp - before;
    log = `🧪 You used ${row.name} and restored ${gained} HP.`;
    changedHP = true;

  } else if (target === "sp" || target === "spoints" || target === "mana") {
    const before = sp;
    const effectiveMaxSP = Number.isFinite(maxsp) && maxsp > 0 ? maxsp : Infinity;
    sp = Math.max(0, Math.min(effectiveMaxSP, sp + val));
    const gained = sp - before;

    log = gained > 0
      ? `🧪 You used ${row.name} and restored ${gained} SP.`
      : `🧪 You used ${row.name}, but your SP is already full.`;

    changedSP = gained !== 0;
  }

  // Persist player changes
  if (changedHP) await db.query(`UPDATE players SET hpoints = ? WHERE id = ?`, [hp, pid]);
  if (changedSP) await db.query(`UPDATE players SET spoints = ? WHERE id = ?`, [sp, pid]);

  // Decrement item quantity
  await db.query(
    `UPDATE inventory SET quantity = GREATEST(0, quantity - 1) WHERE inventory_id = ? AND player_id = ?`,
    [invId, pid]
  );

  // Determine if depleted
  const [[after]]: any = await db.query(
    `SELECT quantity FROM inventory WHERE inventory_id = ? AND player_id = ? LIMIT 1`,
    [invId, pid]
  );

  const depleted = !after || Number(after.quantity) <= 0;

  // Optional delete if 0 (keep your behavior)
  await db.query(
    `DELETE FROM inventory WHERE inventory_id = ? AND player_id = ? AND quantity <= 0`,
    [invId, pid]
  );

  return {
    success: true,
    log,
    playerHP: hp,
    playerSP: sp,
    depleted
  };
}
/* ===========================
   GET COMBAT STATE
=========================== */
router.get("/combat/state", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.json({ inCombat: false });

  const [[row]]: any = await db.query(
    `
SELECT
  pc.id,
  c.name,
  pc.hp,
  c.maxhp,
  EXISTS (
  SELECT 1
  FROM player_creature_dots d
  WHERE d.player_creature_id = pc.id
    AND d.expires_at > NOW()
) AS hasStatus
FROM player_creatures pc
JOIN creatures c ON c.id = pc.creature_id
WHERE pc.player_id = ?

  `,
    [pid]
  );

  if (!row) {
    return res.json({ inCombat: false });
  }

res.json({
  inCombat: true,
  enemy: {
    id: row.id,
    name: row.name,
    hp: row.hp,
    maxHP: row.maxhp,
    hasStatus: !!row.hasStatus
  }
});

});

/* ===========================
   POLL COMBAT STATUS (HP SYNC)
   Used by client while DOT/HOT active
=========================== */
router.get("/combat/poll", async (req, res) => {
  console.log("🧪 /combat/poll HIT");

  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.json({ stop: true });

    const [[enemy]]: any = await db.query(
      `
      SELECT
        pc.id AS playerCreatureId,
        pc.hp AS enemyHP,
        c.maxhp AS enemyMaxHP
      FROM player_creatures pc
      JOIN creatures c ON c.id = pc.creature_id
      WHERE pc.player_id = ?
      LIMIT 1
      `,
      [pid]
    );

    if (!enemy) return res.json({ stop: true });

    let enemyHP = Number(enemy.enemyHP);
    const combatLog: string[] = [];
    let reward = null;

    // 🔥 DOT TICKS
    const [dots]: any = await db.query(
      `
      SELECT *
      FROM player_creature_dots
      WHERE player_creature_id = ?
        AND next_tick_at <= NOW()
        AND expires_at > NOW()
      `,
      [enemy.playerCreatureId]
    );

    for (const dot of dots) {
      enemyHP = Math.max(0, enemyHP - Number(dot.damage));

      await db.query(
        "UPDATE player_creatures SET hp = ? WHERE id = ?",
        [enemyHP, enemy.playerCreatureId]
      );

      await db.query(
        `
        UPDATE player_creature_dots
        SET next_tick_at = DATE_ADD(next_tick_at, INTERVAL tick_interval SECOND)
        WHERE id = ?
        `,
        [dot.id]
      );

      combatLog.push(`🔥 Enemy takes ${dot.damage} damage.`);
    }

    await db.query(
      "DELETE FROM player_creature_dots WHERE expires_at <= NOW()"
    );

    // ☠ Death check AFTER DOTs
    if (enemyHP <= 0 && enemy.enemyHP > 0) {
      reward = await handleCreatureKill(pid, enemy.playerCreatureId);
    }

    res.json({
      stop: false,
      enemyDead: enemyHP <= 0,
      enemyHP,
      enemyMaxHP: Number(enemy.enemyMaxHP),
      log: combatLog,
      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp
    });

  } catch (err) {
    console.error("🔥 /combat/poll ERROR:", err);
    res.status(500).json({ stop: true });
  }
});



/* ===========================
   COMBAT SPELLS
=========================== */
// GET combat spells for current player
router.get("/combat/spells", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.json([]);

    const [[player]]: any = await db.query(
      "SELECT pclass, level FROM players WHERE id = ?",
      [pid]
    );

    if (!player) return res.json([]);

    const [spells]: any = await db.query(
      `
      SELECT
        id,
        name,
        description,
        icon,
        type,
        scost,
        cooldown,

        -- direct effects
        damage,
        heal,

        -- DOT system
        dot_damage,
        dot_duration,
        dot_tick_rate,

        -- buffs
        buff_stat,
        buff_value,
        buff_duration,

        -- debuffs (NON-DOT ONLY)
        debuff_stat,
        debuff_value,
        debuff_duration
      FROM spells
      WHERE sclass = ?
        AND level <= ?
        AND is_combat = 1
      ORDER BY level ASC
      `,
      [player.pclass, player.level]
    );

    res.json(spells ?? []);
  } catch (err) {
    console.error("🔥 /combat/spells ERROR:", err);
    res.status(500).json([]);
  }
});
/* ===========================
   COMBAT ITEMS (USABLE)
=========================== */
router.get("/combat/items", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.json([]);

    const [rows]: any = await db.query(
      `
      SELECT
        inv.inventory_id,
        inv.quantity,
        i.id AS item_id,
        i.name,
        i.icon,
        i.effect_type,
        i.effect_value,
        i.effect_target,
        i.category,
        i.is_combat
      FROM inventory inv
      JOIN items i ON i.id = inv.item_id
      WHERE inv.player_id = ?
        AND inv.quantity > 0
        AND inv.equipped = 0

        -- must be usable in combat
        AND i.is_combat = 1

        -- must actually do something (your new system)
        AND i.effect_target IS NOT NULL
        AND i.effect_target <> ''
        AND i.effect_value IS NOT NULL
        AND i.effect_value > 0

        -- allow consumables (and scrolls if you want)
        AND i.category IN ('consumable','scroll')
      ORDER BY i.category ASC, i.name ASC
      `,
      [pid]
    );

    res.json(rows ?? []);
  } catch (err) {
    console.error("🔥 /combat/items ERROR:", err);
    res.status(500).json([]);
  }
});


/* ===========================
   USE COMBAT ITEM
=========================== */
router.post("/combat/use-item", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ error: "Not logged in" });

    const { inventoryId } = req.body || {};
    const invId = Number(inventoryId);
    if (!Number.isFinite(invId)) return res.status(400).json({ error: "Invalid inventoryId" });

    const out: any = await useInventoryItemInCombat(pid, invId);

    if (out?.error) {
      return res.status(out.status || 400).json({ error: out.error });
    }

    return res.json(out);
  } catch (err) {
    console.error("🔥 /combat/use-item ERROR:", err);
    res.status(500).json({ error: "server_error" });
  }
});


/* ===========================
   POTION HOTBAR
=========================== */
router.get("/combat/potions-equipped", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const [[p]]: any = await db.query(
    `SELECT equip_potion_hp_inventory_id AS hpInv,
            equip_potion_sp_inventory_id AS spInv
     FROM players WHERE id=?`,
    [pid]
  );

async function load(invId: number | null, expectedTarget: "hp" | "sp") {
  if (!invId) return null;

  const [[row]]: any = await db.query(
    `
    SELECT
      inv.inventory_id AS inventoryId,
      inv.quantity AS qty,
      i.id AS item_id,
      i.name,
      i.icon,
      i.type,
      i.effect_target,
      i.effect_value,
      i.effect_type,
      i.description,
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

  // ✅ enforce correct slot
  if (String(row.effect_target).toLowerCase() !== expectedTarget) return null;

  return row;
}

const health = await load(p?.hpInv ?? null, "hp");
const mana   = await load(p?.spInv ?? null, "sp");

  // auto-clear if invalid
  if (!health && p?.hpInv) {
    await db.query(`UPDATE players SET equip_potion_hp_inventory_id=NULL WHERE id=?`, [pid]);
  }
  if (!mana && p?.spInv) {
    await db.query(`UPDATE players SET equip_potion_sp_inventory_id=NULL WHERE id=?`, [pid]);
  }

  res.json({ health, mana });
});




router.post("/combat/potions-equip", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const slot = String(req.body.slot || "");
  const inventoryId = Number(req.body.inventoryId);

  const target = slot === "health" ? "hp" : slot === "mana" ? "sp" : null;
  if (!target || !Number.isFinite(inventoryId)) {
    return res.status(400).json({ error: "Invalid slot or inventoryId" });
  }

  const [[row]]: any = await db.query(
    `
    SELECT inv.inventory_id, inv.quantity,
           i.type, i.effect_target, i.is_combat
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.inventory_id = ?
      AND inv.player_id = ?
    LIMIT 1
    `,
    [inventoryId, pid]
  );

  if (!row) return res.status(404).json({ error: "Potion not found" });
  if (String(row.type) !== "potion") return res.status(400).json({ error: "Item is not a potion" });
  if (Number(row.is_combat) !== 1) return res.status(400).json({ error: "Potion not usable in combat" });
  if (String(row.effect_target).toLowerCase() !== target) return res.status(400).json({ error: "Potion doesn't match this slot" });
  if (Number(row.quantity) <= 0) return res.status(400).json({ error: "No quantity remaining" });

  if (slot === "health") {
    await db.query(`UPDATE players SET equip_potion_hp_inventory_id=? WHERE id=?`, [inventoryId, pid]);
  } else {
    await db.query(`UPDATE players SET equip_potion_sp_inventory_id=? WHERE id=?`, [inventoryId, pid]);
  }

  res.json({ success: true });
});

router.post("/combat/potions-use", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const slot = String(req.body.slot || "");
  const col =
    slot === "health" ? "equip_potion_hp_inventory_id" :
    slot === "mana" ? "equip_potion_sp_inventory_id" :
    null;

  if (!col) return res.status(400).json({ error: "Invalid slot" });

  const [[p]]: any = await db.query(`SELECT ${col} AS invId FROM players WHERE id=?`, [pid]);
  const invId = Number(p?.invId);

  if (!Number.isFinite(invId)) return res.status(400).json({ error: "No potion equipped" });

  const out: any = await useInventoryItemInCombat(pid, invId);

  if (out?.error) {
    return res.status(out.status || 400).json({ error: out.error });
  }

  // clear slot if depleted
  if (out.depleted) {
    await db.query(`UPDATE players SET ${col}=NULL WHERE id=?`, [pid]);
  }

  res.json(out);
});





/* ===========================
   PLAYER ATTACK
=========================== */
router.post("/combat/attack", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ error: "Not logged in" });

  const now = Date.now();
  const nextAllowed = playerAttackCooldowns.get(pid) || 0;

  if (now < nextAllowed) {
    return res.json({
      error: "cooldown",
      remaining: Math.ceil((nextAllowed - now) / 1000)
    });
  }

  const attacker = await getFinalPlayerStats(pid);
  if (!attacker) {
    return res.status(404).json({ error: "Player not found" });
  }

  const agility = Number(attacker.agility || 0);
  const delay = Math.max(400, 1200 - agility * 10);
  playerAttackCooldowns.set(pid, now + delay);

  const [[enemyRow]]: any = await db.query(
    `
    SELECT
      pc.id,
      pc.hp,
      c.attack,
      c.defense,
      c.maxhp
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.player_id = ?
  `,
    [pid]
  );

  if (!enemyRow) {
    return res.json({ error: "No enemy" });
  }

  const debuffs = await getCreatureDebuffTotals(enemyRow.id);

  const defender = {
    attack: Number(enemyRow.attack) + (debuffs["attack"] || 0),
    defense: Number(enemyRow.defense) + (debuffs["defense"] || 0),
    agility: debuffs["agility"] || 0,
    vitality: debuffs["vitality"] || 0,
    intellect: debuffs["intellect"] || 0,
    crit: debuffs["crit"] || 0,
    hpoints: enemyRow.hp,
    spoints: 0,
    maxhp: enemyRow.maxhp,
    maxspoints: 0,
    level: 1,
    dodgeChance: 0,
    spellPower: 1
  };

  const result = resolveAttack(attacker, defender);
  await db.query(
  "UPDATE player_creatures SET hp = GREATEST(0, hp - ?) WHERE id = ?",
  [result.damage, enemyRow.id]
);

const [[updated]]: any = await db.query(
  "SELECT hp FROM player_creatures WHERE id = ?",
  [enemyRow.id]
);

const newHP = updated.hp;

  let reward = null;
  if (newHP <= 0) {
    reward = await handleCreatureKill(pid, enemyRow.id);
    playerAttackCooldowns.delete(pid);
    enemyAttackCooldowns.delete(enemyRow.id);
  }

  res.json({
    damage: result.damage,
    crit: result.crit,
    dodged: result.dodged,
    enemyHP: newHP,
    dead: newHP <= 0,
    exp: reward?.expGained,
    gold: reward?.goldGained,
    levelUp: reward?.levelUp
  });
});

/* ===========================
   ENEMY AUTO ATTACK
=========================== */
router.post("/combat/enemy-attack", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ stop: true });

    const player = await getFinalPlayerStats(pid);
    if (!player) return res.json({ stop: true });

    const [[enemy]]: any = await db.query(
      `
      SELECT
        pc.id,
        pc.hp,
        c.attack,
        c.defense,
        c.agility,
        c.crit
      FROM player_creatures pc
      JOIN creatures c ON c.id = pc.creature_id
      WHERE pc.player_id = ?
    `,
      [pid]
    );
    if (!enemy) {
      return res.json({ stop: true });
    }


    const debuffs = await getCreatureDebuffTotals(enemy.id);

    const enemyStats = {
      level: 1,
      attack: Number(enemy.attack ?? 1) + (debuffs.attack || 0),
      defense: Number(enemy.defense ?? 0) + (debuffs.defense || 0),
      agility: Number(enemy.agility ?? 0) + (debuffs.agility || 0),
      vitality: debuffs.vitality || 0,
      intellect: debuffs.intellect || 0,
      crit: Number(enemy.crit ?? 0) + (debuffs.crit || 0),
      hpoints: Number(enemy.hp),
      spoints: 0,
      maxhp: Number(enemy.hp),
      maxspoints: 0,
      dodgeChance: 0,
      spellPower: 1
    };

    const now = Date.now();
    const nextAllowed = enemyAttackCooldowns.get(enemy.id) || 0;

    if (now < nextAllowed) {
      return res.json({ skipped: true });
    }

    const delay = Math.max(600, 1800 - (enemy.agility ?? 0) * 15);
    enemyAttackCooldowns.set(enemy.id, now + delay);

    const result = resolveAttack(enemyStats as any, player as any);
    const dmg = Math.max(0, Math.floor(Number(result.damage) || 0));
    const newHP = Math.max(0, Number(player.hpoints) - dmg);

    await db.query(
      "UPDATE players SET hpoints = ? WHERE id = ?",
      [newHP, pid]
    );

    if (newHP <= 0) {
      // Clear combat enemy (ends combat)
      await db.query("DELETE FROM player_creatures WHERE player_id = ?", [pid]);

      // clear cooldowns so next combat starts clean
      playerAttackCooldowns.delete(pid);
      enemyAttackCooldowns.delete(enemy.id);

      return res.json({
        type: "enemy-attack",
        playerDead: true,
        redirect: "/death.html",
        damage: dmg,
        crit: result.crit,
        dodged: result.dodged,
        playerHP: newHP,
        playerMaxHP: player.maxhp
      });
    }

    res.json({
      type: "enemy-attack",
      playerDead: newHP <= 0,
      enemyDead: false,
      damage: dmg,
      crit: result.crit,
      dodged: result.dodged,
      playerHP: newHP,
      playerMaxHP: player.maxhp
    });

  } catch (err) {
    console.error("🔥 ENEMY ATTACK ERROR:", err);
    res.status(500).json({ stop: true });
  }
});

/* ===========================
   FLEE COMBAT
=========================== */
router.post("/combat/flee", async (req, res) => {
  const pid = (req.session as any).playerId;
  if (!pid) return res.status(401).json({ success: false });

  await db.query(
    "DELETE FROM player_creatures WHERE player_id = ?",
    [pid]
  );

  playerAttackCooldowns.delete(pid);
  enemyAttackCooldowns.clear();

  res.json({ success: true });
});

export default router;
