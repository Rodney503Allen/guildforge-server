// src/dungeonCombat.routes.ts
//
// Dungeon combat endpoints.
// Supports simultaneous dungeon enemies and per-player target selection.

import express from "express";

import { db } from "./db";

import {
  getDungeonCombatEnemyForPlayer,
} from "./services/dungeonCombatService";

import {
  advanceDungeonCombatSession,
  buildDungeonCombatSnapshot,
  castDungeonSpell,
  createDungeonCombatSession,
  getDungeonCombatSession,
  selectDungeonEnemyTarget,
  useDungeonCombatPotion,
} from "./services/dungeonCombatSessionService";

import {
  getEquippedCombatPotions,
} from "./services/combatPotionService";

import {
  publishDungeonInstanceChanged,
  publishDungeonInstanceState,
} from "./dungeonSocket";

const DUNGEON_SOCKET_TICK_MS = 500;
const dungeonSocketTickers = new Map<number, NodeJS.Timeout>();
const dungeonSocketTicksInFlight = new Set<number>();

async function buildEnrichedDungeonSnapshot(session: any) {
  return enrichDungeonSnapshotWithBuffs(
    buildDungeonCombatSnapshot(session)
  );
}

async function publishCombatSnapshot(instanceId: number, session: any) {
  const snapshot = await buildEnrichedDungeonSnapshot(session);

  publishDungeonInstanceState(instanceId, {
    combat: snapshot,
    serverTime: Date.now(),
  });

  return snapshot;
}

function stopDungeonSocketTicker(instanceId: number) {
  const timer = dungeonSocketTickers.get(instanceId);
  if (!timer) return;
  clearInterval(timer);
  dungeonSocketTickers.delete(instanceId);
}

function ensureDungeonSocketTicker(instanceId: number) {
  if (dungeonSocketTickers.has(instanceId)) return;

  const timer = setInterval(async () => {
    if (dungeonSocketTicksInFlight.has(instanceId)) return;
    dungeonSocketTicksInFlight.add(instanceId);

    const session = getDungeonCombatSession(instanceId);

    if (!session) {
      dungeonSocketTicksInFlight.delete(instanceId);
      stopDungeonSocketTicker(instanceId);
      publishDungeonInstanceChanged(instanceId, {
        reason: "combat-session-ended",
        instanceId,
      });
      return;
    }

    try {
      await advanceDungeonCombatSession(session);
      await publishCombatSnapshot(instanceId, session);

      if (session.state !== "active") {
        stopDungeonSocketTicker(instanceId);
        publishDungeonInstanceChanged(instanceId, {
          reason: "combat-ended",
          instanceId,
          state: session.state,
        });
      }
    } catch (error) {
      console.error("Dungeon socket combat tick failed:", error);
    } finally {
      dungeonSocketTicksInFlight.delete(instanceId);
    }
  }, DUNGEON_SOCKET_TICK_MS);

  dungeonSocketTickers.set(instanceId, timer);
}

const router =
  express.Router();

function requireLogin(
  req: any,
  res: any,
  next: any,
) {
  if (
    !req.session ||
    !req.session.playerId
  ) {
    return res.status(401).json({
      ok: false,
      error:
        "Not logged in.",
    });
  }

  next();
}

router.use(
  requireLogin
);


async function enrichDungeonSnapshotWithBuffs(
  snapshot: any,
) {
  if (
    !snapshot ||
    !Array.isArray(
      snapshot.players
    ) ||
    snapshot.players.length ===
      0
  ) {
    return snapshot;
  }

  const playerIds =
    snapshot.players
      .map(
        (player: any) =>
          Number(
            player.playerId
          )
      )
      .filter(
        (
          playerId: number
        ) =>
          Number.isInteger(
            playerId
          ) &&
          playerId > 0
      );

  if (
    playerIds.length ===
    0
  ) {
    return snapshot;
  }

  const placeholders =
    playerIds
      .map(
        () => "?"
      )
      .join(", ");

  const [rows]: any =
    await db.query(
      `
        SELECT
          player_id,
          stat,
          value,
          source,
          expires_at,
          GREATEST(
            0,
            TIMESTAMPDIFF(
              MICROSECOND,
              NOW(3),
              expires_at
            ) DIV 1000
          ) AS remaining_ms

        FROM player_buffs

        WHERE player_id IN (
          ${placeholders}
        )
          AND expires_at >
              NOW(3)

        ORDER BY
          player_id ASC,
          expires_at ASC
      `,
      playerIds,
    );

  const buffsByPlayer =
    new Map<
      number,
      any[]
    >();

  for (
    const row of
    rows ?? []
  ) {
    const playerId =
      Number(
        row.player_id
      );

    if (
      !buffsByPlayer.has(
        playerId
      )
    ) {
      buffsByPlayer.set(
        playerId,
        []
      );
    }

    buffsByPlayer
      .get(
        playerId
      )!
      .push({
        stat:
          row.stat,

        value:
          Number(
            row.value ??
            0
          ),

        source:
          row.source ??
          null,

        expiresAt:
          row.expires_at,

        remainingMs:
          Math.max(
            0,
            Number(
              row.remaining_ms ??
              0
            )
          ),
      });
  }

  snapshot.players =
    snapshot.players.map(
      (player: any) => ({
        ...player,

        buffs:
          buffsByPlayer.get(
            Number(
              player.playerId
            )
          ) ??
          [],
      })
    );

  return snapshot;
}

router.get(
  "/current",
  async (
    req: any,
    res
  ) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      const state =
        await getDungeonCombatEnemyForPlayer(
          playerId
        );

      if (!state) {
        return res.json({
          ok: true,
          active: false,
        });
      }

      return res.json({
        ok: true,
        active:
          Boolean(
            state.enemies?.length
          ),
        ...state,
      });
    } catch (error: any) {
      console.error(
        "Dungeon combat current error:",
        error
      );

      return res.status(400).json({
        ok: false,
        error:
          error?.message ??
          "Could not load dungeon combat.",
      });
    }
  }
);

router.post(
  "/session",
  async (
    req: any,
    res
  ) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      const state =
        await getDungeonCombatEnemyForPlayer(
          playerId
        );

      if (
        !state ||
        !state.enemies?.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "There are no active dungeon enemies.",
        });
      }

      const session =
        await createDungeonCombatSession(
          state.encounter.instanceId
        );

      if (!session) {
        return res.status(400).json({
          ok: false,
          error:
            "Could not create dungeon combat session.",
        });
      }

      await advanceDungeonCombatSession(
        session
      );

      const instanceId = Number(state.encounter.instanceId);
      const snapshot = await publishCombatSnapshot(instanceId, session);
      ensureDungeonSocketTicker(instanceId);

      return res.json({
        ok: true,
        session: snapshot,
      });
    } catch (error: any) {
      console.error(
        "Dungeon combat session error:",
        error
      );

      return res.status(400).json({
        ok: false,
        error:
          error?.message ??
          "Could not create dungeon combat session.",
      });
    }
  }
);

router.get(
  "/state",
  async (
    req: any,
    res
  ) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      const state =
        await getDungeonCombatEnemyForPlayer(
          playerId
        );

      if (
        !state ||
        !state.enemies?.length
      ) {
        return res.json({
          ok: true,
          active: false,
        });
      }

      const instanceId =
        Number(
          state.encounter.instanceId
        );

      const session =
        getDungeonCombatSession(
          instanceId
        ) ??
        await createDungeonCombatSession(
          instanceId
        );

      if (!session) {
        return res.json({
          ok: true,
          active: false,
        });
      }

      await advanceDungeonCombatSession(
        session
      );

      const snapshot = await publishCombatSnapshot(instanceId, session);

      if (session.state === "active") {
        ensureDungeonSocketTicker(instanceId);
      }

      return res.json({
        ok: true,
        active: session.state === "active",
        combat: snapshot,
      });
    } catch (error: any) {
      console.error(
        "Dungeon combat state error:",
        error
      );

      return res.status(400).json({
        ok: false,
        error:
          error?.message ??
          "Could not advance dungeon combat.",
      });
    }
  }
);

router.post(
  "/target",
  async (
    req: any,
    res
  ) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      const targetEnemyId =
        Number(
          req.body?.targetEnemyId
        );

      if (
        !Number.isFinite(
          targetEnemyId
        ) ||
        targetEnemyId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "A valid targetEnemyId is required.",
        });
      }

      const state =
        await getDungeonCombatEnemyForPlayer(
          playerId
        );

      if (
        !state ||
        !state.enemies?.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "There are no active dungeon enemies.",
        });
      }

      const instanceId =
        Number(
          state.encounter.instanceId
        );

      const session =
        getDungeonCombatSession(
          instanceId
        ) ??
        await createDungeonCombatSession(
          instanceId
        );

      if (!session) {
        return res.status(400).json({
          ok: false,
          error:
            "Could not load dungeon combat session.",
        });
      }

      const snapshot =
        await enrichDungeonSnapshotWithBuffs(
          await selectDungeonEnemyTarget(
            session,
            playerId,
            targetEnemyId,
          )
        );

      publishDungeonInstanceState(instanceId, {
        combat: snapshot,
        serverTime: Date.now(),
      });
      ensureDungeonSocketTicker(instanceId);

      return res.json({
        ok: true,
        snapshot,
      });
    } catch (error: any) {
      console.error(
        "Dungeon combat target error:",
        error
      );

      return res.status(400).json({
        ok: false,
        error:
          error?.message ??
          "Could not select dungeon target.",
      });
    }
  }
);

router.post(
  "/spell",
  async (
    req: any,
    res
  ) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      const spellId =
        Number(
          req.body?.spellId
        );

      const rawTargetPlayerId =
        req.body?.targetPlayerId;

      const targetPlayerId =
        rawTargetPlayerId == null ||
        rawTargetPlayerId === ""
          ? null
          : Number(
              rawTargetPlayerId
            );

      const rawTargetEnemyId =
        req.body?.targetEnemyId;

      const targetEnemyId =
        rawTargetEnemyId == null ||
        rawTargetEnemyId === ""
          ? null
          : Number(
              rawTargetEnemyId
            );

      if (
        !Number.isFinite(
          spellId
        ) ||
        spellId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "A valid spellId is required.",
        });
      }

      if (
        targetPlayerId !== null &&
        (
          !Number.isFinite(
            targetPlayerId
          ) ||
          targetPlayerId <= 0
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "targetPlayerId must be a valid player ID.",
        });
      }

      if (
        targetEnemyId !== null &&
        (
          !Number.isFinite(
            targetEnemyId
          ) ||
          targetEnemyId <= 0
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "targetEnemyId must be a valid enemy ID.",
        });
      }

      const state =
        await getDungeonCombatEnemyForPlayer(
          playerId
        );

      if (
        !state ||
        !state.enemies?.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "There are no active dungeon enemies.",
        });
      }

      const instanceId =
        Number(
          state.encounter.instanceId
        );

      const session =
        getDungeonCombatSession(
          instanceId
        ) ??
        await createDungeonCombatSession(
          instanceId
        );

      if (!session) {
        return res.status(400).json({
          ok: false,
          error:
            "Could not load dungeon combat session.",
        });
      }

      const result =
        await castDungeonSpell(
          session,
          playerId,
          spellId,
          targetPlayerId,
          targetEnemyId,
        );

      if (!result.ok) {
        return res.status(400).json(
          result
        );
      }

      if (result.snapshot) {
        result.snapshot =
          await enrichDungeonSnapshotWithBuffs(result.snapshot);

        publishDungeonInstanceState(instanceId, {
          combat: result.snapshot,
          serverTime: Date.now(),
        });
      }

      if (session.state === "active") {
        ensureDungeonSocketTicker(instanceId);
      } else {
        publishDungeonInstanceChanged(instanceId, {
          reason: "combat-ended",
          instanceId,
          state: session.state,
        });
      }

      return res.json(result);
    } catch (error: any) {
      console.error(
        "Dungeon combat spell error:",
        error
      );

      return res.status(400).json({
        ok: false,
        error:
          error?.message ??
          "Could not cast dungeon spell.",
      });
    }
  }
);

router.get(
  "/potions",
  async (
    req: any,
    res
  ) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      /*
       * Potion equipment belongs to the player, not to the current
       * dungeon enemy/session. Allow this read during rest and room
       * transitions so the client can keep its Q/E hotbar state in sync.
       */
      const potions =
        await getEquippedCombatPotions(
          playerId
        );

      return res.json({
        ok: true,
        ...potions,
      });
    } catch (error: any) {
      console.error(
        "Dungeon combat potions error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Could not load dungeon potions.",
      });
    }
  }
);

router.post(
  "/potions/use",
  async (
    req: any,
    res
  ) => {
    try {
      const playerId =
        Number(
          req.session.playerId
        );

      const slot =
        String(
          req.body?.slot ??
          ""
        );

      if (
        slot !== "health" &&
        slot !== "mana"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid potion slot.",
        });
      }

      const state =
        await getDungeonCombatEnemyForPlayer(
          playerId
        );

      if (
        !state ||
        !state.enemies?.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "There is no active dungeon combat.",
        });
      }

      const instanceId =
        Number(
          state.encounter.instanceId
        );

      const session =
        getDungeonCombatSession(
          instanceId
        ) ??
        await createDungeonCombatSession(
          instanceId
        );

      if (!session) {
        return res.status(400).json({
          ok: false,
          error:
            "Could not load dungeon combat session.",
        });
      }

      const result =
        await useDungeonCombatPotion(
          session,
          playerId,
          slot
        );

      if (!result.ok) {
        return res
          .status(
            Number(
              result.status
            ) || 400
          )
          .json(
            result
          );
      }

if (
  result.ok &&
  "snapshot" in result &&
  result.snapshot
) {
  result.snapshot =
    await enrichDungeonSnapshotWithBuffs(
      result.snapshot
    );

  publishDungeonInstanceState(
    instanceId,
    result.snapshot
  );
}

      ensureDungeonSocketTicker(instanceId);

      return res.json(result);
    } catch (error: any) {
      console.error(
        "Dungeon potion use error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ??
          "Could not use dungeon potion.",
      });
    }
  }
);

export default router;
