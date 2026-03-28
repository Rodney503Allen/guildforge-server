import express from "express";
import { db } from "./db";
import { applyBuff } from "./services/buffService";
import { getFinalPlayerStats } from "./services/playerService";
import { handleCreatureKill } from "./services/killService";
import { applyCreatureDebuff } from "./services/creatureBuffService";
import { ARCHETYPE_SCALING } from "./services/archetypeScaling";
import {
  ensureCombatSession,
  createCombatSession,
  advanceCombatSession,
  buildCombatSnapshot,
  consumeActorTurn,
  getActorReadyInMs,
  isCooldownReady,
  setCooldown
} from "./services/combatSessionService";

const router = express.Router();
let reward: any = null;
async function getOrCreateSession(pid: number) {
  let session = ensureCombatSession(pid);
  if (!session) {
    session = await createCombatSession(pid);
  }
  return session;
}
// ⏱️ playerId:spellId -> timestamp

router.post("/spells/cast", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    const { spellId } = req.body;

    let reward: any = null;
    let appliedStatus = false;

    if (!pid) return res.status(401).json({ error: "Not logged in" });
    if (!spellId) return res.status(400).json({ error: "Missing spellId" });

    const session = await getOrCreateSession(pid);
    if (!session) {
      return res.status(404).json({ error: "No enemy" });
    }

    // refresh session player from authoritative computed stats
    const player = await getFinalPlayerStats(pid);
    if (!player) {
      return res.status(404).json({ error: "Player not found" });
    }

    session.player.stats = player;
    session.player.name = player.name ?? "Player";
    session.player.hp = Number(player.hpoints ?? 0);
    session.player.maxHp = Number(player.maxhp ?? 1);
    session.player.sp = Number(player.spoints ?? 0);
    session.player.maxSp = Number(player.maxspoints ?? 0);

    advanceCombatSession(session);

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

    // 1️⃣ Verify player knows the spell
    const [[known]]: any = await db.query(
      `
      SELECT 1
      FROM player_spells
      WHERE player_id = ? AND spell_id = ?
      `,
      [pid, spellId]
    );

    if (!known) {
      return res.status(403).json({ error: "Spell not learned" });
    }

    // 2️⃣ Load spell definition
    const [[spell]]: any = await db.query(
      `
      SELECT *
      FROM spells
      WHERE id = ?
      `,
      [spellId]
    );

    if (!spell) {
      return res.status(404).json({ error: "Spell not found" });
    }

    const scost = Number(spell.scost) || 0;
    const baseDamage = Number(spell.damage) || 0;
    const baseHeal = Number(spell.heal) || 0;
    const cooldownSec = Number(spell.cooldown) || 0;

    const cooldownKey = `spell:${spellId}`;

    // hybrid cooldown check — do NOT consume the turn if unavailable
    if (!isCooldownReady(session.player, cooldownKey)) {
      const now = Date.now();
      const readyAt = session.player.cooldowns[cooldownKey] || now;
      return res.json({
        error: "cooldown",
        remaining: Math.max(1, Math.ceil((readyAt - now) / 1000)),
        snapshot: buildCombatSnapshot(session)
      });
    }

    // 3️⃣ Load current enemy (if any)
    const [[enemy]]: any = await db.query(
      `
      SELECT pc.id, pc.hp, c.maxhp
      FROM player_creatures pc
      JOIN creatures c ON c.id = pc.creature_id
      WHERE pc.player_id = ?
      `,
      [pid]
    );

    let log = "";
    let enemyHP = enemy?.hp;
    let playerHP = session.player.hp;

    // For damage spells, require enemy before spending SP
    if ((spell.type === "damage" || spell.type === "dot" || spell.type === "damage_dot") && !enemy) {
      return res.json({
        error: "No enemy to target",
        snapshot: buildCombatSnapshot(session)
      });
    }

    // Check SP — do NOT consume turn if not enough
    if (Number(session.player.sp) < scost) {
      return res.json({
        error: "Not enough SP",
        snapshot: buildCombatSnapshot(session)
      });
    }

    // Spend SP
    const newSP = Number(session.player.sp) - scost;
    session.player.sp = newSP;

    await db.query(
      "UPDATE players SET spoints = ? WHERE id = ?",
      [newSP, pid]
    );

    // =========================
    // DOT SPELL
    // =========================
    if (spell.type === "dot" || spell.type === "damage_dot") {
      const dotDamage = Number(spell.dot_damage) || 0;
      const dotDuration = Number(spell.dot_duration) || 0;
      const tickRate = Number(spell.dot_tick_rate) || 1;

      if (dotDamage <= 0 || dotDuration <= 0) {
        return res.status(500).json({ error: "Invalid DOT spell config" });
      }

      await db.query(
        `
        INSERT INTO player_creature_dots
          (player_creature_id, damage, tick_interval, next_tick_at, expires_at, source)
        VALUES
          (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND), ?)
        `,
        [
          enemy.id,
          dotDamage,
          tickRate,
          dotDuration,
          `spell:${spell.id}`
        ]
      );

      log = `☠ ${spell.name} afflicts the enemy!`;

      // optional direct hit part for damage_dot
      if (spell.type === "damage_dot" && baseDamage > 0) {
        const scalingStat = ARCHETYPE_SCALING[player.archetype];

        let statValue = 0;
        switch (scalingStat) {
          case "attack":
            statValue = player.attack;
            break;
          case "agility":
            statValue = player.agility;
            break;
          case "intellect":
            statValue = player.intellect;
            break;
        }

        const spellPower = Number(player.spellPower || 1);
        const directDmg = Math.max(
          0,
          Math.floor(baseDamage + statValue * 0.5 * spellPower)
        );

        enemyHP = Math.max(0, Number(enemy.hp) - directDmg);

        await db.query(
          "UPDATE player_creatures SET hp = ? WHERE id = ?",
          [enemyHP, enemy.id]
        );

        log = `✨ You cast ${spell.name} for ${directDmg} damage and afflict the enemy!`;
      }
    }

    // =========================
    // DAMAGE SPELL
    // =========================
    if (spell.type === "damage") {
      const scalingStat = ARCHETYPE_SCALING[player.archetype];

      let statValue = 0;
      switch (scalingStat) {
        case "attack":
          statValue = player.attack;
          break;
        case "agility":
          statValue = player.agility;
          break;
        case "intellect":
          statValue = player.intellect;
          break;
      }

      const spellPower = Number(player.spellPower || 1);

      const dmg = Math.max(
        0,
        Math.floor(baseDamage + statValue * 0.5 * spellPower)
      );

      enemyHP = Math.max(0, Number(enemy.hp) - dmg);

      await db.query(
        "UPDATE player_creatures SET hp = ? WHERE id = ?",
        [enemyHP, enemy.id]
      );

      log = `✨ You cast ${spell.name} for ${dmg} damage!`;

      const dStat = String(spell.debuff_stat || "").trim();
      const dVal = Number(spell.debuff_value) || 0;
      const dDur = Number(spell.debuff_duration) || 0;

      if (dStat && dDur > 0 && dVal !== 0) {
        await applyCreatureDebuff(
          enemy.id,
          dStat,
          dVal,
          dDur,
          `spell:${spell.id}`
        );

        appliedStatus = true;
        log += ` 🕸 Debuff applied: ${dStat.toUpperCase()} ${dVal > 0 ? "+" : ""}${dVal} (${dDur}s)`;
      }

      if (enemyHP <= 0) {
        reward = await handleCreatureKill(pid, enemy.id);
      }
    }

    // =========================
    // HEAL SPELL
    // =========================
    if (spell.type === "heal") {
      playerHP = Math.min(session.player.maxHp, session.player.hp + baseHeal);
      session.player.hp = playerHP;

      await db.query(
        "UPDATE players SET hpoints = ? WHERE id = ?",
        [playerHP, pid]
      );

      log = `✨ You cast ${spell.name} and heal ${baseHeal} HP!`;
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

      if (enemy && spell.debuff_stat && spell.debuff_value && spell.debuff_duration) {
        await applyCreatureDebuff(
          enemy.id,
          spell.debuff_stat,
          Number(spell.debuff_value),
          Number(spell.debuff_duration),
          `spell:${spell.id}`
        );

        log += ` 🔻 ${spell.debuff_stat.toUpperCase()} reduced!`;
      }
    }

    // successful spell cast: set cooldown + consume ATB turn
    if (cooldownSec > 0) {
      setCooldown(session.player, cooldownKey, cooldownSec);
    }

    consumeActorTurn(session.player, 450);

    if (enemyHP !== undefined) {
      session.enemy.hp = Number(enemyHP);
    }

    if (reward) {
      session.state = "victory";
      session.rewards = {
        exp: reward?.expGained,
        gold: reward?.goldGained,
        levelUp: reward?.levelUp,
        chest: reward?.chest ?? null,
        quest: reward?.quest ?? null
      };
    }

    session.log.push(log);
    if (reward) {
      session.log.push("🏆 Enemy defeated!");
      if (reward?.expGained) session.log.push(`✨ You gained ${reward.expGained} EXP!`);
      if (reward?.goldGained) session.log.push(`💰 You gained ${reward.goldGained} gold!`);
      if (reward?.levelUp) session.log.push("⬆ LEVEL UP!");
    }

    res.json({
      log,
      enemyHP,
      enemyMaxHP: enemy?.maxhp,
      playerHP,
      playerSP: newSP,
      appliedStatus,
      dead: enemyHP !== undefined && enemyHP <= 0,
      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp,
      chest: reward?.chest ?? null,
      quest: reward?.quest ?? null,
      cooldown: cooldownSec,
      snapshot: buildCombatSnapshot(session)
    });
  } catch (err) {
    console.error("POST /spells/cast failed", err);
    res.status(500).json({ error: "Server error" });
  }
});


export default router;
