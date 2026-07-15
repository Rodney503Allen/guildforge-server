//spell.routes.ts
import express from "express";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";
import { handleCreatureKill } from "./services/killService";
import { getSpellHandler } from "./services/spellHandlers";

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
import { getEquippedSpells } from "./services/spellLoadoutService";

const router = express.Router();
async function getOrCreateSession(pid: number) {
  let session = ensureCombatSession(pid);
  if (!session) {
    session = await createCombatSession(pid);
  }
  return session;
}
// ⏱️ playerId:spellId -> timestamp

// =======================
// GET COMBAT HOTBAR SPELLS
// =======================
router.get("/combat/spells", async (req, res) => {
  try {
    const pid = Number((req.session as any)?.playerId || 0);

    if (!pid) {
      return res.status(401).json({
        error: "Not logged in"
      });
    }

    const slots = await getEquippedSpells(pid);

    return res.json({
      success: true,
      maxSlots: 6,
      slots
    });
  } catch (err) {
    console.error("GET /combat/spells failed", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
});

router.post("/spells/cast", async (req, res) => {
  try {
    const pid = Number(
      (req.session as any)?.playerId || 0
    );

    const spellId = Number(req.body?.spellId);

    let reward: any = null;

    if (!pid) {
      return res.status(401).json({
        error: "Not logged in"
      });
    }

    if (
      !Number.isInteger(spellId) ||
      spellId <= 0
    ) {
      return res.status(400).json({
        error: "Invalid spellId"
      });
    }

    const session = await getOrCreateSession(pid);

    if (!session) {
      return res.status(404).json({
        error: "No enemy"
      });
    }

    // Refresh the session using authoritative player stats.
    const player = await getFinalPlayerStats(pid);

    if (!player) {
      return res.status(404).json({
        error: "Player not found"
      });
    }

    session.player.stats = player;
    session.player.name = player.name ?? "Player";
    session.player.hp = Number(player.hpoints ?? 0);
    session.player.maxHp = Number(player.maxhp ?? 1);
    session.player.sp = Number(player.spoints ?? 0);
    session.player.maxSp = Number(
      player.maxspoints ?? 0
    );

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
        remainingMs: getActorReadyInMs(
          session.player
        ),
        snapshot: buildCombatSnapshot(session)
      });
    }

    // Verify that the spell is learned, equipped,
    // and usable in combat.
    const [[spell]]: any = await db.query(
      `
      SELECT
        s.*,
        pes.slot
      FROM player_equipped_spells pes

      JOIN player_spells ps
        ON ps.player_id = pes.player_id
       AND ps.spell_id = pes.spell_id

      JOIN spells s
        ON s.id = pes.spell_id

      WHERE pes.player_id = ?
        AND pes.spell_id = ?
        AND s.is_combat = 1

      LIMIT 1
      `,
      [pid, spellId]
    );

    if (!spell) {
      return res.status(403).json({
        error: "Spell not equipped"
      });
    }

    const manaCost =
      Number(spell.mana_cost) || 0;

    const cooldownSec =
      Number(spell.cooldown) || 0;

    const cooldownKey = `spell:${spellId}`;

    // Cooldown failure does not consume SP or the turn.
    if (
      !isCooldownReady(
        session.player,
        cooldownKey
      )
    ) {
      const now = Date.now();

      const readyAt =
        session.player.cooldowns[cooldownKey] ||
        now;

      return res.json({
        error: "cooldown",
        remaining: Math.max(
          1,
          Math.ceil((readyAt - now) / 1000)
        ),
        snapshot: buildCombatSnapshot(session)
      });
    }

    // Load the current enemy.
    const [[enemy]]: any = await db.query(
      `
      SELECT
        pc.id,
        pc.hp,
        c.maxhp,
        c.defense

      FROM player_creatures pc

      JOIN creatures c
        ON c.id = pc.creature_id

      WHERE pc.player_id = ?

      LIMIT 1
      `,
      [pid]
    );

    // Find the generic spell handler.
    const handler = getSpellHandler(spell);

    if (!handler) {
      console.error(
        `No spell handler for type "${spell.type}"`,
        {
          spellId: spell.id,
          spellName: spell.name
        }
      );

      return res.status(500).json({
        error:
          `No handler exists for spell type: ${spell.type}`
      });
    }

    // Target validation happens before SP is spent.
    if (handler.requiresEnemy && !enemy) {
      return res.json({
        error: "No enemy to target",
        snapshot: buildCombatSnapshot(session)
      });
    }

    // Configuration validation happens before SP is spent.
    const configurationError =
      handler.validate(spell);

    if (configurationError) {
      console.error(
        "Invalid spell configuration",
        {
          spellId: spell.id,
          spellName: spell.name,
          spellType: spell.type,
          configurationError
        }
      );

      return res.status(500).json({
        error: configurationError
      });
    }

    // SP failure does not consume the turn.
    if (
      Number(session.player.sp) < manaCost
    ) {
      return res.json({
        error: "Not enough SP",
        snapshot: buildCombatSnapshot(session)
      });
    }

    // Spend SP only after all normal validation passes.
    const newSP =
      Number(session.player.sp) - manaCost;

    session.player.sp = newSP;

    await db.query(
      `
      UPDATE players
      SET spoints = ?
      WHERE id = ?
      `,
      [newSP, pid]
    );

    // Execute the actual spell effect.
    const result = await handler.execute({
      playerId: pid,
      spell,
      player,
      enemy: enemy ?? null,
      currentPlayerHP: Number(session.player.hp),
      maxPlayerHP: Number(session.player.maxHp)
    });

if (result.appliedStatus) {
  const refreshedPlayer =
    await getFinalPlayerStats(pid);

  if (refreshedPlayer) {
    session.player.stats =
      refreshedPlayer;

    session.player.maxHp =
      Number(refreshedPlayer.maxhp ?? 1);

    session.player.maxSp =
      Number(refreshedPlayer.maxspoints ?? 0);

    session.player.hp = Math.min(
      Number(refreshedPlayer.hpoints ?? session.player.hp),
      session.player.maxHp
    );

    session.player.sp = Math.min(
      Number(refreshedPlayer.spoints ?? session.player.sp),
      session.player.maxSp
    );
  }
}

    let enemyHP =
      result.enemyHP !== undefined
        ? Number(result.enemyHP)
        : enemy
          ? Number(enemy.hp)
          : undefined;

    let playerHP =
      result.playerHP !== undefined
        ? Number(result.playerHP)
        : Number(session.player.hp);

    const appliedStatus =
      result.appliedStatus ?? false;

    if (result.playerHP !== undefined) {
      session.player.hp = playerHP;
    }

    if (
      result.enemyHP !== undefined &&
      session.enemy
    ) {
      session.enemy.hp = enemyHP!;
    }

    // Process direct-hit kills.
    if (
      result.killedEnemy &&
      enemy
    ) {
      reward = await handleCreatureKill(
        pid,
        enemy.id
      );
    }

    // A successful cast receives its cooldown.
    if (cooldownSec > 0) {
      setCooldown(
        session.player,
        cooldownKey,
        cooldownSec
      );
    }

    // A successful cast consumes the player's ATB turn.
    consumeActorTurn(
      session.player,
      450
    );

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

    session.log.push(result.log);

    if (reward) {
      session.log.push(
        "🏆 Enemy defeated!"
      );

      if (reward?.expGained) {
        session.log.push(
          `✨ You gained ${reward.expGained} EXP!`
        );
      }

      if (reward?.goldGained) {
        session.log.push(
          `💰 You gained ${reward.goldGained} gold!`
        );
      }

      if (reward?.levelUp) {
        session.log.push(
          "⬆ LEVEL UP!"
        );
      }
    }

    return res.json({
      log: result.log,

      enemyHP,
      enemyMaxHP: enemy?.maxhp,

      playerHP,
      playerSP: newSP,

      appliedStatus,

      dead:
        enemyHP !== undefined &&
        enemyHP <= 0,

      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp,

      chest: reward?.chest ?? null,
      quest: reward?.quest ?? null,

      cooldown: cooldownSec,

      snapshot: buildCombatSnapshot(session)
    });
  } catch (err) {
    console.error(
      "POST /spells/cast failed",
      err
    );

    return res.status(500).json({
      error: "Server error"
    });
  }
});


export default router;
