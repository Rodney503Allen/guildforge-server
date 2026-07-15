// services/spellLoadoutService.ts
import { db } from "../db";

export const MAX_HOTBAR_SLOTS = 6;

function validateSlot(slot: number) {
  if (
    !Number.isInteger(slot) ||
    slot < 1 ||
    slot > MAX_HOTBAR_SLOTS
  ) {
    throw new Error("INVALID_SLOT");
  }
}

async function verifyLearnedSpell(
  conn: any,
  playerId: number,
  spellId: number
) {
  const [[row]]: any = await conn.query(
    `
    SELECT 1
    FROM player_spells ps
    JOIN spells s
      ON s.id = ps.spell_id
    WHERE ps.player_id = ?
      AND ps.spell_id = ?
      AND s.is_combat = 1
    LIMIT 1
    `,
    [playerId, spellId]
  );

  if (!row) {
    throw new Error("SPELL_NOT_LEARNED");
  }
}

/**
 * Returns all six hotbar positions.
 * Empty positions return spell: null.
 */
export async function getEquippedSpells(playerId: number) {
  const [rows]: any = await db.query(
    `
    SELECT
      pes.slot,
      pes.spell_id,

      s.name,
      s.description,
      s.icon,
      s.level,
      s.mana_cost,
      s.cooldown,
      s.type,

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

    FROM player_equipped_spells pes
    JOIN player_spells ps
    ON ps.player_id = pes.player_id
    AND ps.spell_id = pes.spell_id
    JOIN spells s
    ON s.id = pes.spell_id
    AND s.is_combat = 1
    WHERE pes.player_id = ?
    ORDER BY pes.slot ASC
    `,
    [playerId]
  );

  const bySlot = new Map<number, any>();

  for (const row of rows || []) {
    bySlot.set(Number(row.slot), row);
  }

  return Array.from(
    { length: MAX_HOTBAR_SLOTS },
    (_, index) => {
      const slot = index + 1;
      const row = bySlot.get(slot);

      if (!row) {
        return {
          slot,
          spell: null
        };
      }

      return {
        slot,
        spell: {
          id: Number(row.spell_id),
          name: row.name,
          description: row.description,
          icon: row.icon,
          level: Number(row.level || 1),
          manaCost: Number(row.mana_cost || 0),
          cooldown: Number(row.cooldown || 0),
          type: row.type,

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
        }
      };
    }
  );
}

/**
 * Equips a spell into a slot.
 *
 * If the spell is already equipped elsewhere, it is moved.
 * If the target slot is occupied, its existing spell is replaced.
 */
export async function equipSpell(
  playerId: number,
  spellId: number,
  slot: number
) {
  validateSlot(slot);

  if (!Number.isInteger(spellId) || spellId <= 0) {
    throw new Error("INVALID_SPELL");
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    await verifyLearnedSpell(conn, playerId, spellId);

    // Lock the player's current loadout during the change.
    await conn.query(
      `
      SELECT slot, spell_id
      FROM player_equipped_spells
      WHERE player_id = ?
      FOR UPDATE
      `,
      [playerId]
    );

    // Remove this spell from another slot, if already equipped.
    await conn.query(
      `
      DELETE FROM player_equipped_spells
      WHERE player_id = ?
        AND spell_id = ?
      `,
      [playerId, spellId]
    );

    // Remove whatever currently occupies the destination.
    await conn.query(
      `
      DELETE FROM player_equipped_spells
      WHERE player_id = ?
        AND slot = ?
      `,
      [playerId, slot]
    );

    await conn.query(
      `
      INSERT INTO player_equipped_spells (
        player_id,
        slot,
        spell_id
      )
      VALUES (?, ?, ?)
      `,
      [playerId, slot, spellId]
    );

    await conn.commit();

    return {
      success: true,
      slot,
      spellId
    };
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}

    throw err;
  } finally {
    try {
      conn.release();
    } catch {}
  }
}

/**
 * Removes whichever spell is currently assigned to a slot.
 */
export async function unequipSpell(
  playerId: number,
  slot: number
) {
  validateSlot(slot);

  const [result]: any = await db.query(
    `
    DELETE FROM player_equipped_spells
    WHERE player_id = ?
      AND slot = ?
    `,
    [playerId, slot]
  );

  return {
    success: true,
    slot,
    removed: Number(result?.affectedRows || 0) > 0
  };
}

/**
 * Swaps two hotbar slots.
 *
 * Supports:
 * - occupied ↔ occupied
 * - occupied ↔ empty
 * - empty ↔ empty
 */
export async function swapEquippedSpells(
  playerId: number,
  fromSlot: number,
  toSlot: number
) {
  validateSlot(fromSlot);
  validateSlot(toSlot);

  if (fromSlot === toSlot) {
    return {
      success: true,
      fromSlot,
      toSlot,
      changed: false
    };
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows]: any = await conn.query(
      `
      SELECT
        pes.slot,
        pes.spell_id
        FROM player_equipped_spells pes
        JOIN player_spells ps
        ON ps.player_id = pes.player_id
        AND ps.spell_id = pes.spell_id
        JOIN spells s
        ON s.id = pes.spell_id
        AND s.is_combat = 1
        WHERE pes.player_id = ?
        AND pes.slot IN (?, ?)
        FOR UPDATE
      `,
      [playerId, fromSlot, toSlot]
    );

    const fromRow = (rows || []).find(
      (row: any) => Number(row.slot) === fromSlot
    );

    const toRow = (rows || []).find(
      (row: any) => Number(row.slot) === toSlot
    );

    // Delete both slots first to avoid primary-key collisions.
    await conn.query(
      `
      DELETE FROM player_equipped_spells
      WHERE player_id = ?
        AND slot IN (?, ?)
      `,
      [playerId, fromSlot, toSlot]
    );

    // Spell from the destination moves into the original slot.
    if (toRow) {
      await conn.query(
        `
        INSERT INTO player_equipped_spells (
          player_id,
          slot,
          spell_id
        )
        VALUES (?, ?, ?)
        `,
        [playerId, fromSlot, Number(toRow.spell_id)]
      );
    }

    // Spell from the original slot moves into the destination.
    if (fromRow) {
      await conn.query(
        `
        INSERT INTO player_equipped_spells (
          player_id,
          slot,
          spell_id
        )
        VALUES (?, ?, ?)
        `,
        [playerId, toSlot, Number(fromRow.spell_id)]
      );
    }

    await conn.commit();

    return {
      success: true,
      fromSlot,
      toSlot,
      changed: Boolean(fromRow || toRow)
    };
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}

    throw err;
  } finally {
    try {
      conn.release();
    } catch {}
  }
}