// src/combat.routes.ts
import { Router } from "express";
import { db } from "./db";
import { resolveAttack } from "./services/combatEngine";
import { getFinalPlayerStats } from "./services/playerService";
import { handleCreatureKill } from "./services/killService";
import { getCreatureDebuffTotals } from "./services/creatureDebuffService";
import {
  createCombatSession,
  ensureCombatSession,
  advanceCombatSession,
  buildCombatSnapshot,
  consumeActorTurn,
  destroyCombatSession,
  getActorReadyInMs
} from "./services/combatSessionService";

const router = Router();

// ✅ POTION GLOBAL COOLDOWN (server authoritative)
const potionCooldowns = new Map<number, { health: number; mana: number }>();
const POTION_GCD_MS = 2000; // 2 seconds

function getPotionCd(pid: number) {
  const cur = potionCooldowns.get(pid);
  if (cur) return cur;
  const fresh = { health: 0, mana: 0 };
  potionCooldowns.set(pid, fresh);
  return fresh;
}

async function useInventoryItemInCombat(
  pid: number,
  invId: number,
  potionSlot?: "health" | "mana"
) {
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
  // ✅ Potion global cooldown (server-side)
// ✅ Potion cooldown per slot (server-side authoritative)
if (String(row.type) === "potion") {
  if (!potionSlot) {
    return { error: "Potion slot missing", status: 400 };
  }

  const now = Date.now();
  const cd = getPotionCd(pid);
  const nextAllowed = cd[potionSlot] || 0;

  if (now < nextAllowed) {
    return {
      error: "cooldown",
      status: 429,
      remainingMs: nextAllowed - now
    };
  }

  cd[potionSlot] = now + POTION_GCD_MS;
  potionCooldowns.set(pid, cd); // (not strictly necessary, but explicit)
}
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

async function getOrCreateSession(pid: number) {
  let session = ensureCombatSession(pid);
  if (!session) {
    session = await createCombatSession(pid);
  }
  return session;
}

async function refreshPlayerActor(session: any) {
  const player = await getFinalPlayerStats(session.playerId);
  if (!player) return null;

  session.player.stats = player;
  session.player.name = player.name ?? "Player";
  session.player.hp = Number(player.hpoints ?? 0);
  session.player.maxHp = Number(player.maxhp ?? 1);
  session.player.sp = Number(player.spoints ?? 0);
  session.player.maxSp = Number(player.maxspoints ?? 0);

  return player;
}

async function refreshEnemyActor(session: any) {
const [[enemyRow]]: any = await db.query(
  `
  SELECT
    pc.id,
    pc.hp,
    c.name,
    c.level,
    c.description,
    c.attack,
    c.defense,
    c.agility,
    c.crit,
    c.maxhp
  FROM player_creatures pc
  JOIN creatures c ON c.id = pc.creature_id
  WHERE pc.id = ?
    AND pc.player_id = ?
  LIMIT 1
  `,
  [session.enemyInstanceId, session.playerId]
);

  if (!enemyRow) return null;

  const debuffs = await getCreatureDebuffTotals(enemyRow.id);

const enemyStats = {
  level: Number(enemyRow.level ?? 1),
  attack: Number(enemyRow.attack ?? 0) + Number(debuffs.attack || 0),
  defense: Number(enemyRow.defense ?? 0) + Number(debuffs.defense || 0),
  agility: Number(enemyRow.agility ?? 0) + Number(debuffs.agility || 0),
  vitality: Number(debuffs.vitality || 0),
  intellect: Number(debuffs.intellect || 0),
  crit: Number(enemyRow.crit ?? 0) + Number(debuffs.crit || 0),

  hpoints: Number(enemyRow.hp ?? 0),
  spoints: 0,
  maxhp: Number(enemyRow.maxhp ?? 1),
  maxspoints: 0,

  dodgeChance: 0,
  spellPower: 1,
  critDamageMult: 1.5,
  damageReduction: 0,
  lifesteal: 0
};

  session.enemy.name = String(enemyRow.name ?? "Enemy");
  session.enemy.level = Number(enemyRow.level ?? 1);
  session.enemy.description = String(enemyRow.description ?? "");
  session.enemy.hp = Number(enemyRow.hp ?? 0);
  session.enemy.maxHp = Number(enemyRow.maxhp ?? 1);
  session.enemy.stats = enemyStats as any;

  return { row: enemyRow, stats: enemyStats };
}



/* ===========================
   GET COMBAT STATE
=========================== */
router.get("/combat/state", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.json({ inCombat: false });

    const session = await getOrCreateSession(pid);
    if (!session) {
      return res.json({ inCombat: false });
    }

    await refreshPlayerActor(session);
    const enemyData = await refreshEnemyActor(session);

    if (!enemyData) {
      const snapshot = buildCombatSnapshot(session);
      destroyCombatSession(pid);

      return res.json({
        inCombat: false,
        snapshot
      });
    }

    await advanceCombatSession(session);

    return res.json({
      inCombat: session.state === "active",
      snapshot: buildCombatSnapshot(session)
    });
  } catch (err) {
    console.error("GET /combat/state failed", err);
    return res.status(500).json({ inCombat: false });
  }
});
/* ===========================
   POLL COMBAT STATUS (HP SYNC)
   Used by client while DOT/HOT active
=========================== */
router.get("/combat/poll", async (req, res) => {
  return res.json({ stop: true });
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

  const out: any = await useInventoryItemInCombat(
  pid,
  invId,
  slot as "health" | "mana"
);

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
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.status(401).json({ error: "Not logged in" });

    const session = await getOrCreateSession(pid);
    if (!session) {
      return res.status(404).json({ error: "No enemy" });
    }

    await refreshPlayerActor(session);
    const enemyData = await refreshEnemyActor(session);

    if (!enemyData) {
      session.state = "victory";
      return res.json({
        error: "No enemy",
        snapshot: buildCombatSnapshot(session)
      });
    }

    await advanceCombatSession(session);

    if (session.state !== "active") {
      return res.json({
        error: "combat_over",
        snapshot: buildCombatSnapshot(session)
      });
    }

    if (!session.player.ready) {
      return res.json({
        error: "not_ready",
        remainingMs: getActorReadyInMs(session.player),
        snapshot: buildCombatSnapshot(session)
      });
    }

    const attacker = session.player.stats as any;
    const defender = enemyData.stats as any;

    const result = resolveAttack(attacker, defender);

    let damage = Math.max(0, Number(result.damage || 0));
    let newEnemyHP = Math.max(0, session.enemy.hp - damage);

    await db.query(
      "UPDATE player_creatures SET hp = ? WHERE id = ?",
      [newEnemyHP, session.enemyInstanceId]
    );

    session.enemy.hp = newEnemyHP;
    session.log.push(
      result.dodged
        ? "⚔ Your attack missed!"
        : `⚔ You hit for ${damage}${result.crit ? " (CRITICAL!)" : ""}`
    );

    // lifesteal
    let lifestealHeal = 0;
    if (!result.dodged && damage > 0 && Number(attacker.lifesteal || 0) > 0) {
      lifestealHeal = Math.floor(damage * Number(attacker.lifesteal || 0));
      if (lifestealHeal > 0) {
        session.player.hp = Math.min(session.player.maxHp, session.player.hp + lifestealHeal);

        await db.query(
          "UPDATE players SET hpoints = ? WHERE id = ?",
          [session.player.hp, pid]
        );

        session.log.push(`🩸 You restore ${lifestealHeal} HP.`);
      }
    }

    consumeActorTurn(session.player, 350);

    let reward = null;

    if (newEnemyHP <= 0) {
      reward = await handleCreatureKill(pid, session.enemyInstanceId);

      session.state = "victory";
      session.rewards = {
        exp: reward?.expGained,
        gold: reward?.goldGained,
        levelUp: reward?.levelUp,
        chest: reward?.chest ?? null,
        quest: reward?.quest ?? null
      };

      session.log.push("🏆 Enemy defeated!");
      if (reward?.expGained) session.log.push(`✨ You gained ${reward.expGained} EXP!`);
      if (reward?.goldGained) session.log.push(`💰 You gained ${reward.goldGained} gold!`);
      if (reward?.levelUp) session.log.push("⬆ LEVEL UP!");
    }

    return res.json({
      damage,
      crit: result.crit,
      dodged: result.dodged,
      enemyHP: newEnemyHP,
      dead: newEnemyHP <= 0,
      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp,
      chest: reward?.chest ?? null,
      quest: reward?.quest ?? null,
      lifestealHeal,
      snapshot: buildCombatSnapshot(session)
    });
  } catch (err) {
    console.error("POST /combat/attack failed", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ===========================
   ENEMY AUTO ATTACK
=========================== */
router.post("/combat/enemy-attack", async (req, res) => {
  return res.json({ stop: true });
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

  destroyCombatSession(pid);

  res.json({ success: true });
});

export default router;
