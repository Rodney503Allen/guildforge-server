import { Router } from "express";
import { db } from "./db";
import { handleCreatureKill } from "./services/killService";

const router = Router();

router.get("/combat/poll", async (req, res) => {
  try {
    const pid = (req.session as any).playerId;
    if (!pid) return res.json({ stop: true });

    // Load active enemy
    const [[enemy]]: any = await db.query(
      `
      SELECT pc.id, pc.hp, c.maxhp, c.name
      FROM player_creatures pc
      JOIN creatures c ON c.id = pc.creature_id
      WHERE pc.player_id = ?
      `,
      [pid]
    );

    if (!enemy) {
      return res.json({ stop: true });
    }

    let enemyHP = Number(enemy.hp);
    const combatLog: string[] = [];

    // =========================
    // DOT TICKING (🔥 CORE FIX)
    // =========================
    const [dots]: any = await db.query(
      `
      SELECT *
      FROM player_creature_dots
      WHERE player_creature_id = ?
        AND next_tick_at <= NOW()
        AND expires_at > NOW()
      `,
      [enemy.id]
    );

    for (const dot of dots) {
      enemyHP = Math.max(0, enemyHP - Number(dot.damage));

      await db.query(
        "UPDATE player_creatures SET hp = ? WHERE id = ?",
        [enemyHP, enemy.id]
      );

      await db.query(
        `
        UPDATE player_creature_dots
        SET next_tick_at = DATE_ADD(NOW(), INTERVAL tick_interval SECOND)
        WHERE id = ?
        `,
        [dot.id]
      );

      combatLog.push(`🔥 ${enemy.name} takes ${dot.damage} damage!`);
    }

    // Cleanup expired DOTs
    await db.query(
      "DELETE FROM player_creature_dots WHERE expires_at <= NOW()"
    );

    // =========================
    // DEATH CHECK
    // =========================
    let reward = null;
    if (enemyHP <= 0) {
      reward = await handleCreatureKill(pid, enemy.id);
    }

    res.json({
      enemyHP,
      enemyMaxHP: enemy.maxhp,
      enemyDead: enemyHP <= 0,
      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp,
      log: combatLog
    });

  } catch (err) {
    console.error("COMBAT POLL ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
