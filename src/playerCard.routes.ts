// routes/playerCard.routes.ts
import { Router } from "express";
import { db } from "./db";

const router = Router();

// Player social card
// This is intentionally cosmetic-first. Title and card background currently
// use defaults so the response shape does not need to change when those
// collectible systems are added later.
router.get("/players/:playerId/card", async (req, res) => {
  try {
    const viewerId = Number((req.session as any)?.playerId);
    if (!viewerId) {
      return res.status(401).json({
        ok: false,
        error: "Not logged in"
      });
    }

    const playerId = Number(req.params.playerId);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid playerId"
      });
    }

    const [rows]: any = await db.query(
      `
        SELECT
          p.id,
          p.name,
          p.level,
          p.pclass,
          a.image_url AS portrait_url,
          g.name AS guild_name

        FROM players p

        LEFT JOIN avatars a
          ON a.id = p.equipped_avatar_id
          AND a.is_active = 1

        LEFT JOIN guild_members gm
          ON gm.player_id = p.id

        LEFT JOIN guilds g
          ON g.id = gm.guild_id

        WHERE p.id = ?

        LIMIT 1
      `,
      [playerId]
    );

    const player = rows?.[0];
    if (!player) {
      return res.status(404).json({
        ok: false,
        error: "Player not found"
      });
    }

    return res.json({
      ok: true,
      player: {
        id: Number(player.id),
        name: String(player.name || "Adventurer"),
        level: Math.max(1, Number(player.level) || 1),
        pclass: String(player.pclass || "Adventurer"),
        guildName: player.guild_name
          ? String(player.guild_name)
          : null,

        portraitUrl:
          player.portrait_url ||
          "/images/avatars/default_adventurer.webp",

        // Cosmetic fallbacks until title/background collections are added.
        title: "Adventurer",
        cardBackgroundUrl: null,

        isSelf: Number(player.id) === viewerId
      }
    });
  } catch (err) {
    console.error("Player card endpoint error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error"
    });
  }
});

export default router;
