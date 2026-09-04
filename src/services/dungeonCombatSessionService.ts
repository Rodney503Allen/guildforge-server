// src/services/dungeonCombatSessionService.ts
//
// Dungeon multi-enemy party combat adapter.
//
// IMPORTANT:
// Shared party-combat primitives still operate on one `session.enemy`.
// Dungeons bind each runtime enemy into that shared single-enemy surface
// only while processing that enemy. This keeps Hunts unchanged while
// allowing a dungeon session to own N simultaneous enemies.

import { db } from "../db";

import {
  COMBAT_TIMING,
  KeyedCombatLock,
} from "./combat";

import {
  mitigateIncomingPlayerDamage,
} from "./playerDamageMitigationService";

import {
  advanceEnemyMechanics,
  buildEnemyMechanicSnapshot,
  createEnemyMechanicRuntime,
  interruptEnemyMechanic,
  loadEnemyMechanicDefinitions,
} from "./enemyMechanics";

import type {
  EnemyMechanicAdapter,
  EnemyMechanicRuntime,
} from "./enemyMechanics";

import {
  createPartyCombatEnemy,
  createPartyCombatPlayers,
} from "./partyCombatRuntime";

import type {
  PartyCombatEnemy,
  PartyCombatPlayer,
  PartyCombatDebuffEffect,
  PartyCombatDotEffect,
} from "./partyCombatRuntime";

import {
  advancePartyCombatEnemyATB,
  advancePartyCombatPlayerATBs,
  getEffectivePartyCombatEnemyStats,
  getPartyCombatEnemyReadyInMs,
  getPartyCombatPlayerReadyInMs,
  removeExpiredPartyCombatDebuffs,
} from "./partyCombatSessionCore";

import {
  applyPartyCombatEnemyDamage,
  resolvePartyCombatEnemyAttack,
  resolvePartyCombatPlayerAttack,
  selectPartyCombatThreatTarget,
} from "./partyCombatAttackCore";

import {
  addCombatThreat,
  getCombatThreat,
  getPlayerCombatThreatMultiplier,
  refreshCombatThreatTarget,
} from "./combatThreatService";

import {
  completeDungeonEnemy,
  ensureCurrentDungeonEnemies,
  updateDungeonEnemyHp,
} from "./dungeonCombatService";

import type {
  DungeonRuntimeEnemy,
} from "./dungeonCombatService";

import {
  handleDungeonPartyWipe,
} from "./dungeonWipeService";

import {
  useEquippedCombatPotion,
} from "./combatPotionService";

import type {
  CombatPotionSlot,
} from "./potionCooldownService";

import {
  createPartyCombatSpellEnemy,
} from "./partyCombatSpellEnemy";

import {
  castPartyCombatSpellUnlocked,
} from "./partyCombatSpellCasting";

import {
  processPartyCombatDots,
} from "./partyCombatDotProcessor";

import type {
  SpellEnemy,
} from "./spellHandlers/types";

export type DungeonCombatEnemyState = {
  runtimeEnemyId: number;

  enemy:
    PartyCombatEnemy;

  dots:
    PartyCombatDotEffect[];

  debuffs:
    PartyCombatDebuffEffect[];

  mechanics:
    EnemyMechanicRuntime;
};

export type DungeonCombatSession = {
  instanceId: number;

  createdAt: number;
  updatedAt: number;

  state:
    | "active"
    | "victory"
    | "defeat";

  players:
    Map<
      number,
      PartyCombatPlayer
    >;

  enemies:
    Map<
      number,
      DungeonCombatEnemyState
    >;

  selectedEnemyByPlayer:
    Map<
      number,
      number
    >;

  /*
   * Shared single-enemy compatibility surface.
   * bindDungeonEnemyState() updates these before calling
   * existing shared party-combat helpers.
   */
  runtimeEnemyId: number;
  enemy: PartyCombatEnemy;

  nextEffectId: number;
  dots: PartyCombatDotEffect[];
  debuffs: PartyCombatDebuffEffect[];

  mechanics:
    EnemyMechanicRuntime;

  nextDamageEventId: number;
  damageEvents: any[];

  log: string[];
};

const PLAYER_AUTO_ATTACK_MS =
  COMBAT_TIMING.playerAutoAttackMs;

const DUNGEON_ENEMY_RECOVERY_MS =
  350;

const DUNGEON_SPELL_RECOVERY_MS =
  350;

const dungeonCombatLocks =
  new KeyedCombatLock<number>();

const dungeonCombatSessions =
  new Map<
    number,
    DungeonCombatSession
  >();

/* =========================================================
   SESSION COLLECTION
========================================================= */

export function getDungeonCombatSession(
  instanceId: number,
) {
  return (
    dungeonCombatSessions.get(
      Number(instanceId)
    ) ??
    null
  );
}

export function destroyDungeonCombatSession(
  instanceId: number,
) {
  dungeonCombatSessions.delete(
    Number(instanceId)
  );
}

async function loadDungeonParticipants(
  instanceId: number,
) {
  const [rows]: any =
    await db.query(
      `
        SELECT
          player_id,
          cooldowns_json

        FROM dungeon_instance_members

        WHERE instance_id = ?
          AND is_active = 1

        ORDER BY
          was_leader DESC,
          id ASC
      `,
      [instanceId],
    );

  return (
    rows ?? []
  ).map(
    (row: any) => {
      let cooldowns:
        Record<
          string,
          number
        > =
        {};

      try {
        const raw =
          row.cooldowns_json;

        if (
          raw &&
          typeof raw ===
            "object"
        ) {
          cooldowns = {
            ...raw,
          };
        } else if (
          typeof raw ===
            "string" &&
          raw.trim()
        ) {
          cooldowns =
            JSON.parse(
              raw
            ) ?? {};
        }
      } catch {
        cooldowns =
          {};
      }

      return {
        playerId:
          Number(
            row.player_id
          ),

        cooldowns,
      };
    }
  );
}

async function persistDungeonPlayerCooldowns(
  instanceId: number,
  player:
    PartyCombatPlayer,
) {
  await db.query(
    `
      UPDATE dungeon_instance_members

      SET cooldowns_json = ?

      WHERE instance_id = ?
        AND player_id = ?
        AND is_active = 1
    `,
    [
      JSON.stringify(
        player.cooldowns ??
        {}
      ),
      instanceId,
      player.playerId,
    ],
  );
}

async function persistAllDungeonCooldowns(
  session:
    DungeonCombatSession,
) {
  await Promise.all(
    Array.from(
      session.players.values()
    ).map(
      player =>
        persistDungeonPlayerCooldowns(
          session.instanceId,
          player
        )
    )
  );
}

function getLivingEnemyStates(
  session: DungeonCombatSession,
) {
  return Array.from(
    session.enemies.values()
  ).filter(
    state =>
      state.enemy.hp > 0
  );
}

function getFirstLivingEnemyState(
  session: DungeonCombatSession,
) {
  return (
    getLivingEnemyStates(
      session
    )[0] ??
    null
  );
}

/* =========================================================
   SHARED SINGLE-ENEMY BINDING
========================================================= */

function syncBoundDungeonEnemyState(
  session: DungeonCombatSession,
) {
  const state =
    session.enemies.get(
      Number(
        session.runtimeEnemyId
      )
    );

  if (!state) {
    return;
  }

  state.enemy =
    session.enemy;

  state.dots =
    session.dots;

  state.debuffs =
    session.debuffs;

  state.mechanics =
    session.mechanics;
}

function bindDungeonEnemyState(
  session: DungeonCombatSession,
  state: DungeonCombatEnemyState,
) {
  syncBoundDungeonEnemyState(
    session
  );

  session.runtimeEnemyId =
    state.runtimeEnemyId;

  session.enemy =
    state.enemy;

  session.dots =
    state.dots;

  session.debuffs =
    state.debuffs;

  session.mechanics =
    state.mechanics;
}

function bindFirstLivingEnemy(
  session: DungeonCombatSession,
) {
  const state =
    getFirstLivingEnemyState(
      session
    );

  if (state) {
    bindDungeonEnemyState(
      session,
      state
    );
  }

  return state;
}

/* =========================================================
   TARGETING
========================================================= */

function resolvePlayerEnemyTargetState(
  session: DungeonCombatSession,
  playerId: number,
) {
  const selectedId =
    session.selectedEnemyByPlayer.get(
      Number(playerId)
    );

  if (selectedId) {
    const selected =
      session.enemies.get(
        Number(selectedId)
      );

    if (
      selected &&
      selected.enemy.hp > 0
    ) {
      return selected;
    }
  }

  const fallback =
    getFirstLivingEnemyState(
      session
    );

  if (fallback) {
    session.selectedEnemyByPlayer.set(
      Number(playerId),
      fallback.runtimeEnemyId,
    );
  }

  return fallback;
}

function repairDungeonTargetsAfterDeath(
  session: DungeonCombatSession,
  defeatedEnemyId: number,
) {
  const fallback =
    getFirstLivingEnemyState(
      session
    );

  for (
    const playerId of
    session.players.keys()
  ) {
    const current =
      session.selectedEnemyByPlayer.get(
        playerId
      );

    if (
      current !==
      defeatedEnemyId
    ) {
      continue;
    }

    if (fallback) {
      session.selectedEnemyByPlayer.set(
        playerId,
        fallback.runtimeEnemyId,
      );
    } else {
      session.selectedEnemyByPlayer.delete(
        playerId
      );
    }
  }
}

export async function selectDungeonEnemyTarget(
  session: DungeonCombatSession,
  playerId: number,
  runtimeEnemyId: number,
) {
  return dungeonCombatLocks.run(
    session.instanceId,
    async () => {
      const player =
        session.players.get(
          Number(playerId)
        );

      if (!player) {
        throw new Error(
          "You are not part of this Dungeon encounter.",
        );
      }

      const state =
        session.enemies.get(
          Number(
            runtimeEnemyId
          )
        );

      if (
        !state ||
        state.enemy.hp <= 0
      ) {
        throw new Error(
          "That dungeon enemy is no longer available.",
        );
      }

      session.selectedEnemyByPlayer.set(
        Number(playerId),
        Number(
          runtimeEnemyId
        ),
      );

      session.updatedAt =
        Date.now();

      return buildDungeonCombatSnapshot(
        session
      );
    },
  );
}

/* =========================================================
   CREATE
========================================================= */

async function createDungeonEnemyState(
  runtimeEnemy:
    DungeonRuntimeEnemy,
  participantIds:
    Iterable<number>,
) {
  const enemy =
    createPartyCombatEnemy({
      encounterId:
        runtimeEnemy.id,

      creatureId:
        runtimeEnemy.creatureId,

      sourceId:
        runtimeEnemy.assignmentId,

      name:
        runtimeEnemy.name,

      level:
        runtimeEnemy.level,

      description:
        runtimeEnemy.description,

      image:
        runtimeEnemy.image,

      hp:
        runtimeEnemy.hp,

      maxHp:
        runtimeEnemy.maxHp,

      attack:
        runtimeEnemy.attack,

      defense:
        runtimeEnemy.defense,

      agility:
        runtimeEnemy.agility,

      crit:
        runtimeEnemy.crit,

      participantIds,
    });

  const mechanicDefinitions =
    await loadEnemyMechanicDefinitions([
      {
        sourceType:
          "creature",

        sourceId:
          Number(
            runtimeEnemy.creatureId
          ),
      },
      {
        sourceType:
          "dungeon_enemy",

        sourceId:
          Number(
            runtimeEnemy.id
          ),
      },
    ]);

  return {
    runtimeEnemyId:
      runtimeEnemy.id,

    enemy,

    dots: [],

    debuffs: [],

    mechanics:
      createEnemyMechanicRuntime(
        mechanicDefinitions
      ),
  } as DungeonCombatEnemyState;
}

export async function createDungeonCombatSession(
  instanceId: number,
): Promise<
  DungeonCombatSession |
  null
> {
  const runtimeEnemies =
    await ensureCurrentDungeonEnemies(
      instanceId
    );

  if (
    !runtimeEnemies.length
  ) {
    destroyDungeonCombatSession(
      instanceId
    );

    return null;
  }

  const existing =
    getDungeonCombatSession(
      instanceId
    );

  if (
    existing &&
    existing.state ===
      "active"
  ) {
    const runtimeIds =
      runtimeEnemies
        .map(
          enemy =>
            Number(
              enemy.id
            )
        )
        .sort(
          (a, b) =>
            a - b
        );

    const existingIds =
      Array.from(
        existing.enemies.keys()
      )
        .sort(
          (a, b) =>
            a - b
        );

    if (
      JSON.stringify(
        runtimeIds
      ) ===
      JSON.stringify(
        existingIds
      )
    ) {
      return existing;
    }

    destroyDungeonCombatSession(
      instanceId
    );
  }

  const participants =
    await loadDungeonParticipants(
      instanceId
    );

const participantIds =
  participants.map(
    (
      participant: {
        playerId: number;
        cooldowns: Record<
          string,
          number
        >;
      }
    ) =>
      participant.playerId
  );

  if (
    !participantIds.length
  ) {
    return null;
  }

  const now =
    Date.now();

  const players =
    await createPartyCombatPlayers(
      participantIds,
      {
        now,

        autoAttackMs:
          PLAYER_AUTO_ATTACK_MS,
      },
    );

  if (!players.size) {
    return null;
  }

  /*
   * Restore spell cooldown timestamps from the dungeon member row.
   * Expired timestamps are harmless and naturally read as ready.
   */
  for (
    const participant of
    participants
  ) {
    const player =
      players.get(
        participant.playerId
      );

    if (!player) {
      continue;
    }

    player.cooldowns = {
      ...participant.cooldowns,
    };
  }

  const enemies =
    new Map<
      number,
      DungeonCombatEnemyState
    >();

  for (
    const runtimeEnemy of
    runtimeEnemies
  ) {
    const state =
      await createDungeonEnemyState(
        runtimeEnemy,
        players.keys(),
      );

    enemies.set(
      state.runtimeEnemyId,
      state,
    );
  }

  const firstState =
    Array.from(
      enemies.values()
    )[0];

  if (!firstState) {
    return null;
  }

  const selectedEnemyByPlayer =
    new Map<
      number,
      number
    >();

  for (
    const playerId of
    players.keys()
  ) {
    selectedEnemyByPlayer.set(
      playerId,
      firstState.runtimeEnemyId,
    );
  }

  const session:
    DungeonCombatSession = {
      instanceId:
        Number(
          instanceId
        ),

      createdAt:
        now,

      updatedAt:
        now,

      state:
        "active",

      players,

      enemies,

      selectedEnemyByPlayer,

      runtimeEnemyId:
        firstState.runtimeEnemyId,

      enemy:
        firstState.enemy,

      nextEffectId:
        1,

      dots:
        firstState.dots,

      debuffs:
        firstState.debuffs,

      mechanics:
        firstState.mechanics,

      nextDamageEventId:
        1,

      damageEvents:
        [],

      log: [
        runtimeEnemies.length > 1
          ? `⚠ ${runtimeEnemies.length} enemies engage your party!`
          : `⚠ ${runtimeEnemies[0].name} faces your party!`,
      ],
    };

  dungeonCombatSessions.set(
    Number(
      instanceId
    ),
    session,
  );

  return session;
}

/* =========================================================
   HELPERS
========================================================= */

function getLivingDungeonPlayers(
  session: DungeonCombatSession,
) {
  return Array.from(
    session.players.values()
  ).filter(
    player =>
      player.hp > 0
  );
}

function clampDungeonCombat(
  value: number,
  min: number,
  max: number,
) {
  return Math.max(
    min,
    Math.min(
      max,
      value
    ),
  );
}

async function persistDungeonPlayerHp(
  player:
    PartyCombatPlayer,
) {
  await db.query(
    `
      UPDATE players
      SET hpoints = ?
      WHERE id = ?
    `,
    [
      player.hp,
      player.playerId,
    ],
  );
}

/* =========================================================
   ENEMY DEFEAT
========================================================= */

export async function completeDungeonCombatEnemyDefeat(
  session: DungeonCombatSession,
) {
  const defeatedId =
    Number(
      session.runtimeEnemyId
    );

  const state =
    session.enemies.get(
      defeatedId
    );

  if (!state) {
    return;
  }

  state.enemy.hp =
    0;

  state.enemy.stats.hpoints =
    0;

  state.dots =
    [];

  state.debuffs =
    [];

  await updateDungeonEnemyHp(
    defeatedId,
    0,
  );

  const result =
    await completeDungeonEnemy(
      session.instanceId,
      defeatedId,
    );

  repairDungeonTargetsAfterDeath(
    session,
    defeatedId,
  );

  if (
    result.completedWave ||
    result.completedBoss
  ) {
    session.state =
      "victory";

    destroyDungeonCombatSession(
      session.instanceId
    );

    return;
  }

  bindFirstLivingEnemy(
    session
  );
}

export async function completeDungeonCombatPartyDefeat(
  session: DungeonCombatSession,
) {
  if (
    session.state !==
    "active"
  ) {
    return;
  }

  session.state =
    "defeat";

  session.log.push(
    "☠ Your party has been defeated.",
  );

  await handleDungeonPartyWipe(
    session.instanceId
  );

  destroyDungeonCombatSession(
    session.instanceId
  );
}

/* =========================================================
   SPELL ENEMY
========================================================= */

export function buildDungeonSpellEnemy(
  session:
    DungeonCombatSession,
): SpellEnemy {
  return createPartyCombatSpellEnemy({
    host:
      session,

    enemyId:
      session.runtimeEnemyId,

    sourceType:
      "dungeon",

    getEffectiveStats:
      (
        currentSession,
        now,
      ) =>
        getEffectivePartyCombatEnemyStats(
          currentSession,
          now,
        ),

    persistEnemyHp:
      async currentSession => {
        await updateDungeonEnemyHp(
          currentSession.runtimeEnemyId,
          currentSession.enemy.hp,
        );
      },
  });
}


function createStableDungeonSpellEnemy(
  session:
    DungeonCombatSession,
  state:
    DungeonCombatEnemyState,
): SpellEnemy {
  /*
   * createPartyCombatSpellEnemy mutates its host's dots/debuffs.
   * Use accessor properties so every adapter remains permanently
   * attached to its own dungeon enemy even while session.enemy is
   * rebound for shared legacy helpers.
   */
  const host: any =
    {};

  Object.defineProperties(
    host,
    {
      enemy: {
        enumerable:
          true,

        get: () =>
          state.enemy,

        set: (
          value:
            PartyCombatEnemy
        ) => {
          state.enemy =
            value;
        },
      },

      dots: {
        enumerable:
          true,

        get: () =>
          state.dots,

        set: (
          value:
            PartyCombatDotEffect[]
        ) => {
          state.dots =
            value;
        },
      },

      debuffs: {
        enumerable:
          true,

        get: () =>
          state.debuffs,

        set: (
          value:
            PartyCombatDebuffEffect[]
        ) => {
          state.debuffs =
            value;
        },
      },

      nextEffectId: {
        enumerable:
          true,

        get: () =>
          session.nextEffectId,

        set: (
          value:
            number
        ) => {
          session.nextEffectId =
            Number(
              value
            );
        },
      },
    }
  );

  return createPartyCombatSpellEnemy({
    host,

    enemyId:
      state.runtimeEnemyId,

    sourceType:
      "dungeon",

    getEffectiveStats:
      (
        _host,
        now,
      ) => {
        bindDungeonEnemyState(
          session,
          state
        );

        return getEffectivePartyCombatEnemyStats(
          session,
          now,
        );
      },

    persistEnemyHp:
      async () => {
        await updateDungeonEnemyHp(
          state.runtimeEnemyId,
          state.enemy.hp,
        );
      },
  });
}

function buildDungeonSpellEnemiesForPlayer(
  session:
    DungeonCombatSession,
  playerId: number,
): SpellEnemy[] {
  const selected =
    resolvePlayerEnemyTargetState(
      session,
      playerId,
    );

  const living =
    getLivingEnemyStates(
      session
    );

  const ordered =
    selected
      ? [
          selected,
          ...living.filter(
            state =>
              state.runtimeEnemyId !==
              selected.runtimeEnemyId
          ),
        ]
      : living;

  const spellEnemies =
    ordered.map(
      state =>
        createStableDungeonSpellEnemy(
          session,
          state
        )
    );

  /*
   * createStableDungeonSpellEnemy() calculates effective stats
   * while each adapter is created, which temporarily binds that
   * runtime enemy to session.enemy.
   *
   * Without restoring the selected target here, the LAST enemy in
   * the wave becomes session.enemy. That caused shared single-target
   * post-processing, threat and gauge effects to operate on the
   * wrong creature.
   */
  if (selected) {
    bindDungeonEnemyState(
      session,
      selected
    );
  }

  return spellEnemies;
}

async function completeDungeonCombatEnemyDefeatById(
  session:
    DungeonCombatSession,
  runtimeEnemyId: number,
) {
  const state =
    session.enemies.get(
      Number(
        runtimeEnemyId
      )
    );

  if (
    !state ||
    state.enemy.hp > 0
  ) {
    return;
  }

  bindDungeonEnemyState(
    session,
    state
  );

  await completeDungeonCombatEnemyDefeat(
    session
  );
}

function addDungeonThreatForEnemy(
  session:
    DungeonCombatSession,
  runtimeEnemyId: number,
  playerId: number,
  threat: number,
) {
  const state =
    session.enemies.get(
      Number(
        runtimeEnemyId
      )
    );

  if (
    !state ||
    state.enemy.hp <= 0
  ) {
    return;
  }

  addCombatThreat(
    state.enemy,
    session.players.values(),
    playerId,
    threat,
  );
}

/* =========================================================
   ENEMY MECHANICS
========================================================= */

function createDungeonEnemyMechanicAdapter(
  session:
    DungeonCombatSession,
): EnemyMechanicAdapter {
  return {
    enemyName:
      session.enemy.name,

    enemyMaxHp:
      session.enemy.maxHp,

    participants:
      getLivingDungeonPlayers(
        session
      ).map(
        player => ({
          playerId:
            player.playerId,

          name:
            player.name,

          hp:
            player.hp,

          maxHp:
            player.maxHp,

          gauge:
            player.gauge,

          ready:
            player.ready,
        })
      ),

    threatState: {
      threat:
        session.enemy.threat,

      targetPlayerId:
        session.enemy.targetPlayerId,
    },

    attackPlayer:
      async (
        playerId,
        options,
      ) => {
        await processDungeonEnemyAttack(
          session,
          {
            targetPlayerId:
              Number(
                playerId
              ),

            damageMultiplier:
              options.damageMultiplier,

            abilityName:
              options.abilityName,

            consumeTurn:
              false,

            requireReady:
              false,
          },
        );
      },

    healEnemy:
      async amount => {
        const before =
          session.enemy.hp;

        session.enemy.hp =
          Math.min(
            session.enemy.maxHp,
            session.enemy.hp +
              Math.max(
                0,
                Math.floor(
                  Number(
                    amount
                  ) || 0
                ),
              ),
          );

        session.enemy.stats.hpoints =
          session.enemy.hp;

        const actualHealing =
          Math.max(
            0,
            session.enemy.hp -
              before,
          );

        if (
          actualHealing > 0
        ) {
          await updateDungeonEnemyHp(
            session.runtimeEnemyId,
            session.enemy.hp,
          );
        }

        return actualHealing;
      },

    changePlayerGauge:
      async (
        playerId,
        amount,
      ) => {
        const player =
          session.players.get(
            Number(
              playerId
            ),
          );

        if (
          !player ||
          player.hp <= 0
        ) {
          return 0;
        }

        const before =
          player.gauge;

        player.gauge =
          clampDungeonCombat(
            player.gauge +
              Number(
                amount ||
                0
              ),
            0,
            100,
          );

        player.ready =
          player.gauge >=
          100;

        return (
          player.gauge -
          before
        );
      },

    appendLog:
      line => {
        session.log.push(
          line
        );

        if (
          session.log.length >
          60
        ) {
          session.log =
            session.log.slice(
              -60
            );
        }
      },
  };
}

async function advanceBoundDungeonEnemyMechanics(
  session:
    DungeonCombatSession,
  now: number,
) {
  if (
    session.state !==
      "active" ||
    session.enemy.hp <=
      0
  ) {
    return {
      kind:
        "none" as const,
    };
  }

  const result =
    await advanceEnemyMechanics({
      runtime:
        session.mechanics,

      adapter:
        createDungeonEnemyMechanicAdapter(
          session
        ),

      enemyHp:
        session.enemy.hp,

      encounterStartedAt:
        session.createdAt,

      now,
    });

  if (
    result.kind ===
    "started"
  ) {
    session.enemy.gauge =
      0;

    session.enemy.ready =
      false;

    session.enemy.recoveryUntil =
      Math.max(
        session.enemy.recoveryUntil,
        result.cast.resolvesAt,
      );
  }

  if (
    result.kind ===
    "resolved"
  ) {
    session.enemy.gauge =
      0;

    session.enemy.ready =
      false;

    session.enemy.recoveryUntil =
      now +
      Math.max(
        0,
        Number(
          result.recoveryMs ||
          0
        ),
      );
  }

  return result;
}

export function interruptDungeonEnemyMechanic(
  session:
    DungeonCombatSession,
  sourcePlayerId: number,
) {
  const player =
    session.players.get(
      Number(
        sourcePlayerId
      ),
    );

  const target =
    resolvePlayerEnemyTargetState(
      session,
      sourcePlayerId,
    );

  if (
    session.state !==
      "active" ||
    !player ||
    player.hp <= 0 ||
    !target
  ) {
    return {
      interrupted:
        false,

      cast:
        null,
    };
  }

  bindDungeonEnemyState(
    session,
    target
  );

  const result =
    interruptEnemyMechanic(
      session.mechanics
    );

  if (
    result.interrupted &&
    result.cast
  ) {
    session.enemy.gauge =
      0;

    session.enemy.ready =
      false;

    session.enemy.recoveryUntil =
      Date.now() +
      DUNGEON_ENEMY_RECOVERY_MS;

    session.log.push(
      `⚡ ${player.name} interrupts ${session.enemy.name}'s ${result.cast.name}!`,
    );

    session.updatedAt =
      Date.now();

    syncBoundDungeonEnemyState(
      session
    );
  }

  return result;
}

/* =========================================================
   PLAYER DAMAGE
========================================================= */

async function applyDungeonMitigatedDamage(
  session:
    DungeonCombatSession,
  target:
    PartyCombatPlayer,
  incomingDamage: number,
) {
  const damage =
    Math.max(
      0,
      Math.floor(
        Number(
          incomingDamage
        ) || 0,
      ),
    );

  if (
    damage <= 0
  ) {
    return 0;
  }

  const mitigation =
    await mitigateIncomingPlayerDamage(
      target.playerId,
      target.hp,
      damage,
      target.maxHp,
    );

  target.hp =
    Math.max(
      0,
      Math.min(
        target.maxHp,
        target.hp -
          mitigation.finalDamage +
          (
            mitigation.aegisHealing ??
            0
          ) +
          (
            mitigation.shieldBreakHealing ??
            0
          ) +
          (
            mitigation.thornsHealing ??
            0
          ) +
          (
            mitigation.priestReviveHealing ??
            0
          ) +
          (
            mitigation.bloodweaverReviveHealing ??
            0
          ) +
          (
            mitigation.sentinelReviveHealing ??
            0
          ) +
          (
            mitigation.sageReviveHealing ??
            0
          ),
      ),
    );

  target.stats.hpoints =
    target.hp;

  if (
    (
      mitigation.sageTriggerGaugeGain ??
      0
    ) > 0
  ) {
    target.gauge =
      Math.min(
        100,
        target.gauge +
          Number(
            mitigation.sageTriggerGaugeGain
          ),
      );

    target.ready =
      target.gauge >=
      100;
  }

  await persistDungeonPlayerHp(
    target
  );

  if (
    (
      mitigation.redirectedDamage ??
      0
    ) > 0 &&
    mitigation.redirectPlayerId
  ) {
    const redirectTarget =
      session.players.get(
        Number(
          mitigation.redirectPlayerId
        ),
      );

    if (
      redirectTarget &&
      redirectTarget.hp > 0
    ) {
      const redirected =
        await mitigateIncomingPlayerDamage(
          redirectTarget.playerId,
          redirectTarget.hp,
          mitigation.redirectedDamage,
          redirectTarget.maxHp,
        );

      redirectTarget.hp =
        Math.max(
          0,
          Math.min(
            redirectTarget.maxHp,
            redirectTarget.hp -
              redirected.finalDamage +
              (
                redirected.aegisHealing ??
                0
              ) +
              (
                redirected.shieldBreakHealing ??
                0
              ) +
              (
                redirected.thornsHealing ??
                0
              ) +
              (
                redirected.priestReviveHealing ??
                0
              ) +
              (
                redirected.bloodweaverReviveHealing ??
                0
              ) +
              (
                redirected.sentinelReviveHealing ??
                0
              ) +
              (
                redirected.sageReviveHealing ??
                0
              ),
          ),
        );

      redirectTarget.stats.hpoints =
        redirectTarget.hp;

      if (
        (
          mitigation.spatialGaugeGain ??
          0
        ) > 0
      ) {
        const gain =
          Number(
            mitigation.spatialGaugeGain
          );

        target.gauge =
          Math.min(
            100,
            target.gauge +
              gain,
          );

        redirectTarget.gauge =
          Math.min(
            100,
            redirectTarget.gauge +
              gain,
          );

        target.ready =
          target.gauge >=
          100;

        redirectTarget.ready =
          redirectTarget.gauge >=
          100;
      }

      await persistDungeonPlayerHp(
        redirectTarget
      );
    }
  }

  /*
   * Reflection belongs to the enemy currently bound as the attacker.
   */
  const reflectedDamage =
    Math.max(
      0,
      Number(
        mitigation.voidFeedbackDamage ??
        0
      ),
    ) +
    Math.max(
      0,
      Number(
        mitigation.thornsDamage ??
        0
      ),
    );

  if (
    reflectedDamage > 0 &&
    session.enemy.hp > 0
  ) {
    const applied =
      applyPartyCombatEnemyDamage(
        session.enemy,
        reflectedDamage,
      );

    if (
      applied.damage > 0
    ) {
      await updateDungeonEnemyHp(
        session.runtimeEnemyId,
        session.enemy.hp,
      );
    }

    if (
      applied.defeated &&
      session.state ===
        "active"
    ) {
      await completeDungeonCombatEnemyDefeat(
        session
      );
    }
  }

  return mitigation.finalDamage;
}

/* =========================================================
   ENEMY ATTACKS
========================================================= */

type DungeonEnemyAttackOptions = {
  targetPlayerId?: number;
  damageMultiplier?: number;
  abilityName?: string;
  consumeTurn?: boolean;
  requireReady?: boolean;
};

async function processDungeonEnemyAttack(
  session:
    DungeonCombatSession,
  options:
    DungeonEnemyAttackOptions =
      {},
) {
  if (
    session.state !==
      "active" ||
    session.enemy.hp <=
      0
  ) {
    return;
  }

  if (
    options.requireReady !==
      false &&
    !session.enemy.ready
  ) {
    return;
  }

  const requestedTarget =
    options.targetPlayerId ==
      null
      ? null
      : session.players.get(
          Number(
            options.targetPlayerId
          ),
        );

  const target =
    requestedTarget &&
    requestedTarget.hp > 0
      ? requestedTarget
      : selectPartyCombatThreatTarget(
          session.enemy,
          session.players.values(),
        );

  if (!target) {
    await completeDungeonCombatPartyDefeat(
      session
    );

    return;
  }

  session.enemy.targetPlayerId =
    target.playerId;

  const effectiveStats =
    getEffectivePartyCombatEnemyStats(
      session,
    );

  const result =
    resolvePartyCombatEnemyAttack(
      effectiveStats,
      target,
      {
        damageMultiplier:
          options.damageMultiplier,
      },
    );

  if (
    options.consumeTurn !==
    false
  ) {
    session.enemy.gauge =
      0;

    session.enemy.ready =
      false;

    session.enemy.recoveryUntil =
      Date.now() +
      DUNGEON_ENEMY_RECOVERY_MS;
  }

  if (
    result.dodged
  ) {
    session.log.push(
      `🛡 ${target.name} evades ${session.enemy.name}'s ${options.abilityName || "attack"}!`,
    );
  } else {
    const damage =
      await applyDungeonMitigatedDamage(
        session,
        target,
        result.damage,
      );

    session.log.push(
      `☠ ${session.enemy.name} ${options.abilityName ? `uses ${options.abilityName} on` : "attacks"} ${target.name} for ${damage} damage${result.crit ? " (CRITICAL!)" : ""}`,
    );
  }

  if (
    target.hp <= 0
  ) {
    target.gauge =
      0;

    target.ready =
      false;

    session.log.push(
      `💀 ${target.name} has fallen!`,
    );
  }

  if (
    getLivingDungeonPlayers(
      session
    ).length === 0 &&
    session.state ===
      "active"
  ) {
    await completeDungeonCombatPartyDefeat(
      session
    );
  }
}

/* =========================================================
   AUTO ATTACKS
========================================================= */

async function processDungeonPlayerAutoAttacks(
  session:
    DungeonCombatSession,
  now: number,
) {
  if (
    session.state !==
    "active"
  ) {
    return;
  }

  for (
    const player of
    session.players.values()
  ) {
    if (
      player.hp <= 0 ||
      now <
        player.nextAutoAttackAt
    ) {
      continue;
    }

    const targetState =
      resolvePlayerEnemyTargetState(
        session,
        player.playerId,
      );

    if (!targetState) {
      break;
    }

    bindDungeonEnemyState(
      session,
      targetState
    );

    const effectiveEnemyStats =
      getEffectivePartyCombatEnemyStats(
        session,
        now,
      );

    const result =
      resolvePartyCombatPlayerAttack(
        player,
        effectiveEnemyStats,
      );

    const threatMultiplier =
      await getPlayerCombatThreatMultiplier(
        player.playerId
      );

    addCombatThreat(
      session.enemy,
      session.players.values(),
      player.playerId,
      result.damage *
        Math.max(
          0,
          Number(
            threatMultiplier
          ) || 0,
        ),
    );

    const applied =
      applyPartyCombatEnemyDamage(
        session.enemy,
        result.damage,
      );

    player.nextAutoAttackAt =
      now +
      PLAYER_AUTO_ATTACK_MS;

    await updateDungeonEnemyHp(
      session.runtimeEnemyId,
      session.enemy.hp,
    );

    if (
      result.dodged
    ) {
      session.log.push(
        `⚔ ${player.name}'s auto attack misses ${session.enemy.name}!`,
      );
    } else {
      session.log.push(
        `⚔ ${player.name} attacks ${session.enemy.name} for ${applied.damage}${result.crit ? " (CRITICAL!)" : ""}`,
      );
    }

    if (
      applied.defeated
    ) {
      await completeDungeonCombatEnemyDefeat(
        session
      );

      if (
        session.state !==
        "active"
      ) {
        break;
      }
    }
  }
}

/* =========================================================
   DOTS
========================================================= */

async function processBoundDungeonDots(
  session:
    DungeonCombatSession,
  now: number,
) {
  if (
    session.enemy.hp <= 0 ||
    session.dots.length === 0
  ) {
    return;
  }

  await processPartyCombatDots(
    session,
    now,
    {
      buildSpellEnemy:
        buildDungeonSpellEnemy,

      persistEnemyHp:
        async currentSession => {
          await updateDungeonEnemyHp(
            currentSession.runtimeEnemyId,
            currentSession.enemy.hp,
          );
        },

      completeEnemyDefeat:
        completeDungeonCombatEnemyDefeat,
    },
  );
}

/* =========================================================
   ADVANCE
========================================================= */

async function advanceDungeonCombatSessionUnlocked(
  session:
    DungeonCombatSession,
) {
  if (
    session.state !==
    "active"
  ) {
    return session;
  }

  const now =
    Date.now();

  /*
   * Player ATB advances once globally.
   */
  advancePartyCombatPlayerATBs(
    session,
    now,
  );

  /*
   * Each enemy owns separate debuffs, DOTs, mechanics and ATB.
   */
  for (
    const state of
    getLivingEnemyStates(
      session
    )
  ) {
    bindDungeonEnemyState(
      session,
      state
    );

    removeExpiredPartyCombatDebuffs(
      session,
      now,
    );

    syncBoundDungeonEnemyState(
      session
    );

    advancePartyCombatEnemyATB(
      session,
      now,
      {
        pause:
          Boolean(
            session.mechanics.activeCast
          ),
      },
    );

    syncBoundDungeonEnemyState(
      session
    );
  }

  for (
    const state of
    getLivingEnemyStates(
      session
    )
  ) {
    if (
      session.state !==
      "active"
    ) {
      break;
    }

    bindDungeonEnemyState(
      session,
      state
    );

    await processBoundDungeonDots(
      session,
      now,
    );

    syncBoundDungeonEnemyState(
      session
    );
  }

  if (
    session.state !==
    "active"
  ) {
    session.updatedAt =
      now;

    return session;
  }

  await processDungeonPlayerAutoAttacks(
    session,
    now,
  );

  if (
    session.state !==
    "active"
  ) {
    session.updatedAt =
      now;

    return session;
  }

  /*
   * Every living enemy receives its own turn opportunity.
   */
  for (
    const state of
    getLivingEnemyStates(
      session
    )
  ) {
    if (
      session.state !==
      "active"
    ) {
      break;
    }

    bindDungeonEnemyState(
      session,
      state
    );

    if (
      !session.mechanics.activeCast &&
      !session.enemy.ready
    ) {
      continue;
    }

    refreshCombatThreatTarget(
      session.enemy,
      session.players.values(),
    );

    const result =
      await advanceBoundDungeonEnemyMechanics(
        session,
        now,
      );

    if (
      result.kind ===
      "none"
    ) {
      await processDungeonEnemyAttack(
        session
      );
    }

    syncBoundDungeonEnemyState(
      session
    );
  }

  session.updatedAt =
    now;

  /*
   * Leave compatibility aliases on a predictable living target.
   */
  bindFirstLivingEnemy(
    session
  );

  return session;
}

export async function advanceDungeonCombatSession(
  session:
    DungeonCombatSession,
) {
  return dungeonCombatLocks.run(
    session.instanceId,
    () =>
      advanceDungeonCombatSessionUnlocked(
        session
      ),
  );
}

/* =========================================================
   SPELLS — PASS 1: SINGLE TARGET
========================================================= */

export type DungeonSpellCastResult = {
  ok: boolean;
  error?: string;

  spellId?: number;
  spellName?: string;

  damage?: number;
  crit?: boolean;
  dodged?: boolean;

  snapshot?: ReturnType<
    typeof buildDungeonCombatSnapshot
  >;
};

async function castDungeonSpellUnlocked(
  session:
    DungeonCombatSession,
  playerId: number,
  spellId: number,
  targetPlayerId:
    number |
    null =
    null,
  targetEnemyId:
    number |
    null =
    null,
): Promise<
  DungeonSpellCastResult
> {
  if (
    targetEnemyId != null
  ) {
    const requested =
      session.enemies.get(
        Number(
          targetEnemyId
        ),
      );

    if (
      requested &&
      requested.enemy.hp > 0
    ) {
      session.selectedEnemyByPlayer.set(
        Number(
          playerId
        ),
        requested.runtimeEnemyId,
      );
    }
  }

  const targetState =
    resolvePlayerEnemyTargetState(
      session,
      playerId,
    );

  if (!targetState) {
    return {
      ok: false,
      error:
        "There is no active Dungeon enemy.",
    };
  }

  bindDungeonEnemyState(
    session,
    targetState
  );

  const result =
    await castPartyCombatSpellUnlocked(
      session,
      playerId,
      spellId,
      targetPlayerId,
      {
      contextLabel:
        "Dungeon",

      enemyLabel:
        targetState.enemy.name,

      notParticipantMessage:
        "You are not part of this Dungeon encounter.",

      invalidAllyMessage:
        "That player is not part of this Dungeon.",

      noEnemyMessage:
        "There is no active Dungeon enemy.",

      spellRecoveryMs:
        DUNGEON_SPELL_RECOVERY_MS,

      /*
       * Shared spell casting advances the session before casting.
       * Re-bind THIS player's target after that full multi-enemy advance.
       */
      advanceSessionUnlocked:
        async currentSession => {
          await advanceDungeonCombatSessionUnlocked(
            currentSession
          );

          const rebound =
            resolvePlayerEnemyTargetState(
              currentSession,
              playerId,
            );

          if (rebound) {
            bindDungeonEnemyState(
              currentSession,
              rebound
            );
          }

          return currentSession;
        },

      buildSpellEnemy:
        currentSession => {
          const selected =
            resolvePlayerEnemyTargetState(
              currentSession,
              playerId
            );

          if (!selected) {
            return buildDungeonSpellEnemy(
              currentSession
            );
          }

          bindDungeonEnemyState(
            currentSession,
            selected
          );

          return createStableDungeonSpellEnemy(
            currentSession,
            selected
          );
        },

      buildSpellEnemies:
        (
          currentSession,
          currentPlayerId
        ) =>
          buildDungeonSpellEnemiesForPlayer(
            currentSession,
            currentPlayerId
          ),

      addThreatForEnemy:
        addDungeonThreatForEnemy,

      completeEnemyDefeat:
        completeDungeonCombatEnemyDefeat,

      completeEnemyDefeatById:
        completeDungeonCombatEnemyDefeatById,

      buildSnapshot:
        buildDungeonCombatSnapshot,
      },
    );

  if (
    result.ok
  ) {
    /*
     * Party talents can change cooldowns for more than just the caster,
     * so persist every member after a successful action.
     */
    await persistAllDungeonCooldowns(
      session
    );
  }

  return result;
}

export async function castDungeonSpell(
  session:
    DungeonCombatSession,
  playerId: number,
  spellId: number,
  targetPlayerId:
    number |
    null =
    null,
  targetEnemyId:
    number |
    null =
    null,
): Promise<
  DungeonSpellCastResult
> {
  return dungeonCombatLocks.run(
    session.instanceId,
    () =>
      castDungeonSpellUnlocked(
        session,
        playerId,
        spellId,
        targetPlayerId,
        targetEnemyId,
      ),
  );
}

/* =========================================================
   POTIONS
========================================================= */

export async function useDungeonCombatPotion(
  session:
    DungeonCombatSession,
  playerId: number,
  slot:
    CombatPotionSlot,
) {
  return dungeonCombatLocks.run(
    session.instanceId,
    async () => {
      if (
        session.state !==
        "active"
      ) {
        return {
          ok: false,
          status: 400,
          error:
            "Dungeon combat is no longer active.",
        };
      }

      const player =
        session.players.get(
          Number(
            playerId
          )
        );

      if (
        !player ||
        player.hp <= 0
      ) {
        return {
          ok: false,
          status: 400,
          error:
            "You cannot use a potion right now.",
        };
      }

      const result =
        await useEquippedCombatPotion(
          playerId,
          slot
        );

      if (
        !result.ok
      ) {
        return result;
      }

      /*
       * combatPotionService updates the authoritative players row.
       * Mirror those values into the live dungeon session so the
       * modal reflects the potion immediately.
       */
      player.hp =
        Math.max(
          0,
          Math.min(
            player.maxHp,
            Number(
              result.playerHP
            ) || 0
          )
        );

      player.sp =
        Math.max(
          0,
          Math.min(
            player.maxSp,
            Number(
              result.playerSP
            ) || 0
          )
        );

      player.stats.hpoints =
        player.hp;

      player.stats.spoints =
        player.sp;

      if (
        result.log
      ) {
        session.log.push(
          result.log
        );

        if (
          session.log.length >
          60
        ) {
          session.log =
            session.log.slice(
              -60
            );
        }
      }

      session.updatedAt =
        Date.now();

      return {
        ...result,

        snapshot:
          buildDungeonCombatSnapshot(
            session
          ),
      };
    }
  );
}


/* =========================================================
   SNAPSHOT
========================================================= */

function buildDungeonEnemySnapshot(
  session:
    DungeonCombatSession,
  state:
    DungeonCombatEnemyState,
  now: number,
) {
  bindDungeonEnemyState(
    session,
    state
  );

  refreshCombatThreatTarget(
    session.enemy,
    session.players.values(),
  );

  return {
    runtimeEnemyId:
      state.runtimeEnemyId,

    creatureId:
      session.enemy.creatureId,

    name:
      session.enemy.name,

    level:
      session.enemy.level,

    description:
      session.enemy.description,

    image:
      session.enemy.image,

    hp:
      session.enemy.hp,

    maxHp:
      session.enemy.maxHp,

    gauge:
      session.enemy.gauge,

    ready:
      session.enemy.ready,

    recoveryMs:
      Math.max(
        0,
        session.enemy.recoveryUntil -
          now,
      ),

    readyInMs:
      getPartyCombatEnemyReadyInMs(
        session,
        now,
      ),

    targetPlayerId:
      session.enemy.targetPlayerId,

    mechanic: {
      ...buildEnemyMechanicSnapshot(
        session.mechanics,
        now,
      ),

      abilities:
        session.mechanics.definitions.map(
          definition => {
            const mechanicKey =
              String(
                definition.mechanicKey
              );

            const activeCast =
              session.mechanics.activeCast;

            const casting =
              Boolean(
                activeCast &&
                activeCast.mechanicKey ===
                  mechanicKey
              );

            const cooldownRemainingMs =
              Math.max(
                0,
                Number(
                  session.mechanics.cooldowns[
                    mechanicKey
                  ] ??
                  0
                ) -
                now,
              );

            const availableInMs =
              Math.max(
                0,
                (
                  session.createdAt +
                  Math.max(
                    0,
                    Number(
                      definition.availableAfterMs
                    ) || 0
                  )
                ) -
                now,
              );

            const uses =
              Number(
                session.mechanics.uses[
                  mechanicKey
                ] ??
                0
              );

            const maximumUses =
              definition.maximumUses ==
                null
                ? null
                : Number(
                    definition.maximumUses
                  );

            const exhausted =
              maximumUses != null &&
              uses >= maximumUses;

            const hpPercent =
              (
                session.enemy.hp /
                Math.max(
                  1,
                  session.enemy.maxHp
                )
              ) *
              100;

            const hpEligible =
              hpPercent >=
                Number(
                  definition.minimumHpPercent ??
                  0
                ) &&
              hpPercent <=
                Number(
                  definition.maximumHpPercent ??
                  100
                );

            const ready =
              !casting &&
              !exhausted &&
              hpEligible &&
              cooldownRemainingMs <=
                0 &&
              availableInMs <=
                0;

            return {
              mechanicKey,

              name:
                definition.name,

              description:
                definition.description,

              interruptible:
                definition.interruptible,

              targetRule:
                definition.targetRule,

              castTimeMs:
                definition.castTimeMs,

              cooldownMs:
                definition.cooldownMs,

              cooldownRemainingMs,

              availableInMs,

              uses,

              maximumUses,

              minimumHpPercent:
                definition.minimumHpPercent,

              maximumHpPercent:
                definition.maximumHpPercent,

              casting,

              exhausted,

              hpEligible,

              ready,
            };
          }
        ),
    },

    effects: {
      dots:
        session.dots.map(
          dot => ({
            id:
              dot.id,

            sourcePlayerId:
              dot.sourcePlayerId,

            spellId:
              dot.spellId,

            spellName:
              dot.spellName,

            ticksApplied:
              dot.ticksApplied,

            totalTicks:
              dot.totalTicks,

            nextTickMs:
              Math.max(
                0,
                dot.nextTickAt -
                now
              ),

            remainingMs:
              Math.max(
                0,
                dot.expiresAt -
                now
              ),
          })
        ),

      debuffs:
        session.debuffs
          .filter(
            debuff =>
              debuff.expiresAt >
              now
          )
          .map(
            debuff => ({
              id:
                debuff.id,

              sourcePlayerId:
                debuff.sourcePlayerId,

              spellId:
                debuff.spellId,

              spellName:
                debuff.spellName,

              stat:
                debuff.stat,

              value:
                debuff.value,

              remainingMs:
                Math.max(
                  0,
                  debuff.expiresAt -
                  now
                ),
            })
          ),
    },
  };
}

export function buildDungeonCombatSnapshot(
  session:
    DungeonCombatSession,
) {
  const now =
    Date.now();

  const livingStates =
    getLivingEnemyStates(
      session
    );

  const enemies =
    livingStates.map(
      state =>
        buildDungeonEnemySnapshot(
          session,
          state,
          now,
        )
    );

  const primaryEnemy =
    enemies[0] ??
    null;

  const selectedTargets:
    Record<
      number,
      number | null
    > =
    {};

  for (
    const playerId of
    session.players.keys()
  ) {
    const targetState =
      resolvePlayerEnemyTargetState(
        session,
        playerId,
      );

    selectedTargets[
      playerId
    ] =
      targetState
        ? targetState.runtimeEnemyId
        : null;
  }

  const players =
    Array.from(
      session.players.values()
    ).map(
      player => {
        const selectedState =
          resolvePlayerEnemyTargetState(
            session,
            player.playerId,
          );

        const threat =
          selectedState
            ? getCombatThreat(
                selectedState.enemy,
                player.playerId,
              )
            : 0;

        const threatByEnemy:
          Record<
            number,
            number
          > =
          {};

        for (
          const state of
          livingStates
        ) {
          threatByEnemy[
            state.runtimeEnemyId
          ] =
            getCombatThreat(
              state.enemy,
              player.playerId,
            );
        }

        return {
          playerId:
            player.playerId,

          name:
            player.name,

          hp:
            player.hp,

          maxHp:
            player.maxHp,

          sp:
            player.sp,

          maxSp:
            player.maxSp,

          gauge:
            player.gauge,

          ready:
            player.ready,

          recoveryMs:
            Math.max(
              0,
              player.recoveryUntil -
                now,
            ),

          readyInMs:
            getPartyCombatPlayerReadyInMs(
              player,
              now,
            ),

          autoAttackMs:
            Math.max(
              0,
              player.nextAutoAttackAt -
                now,
            ),

          autoAttackTotalMs:
            PLAYER_AUTO_ATTACK_MS,

          cooldowns:
            player.cooldowns,

          selectedEnemyId:
            selectedTargets[
              player.playerId
            ] ??
            null,

          threat,

          threatByEnemy,
        };
      }
    );

  /*
   * Keep aliases on the first living enemy after snapshot construction.
   */
  bindFirstLivingEnemy(
    session
  );

  return {
    instanceId:
      session.instanceId,

    state:
      session.state,

    enemyCount:
      enemies.length,

    /*
     * Compatibility for older UI code during migration.
     */
    runtimeEnemyId:
      primaryEnemy?.runtimeEnemyId ??
      null,

    enemy:
      primaryEnemy,

    enemies,

    selectedTargets,

    players,

    log:
      session.log.slice(
        -60
      ),
  };
}

export function buildDungeonEnemyMechanicSnapshot(
  session:
    DungeonCombatSession,
) {
  const state =
    getFirstLivingEnemyState(
      session
    );

  if (!state) {
    return null;
  }

  bindDungeonEnemyState(
    session,
    state
  );

  return buildEnemyMechanicSnapshot(
    session.mechanics
  );
}
