import express from "express";
import { db } from "./db";
import { applyBuff } from "./services/buffService";
import { getFinalPlayerStats } from "./services/playerService";
import { handleCreatureKill } from "./services/killService";

const router = express.Router();

// ⏱️ playerId:spellId -> timestamp
const spellCooldowns = new Map<string, number>();

router.post("/spells/cast", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    const { spellId } = req.body;

    if (!pid) return res.status(401).json({ error: "Not logged in" });
    if (!spellId) return res.status(400).json({ error: "Missing spellId" });

    const cdKey = `${pid}:${spellId}`;
    const now = Date.now();
    const nextAllowed = spellCooldowns.get(cdKey) || 0;

    // ⛔ COOLDOWN CHECK
    if (now < nextAllowed) {
      return res.json({
        error: "cooldown",
        remaining: Math.ceil((nextAllowed - now) / 1000)
      });
    }

    // 1️⃣ Verify player knows the spell
    const [[known]]: any = await db.query(`
      SELECT 1
      FROM player_spells
      WHERE player_id = ? AND spell_id = ?
    `, [pid, spellId]);

    if (!known) {
      return res.status(403).json({ error: "Spell not learned" });
    }

    // 2️⃣ Load spell definition
      const [[spell]]: any = await db.query(`
        SELECT *
        FROM spells
        WHERE id = ?
      `, [spellId]);

      if (!spell) {
        return res.status(404).json({ error: "Spell not found" });
      }

      const scost = Number(spell.scost) || 0;
      const svalue = Number(spell.svalue) || 0;
      const cooldownSec = Number(spell.cooldown) || 0;


    // 3️⃣ Load player (FINAL stats)
    const player = await getFinalPlayerStats(pid);
    if (!player) {
      return res.status(404).json({ error: "Player not found" });
    }

    // 5️⃣ Load current enemy (if any)
    const [[enemy]]: any = await db.query(`
      SELECT pc.id, pc.hp
      FROM player_creatures pc
      WHERE pc.player_id = ?
    `, [pid]);

    let log = "";
    let enemyHP = enemy?.hp;
    let playerHP = player.hpoints;

    // For damage spells, require enemy before spending SP
    if (spell.type === "damage" && !enemy) {
      return res.json({ error: "No enemy to target" });
    }
    // Check SP
    if (Number(player.spoints) < scost) {
      return res.json({ error: "Not enough SP" });
    }

    // Spend SP ONCE (valid cast)
    const newSP = Number(player.spoints) - scost;
    await db.query(
      "UPDATE players SET spoints = ? WHERE id = ?",
      [newSP, pid]
    );
    // =========================
    // DAMAGE SPELL
    // =========================
    if (spell.type === "damage") {
      if (!enemy) {
        return res.json({ error: "No enemy to target" });
      }
console.log("SPELL DEBUG:", {
  spellId,
  spellName: spell.name,
  rawSvalue: spell.svalue,
  parsedSvalue: Number(spell.svalue),
  spellType: spell.type
});

      const intellect = Number(player.intellect || 0);
      const spellPower = Number(player.spellPower || 1);

      const dmg = Math.max(
        0,
        Math.floor(svalue + intellect * 0.5 * spellPower)
      );
      enemyHP = Math.max(0, Number(enemy.hp) - dmg);


      await db.query(
        "UPDATE player_creatures SET hp = ? WHERE id = ?",
        [enemyHP, enemy.id]
      );

      log = `✨ You cast ${spell.name} for ${dmg} damage!`;

    

    if (enemyHP <= 0) {
      const reward = await handleCreatureKill(pid, enemy.id);
    }

    }

    // =========================
    // HEAL SPELL
    // =========================
    if (spell.type === "heal") {
      playerHP = Math.min(player.maxhp, player.hpoints + svalue);

      await db.query(
        "UPDATE players SET hpoints = ? WHERE id = ?",
        [playerHP, pid]
      );

      log = `✨ You cast ${spell.name} and heal ${svalue} HP!`;
    }

    // =========================
    // BUFF SPELL
    // =========================
    if (spell.type === "buff") {
      if (!spell.buff_stat || !spell.buff_duration) {
        return res.status(500).json({ error: "Invalid buff spell config" });
      }

      await applyBuff(
        pid,
        spell.buff_stat,
        spell.buff_value,
        spell.buff_duration,
        `spell:${spell.id}`
      );

      log = `✨ You cast ${spell.name} and gain a buff!`;
    }

    // ⏱️ SET COOLDOWN (seconds → ms)
    if (cooldownSec > 0) {
      spellCooldowns.set(cdKey, now + cooldownSec * 1000);
    }
    res.json({
      log,
      enemyHP,
      playerHP,
      playerSP: newSP,
      dead: enemyHP !== undefined && enemyHP <= 0,
      cooldown: cooldownSec
    });

  } catch (err) {
    console.error("SPELL CAST ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
