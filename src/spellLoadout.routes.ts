//spellLoadout.routes.ts
import { Router } from "express";
import {
  equipSpell,
  getEquippedSpells,
  swapEquippedSpells,
  unequipSpell
} from "./services/spellLoadoutService";
import { db } from "./db";

const router = Router();

function getPlayerId(req: any) {
  return Number(req.session?.playerId || 0);
}

function handleLoadoutError(res: any, err: any) {
  const message = String(err?.message || "");

  if (message === "INVALID_SLOT") {
    return res.status(400).json({
      error: "invalid_slot"
    });
  }

  if (message === "INVALID_SPELL") {
    return res.status(400).json({
      error: "invalid_spell"
    });
  }

  if (message === "SPELL_NOT_LEARNED") {
    return res.status(403).json({
      error: "spell_not_learned"
    });
  }

  console.error("🔥 Spell loadout error:", err);

  return res.status(500).json({
    error: "server_error"
  });
}

// =======================
// GET LEARNED COMBAT SPELLS
// =======================
router.get("/spells/learned", async (req, res) => {
  try {
    const playerId = getPlayerId(req);

    if (!playerId) {
      return res.status(401).json({
        error: "not_logged_in"
      });
    }

const [rows]: any = await db.query(
  `
  SELECT
    s.id,
    s.name,
    s.description,
    s.icon,
    s.level,
    s.mana_cost,
    s.cooldown,
    s.type,

    s.discipline_id,
    d.name AS discipline_name,

    s.damage,
    s.heal,

    s.dot_damage,
    s.dot_duration,
    s.dot_tick_rate,

    s.buff_stat,
    s.buff_value,
    s.buff_duration,

    s.debuff_stat,
    s.debuff_value,
    s.debuff_duration

  FROM player_spells ps
  JOIN spells s
    ON s.id = ps.spell_id
  JOIN disciplines d
    ON d.id = s.discipline_id
  WHERE ps.player_id = ?
    AND s.is_combat = 1
  ORDER BY
    d.id ASC,
    s.level ASC,
    s.name ASC
  `,
  [playerId]
);
const spells = (rows || []).map((row: any) => ({
  id: Number(row.id),
  name: row.name,
  description: row.description,
  icon: row.icon,
  level: Number(row.level || 1),
  manaCost: Number(row.mana_cost || 0),
  cooldown: Number(row.cooldown || 0),
  type: row.type,

  disciplineId: Number(row.discipline_id),
  disciplineName: row.discipline_name,

  damage: Number(row.damage || 0),
  heal: Number(row.heal || 0),

  dot_damage: Number(row.dot_damage || 0),
  dot_duration: Number(row.dot_duration || 0),
  dot_tick_rate: Number(row.dot_tick_rate || 0),

  buff_stat: row.buff_stat,
  buff_value: Number(row.buff_value || 0),
  buff_duration: Number(row.buff_duration || 0),

  debuff_stat: row.debuff_stat,
  debuff_value: Number(row.debuff_value || 0),
  debuff_duration: Number(row.debuff_duration || 0)
}));

    return res.json({
      success: true,
      spells
    });
  } catch (err) {
    console.error("GET /spells/learned failed:", err);

    return res.status(500).json({
      error: "server_error"
    });
  }
});

// =======================
// GET EQUIPPED SPELLS
// =======================
router.get("/spells/equipped", async (req, res) => {
  try {
    const playerId = getPlayerId(req);

    if (!playerId) {
      return res.status(401).json({
        error: "not_logged_in"
      });
    }

    const slots = await getEquippedSpells(playerId);

    return res.json({
      success: true,
      maxSlots: 6,
      slots
    });
  } catch (err) {
    return handleLoadoutError(res, err);
  }
});

// =======================
// EQUIP OR REPLACE SPELL
// =======================
router.post("/spells/equip", async (req, res) => {
  try {
    const playerId = getPlayerId(req);

    if (!playerId) {
      return res.status(401).json({
        error: "not_logged_in"
      });
    }

    const spellId = Number(req.body?.spellId);
    const slot = Number(req.body?.slot);

    const result = await equipSpell(
      playerId,
      spellId,
      slot
    );

    const slots = await getEquippedSpells(playerId);

    return res.json({
      ...result,
      slots
    });
  } catch (err) {
    return handleLoadoutError(res, err);
  }
});

// =======================
// UNEQUIP SPELL
// =======================
router.post("/spells/unequip", async (req, res) => {
  try {
    const playerId = getPlayerId(req);

    if (!playerId) {
      return res.status(401).json({
        error: "not_logged_in"
      });
    }

    const slot = Number(req.body?.slot);

    const result = await unequipSpell(
      playerId,
      slot
    );

    const slots = await getEquippedSpells(playerId);

    return res.json({
      ...result,
      slots
    });
  } catch (err) {
    return handleLoadoutError(res, err);
  }
});

// =======================
// SWAP TWO SPELL SLOTS
// =======================
router.post("/spells/swap", async (req, res) => {
  try {
    const playerId = getPlayerId(req);

    if (!playerId) {
      return res.status(401).json({
        error: "not_logged_in"
      });
    }

    const fromSlot = Number(req.body?.fromSlot);
    const toSlot = Number(req.body?.toSlot);

    const result = await swapEquippedSpells(
      playerId,
      fromSlot,
      toSlot
    );

    const slots = await getEquippedSpells(playerId);

    return res.json({
      ...result,
      slots
    });
  } catch (err) {
    return handleLoadoutError(res, err);
  }
});

export default router;