//huntCombatSessionService.ts
import { db } from "../db";
import { getFinalPlayerStats } from "./playerService";
import { resolveAttack } from "./combatEngine";
import {
  mitigateIncomingPlayerDamage
} from "./playerDamageMitigationService";

import type {
  DerivedStats
} from "./statEngine";

import {
  getSpellHandler
} from "./spellHandlers";

import type {
  SpellEnemy
} from "./spellHandlers/types";

import {
  resolveDirectSpellDamage
} from "./spellHandlers/helpers";

import {
  createChestFromDrops,
  type DropLine
} from "./chestService";

import {
  generateLootForCreature
} from "./lootGenerator";

import {
  grantExperienceTx
} from "./experienceService";


export type HuntCombatPlayer = {
  playerId: number;

  name: string;

  hp: number;
  maxHp: number;

  sp: number;
  maxSp: number;

  stats: DerivedStats;

  gauge: number;
  ready: boolean;

  recoveryUntil: number;

  nextAutoAttackAt: number;

  cooldowns: Record<string, number>;
};

export type HuntCombatEnemy = {
  encounterId: number;

  name: string;

  level: number;
  description: string;
  image: string | null;

  hp: number;
  maxHp: number;

  gauge: number;
  ready: boolean;

  recoveryUntil: number;

  stats: DerivedStats;
};



export type HuntDotEffect = {
  id: number;

  sourcePlayerId: number;

  spellId: number;
  spellName: string;

  totalDamage: number;
  totalTicks: number;
  ticksApplied: number;

  tickIntervalMs: number;
  nextTickAt: number;
  expiresAt: number;
};

export type HuntDebuffEffect = {
  id: number;

  sourcePlayerId: number;

  spellId: number;
  spellName: string;

  stat:
    | "attack"
    | "defense"
    | "agility"
    | "vitality"
    | "intellect"
    | "crit"
    | "attack_speed_pct"
    | "damage_dealt_pct"
    | "damage_taken_pct";

  value: number;

  appliedAt: number;
  expiresAt: number;
};

export type HuntCombatRewardItem = {
  itemId?: number | null;
  playerItemId?: number | null;

  name: string;
  quantity: number;

  rarity?: string | null;
  isEquipment?: boolean;
};

export type HuntCombatReward = {
  playerId: number;

  exp: number;
  gold: number;

  items: HuntCombatRewardItem[];

  chestId?: number | null;

  levelUp?: {
    oldLevel: number;
    newLevel: number;
    levelsGained: number;
    exp: number;
    hpGain: number;
    spGain: number;
    statPoints: number;
    skillPoints: number;
    restoredToFull: boolean;
  } | null;
};

export type HuntCombatSession = {
  encounterId: number;
  partyHuntId: number;
  partyId: number;

  createdAt: number;
  updatedAt: number;

  state:
    | "active"
    | "victory"
    | "defeat";

  players: Map<number, HuntCombatPlayer>;

  enemy: HuntCombatEnemy;

  log: string[];

  nextDamageEventId: number;
  damageEvents: any[];

  nextEffectId: number;

  dots: HuntDotEffect[];

  debuffs: HuntDebuffEffect[];

  rewards: HuntCombatReward[];
};

export type HuntSpellCastResult = {
  ok: boolean;
  error?: string;

  spellId?: number;
  spellName?: string;

  damage?: number;
  crit?: boolean;
  dodged?: boolean;

  snapshot?: ReturnType<
    typeof buildHuntCombatSnapshot
  >;
};




const huntCombatSessions =
  new Map<number, HuntCombatSession>();

const huntCombatLocks =
  new Map<number, Promise<void>>();

const PLAYER_AUTO_ATTACK_MS = 6000;

const BASE_ATB_SECONDS = 6.0;
const MIN_ATB_SECONDS = 3.0;
const MAX_AGILITY = 500;
const AGILITY_EXPONENT = 0.6;
const HUNT_SPELL_RECOVERY_MS = 350;
const HUNT_ENEMY_RECOVERY_MS = 350;
const HUNT_FINAL_SESSION_LIFETIME_MS =
  2 * 60 * 1000;

function clamp(
  value: number,
  min: number,
  max: number
) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

async function withHuntCombatLock<T>(
  encounterId: number,
  action: () => Promise<T>
): Promise<T> {

  const previous =
    huntCombatLocks.get(encounterId) ??
    Promise.resolve();

  let release!: () => void;

  const current =
    new Promise<void>(
      resolve => {
        release = resolve;
      }
    );

  const queued =
    previous.then(
      () => current
    );

  huntCombatLocks.set(
    encounterId,
    queued
  );

  await previous;

  try {
    return await action();

  } finally {
    release();

    if (
      huntCombatLocks.get(encounterId) ===
      queued
    ) {
      huntCombatLocks.delete(
        encounterId
      );
    }
  }
}


export function getHuntATBTimeSeconds(
  agility: number
) {
  const agi =
    Math.max(
      0,
      Math.min(
        MAX_AGILITY,
        Number(agility || 0)
      )
    );

  const progress =
    Math.pow(
      agi / MAX_AGILITY,
      AGILITY_EXPONENT
    );

  return (
    BASE_ATB_SECONDS -
    progress *
      (
        BASE_ATB_SECONDS -
        MIN_ATB_SECONDS
      )
  );
}

export function getHuntATBFillRate(
  agility: number
) {
  return (
    100 /
    getHuntATBTimeSeconds(
      agility
    )
  );
}

export function getHuntCombatSession(
  encounterId: number
) {
  return (
    huntCombatSessions.get(
      encounterId
    ) ?? null
  );
}

export function destroyHuntCombatSession(
  encounterId: number
) {
  huntCombatSessions.delete(
    encounterId
  );
}

function scheduleHuntSessionCleanup(
  encounterId: number
) {
  setTimeout(() => {
    const session =
      huntCombatSessions.get(
        encounterId
      );

    if (
      !session ||
      session.state === "active"
    ) {
      return;
    }

    destroyHuntCombatSession(
      encounterId
    );
  }, HUNT_FINAL_SESSION_LIFETIME_MS);
}

export async function createHuntCombatSession(
  encounterId: number
): Promise<HuntCombatSession | null> {

const [[encounter]]: any =
  await db.query(
    `
      SELECT
        he.id AS encounter_id,
        he.party_hunt_id,
        he.party_id,
        he.creature_id,
        he.hp,
        he.max_hp,
        he.status,

        ht.name,
        ht.description,
        ht.image,

        c.level,
        c.attack,
        c.defense,
        c.agility,
        c.crit

      FROM hunt_encounters he

      JOIN hunt_targets ht
        ON ht.id = he.hunt_target_id

      JOIN creatures c
        ON c.id = he.creature_id

      WHERE he.id = ?
        AND he.status = 'active'

      LIMIT 1
    `,
    [encounterId]
  );

  if (!encounter) {
    return null;
  }

  const [participantRows]: any =
    await db.query(
      `
        SELECT
          hep.player_id

        FROM hunt_encounter_players hep

        WHERE hep.hunt_encounter_id = ?
          AND hep.is_active = 1

        ORDER BY hep.player_id ASC
      `,
      [encounterId]
    );

  if (!participantRows?.length) {
    return null;
  }

  const now =
    Date.now();

  const players =
    new Map<
      number,
      HuntCombatPlayer
    >();

  for (
    const row of
    participantRows
  ) {
    const playerId =
      Number(row.player_id);

    const stats =
      await getFinalPlayerStats(
        playerId
      );

    if (!stats) {
      continue;
    }

    players.set(
      playerId,
      {
        playerId,

        name:
          stats.name ??
          "Adventurer",

        hp:
          Number(
            stats.hpoints ?? 0
          ),

        maxHp:
          Number(
            stats.maxhp ?? 1
          ),

        sp:
          Number(
            stats.spoints ?? 0
          ),

        maxSp:
          Number(
            stats.maxspoints ?? 0
          ),

        stats,

        gauge: 0,
        ready: false,

        recoveryUntil: 0,

        nextAutoAttackAt:
          now +
          PLAYER_AUTO_ATTACK_MS,

        cooldowns: {}
      }
    );
  }

  if (players.size === 0) {
    return null;
  }

  const enemyStats: DerivedStats = {
    level:
      Number(
        encounter.level ?? 1
      ),

    attack:
      Number(
        encounter.attack ?? 0
      ),

    defense:
      Number(
        encounter.defense ?? 0
      ),

    agility:
      Number(
        encounter.agility ?? 0
      ),

    vitality: 0,
    intellect: 0,

    crit:
    Math.max(
        0,
        Math.min(
        0.4,
        Number(
            encounter.crit ?? 0
        ) * 0.005
        )
    ),

    hpoints:
      Number(
        encounter.hp ?? 0
      ),

    spoints: 0,

    maxhp:
      Number(
        encounter.max_hp ?? 1
      ),

    maxspoints: 0,

    spellPower: 1,

    dodgeChance:
      clamp(
        Number(
          encounter.agility ?? 0
        ) * 0.002,
        0,
        0.35
      ),

    critDamageMult: 1.5,

    damageReduction: 0,

    lifesteal: 0,

    healingReceivedMult: 1,

    atbRateMult: 1,

    damageTakenMult: 1
  };

const session:
  HuntCombatSession = {

  encounterId:
    Number(
      encounter.encounter_id
    ),

  partyHuntId:
    Number(
      encounter.party_hunt_id
    ),

  partyId:
    Number(
      encounter.party_id
    ),

  createdAt: now,
  updatedAt: now,

  state: "active",

  players,

  enemy: {
  encounterId:
    Number(
      encounter.encounter_id
    ),

  name:
    String(
      encounter.name ??
      "Hunt Target"
    ),

  level:
    Number(
      encounter.level ?? 1
    ),

  description:
    String(
      encounter.description ?? ""
    ),

  image:
    encounter.image ?? null,

  hp:
    Number(
      encounter.hp ?? 0
    ),

  maxHp:
    Number(
      encounter.max_hp ?? 1
    ),

  stats:
    enemyStats,

  gauge: 0,
  ready: false,

  recoveryUntil: 0
},

  log: [
    `⚠ ${encounter.name ?? "The quarry"} faces your party!`
  ],

  nextDamageEventId: 1,

  damageEvents: [],

  nextEffectId: 1,

  dots: [],

  debuffs: [],

  rewards: []
};

  huntCombatSessions.set(
    encounterId,
    session
  );

  return session;
}

export async function ensureHuntCombatSessionForPlayer(
  playerId: number
): Promise<HuntCombatSession | null> {

  const pid =
    Number(playerId);


  /*
   * First prefer an ACTIVE in-memory session.
   */
  for (
    const session of
    huntCombatSessions.values()
  ) {
    if (
      session.state === "active" &&
      session.players.has(pid)
    ) {
      return session;
    }
  }


  /*
   * Next check the database for a newly-created
   * active encounter.
   *
   * This is important because a completed Hunt
   * may still have a short-lived victory session
   * retained in memory.
   */
  const [[row]]: any =
    await db.query(
      `
        SELECT
          he.id AS encounter_id

        FROM hunt_encounter_players hep

        JOIN hunt_encounters he
          ON he.id =
             hep.hunt_encounter_id

        WHERE hep.player_id = ?
          AND hep.is_active = 1
          AND he.status = 'active'

        ORDER BY
          he.started_at DESC

        LIMIT 1
      `,
      [
        pid
      ]
    );


  if (row) {

    const encounterId =
      Number(
        row.encounter_id
      );

    let session =
      getHuntCombatSession(
        encounterId
      );

    if (!session) {
      session =
        await createHuntCombatSession(
          encounterId
        );
    }

    return session;
  }


  /*
   * No active encounter exists.
   *
   * Now allow a retained victory/defeat snapshot
   * to be returned so the client can display
   * the final result screen.
   */
  for (
    const session of
    huntCombatSessions.values()
  ) {
    if (
      session.state !== "active" &&
      session.players.has(pid)
    ) {
      return session;
    }
  }


  return null;
}

async function processPlayerAutoAttacks(
  session: HuntCombatSession
) {
  if (
    session.state !==
    "active"
  ) {
    return;
  }

  const now =
    Date.now();

  for (
    const player of
    session.players.values()
  ) {

    if (player.hp <= 0) {
      continue;
    }

    if (
      now <
      player.nextAutoAttackAt
    ) {
      continue;
    }

    if (
      session.enemy.hp <= 0
    ) {
      break;
    }

    const effectiveEnemyStats =
      getEffectiveHuntEnemyStats(
        session,
        now
      );

    const result =
      resolveAttack(
        player.stats as any,
        effectiveEnemyStats as any
      );

const damage =
  result.dodged
    ? 0
    : Math.max(
        0,
        Math.floor(
          Number(
            result.damage ?? 0
          )
        )
      );

    const previousBossHP =
      session.enemy.hp;

    const newBossHP =
      Math.max(
        0,
        previousBossHP -
          damage
      );

session.enemy.hp =
  newBossHP;

  session.enemy.stats.hpoints =
  newBossHP;

player.nextAutoAttackAt =
  now +
  PLAYER_AUTO_ATTACK_MS;

await db.query(
  `
    UPDATE hunt_encounters

    SET hp = ?

    WHERE id = ?
  `,
  [
    newBossHP,
    session.encounterId
  ]
);
    if (result.dodged) {
      session.log.push(
        `⚔ ${player.name}'s auto attack misses!`
      );
    } else {
      session.log.push(
        `⚔ ${player.name} attacks ${session.enemy.name} for ${damage}${
          result.crit
            ? " (CRITICAL!)"
            : ""
        }`
      );
    }

    if (
      session.log.length > 60
    ) {
      session.log =
        session.log.slice(-60);
    }

if (
  newBossHP <= 0
) {
  await completeHuntVictory(
    session
  );

  break;
}
  }
}

function advancePlayerATBs(
  session: HuntCombatSession,
  now: number
) {
  for (
    const player of
    session.players.values()
  ) {
    if (player.hp <= 0) {
      continue;
    }

    if (player.ready) {
      continue;
    }

    const fillStartedAt =
      Math.max(
        session.updatedAt,
        player.recoveryUntil
      );

    const fillElapsedMs =
      Math.max(
        0,
        now -
        fillStartedAt
      );

    if (
      fillElapsedMs <= 0
    ) {
      continue;
    }

    const fillRate =
      getHuntATBFillRate(
        player.stats.agility
      );

    player.gauge =
      Math.min(
        100,
        player.gauge +
          fillRate *
          (
            fillElapsedMs /
            1000
          )
      );

    if (
      player.gauge >= 100
    ) {
      player.gauge = 100;
      player.ready = true;
    }
  }
}

function removeExpiredHuntDebuffs(
  session: HuntCombatSession,
  now: number = Date.now()
) {
  session.debuffs =
    session.debuffs.filter(
      debuff =>
        debuff.expiresAt > now
    );
}


function getHuntDebuffTotals(
  session: HuntCombatSession,
  now: number = Date.now()
) {
  removeExpiredHuntDebuffs(
    session,
    now
  );

  const totals = {
    attack: 0,
    defense: 0,
    agility: 0,
    vitality: 0,
    intellect: 0,
    crit: 0,

    attack_speed_pct: 0,
    damage_dealt_pct: 0,
    damage_taken_pct: 0
  };

  for (
    const debuff of
    session.debuffs
  ) {
    const key =
      debuff.stat;

    if (
      Object.prototype.hasOwnProperty.call(
        totals,
        key
      )
    ) {
      totals[
        key as keyof typeof totals
      ] +=
        Number(
          debuff.value || 0
        );
    }
  }

  return totals;
}


function getEffectiveHuntEnemyStats(
  session: HuntCombatSession,
  now: number = Date.now()
): DerivedStats {

  const base =
    session.enemy.stats;

  const debuffs =
    getHuntDebuffTotals(
      session,
      now
    );


  /*
   * Flat stat debuffs use the same convention
   * as normal combat:
   *
   * -10 attack means debuff value = -10.
   */
  const baseAttack =
    Number(
      base.attack || 0
    ) +
    Number(
      debuffs.attack || 0
    );


  const damageDealtReductionPct =
    Math.max(
      0,
      Math.min(
        80,
        Number(
          debuffs.damage_dealt_pct ||
          0
        )
      )
    );


  const finalAttack =
    Math.max(
      0,
      Math.floor(
        baseAttack *
        (
          1 -
          damageDealtReductionPct /
            100
        )
      )
    );


  const damageTakenPct =
    Math.max(
      0,
      Number(
        debuffs.damage_taken_pct ||
        0
      )
    );


  return {
    ...base,

    attack:
      finalAttack,

    defense:
      Math.max(
        0,
        Number(
          base.defense || 0
        ) +
        Number(
          debuffs.defense || 0
        )
      ),

    agility:
      Math.max(
        0,
        Number(
          base.agility || 0
        ) +
        Number(
          debuffs.agility || 0
        )
      ),

    vitality:
      Number(
        base.vitality || 0
      ) +
      Number(
        debuffs.vitality || 0
      ),

    intellect:
      Number(
        base.intellect || 0
      ) +
      Number(
        debuffs.intellect || 0
      ),

    crit:
      Math.max(
        0,
        Number(
          base.crit || 0
        ) +
        Number(
          debuffs.crit || 0
        )
      ),

    hpoints:
      session.enemy.hp,

    maxhp:
      session.enemy.maxHp,

    damageTakenMult:
      1 +
      damageTakenPct /
        100
  };
}


function getHuntEnemyAtbRateMult(
  session: HuntCombatSession,
  now: number = Date.now()
) {
  const debuffs =
    getHuntDebuffTotals(
      session,
      now
    );

  const slowPct =
    Math.max(
      0,
      Math.min(
        80,
        Number(
          debuffs.attack_speed_pct ||
          0
        )
      )
    );

  return Math.max(
    0.2,
    1 -
      slowPct /
        100
  );
}


function buildHuntSpellEnemy(
  session: HuntCombatSession
): SpellEnemy {

  const now =
    Date.now();

  const effectiveStats =
    getEffectiveHuntEnemyStats(
      session,
      now
    );

  const spellEnemy: SpellEnemy = {

    id:
      session.encounterId,

    name:
      session.enemy.name,

    sourceType:
      "hunt",

    hp:
      session.enemy.hp,

    maxhp:
      session.enemy.maxHp,

    level:
      session.enemy.level,

    attack:
      Number(
        effectiveStats.attack ?? 0
      ),

    defense:
      Number(
        effectiveStats.defense ?? 0
      ),

    agility:
      Number(
        effectiveStats.agility ?? 0
      ),

    stats:
      effectiveStats,


    // =================================================
    // HP PERSISTENCE
    // =================================================

    setHP:
      async (
        newHP: number
      ) => {

        const finalHP =
          Math.max(
            0,
            Math.floor(
              Number(newHP) || 0
            )
          );

        /*
         * Keep the Hunt session authoritative.
         */
        session.enemy.hp =
          finalHP;

        session.enemy.stats.hpoints =
          finalHP;

        /*
         * Keep the handler-facing adapter
         * synchronized too.
         */
        spellEnemy.hp =
          finalHP;

        /*
         * Persist Hunt boss HP.
         */
        await db.query(
          `
            UPDATE hunt_encounters

            SET hp = ?

            WHERE id = ?
          `,
          [
            finalHP,
            session.encounterId
          ]
        );

      },

getDebuffValue:
  async (
    stat: string
  ) => {

    const normalizedStat =
      String(stat)
        .trim()
        .toLowerCase();

    const currentTime =
      Date.now();

    let strongestValue = 0;

    for (
      const effect of
      session.debuffs
    ) {

      if (
        effect.expiresAt <=
        currentTime
      ) {
        continue;
      }

      if (
        String(
          effect.stat
        ).toLowerCase() !==
        normalizedStat
      ) {
        continue;
      }

      strongestValue =
        Math.max(
          strongestValue,
          Number(
            effect.value
          ) || 0
        );
    }

    return strongestValue;
  },

    // =================================================
    // DOT APPLICATION
    // =================================================

    applyDot:
      async (args) => {

        const totalDamage =
          Math.max(
            1,
            Math.floor(
              Number(
                args.totalDamage
              ) || 1
            )
          );

        const durationSeconds =
          Math.max(
            0.1,
            Number(
              args.durationSeconds
            ) || 1
          );

        const tickRateSeconds =
          Math.max(
            0.1,
            Number(
              args.tickRateSeconds
            ) || 1
          );

        const durationMs =
          durationSeconds *
          1000;

        const tickIntervalMs =
          tickRateSeconds *
          1000;

        const totalTicks =
          Math.max(
            1,
            Math.floor(
              durationSeconds /
              tickRateSeconds
            )
          );

        /*
         * Refresh the same player's same
         * spell rather than stacking itself
         * infinitely.
         */
        session.dots =
          session.dots.filter(
            effect =>
              !(
                effect.sourcePlayerId ===
                  Number(
                    args.sourcePlayerId
                  ) &&
                effect.spellId ===
                  Number(
                    args.spellId
                  )
              )
          );

        const effect:
          HuntDotEffect = {

          id:
            session.nextEffectId++,

          sourcePlayerId:
            Number(
              args.sourcePlayerId
            ),

          spellId:
            Number(
              args.spellId
            ),

          spellName:
            String(
              args.spellName
            ),

          totalDamage,

          totalTicks,

          ticksApplied:
            0,

          tickIntervalMs,

          /*
           * Same behavior as your normal DOT
           * pipeline: first tick may occur
           * immediately during advancement.
           */
          nextTickAt:
            Date.now(),

          expiresAt:
            Date.now() +
            durationMs
        };

        session.dots.push(
          effect
        );

        return effect;
      },


    // =================================================
    // DEBUFF APPLICATION
    // =================================================

    applyDebuff:
      async (args) => {

        const stat =
          String(
            args.stat ||
            ""
          )
            .trim()
            .toLowerCase() as
              HuntDebuffEffect["stat"];

        const value =
          Number(
            args.value
          ) || 0;

        const durationSeconds =
          Math.max(
            0.1,
            Number(
              args.durationSeconds
            ) || 1
          );

        /*
         * Same caster + same spell + same stat
         * refreshes instead of stacking itself.
         */
        session.debuffs =
          session.debuffs.filter(
            effect =>
              !(
                effect.sourcePlayerId ===
                  Number(
                    args.sourcePlayerId
                  ) &&
                effect.spellId ===
                  Number(
                    args.spellId
                  ) &&
                effect.stat ===
                  stat
              )
          );

        const appliedAt =
          Date.now();

        const effect:
          HuntDebuffEffect = {

          id:
            session.nextEffectId++,

          sourcePlayerId:
            Number(
              args.sourcePlayerId
            ),

          spellId:
            Number(
              args.spellId
            ),

          spellName:
            String(
              args.spellName
            ),

          stat,

          value,

          appliedAt,

          expiresAt:
            appliedAt +
            durationSeconds *
              1000
        };

        session.debuffs.push(
          effect
        );

        return effect;
      }
  };

  return spellEnemy;
}


async function processHuntDots(
  session: HuntCombatSession,
  now: number
) {
  if (
    session.state !== "active" ||
    session.enemy.hp <= 0 ||
    session.dots.length === 0
  ) {
    return;
  }

  let enemyHP =
    session.enemy.hp;


  for (
    const dot of
    session.dots
  ) {

    /*
     * A poll could arrive late enough that
     * multiple ticks are due.
     *
     * Process every missed tick rather than
     * silently losing damage.
     */
    while (
      dot.ticksApplied <
        dot.totalTicks &&
      dot.nextTickAt <= now &&
      enemyHP > 0
    ) {

      /*
       * Fraction-safe distribution.
       *
       * Example:
       * 25 total damage / 15 ticks
       * still ultimately deals exactly 25.
       */
      const damageBefore =
        Math.floor(
          (
            dot.totalDamage *
            dot.ticksApplied
          ) /
          dot.totalTicks
        );

      const damageAfter =
        Math.floor(
          (
            dot.totalDamage *
            (
              dot.ticksApplied +
              1
            )
          ) /
          dot.totalTicks
        );

      const tickDamage =
        Math.max(
          0,
          damageAfter -
            damageBefore
        );


      dot.ticksApplied++;

      dot.nextTickAt +=
        dot.tickIntervalMs;


      if (tickDamage <= 0) {
        continue;
      }


      enemyHP =
        Math.max(
          0,
          enemyHP -
            tickDamage
        );


      session.log.push(
        `🔥 ${session.enemy.name} takes ${tickDamage} damage from ${dot.spellName}.`
      );


      session.damageEvents.push({
        id:
          session.nextDamageEventId++,

        type:
          "damage",

        source:
          "player",

        playerId:
          dot.sourcePlayerId,

        target:
          "enemy",

        amount:
          tickDamage,

        crit:
          false,

        spellId:
          dot.spellId,

        spellName:
          dot.spellName,

        kind:
          "dot",

        createdAt:
          Date.now()
      });


      if (
        enemyHP <= 0
      ) {
        break;
      }
    }
  }


  session.enemy.hp =
    enemyHP;

  session.enemy.stats.hpoints =
    enemyHP;


  /*
   * Remove finished effects.
   */
  session.dots =
    session.dots.filter(
      dot =>
        dot.ticksApplied <
        dot.totalTicks
    );


  await db.query(
    `
      UPDATE hunt_encounters

      SET hp = ?

      WHERE id = ?
    `,
    [
      enemyHP,
      session.encounterId
    ]
  );


  if (
    session.damageEvents.length >
    40
  ) {
    session.damageEvents =
      session.damageEvents.slice(
        -40
      );
  }


  if (
    session.log.length >
    60
  ) {
    session.log =
      session.log.slice(
        -60
      );
  }


  /*
   * Critical:
   * DOT kills must use the normal Hunt
   * victory/reward lifecycle.
   */
  if (
    enemyHP <= 0
  ) {
    await completeHuntVictory(
      session
    );
  }
}



async function castHuntSpellUnlocked(
  session: HuntCombatSession,
  playerId: number,
  spellId: number,
  targetPlayerId: number | null = null
): Promise<HuntSpellCastResult> {

  // =====================================================
  // ENCOUNTER VALIDATION
  // =====================================================

  if (
    session.state !==
    "active"
  ) {
    return {
      ok: false,
      error:
        "The Hunt encounter is no longer active."
    };
  }


  /*
   * Advance authoritative Hunt state before
   * attempting the player's action.
   */
  await advanceHuntCombatSessionUnlocked(
    session
  );


  /*
   * Advancement may have ended the encounter
   * through an auto attack, DOT, etc.
   */
  if (
    session.state !==
    "active"
  ) {
    return {
      ok: false,

      error:
        "The Hunt target has already been defeated.",

      snapshot:
        buildHuntCombatSnapshot(
          session
        )
    };
  }


  // =====================================================
  // PLAYER VALIDATION
  // =====================================================

  const player =
    session.players.get(
      Number(
        playerId
      )
    );


  if (!player) {
    return {
      ok: false,
      error:
        "You are not part of this Hunt encounter."
    };
  }


  if (
    player.hp <= 0
  ) {
    return {
      ok: false,
      error:
        "You cannot act while defeated."
    };
  }


  if (
    !player.ready
  ) {
    return {
      ok: false,
      error:
        "Your action gauge is not ready."
    };
  }


  if (
    session.enemy.hp <= 0
  ) {
    return {
      ok: false,
      error:
        "The Hunt target has already been defeated."
    };
  }


  // =====================================================
  // LOAD / VERIFY SPELL
  // =====================================================

  /*
   * Never trust spellId from the browser.
   *
   * Spell must:
   * - be learned
   * - be equipped
   * - be a combat spell
   */
  const [[spell]]: any =
    await db.query(
      `
        SELECT
          s.*,
          pes.slot

        FROM player_equipped_spells pes

        JOIN player_spells ps
          ON ps.player_id =
             pes.player_id
         AND ps.spell_id =
             pes.spell_id

        JOIN spells s
          ON s.id =
             pes.spell_id

        WHERE pes.player_id = ?
          AND pes.spell_id = ?
          AND s.is_combat = 1

        LIMIT 1
      `,
      [
        playerId,
        spellId
      ]
    );


  if (!spell) {
    return {
      ok: false,
      error:
        "That spell is not equipped."
    };
  }


  const spellName =
    String(
      spell.name ??
      "Ability"
    );


  const targetType =
    String(
      spell.target_type ||
      spell.target ||
      "enemy"
    )
      .trim()
      .toLowerCase();


  // =====================================================
  // SINGLE FRIENDLY TARGET
  // =====================================================

  let targetPlayer:
    HuntCombatPlayer | null =
    null;


  /*
   * Ally-targeted abilities require an
   * explicitly selected Hunt participant.
   */
  if (
    targetType ===
    "ally"
  ) {

    if (
      !targetPlayerId
    ) {
      return {
        ok: false,
        error:
          "Choose an ally to target."
      };
    }


    const selectedTarget =
      session.players.get(
        Number(
          targetPlayerId
        )
      );


    if (
      !selectedTarget
    ) {
      return {
        ok: false,
        error:
          "That player is not part of this Hunt."
      };
    }


    if (
      selectedTarget.hp <= 0
    ) {
      return {
        ok: false,
        error:
          "That ally is defeated."
      };
    }


    targetPlayer =
      selectedTarget;
  }


  /*
   * Self-targeted abilities always target
   * the caster regardless of anything the
   * browser supplied.
   */
  if (
    targetType ===
    "self"
  ) {
    targetPlayer =
      player;
  }


  // =====================================================
  // PARTY TARGET COLLECTION
  // =====================================================

  /*
   * Party-wide handlers receive all living
   * Hunt participants.
   *
   * This gives shared handlers a combat-mode
   * independent representation of:
   *
   * target_type = all_allies
   */
  const alliedPlayers =
    Array.from(
      session.players.values()
    )
      .filter(
        member =>
          member.hp > 0
      )
      .map(
        member => ({
          playerId:
            member.playerId,

          name:
            member.name,

          stats:
            member.stats,

          hp:
            member.hp,

          maxHp:
            member.maxHp,

          sp:
            member.sp,

          maxSp:
            member.maxSp
        })
      );


  // =====================================================
  // RESOLVE SHARED SPELL HANDLER
  // =====================================================

  /*
   * handler_key
   *      ↓
   * custom class handler
   *
   * otherwise
   *
   * spell.type
   *      ↓
   * generic handler
   */
  const handler =
    getSpellHandler(
      spell
    );


  if (!handler) {
    return {
      ok: false,

      error:
        `No spell handler exists for ${spellName}.`
    };
  }


  // =====================================================
  // BUILD HUNT ENEMY ADAPTER
  // =====================================================

  const spellEnemy =
    buildHuntSpellEnemy(
      session
    );


  if (
    handler.requiresEnemy &&
    !spellEnemy
  ) {
    return {
      ok: false,
      error:
        "There is no Hunt target."
    };
  }


  // =====================================================
  // SPELL CONFIGURATION VALIDATION
  // =====================================================

  const configurationError =
    handler.validate?.(
      spell
    ) ??
    null;


  if (
    configurationError
  ) {

    console.error(
      "Invalid Hunt spell configuration:",
      {
        spellId:
          spell.id,

        spellName:
          spell.name,

        spellType:
          spell.type,

        handlerKey:
          spell.handler_key,

        targetType:
          spell.target_type,

        configurationError
      }
    );


    return {
      ok: false,
      error:
        configurationError
    };
  }


  // =====================================================
  // SP VALIDATION
  // =====================================================

  const manaCost =
    Math.max(
      0,
      Number(
        spell.mana_cost ??
        0
      )
    );


  if (
    player.sp <
    manaCost
  ) {
    return {
      ok: false,
      error:
        "Not enough SP."
    };
  }


  // =====================================================
  // COOLDOWN VALIDATION
  // =====================================================

  const now =
    Date.now();


  const cooldownKey =
    `spell:${spellId}`;


  const cooldownUntil =
    Number(
      player.cooldowns[
        cooldownKey
      ] ??
      0
    );


  if (
    cooldownUntil >
    now
  ) {
    return {
      ok: false,
      error:
        "That spell is still on cooldown."
    };
  }


  // =====================================================
  // PRE-CAST ENEMY SNAPSHOT
  // =====================================================

  /*
   * Used to derive direct damage regardless
   * of which shared handler performed it.
   */
  const enemyHPBeforeCast =
    Math.max(
      0,
      Number(
        session.enemy.hp
      ) ||
      0
    );


  // =====================================================
  // SPEND SP
  // =====================================================

  /*
   * Resource cost is paid only after every
   * normal validation has succeeded.
   */
  player.sp =
    Math.max(
      0,
      player.sp -
      manaCost
    );


  await db.query(
    `
      UPDATE players

      SET spoints = ?

      WHERE id = ?
    `,
    [
      player.sp,
      playerId
    ]
  );


  // =====================================================
  // EXECUTE SHARED SPELL HANDLER
  // =====================================================

  const result =
    await handler.execute({
      playerId:
        player.playerId,

      spell,

      /*
       * Spell scaling always comes from
       * the caster.
       */
      player:
        player.stats,

      /*
       * Enemy-targeted context.
       */
      enemy:
        spellEnemy,

      /*
       * Caster resources.
       */
      currentPlayerHP:
        player.hp,

      currentPlayerSP:
        player.sp,

      maxPlayerHP:
        player.maxHp,

      maxPlayerSP:
        player.maxSp,

      /*
       * Single friendly target.
       */
      targetPlayerId:
        targetPlayer
          ? targetPlayer.playerId
          : undefined,

      targetPlayer:
        targetPlayer
          ? targetPlayer.stats
          : undefined,

      currentTargetHP:
        targetPlayer
          ? targetPlayer.hp
          : undefined,

      currentTargetSP:
        targetPlayer
          ? targetPlayer.sp
          : undefined,

      maxTargetHP:
        targetPlayer
          ? targetPlayer.maxHp
          : undefined,

      maxTargetSP:
        targetPlayer
          ? targetPlayer.maxSp
          : undefined,

      /*
       * Party-wide friendly targets.
       */
      allies:
        alliedPlayers
    });


  // =====================================================
  // RECONCILE ENEMY HP
  // =====================================================

  /*
   * Universal handlers should normally
   * persist enemy HP using SpellEnemy.setHP().
   *
   * Some handlers also return enemyHP.
   * Honor that value as well.
   */
  if (
    result.enemyHP !==
    undefined
  ) {

    const returnedEnemyHP =
      Math.max(
        0,
        Math.floor(
          Number(
            result.enemyHP
          ) ||
          0
        )
      );


    if (
      returnedEnemyHP !==
      session.enemy.hp
    ) {

      if (
        spellEnemy.setHP
      ) {

        await spellEnemy.setHP(
          returnedEnemyHP
        );

      } else {

        session.enemy.hp =
          returnedEnemyHP;

        session.enemy.stats.hpoints =
          returnedEnemyHP;
      }
    }
  }


  /*
   * Ensure local Hunt representation remains
   * valid after the handler runs.
   */
  session.enemy.hp =
    Math.max(
      0,
      Number(
        session.enemy.hp
      ) ||
      0
    );


  session.enemy.stats.hpoints =
    session.enemy.hp;


  // =====================================================
  // CALCULATE DIRECT DAMAGE
  // =====================================================

  /*
   * HP delta is the authoritative measure
   * of immediate spell damage.
   *
   * DOT effects therefore don't count here
   * until an actual DOT tick occurs.
   */
  const damage =
    Math.max(
      0,
      enemyHPBeforeCast -
      session.enemy.hp
    );


  const crit =
    Boolean(
      result.crit
    );


  const dodged =
    Boolean(
      result.dodged
    );


  // =====================================================
  // FRIENDLY STATE REFRESH HELPER
  // =====================================================

  /*
   * Shared handlers may modify:
   *
   * players.hpoints
   * player_buffs
   * player_shields
   * player_status_effects
   * healing-received modifiers
   * max HP
   * derived combat stats
   *
   * Refresh from the authoritative player
   * stat engine after the cast.
   */
  const refreshHuntPlayer =
    async (
      member: HuntCombatPlayer
    ) => {

      const refreshed =
        await getFinalPlayerStats(
          member.playerId
        );


      if (
        !refreshed
      ) {
        return;
      }


      member.stats =
        refreshed;


      member.maxHp =
        Math.max(
          1,
          Number(
            refreshed.maxhp ??
            member.maxHp
          )
        );


      member.maxSp =
        Math.max(
          0,
          Number(
            refreshed.maxspoints ??
            member.maxSp
          )
        );


      member.hp =
        Math.max(
          0,
          Math.min(
            member.maxHp,

            Number(
              refreshed.hpoints ??
              member.hp
            )
          )
        );


      member.sp =
        Math.max(
          0,
          Math.min(
            member.maxSp,

            Number(
              refreshed.spoints ??
              member.sp
            )
          )
        );
    };


  // =====================================================
  // SYNCHRONIZE FRIENDLY PLAYER STATE
  // =====================================================

  if (
    targetType ===
    "all_allies"
  ) {

    /*
     * Party-wide spells can affect every
     * player simultaneously.
     */
    for (
      const member of
      session.players.values()
    ) {

      await refreshHuntPlayer(
        member
      );
    }

  } else {

    /*
     * The caster may always have changed:
     *
     * - SP was spent
     * - self healing
     * - self buff
     * - life siphon
     * - health-cost abilities
     */
    await refreshHuntPlayer(
      player
    );


    /*
     * Refresh an explicitly selected ally.
     */
    if (
      targetPlayer &&
      targetPlayer.playerId !==
        player.playerId
    ) {

      await refreshHuntPlayer(
        targetPlayer
      );
    }
  }


  // =====================================================
  // LEGACY EXPLICIT CASTER HP RESULT
  // =====================================================

  /*
   * playerHP historically means CASTER HP.
   *
   * Only honor it when the spell logically
   * acts on the caster.
   *
   * Ally-targeted handlers should persist
   * their recipient's HP themselves and let
   * refreshHuntPlayer() synchronize it.
   */
  if (
    result.playerHP !==
      undefined &&
    (
      targetType ===
        "self" ||
      targetType ===
        "enemy"
    )
  ) {

    player.hp =
      Math.max(
        0,
        Math.min(
          player.maxHp,

          Number(
            result.playerHP
          ) ||
          0
        )
      );


    player.stats.hpoints =
      player.hp;
  }


  // =====================================================
  // COOLDOWN
  // =====================================================

  const cooldownSeconds =
    Math.max(
      0,
      Number(
        spell.cooldown ??
        0
      )
    );


  player.cooldowns[
    cooldownKey
  ] =
    now +
    cooldownSeconds *
    1000;


  // =====================================================
  // CONSUME PLAYER ATB
  // =====================================================

  player.gauge =
    0;


  player.ready =
    false;


  player.recoveryUntil =
    now +
    HUNT_SPELL_RECOVERY_MS;


  // =====================================================
  // COMBAT LOG
  // =====================================================

  if (
    result.log
  ) {

    session.log.push(
      result.log
    );

  } else {

    session.log.push(
      `✨ ${player.name} casts ${spellName}.`
    );
  }


  // =====================================================
  // DIRECT DAMAGE EVENT
  // =====================================================

  if (
    damage >
    0
  ) {

    session.damageEvents.push({
      id:
        session.nextDamageEventId++,

      type:
        "damage",

      source:
        "player",

      playerId:
        player.playerId,

      target:
        "enemy",

      amount:
        damage,

      crit,

      spellId:
        Number(
          spell.id
        ),

      spellName,

      kind:
        "spell",

      createdAt:
        now
    });


    if (
      session.damageEvents.length >
      40
    ) {

      session.damageEvents =
        session.damageEvents.slice(
          -40
        );
    }
  }


  // =====================================================
  // TRIM COMBAT LOG
  // =====================================================

  if (
    session.log.length >
    60
  ) {

    session.log =
      session.log.slice(
        -60
      );
  }


  // =====================================================
  // VICTORY
  // =====================================================

  if (
    result.killedEnemy ||
    session.enemy.hp <= 0
  ) {

    await completeHuntVictory(
      session
    );
  }


  // =====================================================
  // FINALIZE
  // =====================================================

  session.updatedAt =
    Date.now();


  return {
    ok: true,

    spellId:
      Number(
        spell.id
      ),

    spellName,

    damage,

    crit,

    dodged,

    snapshot:
      buildHuntCombatSnapshot(
        session
      )
  };
}

export async function castHuntSpell(
  session: HuntCombatSession,
  playerId: number,
  spellId: number,
  targetPlayerId: number | null = null
): Promise<HuntSpellCastResult> {

  return withHuntCombatLock(
    session.encounterId,
    () =>
      castHuntSpellUnlocked(
        session,
        playerId,
        spellId,
        targetPlayerId
      )
  );
}

async function advanceHuntCombatSessionUnlocked(
  session: HuntCombatSession
) {
  if (
    session.state !== "active"
  ) {
    return session;
  }

  const now =
    Date.now();


  /*
   * Expire timed debuffs before calculating
   * this advancement's combat stats.
   */
  removeExpiredHuntDebuffs(
    session,
    now
  );


  /*
   * Action gauges.
   */
  advancePlayerATBs(
    session,
    now
  );

  advanceEnemyATB(
    session,
    now
  );


  /*
   * Damage-over-time effects.
   */
  await processHuntDots(
    session,
    now
  );


  if (
    session.state !== "active"
  ) {
    session.updatedAt =
      now;

    return session;
  }


  /*
   * Automatic party weapon attacks.
   */
  await processPlayerAutoAttacks(
    session
  );


  if (
    session.state !== "active"
  ) {
    session.updatedAt =
      now;

    return session;
  }


  /*
   * Hunt target action.
   */
  await processEnemyAttack(
    session
  );


  session.updatedAt =
    now;

  return session;
}

export async function advanceHuntCombatSession(
  session: HuntCombatSession
) {
  return withHuntCombatLock(
    session.encounterId,
    () =>
      advanceHuntCombatSessionUnlocked(
        session
      )
  );
}


export function buildHuntCombatSnapshot(
  session: HuntCombatSession
) {
  const now =
    Date.now();

  return {
    encounterId:
      session.encounterId,

    partyHuntId:
      session.partyHuntId,

    partyId:
      session.partyId,

    state:
      session.state,

enemy: {
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
    session.enemy.ready
},

    players:
      Array.from(
        session.players.values()
      ).map(player => ({
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

        autoAttackMs:
          Math.max(
            0,
            player.nextAutoAttackAt -
              now
          ),

        autoAttackTotalMs:
          PLAYER_AUTO_ATTACK_MS,

        cooldowns:
          player.cooldowns
      })),

log:
  session.log,

damageEvents:
  session.damageEvents,

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
          )
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
            )
        })
      )
},

rewards:
  session.rewards
  };
}









function advanceEnemyATB(
  session: HuntCombatSession,
  now: number
) {
  const enemy =
    session.enemy;

  if (
    session.state !== "active"
  ) {
    return;
  }

  if (enemy.hp <= 0) {
    return;
  }

  if (enemy.ready) {
    return;
  }

  const fillStartedAt =
    Math.max(
      session.updatedAt,
      enemy.recoveryUntil
    );

  const fillElapsedMs =
    Math.max(
      0,
      now -
      fillStartedAt
    );

  if (
    fillElapsedMs <= 0
  ) {
    return;
  }

  const effectiveStats =
    getEffectiveHuntEnemyStats(
      session,
      now
    );

  const baseFillRate =
    getHuntATBFillRate(
      effectiveStats.agility
    );

  const atbRateMult =
    getHuntEnemyAtbRateMult(
      session,
      now
    );

  const fillRate =
    baseFillRate *
    atbRateMult;

  enemy.gauge =
    Math.min(
      100,
      enemy.gauge +
        fillRate *
        (
          fillElapsedMs /
          1000
        )
    );

  if (
    enemy.gauge >= 100
  ) {
    enemy.gauge = 100;
    enemy.ready = true;
  }
}

function getLivingHuntPlayers(
  session: HuntCombatSession
) {
  return Array.from(
    session.players.values()
  ).filter(
    player =>
      player.hp > 0
  );
}

async function completeHuntCombatDefeat(
  session: HuntCombatSession
) {
  if (
    session.state !== "active"
  ) {
    return;
  }

  session.state =
    "defeat";

  await db.query(
    `
      UPDATE hunt_encounters

      SET
        status = 'defeat',
        completed_at = NOW()

      WHERE id = ?
    `,
    [
      session.encounterId
    ]
  );

  session.log.push(
    `☠ Your party has been defeated by ${session.enemy.name}.`
  );

  if (
    session.log.length > 60
  ) {
    session.log =
      session.log.slice(-60);
  }
}

async function processEnemyAttack(
  session: HuntCombatSession
) {
  if (
    session.state !== "active"
  ) {
    return;
  }

  const enemy =
    session.enemy;

  if (
    enemy.hp <= 0 ||
    !enemy.ready
  ) {
    return;
  }

  const livingPlayers =
    getLivingHuntPlayers(
      session
    );

  if (
    livingPlayers.length === 0
  ) {
    await completeHuntCombatDefeat(
      session
    );

    return;
  }

  /*
   * Random living Hunt participant.
   */
  const target =
    livingPlayers[
      Math.floor(
        Math.random() *
        livingPlayers.length
      )
    ];

  /*
   * Apply active Hunt debuffs before
   * resolving the boss attack.
   */
  const effectiveEnemyStats =
    getEffectiveHuntEnemyStats(
      session
    );

  const result =
    resolveAttack(
      effectiveEnemyStats as any,
      target.stats as any
    );

  /*
   * Damage after normal combat-engine
   * defense/dodge calculations, but before
   * shields and defensive statuses.
   */
  const incomingDamage =
    result.dodged
      ? 0
      : Math.max(
          0,
          Math.floor(
            Number(
              result.damage ?? 0
            )
          )
        );

  /*
   * Shared player defensive pipeline.
   *
   * This handles:
   * - Sacred Shield / absorb shields
   * - Intercept
   * - Aegis of Faith
   *
   * The same service can later be used
   * by dungeons and raids.
   */
  const mitigation =
    !result.dodged &&
    incomingDamage > 0
      ? await mitigateIncomingPlayerDamage(
          target.playerId,
          target.hp,
          incomingDamage
        )
      : null;

  const damage =
    mitigation
      ? mitigation.finalDamage
      : incomingDamage;

  /*
   * Consume enemy turn regardless
   * of hit/miss/absorption.
   */
  enemy.gauge = 0;
  enemy.ready = false;

  enemy.recoveryUntil =
    Date.now() +
    HUNT_ENEMY_RECOVERY_MS;

  // =====================================================
  // MISS
  // =====================================================

  if (
    result.dodged
  ) {
    session.log.push(
      `🛡 ${target.name} evades ${enemy.name}'s attack!`
    );

  } else {

    // =====================================================
    // APPLY FINAL HP DAMAGE
    // =====================================================

    target.hp =
      Math.max(
        0,
        target.hp -
        damage
      );

    target.stats.hpoints =
      target.hp;

    await db.query(
      `
        UPDATE players

        SET hpoints = ?

        WHERE id = ?
      `,
      [
        target.hp,
        target.playerId
      ]
    );

    // =====================================================
    // MAIN ATTACK LOG
    // =====================================================

    if (
      damage > 0
    ) {
      session.log.push(
        `☠ ${enemy.name} attacks ${target.name} for ${damage} damage${
          result.crit
            ? " (CRITICAL!)"
            : ""
        }`
      );

    } else if (
      mitigation?.absorbedDamage
    ) {
      session.log.push(
        `☠ ${enemy.name} attacks ${target.name}, but the blow is absorbed!`
      );

    } else {
      session.log.push(
        `☠ ${enemy.name} attacks ${target.name}, but deals no damage.`
      );
    }

    // =====================================================
    // DEFENSIVE EFFECT LOGS
    // =====================================================

    if (
      mitigation?.absorbedDamage
    ) {
      session.log.push(
        `🛡 ${target.name}'s shield absorbs ${mitigation.absorbedDamage} damage.`
      );
    }

    if (
      mitigation?.shieldBroken
    ) {
      session.log.push(
        `💥 ${target.name}'s shield shatters!`
      );
    }

    if (
      mitigation?.interceptTriggered
    ) {
      session.log.push(
        `🛡 Intercept reduces the attack against ${target.name} by ${mitigation.interceptReductionPercent}%!`
      );
    }

    if (
      mitigation?.aegisTriggered
    ) {
      session.log.push(
        `✨ Aegis of Faith reduces the attack against ${target.name} by ${mitigation.aegisReductionPercent}%!`
      );
    }

    if (
      mitigation?.aegisPreventedDeath
    ) {
      session.log.push(
        `🕊 Aegis of Faith prevents a lethal blow against ${target.name}!`
      );
    }

    // =====================================================
    // DAMAGE EVENT
    // =====================================================

    /*
     * Only actual HP loss should create
     * floating damage.
     */
    if (
      damage > 0
    ) {
      session.damageEvents.push({
        id:
          session.nextDamageEventId++,

        type:
          "damage",

        source:
          "enemy",

        target:
          "player",

        playerId:
          target.playerId,

        amount:
          damage,

        crit:
          Boolean(
            result.crit
          ),

        kind:
          "attack",

        createdAt:
          Date.now()
      });

      if (
        session.damageEvents.length >
        40
      ) {
        session.damageEvents =
          session.damageEvents.slice(
            -40
          );
      }
    }

    // =====================================================
    // PLAYER DEFEATED
    // =====================================================

    if (
      target.hp <= 0
    ) {
      target.hp = 0;

      target.gauge = 0;
      target.ready = false;

      session.log.push(
        `💀 ${target.name} has fallen!`
      );
    }
  }

  if (
    session.log.length >
    60
  ) {
    session.log =
      session.log.slice(
        -60
      );
  }

  /*
   * Last living party member defeated?
   */
  const survivors =
    getLivingHuntPlayers(
      session
    );

  if (
    survivors.length === 0
  ) {
    await completeHuntCombatDefeat(
      session
    );
  }
}

export function findHuntCombatSessionForPlayer(
  playerId: number
): HuntCombatSession | null {

  const pid =
    Number(playerId);

  for (
    const session of
    huntCombatSessions.values()
  ) {
    if (
      session.players.has(pid)
    ) {
      return session;
    }
  }

  return null;
}

function rollHuntItemRewards(
  rows: any[]
): HuntCombatRewardItem[] {

  const rewards:
    HuntCombatRewardItem[] = [];

  for (const row of rows || []) {

    const dropChance =
      Math.max(
        0,
        Math.min(
          100,
          Number(
            row.drop_chance ?? 0
          )
        )
      );

    const roll =
      Math.random() * 100;

    if (roll >= dropChance) {
      continue;
    }

    const minQty =
      Math.max(
        1,
        Math.floor(
          Number(
            row.min_qty ?? 1
          )
        )
      );

    const maxQty =
      Math.max(
        minQty,
        Math.floor(
          Number(
            row.max_qty ?? minQty
          )
        )
      );

    const quantity =
      minQty +
      Math.floor(
        Math.random() *
        (
          maxQty -
          minQty +
          1
        )
      );

    rewards.push({
      itemId:
        Number(row.item_id),

      name:
        String(
          row.name ||
          "Unknown Item"
        ),

      quantity
    });
  }

  return rewards;
}

async function completeHuntVictory(
  session: HuntCombatSession
) {
  if (
    session.state === "victory"
  ) {
    return;
  }

  const connection =
    await db.getConnection();

  try {
    await connection.beginTransaction();

    const [[encounter]]: any =
      await connection.query(
        `
          SELECT
            id,
            party_hunt_id,
            creature_id,
            status

          FROM hunt_encounters

          WHERE id = ?

          FOR UPDATE
        `,
        [
          session.encounterId
        ]
      );

    if (!encounter) {
      throw new Error(
        "Hunt encounter not found."
      );
    }

      const [[hunt]]: any =
        await connection.query(
          `
            SELECT
              ph.id AS party_hunt_id,
              ph.hunt_id,

              h.name,
              h.reward_xp AS exp_reward,
              h.reward_gold AS gold_reward,

              he.creature_id,

              c.name AS creature_name,
              c.level AS creature_level,
              c.rarity AS creature_rarity

            FROM party_hunts ph

            JOIN hunts h
              ON h.id = ph.hunt_id

            JOIN hunt_encounters he
              ON he.id = ?

            JOIN creatures c
              ON c.id = he.creature_id

            WHERE ph.id = ?

            LIMIT 1
          `,
          [
            session.encounterId,
            session.partyHuntId
          ]
        );

    if (!hunt) {
      throw new Error(
        "Active Hunt not found."
      );
    }

    const [participants]: any =
      await connection.query(
        `
          SELECT
            hp.player_id

          FROM hunt_participants hp

          WHERE hp.party_hunt_id = ?
        `,
        [
          session.partyHuntId
        ]
      );

    const expReward =
      Math.max(
        0,
        Number(
          hunt.exp_reward ?? 0
        )
      );

    const goldReward =
      Math.max(
        0,
        Number(
          hunt.gold_reward ?? 0
        )
      );

      /*
 * Load the Hunt's personal item
 * reward pool.
 */
const [huntRewardRows]: any =
  await connection.query(
    `
      SELECT
        hr.item_id,
        hr.drop_chance,
        hr.min_qty,
        hr.max_qty,

        i.name

      FROM hunt_rewards hr

      JOIN items i
        ON i.id = hr.item_id

      WHERE hr.hunt_id = ?

      ORDER BY
        hr.id ASC
    `,
    [
      Number(
        hunt.hunt_id
      )
    ]
  );

    const pendingRewards:
      HuntCombatReward[] = [];

for (
  const participant of
  participants
) {
  const playerId =
    Number(
      participant.player_id
    );

  /*
   * -------------------------------------------------
   * EXPERIENCE / LEVEL PROGRESSION
   * -------------------------------------------------
   */

  const experienceResult =
    await grantExperienceTx(
      connection,
      playerId,
      expReward
    );

  /*
   * -------------------------------------------------
   * GOLD
   * -------------------------------------------------
   */

  if (goldReward > 0) {
    await connection.query(
      `
        UPDATE players

        SET gold = gold + ?

        WHERE id = ?
      `,
      [
        goldReward,
        playerId
      ]
    );
  }

  /*
   * -------------------------------------------------
   * PERSONAL HUNT MATERIAL ROLLS
   * -------------------------------------------------
   */

  const materialRewards =
    rollHuntItemRewards(
      huntRewardRows
    );


  /*
   * -------------------------------------------------
   * PERSONAL EQUIPMENT ROLL
   * -------------------------------------------------
   *
   * Hunt targets use the normal Guildforge
   * generated equipment system.
   *
   * Each player rolls independently.
   */

  const generatedEquipment =
    await generateLootForCreature(
      {
        id:
          Number(
            encounter.creature_id
          ),

        name:
          session.enemy.name,

        level:
          session.enemy.level,

        rarity:
          "boss"
      },

      {
        id:
          playerId,

        level:
          session.enemy.level
      },

      1,

      {
        sourceType:
          "hunt",

        /*
         * Use hunt_id instead of party_hunt_id
         * because party_hunts is deleted when
         * victory cleanup finishes.
         */
        sourceId:
          Number(
            hunt.hunt_id
          ),

        conn:
          connection
      }
    );


  /*
   * -------------------------------------------------
   * BUILD CHEST DROPS
   * -------------------------------------------------
   */

  const chestDrops:
    DropLine[] = [];


  /*
   * Static crafting materials.
   */
  for (
    const material of
    materialRewards
  ) {
    chestDrops.push({
      item_id:
        material.itemId,

      qty:
        material.quantity
    });
  }


  /*
   * Generated equipment.
   *
   * player_items rows were created above,
   * but remain unclaimed until the reward
   * chest is claimed.
   */
  for (
    const equipment of
    generatedEquipment
  ) {
    chestDrops.push({
      player_item_id:
        equipment.playerItemId,

      qty:
        1,

      roll_json:
        equipment.affixes
    });
  }


  /*
   * -------------------------------------------------
   * CREATE PERSONAL HUNT CHEST
   * -------------------------------------------------
   */

  const chest =
    await createChestFromDrops({
      playerId,

      sourceType:
        "hunt",

      sourceId:
        Number(
          hunt.hunt_id
        ),

      drops:
        chestDrops,

      conn:
        connection
    });


  /*
   * -------------------------------------------------
   * FINAL CLIENT-FACING REWARD DATA
   * -------------------------------------------------
   */

  const rewardItems:
    HuntCombatRewardItem[] = [
      ...materialRewards.map(
        item => ({
          itemId:
            item.itemId,

          playerItemId:
            null,

          name:
            item.name,

          quantity:
            item.quantity,

          rarity:
            null,

          isEquipment:
            false
        })
      ),

      ...generatedEquipment.map(
        item => ({
          itemId:
            null,

          playerItemId:
            item.playerItemId,

          name:
            item.name,

          quantity:
            1,

          rarity:
            item.rarity,

          isEquipment:
            true
        })
      )
    ];


  pendingRewards.push({
    playerId,

    exp:
      experienceResult.expGained,

    gold:
      goldReward,

    items:
      rewardItems,

    chestId:
      chest?.chestId ??
      null,

    levelUp:
      experienceResult.levelUp ??
      null
  });
}
    /*
     * Remove clue instances.
     */
    await connection.query(
      `
        DELETE FROM party_hunt_clues

        WHERE party_hunt_id = ?
      `,
      [
        session.partyHuntId
      ]
    );

    /*
     * Remove combat participants.
     */
    await connection.query(
      `
        DELETE FROM hunt_encounter_players

        WHERE hunt_encounter_id = ?
      `,
      [
        session.encounterId
      ]
    );

    /*
     * Remove combat encounter.
     */
    await connection.query(
      `
        DELETE FROM hunt_encounters

        WHERE id = ?
      `,
      [
        session.encounterId
      ]
    );

    /*
     * Remove Hunt participants.
     */
    await connection.query(
      `
        DELETE FROM hunt_participants

        WHERE party_hunt_id = ?
      `,
      [
        session.partyHuntId
      ]
    );

    /*
     * Finally remove the completed
     * active Hunt instance.
     */
    await connection.query(
      `
        DELETE FROM party_hunts

        WHERE id = ?
      `,
      [
        session.partyHuntId
      ]
    );

await connection.commit();

/*
 * Database lifecycle is complete.
 *
 * From this point onward the in-memory
 * session becomes the short-lived final
 * victory record shown to the clients.
 */

session.rewards =
  pendingRewards;

session.enemy.hp = 0;
session.enemy.stats.hpoints = 0;

session.enemy.gauge = 0;
session.enemy.ready = false;

session.state =
  "victory";

session.updatedAt =
  Date.now();

session.log.push(
  `🏆 ${session.enemy.name} has been defeated!`
);

session.log.push(
  `🎖 The Hunt is complete!`
);

session.log.push(
  `✨ Each eligible adventurer receives ${expReward} EXP and ${goldReward} gold.`
);

if (
  session.log.length > 60
) {
  session.log =
    session.log.slice(-60);
}

/*
 * Keep the final snapshot alive long enough
 * for all party clients to receive victory.
 */
scheduleHuntSessionCleanup(
  session.encounterId
);

  } catch (err) {

    await connection.rollback();

    console.error(
      "Hunt victory completion failed:",
      err
    );

    throw err;

  } finally {

    connection.release();
  }
}