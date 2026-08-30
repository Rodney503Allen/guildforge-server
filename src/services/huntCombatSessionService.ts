//huntCombatSessionService.ts
import { db } from "../db";
import { getFinalPlayerStats } from "./playerService";
import { resolveAttack } from "./combatEngine";
import {
  COMBAT_TIMING,
  KeyedCombatLock,
  advanceCombatActorGauge,
  calculateDistributedTickDamage,
  getCombatActorReadyInMs,
  getCombatATBFillRate,
  getCombatATBTimeSeconds,
  getEffectRemainingMs,
  applyEnemyDebuffs,
  getEnemyAtbRateMultiplier,
  publishCombatPlayerVitals,
  reduceCombatSpellCooldowns,
} from "./combat";
import { mitigateIncomingPlayerDamage } from "./playerDamageMitigationService";

import { processDuePlayerHots } from "./playerHotService";

import type { DerivedStats } from "./statEngine";

import { getSpellHandler } from "./spellHandlers";

import {
  prepareSpellForCast,
  runAfterCastTalents,
  runBeforeCastTalents,
  validatePreparedSpellTalents,
} from "./spellTalents";

import type { SpellEnemy, SpellHandlerContext } from "./spellHandlers/types";
import {
  getActiveBerserkerDamageMultiplier,
  processBerserkerCriticalGauge,
  convertBerserkerLifestealOverhealToShield
} from "./spellTalents/handlers/berserkerTalentHandlers";
import {
  getWarlordNextSpellOrder,
  consumeWarlordNextSpellOrder,
  processWarlordBannerGaugeTick,
  processWarlordMarkedHit,
  processWarlordClaimThePrize
} from "./spellTalents/handlers/warlordTalentHandlers";

import {
  resolveDirectSpellDamage,
  processJudgmentSpellHit,
} from "./spellHandlers/helpers";

import { createChestFromDrops, type DropLine } from "./chestService";

import { generateLootForCreature } from "./lootGenerator";

import { grantExperienceTx } from "./experienceService";

import {
  publishPlayerStatePatch,
  publishPlayerLevelUp,
} from "../playerStateEvents";

import {
  addCombatThreat,
  calculateCombatThreat,
  createCombatThreatTable,
  getCombatThreat,
  getHighestThreatTarget,
  getPlayerCombatThreatMultiplier,
  refreshCombatThreatTarget,
} from "./combatThreatService";

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

  threat: Record<number, number>;
  targetPlayerId: number | null;

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
  defenseReductionPerTick?: number;
  defenseReductionMaxStacks?: number;
  manaRestorePercentPerTick?: number;
  tickHealingPercent?: number;
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
    | "damage_taken_pct"
    | "spell_damage_taken_pct"
    | "judgment"
    | "judgment_refresh_on_spell"
    | "judgment_refresh_icd"
    | "judgment_crit_upgrade"
    | "crit_chance_taken_pct"
    | "critical_damage_taken_pct"
    | "warlord_bounty_gauge"
    | "warlord_bounty_icd"
    | "warlord_mark_extension"
    | "warlord_claim_hp_pct"
    | "warlord_claim_mana_pct"
    | "warlord_claim_gauge";

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

  state: "active" | "victory" | "defeat";

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

  snapshot?: ReturnType<typeof buildHuntCombatSnapshot>;
};

const huntCombatSessions = new Map<number, HuntCombatSession>();

const huntCombatLocks = new KeyedCombatLock<number>();

const PLAYER_AUTO_ATTACK_MS = COMBAT_TIMING.playerAutoAttackMs;
const HUNT_SPELL_RECOVERY_MS = 350;
const HUNT_ENEMY_RECOVERY_MS = 350;
const HUNT_FINAL_SESSION_LIFETIME_MS = 2 * 60 * 1000;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function publishHuntPlayerVitals(player: HuntCombatPlayer) {
  publishCombatPlayerVitals(player);
}

async function withHuntCombatLock<T>(
  encounterId: number,
  action: () => Promise<T>,
): Promise<T> {
  return huntCombatLocks.run(encounterId, action);
}

export function getHuntATBTimeSeconds(agility: number) {
  return getCombatATBTimeSeconds(agility);
}

export function getHuntATBFillRate(agility: number) {
  return getCombatATBFillRate(agility);
}

function getHuntPlayerReadyInMs(
  player: HuntCombatPlayer,
  now: number = Date.now(),
) {
  return getCombatActorReadyInMs(player, now);
}

function getHuntEnemyReadyInMs(
  session: HuntCombatSession,
  now: number = Date.now(),
) {
  const enemy = session.enemy;

  const effectiveStats = getEffectiveHuntEnemyStats(session, now);
  const atbRateMult = getHuntEnemyAtbRateMult(session, now);
  return getCombatActorReadyInMs(
    { ...enemy, stats: effectiveStats, atbRateMult },
    now,
  );
}

export function getHuntCombatSession(encounterId: number) {
  return huntCombatSessions.get(encounterId) ?? null;
}

export function destroyHuntCombatSession(encounterId: number) {
  huntCombatSessions.delete(encounterId);
}

function scheduleHuntSessionCleanup(encounterId: number) {
  setTimeout(() => {
    const session = huntCombatSessions.get(encounterId);

    if (!session || session.state === "active") {
      return;
    }

    destroyHuntCombatSession(encounterId);
  }, HUNT_FINAL_SESSION_LIFETIME_MS);
}

export async function createHuntCombatSession(
  encounterId: number,
): Promise<HuntCombatSession | null> {
  const [[encounter]]: any = await db.query(
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
    [encounterId],
  );

  if (!encounter) {
    return null;
  }

  const [participantRows]: any = await db.query(
    `
        SELECT
          hep.player_id

        FROM hunt_encounter_players hep

        WHERE hep.hunt_encounter_id = ?
          AND hep.is_active = 1

        ORDER BY hep.player_id ASC
      `,
    [encounterId],
  );

  if (!participantRows?.length) {
    return null;
  }

  const now = Date.now();

  const players = new Map<number, HuntCombatPlayer>();

  for (const row of participantRows) {
    const playerId = Number(row.player_id);

    const stats = await getFinalPlayerStats(playerId);

    if (!stats) {
      continue;
    }

    players.set(playerId, {
      playerId,

      name: stats.name ?? "Adventurer",

      hp: Number(stats.hpoints ?? 0),

      maxHp: Number(stats.maxhp ?? 1),

      sp: Number(stats.spoints ?? 0),

      maxSp: Number(stats.maxspoints ?? 0),

      stats,

      gauge: 0,
      ready: false,

      recoveryUntil: 0,

      nextAutoAttackAt: now + PLAYER_AUTO_ATTACK_MS,

      cooldowns: {},
    });
  }

  if (players.size === 0) {
    return null;
  }

  const enemyStats: DerivedStats = {
    level: Number(encounter.level ?? 1),

    attack: Number(encounter.attack ?? 0),

    defense: Number(encounter.defense ?? 0),

    agility: Number(encounter.agility ?? 0),

    vitality: 0,
    intellect: 0,

    crit: Math.max(0, Math.min(0.4, Number(encounter.crit ?? 0) * 0.005)),

    hpoints: Number(encounter.hp ?? 0),

    spoints: 0,

    maxhp: Number(encounter.max_hp ?? 1),

    maxspoints: 0,

    spellPower: 1,

    dodgeChance: clamp(Number(encounter.agility ?? 0) * 0.002, 0, 0.35),

    critDamageMult: 1.5,

    damageReduction: 0,

    lifesteal: 0,

    healingReceivedMult: 1,

    healingDealtMult: 1,

    atbRateMult: 1,

    damageTakenMult: 1,
  };

  const session: HuntCombatSession = {
    encounterId: Number(encounter.encounter_id),

    partyHuntId: Number(encounter.party_hunt_id),

    partyId: Number(encounter.party_id),

    createdAt: now,
    updatedAt: now,

    state: "active",

    players,

    enemy: {
      encounterId: Number(encounter.encounter_id),

      name: String(encounter.name ?? "Hunt Target"),

      level: Number(encounter.level ?? 1),

      description: String(encounter.description ?? ""),

      image: encounter.image ?? null,

      hp: Number(encounter.hp ?? 0),

      maxHp: Number(encounter.max_hp ?? 1),

      stats: enemyStats,

      gauge: 0,
      ready: false,

      recoveryUntil: 0,

      threat: createCombatThreatTable(players.keys()),
      targetPlayerId: null,
    },

    log: [`⚠ ${encounter.name ?? "The quarry"} faces your party!`],

    nextDamageEventId: 1,

    damageEvents: [],

    nextEffectId: 1,

    dots: [],

    debuffs: [],

    rewards: [],
  };

  huntCombatSessions.set(encounterId, session);

  return session;
}

export async function ensureHuntCombatSessionForPlayer(
  playerId: number,
): Promise<HuntCombatSession | null> {
  const pid = Number(playerId);

  /*
   * First prefer an ACTIVE in-memory session.
   */
  for (const session of huntCombatSessions.values()) {
    if (session.state === "active" && session.players.has(pid)) {
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
  const [[row]]: any = await db.query(
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
    [pid],
  );

  if (row) {
    const encounterId = Number(row.encounter_id);

    let session = getHuntCombatSession(encounterId);

    if (!session) {
      session = await createHuntCombatSession(encounterId);
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
  for (const session of huntCombatSessions.values()) {
    if (session.state !== "active" && session.players.has(pid)) {
      return session;
    }
  }

  return null;
}

async function processPlayerAutoAttacks(session: HuntCombatSession) {
  if (session.state !== "active") {
    return;
  }

  const now = Date.now();

  for (const player of session.players.values()) {
    if (player.hp <= 0) {
      continue;
    }

    if (now < player.nextAutoAttackAt) {
      continue;
    }

    if (session.enemy.hp <= 0) {
      break;
    }

    const effectiveEnemyStats = getEffectiveHuntEnemyStats(session, now);

    const result = resolveAttack(
      player.stats as any,
      effectiveEnemyStats as any,
    );

    const deathWishMultiplier = await getActiveBerserkerDamageMultiplier(player.playerId, player.hp, player.maxHp);
    const damage = result.dodged
      ? 0
      : Math.max(0, Math.floor(Number(result.damage ?? 0) * deathWishMultiplier));

    if (!result.dodged && result.crit) {
      const gauge = await processBerserkerCriticalGauge(player.playerId, true);
      if (gauge > 0) {
        player.gauge = Math.min(100, player.gauge + gauge);
        player.ready = player.gauge >= 100;
      }
    }

    if (!result.dodged && damage > 0 && Number(player.stats.lifesteal || 0) > 0) {
      const raw = Math.max(0, Math.floor(damage * Number(player.stats.lifesteal)));
      const actual = Math.max(0, Math.min(raw, player.maxHp - player.hp));
      const overheal = Math.max(0, raw - actual);
      if (actual > 0) {
        player.hp += actual;
        player.stats.hpoints = player.hp;
        await db.query(`UPDATE players SET hpoints=? WHERE id=?`, [player.hp, player.playerId]);
      }
      await convertBerserkerLifestealOverhealToShield(player.playerId, overheal);
    }

    const autoAttackThreatMultiplier = await getPlayerCombatThreatMultiplier(
      player.playerId,
    );

    addCombatThreat(
      session.enemy,
      session.players.values(),
      player.playerId,
      damage * autoAttackThreatMultiplier,
    );

    const previousBossHP = session.enemy.hp;

    const newBossHP = Math.max(0, previousBossHP - damage);

    if (!result.dodged && damage > 0) {
      const markedHit = await processWarlordMarkedHit(
        buildHuntSpellEnemy(session) as any,
        player.playerId,
        damage,
      );
      player.gauge = Math.min(100, player.gauge + markedHit.gaugeGain);
      player.ready = player.gauge >= 100;
    }

    session.enemy.hp = newBossHP;

    session.enemy.stats.hpoints = newBossHP;

    player.nextAutoAttackAt = now + PLAYER_AUTO_ATTACK_MS;

    await db.query(
      `
    UPDATE hunt_encounters

    SET hp = ?

    WHERE id = ?
  `,
      [newBossHP, session.encounterId],
    );
    if (result.dodged) {
      session.log.push(`⚔ ${player.name}'s auto attack misses!`);
    } else {
      session.log.push(
        `⚔ ${player.name} attacks ${session.enemy.name} for ${damage}${
          result.crit ? " (CRITICAL!)" : ""
        }`,
      );
    }

    if (session.log.length > 60) {
      session.log = session.log.slice(-60);
    }

    if (newBossHP <= 0) {
      const claim = await processWarlordClaimThePrize(
        buildHuntSpellEnemy(session) as any,
        Array.from(session.players.values())
          .filter((member) => member.hp > 0)
          .map((member) => member.playerId),
      );
      for (const claimed of claim.players) {
        const member = session.players.get(claimed.playerId);
        if (!member) continue;
        member.hp = claimed.hp;
        member.sp = claimed.sp;
        member.stats.hpoints = claimed.hp;
        member.stats.spoints = claimed.sp;
        member.gauge = Math.min(100, member.gauge + claim.gaugeGain);
        member.ready = member.gauge >= 100;
      }
      await completeHuntVictory(session);

      break;
    }
  }
}

function advancePlayerATBs(session: HuntCombatSession, now: number) {
  for (const player of session.players.values()) {
    advanceCombatActorGauge(player, session.updatedAt, now);
  }
}

function removeExpiredHuntDebuffs(
  session: HuntCombatSession,
  now: number = Date.now(),
) {
  session.debuffs = session.debuffs.filter((debuff) => debuff.expiresAt > now);
}

function getHuntDebuffTotals(
  session: HuntCombatSession,
  now: number = Date.now(),
) {
  removeExpiredHuntDebuffs(session, now);

  const totals = {
    attack: 0,
    defense: 0,
    agility: 0,
    vitality: 0,
    intellect: 0,
    crit: 0,

    attack_speed_pct: 0,
    damage_dealt_pct: 0,
    damage_taken_pct: 0,
    spell_damage_taken_pct: 0,
    crit_chance_taken_pct: 0,
    critical_damage_taken_pct: 0,
  };

  for (const debuff of session.debuffs) {
    const key = debuff.stat;

    if (Object.prototype.hasOwnProperty.call(totals, key)) {
      totals[key as keyof typeof totals] += Number(debuff.value || 0);
    }
  }

  return totals;
}

function getEffectiveHuntEnemyStats(
  session: HuntCombatSession,
  now: number = Date.now(),
): DerivedStats {
  const base = session.enemy.stats;

  const debuffs = getHuntDebuffTotals(session, now);

  return {
    ...applyEnemyDebuffs(base, debuffs),
    hpoints: session.enemy.hp,
    maxhp: session.enemy.maxHp,
  } as DerivedStats;
}

function getHuntEnemyAtbRateMult(
  session: HuntCombatSession,
  now: number = Date.now(),
) {
  const debuffs = getHuntDebuffTotals(session, now);

  return getEnemyAtbRateMultiplier(debuffs);
}

function buildHuntSpellEnemy(session: HuntCombatSession): SpellEnemy {
  const now = Date.now();

  const effectiveStats = getEffectiveHuntEnemyStats(session, now);

  const spellEnemy = {
    id: session.encounterId,

    name: session.enemy.name,

    sourceType: "hunt",

    hp: session.enemy.hp,

    maxhp: session.enemy.maxHp,

    level: session.enemy.level,

    attack: Number(effectiveStats.attack ?? 0),

    defense: Number(effectiveStats.defense ?? 0),

    agility: Number(effectiveStats.agility ?? 0),

    stats: effectiveStats,

    // =================================================
    // HP PERSISTENCE
    // =================================================

    setHP: async (newHP: number) => {
      const finalHP = Math.max(0, Math.floor(Number(newHP) || 0));

      /*
       * Keep the Hunt session authoritative.
       */
      session.enemy.hp = finalHP;

      session.enemy.stats.hpoints = finalHP;

      /*
       * Keep the handler-facing adapter
       * synchronized too.
       */
      spellEnemy.hp = finalHP;

      /*
       * Persist Hunt boss HP.
       */
      await db.query(
        `
            UPDATE hunt_encounters

            SET hp = ?

            WHERE id = ?
          `,
        [finalHP, session.encounterId],
      );
    },

    getDebuffValue: async (stat: string) => {
      const normalizedStat = String(stat).trim().toLowerCase();

      const currentTime = Date.now();

      if (normalizedStat === "__any__") {
        return session.debuffs.some((effect) => effect.expiresAt > currentTime)
          ? 1
          : 0;
      }

      let strongestValue = 0;

      for (const effect of session.debuffs) {
        if (effect.expiresAt <= currentTime) {
          continue;
        }

        if (String(effect.stat).toLowerCase() !== normalizedStat) {
          continue;
        }

        strongestValue = Math.max(strongestValue, Number(effect.value) || 0);
      }

      return strongestValue;
    },

    removeDebuff: async (stat: string) => {
      const normalized = String(stat).trim().toLowerCase();
      session.debuffs = session.debuffs.filter(
        (effect) => effect.stat !== normalized,
      );
    },

    extendWarlordMark: async (maximumExtensionSeconds: number) => {
      const now = Date.now();
      const marker = session.debuffs
        .filter((effect) =>
          effect.stat === "warlord_mark_extension" && effect.expiresAt > now
        )
        .sort((a, b) => b.expiresAt - a.expiresAt)[0];
      if (!marker) return 0;

      const cap = marker.expiresAt + Math.max(0, maximumExtensionSeconds) * 1000;
      let changed = false;
      for (const effect of session.debuffs) {
        if (
          effect.spellId === 16 &&
          effect.stat !== "warlord_mark_extension" &&
          effect.expiresAt > now
        ) {
          const nextExpiry = Math.min(cap, effect.expiresAt + 1000);
          changed ||= nextExpiry > effect.expiresAt;
          effect.expiresAt = nextExpiry;
        }
      }
      return changed ? 1 : 0;
    },

    consumeDot: async (sourcePlayerId: number, spellId: number) => {
      const existing = session.dots.find(
        effect => effect.sourcePlayerId === Number(sourcePlayerId) && effect.spellId === Number(spellId)
      );
      if (!existing) return 0;
      const dealt = Math.floor(existing.totalDamage * existing.ticksApplied / Math.max(1, existing.totalTicks));
      const remaining = Math.max(0, existing.totalDamage - dealt);
      session.dots = session.dots.filter(effect => effect.id !== existing.id);
      return remaining;
    },

    // =================================================
    // DOT APPLICATION
    // =================================================

    applyDot: async (args) => {
      const totalDamage = Math.max(
        1,
        Math.floor(Number(args.totalDamage) || 1),
      );

      const durationSeconds = Math.max(0.1, Number(args.durationSeconds) || 1);

      const tickRateSeconds = Math.max(0.1, Number(args.tickRateSeconds) || 1);

      const durationMs = durationSeconds * 1000;

      const tickIntervalMs = tickRateSeconds * 1000;

      const totalTicks = Math.max(
        1,
        Math.floor(durationSeconds / tickRateSeconds),
      );

      /*
       * Refresh the same player's same
       * spell rather than stacking itself
       * infinitely.
       */
      session.dots = session.dots.filter(
        (effect) =>
          !(
            effect.sourcePlayerId === Number(args.sourcePlayerId) &&
            effect.spellId === Number(args.spellId)
          ),
      );

      const effect: HuntDotEffect = {
        id: session.nextEffectId++,

        sourcePlayerId: Number(args.sourcePlayerId),

        spellId: Number(args.spellId),

        spellName: String(args.spellName),

        totalDamage,

        totalTicks,

        ticksApplied: 0,

        tickIntervalMs,

        /*
         * Same behavior as your normal DOT
         * pipeline: first tick may occur
         * immediately during advancement.
         */
        nextTickAt: Date.now() + (args.immediateFirstTick ? 0 : tickIntervalMs),

        expiresAt: Date.now() + durationMs,

        defenseReductionPerTick: Number(args.defenseReductionPerTick) || 0,
        defenseReductionMaxStacks: Number(args.defenseReductionMaxStacks) || 0,
        manaRestorePercentPerTick: Number(args.manaRestorePercentPerTick) || 0,
        tickHealingPercent: Number((args as any).tickHealingPercent) || 0,
      };

      session.dots.push(effect);

      return effect;
    },

    // =================================================
    // DEBUFF APPLICATION
    // =================================================

    applyDebuff: async (args) => {
      const stat = String(args.stat || "")
        .trim()
        .toLowerCase() as HuntDebuffEffect["stat"];

      const value = Number(args.value) || 0;

      const durationSeconds = Math.max(0.1, Number(args.durationSeconds) || 1);

      /*
       * Same caster + same spell + same stat
       * refreshes instead of stacking itself.
       */
      session.debuffs = session.debuffs.filter(
        (effect) =>
          !(
            effect.sourcePlayerId === Number(args.sourcePlayerId) &&
            effect.spellId === Number(args.spellId) &&
            effect.stat === stat
          ),
      );

      const appliedAt = Date.now();

      const effect: HuntDebuffEffect = {
        id: session.nextEffectId++,

        sourcePlayerId: Number(args.sourcePlayerId),

        spellId: Number(args.spellId),

        spellName: String(args.spellName),

        stat,

        value,

        appliedAt,

        expiresAt: appliedAt + durationSeconds * 1000,
      };

      session.debuffs.push(effect);

      return effect;
    },
  } as SpellEnemy & {
    consumeDot: (
      sourcePlayerId: number,
      spellId: number
    ) => Promise<number>;
  };

  return spellEnemy;
}

async function processHuntDots(session: HuntCombatSession, now: number) {
  if (
    session.state !== "active" ||
    session.enemy.hp <= 0 ||
    session.dots.length === 0
  ) {
    return;
  }

  let enemyHP = session.enemy.hp;

  for (const dot of session.dots) {
    /*
     * A poll could arrive late enough that
     * multiple ticks are due.
     *
     * Process every missed tick rather than
     * silently losing damage.
     */
    while (
      dot.ticksApplied < dot.totalTicks &&
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
      const tickDamage = calculateDistributedTickDamage(
        dot.totalDamage,
        dot.totalTicks,
        dot.ticksApplied,
      );

      dot.ticksApplied++;

      if (
        (dot.defenseReductionPerTick || 0) > 0 &&
        (dot.defenseReductionMaxStacks || 0) > 0
      ) {
        const stacks = Math.min(
          Number(dot.defenseReductionMaxStacks),
          dot.ticksApplied,
        );
        const reduction = -Math.max(
          1,
          Math.floor(
            (Number(session.enemy.stats.defense || 0) *
              Number(dot.defenseReductionPerTick) *
              stacks) /
              100,
          ),
        );
        session.debuffs = session.debuffs.filter(
          (effect) =>
            !(
              effect.sourcePlayerId === dot.sourcePlayerId &&
              effect.spellId === dot.spellId &&
              effect.stat === "defense"
            ),
        );
        session.debuffs.push({
          id: session.nextEffectId++,
          sourcePlayerId: dot.sourcePlayerId,
          spellId: dot.spellId,
          spellName: dot.spellName,
          stat: "defense",
          value: reduction,
          appliedAt: now,
          expiresAt: dot.expiresAt,
        });
      }

      if ((dot.manaRestorePercentPerTick || 0) > 0) {
        const source = session.players.get(dot.sourcePlayerId);
        if (source) {
          const restored = Math.max(
            1,
            Math.floor(
              (source.maxSp * Number(dot.manaRestorePercentPerTick)) / 100,
            ),
          );
          source.sp = Math.min(source.maxSp, source.sp + restored);
          source.stats.spoints = source.sp;
          await db.query(`UPDATE players SET spoints = ? WHERE id = ?`, [
            source.sp,
            source.playerId,
          ]);
        }
      }

      if ((dot.tickHealingPercent || 0) > 0 && tickDamage > 0) {
        const source = session.players.get(dot.sourcePlayerId);
        if (source && source.hp > 0) {
          const healing = Math.max(1, Math.floor(tickDamage * Number(dot.tickHealingPercent) / 100));
          source.hp = Math.min(source.maxHp, source.hp + healing);
          source.stats.hpoints = source.hp;
          await db.query(`UPDATE players SET hpoints=? WHERE id=?`, [source.hp, source.playerId]);
          publishHuntPlayerVitals(source);
          session.log.push(`🩸 Scent of Blood restores ${healing} HP to ${source.name}.`);
        }
      }

      dot.nextTickAt += dot.tickIntervalMs;

      if (tickDamage <= 0) {
        continue;
      }

      enemyHP = Math.max(0, enemyHP - tickDamage);

      const markedHit = await processWarlordMarkedHit(
        buildHuntSpellEnemy(session) as any,
        dot.sourcePlayerId,
        tickDamage,
      );
      const markedAttacker = session.players.get(dot.sourcePlayerId);
      if (markedAttacker) {
        markedAttacker.gauge = Math.min(
          100,
          markedAttacker.gauge + markedHit.gaugeGain,
        );
        markedAttacker.ready = markedAttacker.gauge >= 100;
      }

      const dotThreatMultiplier = await getPlayerCombatThreatMultiplier(
        dot.sourcePlayerId,
      );

      addCombatThreat(
        session.enemy,
        session.players.values(),
        dot.sourcePlayerId,
        tickDamage * dotThreatMultiplier,
      );

      session.log.push(
        `🔥 ${session.enemy.name} takes ${tickDamage} damage from ${dot.spellName}.`,
      );

      session.damageEvents.push({
        id: session.nextDamageEventId++,

        type: "damage",

        source: "player",

        playerId: dot.sourcePlayerId,

        target: "enemy",

        amount: tickDamage,

        crit: false,

        spellId: dot.spellId,

        spellName: dot.spellName,

        kind: "dot",

        createdAt: Date.now(),
      });

      if (enemyHP <= 0) {
        break;
      }
    }
  }

  session.enemy.hp = enemyHP;

  session.enemy.stats.hpoints = enemyHP;

  /*
   * Remove finished effects.
   */
  session.dots = session.dots.filter(
    (dot) => dot.ticksApplied < dot.totalTicks,
  );

  await db.query(
    `
      UPDATE hunt_encounters

      SET hp = ?

      WHERE id = ?
    `,
    [enemyHP, session.encounterId],
  );

  if (session.damageEvents.length > 40) {
    session.damageEvents = session.damageEvents.slice(-40);
  }

  if (session.log.length > 60) {
    session.log = session.log.slice(-60);
  }

  /*
   * Critical:
   * DOT kills must use the normal Hunt
   * victory/reward lifecycle.
   */
  if (enemyHP <= 0) {
    const claim = await processWarlordClaimThePrize(
      buildHuntSpellEnemy(session) as any,
      Array.from(session.players.values())
        .filter((member) => member.hp > 0)
        .map((member) => member.playerId),
    );
    for (const claimed of claim.players) {
      const member = session.players.get(claimed.playerId);
      if (!member) continue;
      member.hp = claimed.hp;
      member.sp = claimed.sp;
      member.stats.hpoints = claimed.hp;
      member.stats.spoints = claimed.sp;
      member.gauge = Math.min(100, member.gauge + claim.gaugeGain);
      member.ready = member.gauge >= 100;
    }
    await completeHuntVictory(session);
  }
}

async function castHuntSpellUnlocked(
  session: HuntCombatSession,
  playerId: number,
  spellId: number,
  targetPlayerId: number | null = null,
): Promise<HuntSpellCastResult> {
  // =====================================================
  // ENCOUNTER VALIDATION
  // =====================================================

  if (session.state !== "active") {
    return {
      ok: false,
      error: "The Hunt encounter is no longer active.",
    };
  }

  /*
   * Advance authoritative Hunt state before
   * attempting the player's action.
   */
  await advanceHuntCombatSessionUnlocked(session);

  /*
   * Advancement may have ended the encounter
   * through an auto attack, DOT, etc.
   */
  if (session.state !== "active") {
    return {
      ok: false,

      error: "The Hunt target has already been defeated.",

      snapshot: buildHuntCombatSnapshot(session),
    };
  }

  // =====================================================
  // PLAYER VALIDATION
  // =====================================================

  const player = session.players.get(Number(playerId));

  if (!player) {
    return {
      ok: false,
      error: "You are not part of this Hunt encounter.",
    };
  }

  if (player.hp <= 0) {
    return {
      ok: false,
      error: "You cannot act while defeated.",
    };
  }

  if (!player.ready) {
    return {
      ok: false,
      error: "Your action gauge is not ready.",
    };
  }

  if (session.enemy.hp <= 0) {
    return {
      ok: false,
      error: "The Hunt target has already been defeated.",
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
  const [[baseSpell]]: any = await db.query(
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
    [playerId, spellId],
  );

  if (!baseSpell) {
    return {
      ok: false,
      error: "That spell is not equipped.",
    };
  }

  /*
   * Build the authoritative Hunt spell:
   *
   * base spell + purchased rank + selected talents.
   *
   * Every validation and effect below uses this prepared spell.
   */
  const preparedCast = await prepareSpellForCast(playerId, baseSpell);

  const spell = preparedCast.spell;

  const warlordOrder = await getWarlordNextSpellOrder(playerId);
  const isDamagingSpell =
    Number(spell.damage) > 0 ||
    Number(spell.dot_damage) > 0 ||
    ["damage", "dot", "damage_dot"].includes(String(spell.type));

  if (isDamagingSpell && warlordOrder.damagePercent > 0) {
    const multiplier = 1 + warlordOrder.damagePercent / 100;
    if (Number(spell.damage) > 0) spell.damage = Math.round(Number(spell.damage) * multiplier);
    if (Number(spell.dot_damage) > 0) spell.dot_damage = Math.round(Number(spell.dot_damage) * multiplier);
  }

  const spellName = String(spell.name ?? "Ability");

  const targetType = String(spell.target_type || spell.target || "enemy")
    .trim()
    .toLowerCase();

  // =====================================================
  // SINGLE FRIENDLY TARGET
  // =====================================================

  let targetPlayer: HuntCombatPlayer | null = null;

  /*
   * Ally-targeted abilities require an
   * explicitly selected Hunt participant.
   */
  if (targetType === "ally") {
    if (!targetPlayerId) {
      return {
        ok: false,
        error: "Choose an ally to target.",
      };
    }

    const selectedTarget = session.players.get(Number(targetPlayerId));

    if (!selectedTarget) {
      return {
        ok: false,
        error: "That player is not part of this Hunt.",
      };
    }

    if (selectedTarget.hp <= 0) {
      return {
        ok: false,
        error: "That ally is defeated.",
      };
    }

    targetPlayer = selectedTarget;
  }

  /*
   * Self-targeted abilities always target
   * the caster regardless of anything the
   * browser supplied.
   */
  if (targetType === "self") {
    targetPlayer = player;
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
  const alliedPlayers = Array.from(session.players.values())
    .filter((member) => member.hp > 0)
    .map((member) => ({
      playerId: member.playerId,

      name: member.name,

      stats: member.stats,

      hp: member.hp,

      maxHp: member.maxHp,

      sp: member.sp,

      maxSp: member.maxSp,
    }));

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
  const handler = getSpellHandler(spell);

  if (!handler) {
    return {
      ok: false,

      error: `No spell handler exists for ${spellName}.`,
    };
  }

  // =====================================================
  // BUILD HUNT ENEMY ADAPTER
  // =====================================================

  const spellEnemy = buildHuntSpellEnemy(session);

  if (handler.requiresEnemy && !spellEnemy) {
    return {
      ok: false,
      error: "There is no Hunt target.",
    };
  }

  // =====================================================
  // SPELL CONFIGURATION VALIDATION
  // =====================================================

  const configurationError = handler.validate?.(spell) ?? null;

  if (configurationError) {
    console.error("Invalid Hunt spell configuration:", {
      spellId: spell.id,

      spellName: spell.name,

      spellType: spell.type,

      handlerKey: spell.handler_key,

      targetType: spell.target_type,

      configurationError,
    });

    return {
      ok: false,
      error: configurationError,
    };
  }

  /*
   * One combat-mode-neutral context is shared by the spell handler and
   * every custom talent lifecycle hook.
   */
  const spellContext: SpellHandlerContext = {
    playerId: player.playerId,

    spell,

    player: player.stats,

    enemy: spellEnemy,

    currentPlayerHP: player.hp,

    currentPlayerSP: player.sp,

    maxPlayerHP: player.maxHp,

    maxPlayerSP: player.maxSp,

    targetPlayerId: targetPlayer ? targetPlayer.playerId : undefined,

    targetPlayer: targetPlayer ? targetPlayer.stats : undefined,

    currentTargetHP: targetPlayer ? targetPlayer.hp : undefined,

    currentTargetSP: targetPlayer ? targetPlayer.sp : undefined,

    maxTargetHP: targetPlayer ? targetPlayer.maxHp : undefined,

    maxTargetSP: targetPlayer ? targetPlayer.maxSp : undefined,

    allies: alliedPlayers,

    talents: preparedCast.talents,

    castState: preparedCast.castState,

    hasTalent: preparedCast.hasTalent,

    getTalent: preparedCast.getTalent,

    getTalentConfig: preparedCast.getTalentConfig,
  };

  (spellContext as any).alliesIncludingDefeated = Array.from(session.players.values()).map(
    (member) => ({
      playerId: member.playerId,
      name: member.name,
      stats: member.stats,
      hp: member.hp,
      maxHp: member.maxHp,
      sp: member.sp,
      maxSp: member.maxSp
    })
  );

  // Talent-specific casting rules fail before SP or the ATB turn is spent.
  const talentValidationError = await validatePreparedSpellTalents(
    preparedCast,
    spellContext,
  );

  if (talentValidationError) {
    return {
      ok: false,
      error: talentValidationError,
    };
  }

  // =====================================================
  // SP VALIDATION
  // =====================================================

  const manaCost = warlordOrder.free
    ? 0
    : Math.max(0, Number(preparedCast.castState.manaCost ?? 0));

  if (player.sp < manaCost) {
    return {
      ok: false,
      error: "Not enough SP.",
    };
  }

  // =====================================================
  // COOLDOWN VALIDATION
  // =====================================================

  const now = Date.now();

  const cooldownKey = `spell:${spellId}`;

  const cooldownUntil = Number(player.cooldowns[cooldownKey] ?? 0);

  if (cooldownUntil > now) {
    return {
      ok: false,
      error: "That spell is still on cooldown.",
    };
  }

  if (warlordOrder.free || isDamagingSpell) {
    await consumeWarlordNextSpellOrder(playerId, warlordOrder);
  }

  // =====================================================
  // PRE-CAST ENEMY SNAPSHOT
  // =====================================================

  /*
   * Used to derive direct damage regardless
   * of which shared handler performed it.
   */
  const enemyHPBeforeCast = Math.max(0, Number(session.enemy.hp) || 0);

  const playerHPBeforeCast = new Map(
    Array.from(session.players.values()).map((member) => [
      member.playerId,
      member.hp,
    ]),
  );

  // =====================================================
  // SPEND SP
  // =====================================================

  /*
   * Resource cost is paid only after every
   * normal validation has succeeded.
   */
  player.sp = Math.max(0, player.sp - manaCost);

  await db.query(
    `
      UPDATE players

      SET spoints = ?

      WHERE id = ?
    `,
    [player.sp, playerId],
  );

  /*
   * Side-effecting pre-cast hooks only run after all normal validation has
   * passed and the spell's adjusted SP cost has been paid.
   */
  spellContext.currentPlayerSP = player.sp;

  await runBeforeCastTalents(preparedCast, spellContext);

  // =====================================================
  // EXECUTE SHARED SPELL HANDLER
  // =====================================================

  const berserkerDamageMultiplier = await getActiveBerserkerDamageMultiplier(
    playerId,
    player.hp,
    player.maxHp
  );
  if (berserkerDamageMultiplier > 1) {
    if (Number(spell.damage) > 0) spell.damage = Math.round(Number(spell.damage) * berserkerDamageMultiplier);
    if (Number(spell.dot_damage) > 0) spell.dot_damage = Math.round(Number(spell.dot_damage) * berserkerDamageMultiplier);
  }

  let result = await handler.execute(spellContext);

  result = await runAfterCastTalents(preparedCast, spellContext, result);

  const berserkerCriticalGauge = await processBerserkerCriticalGauge(playerId, Boolean(result.crit));
  if (berserkerCriticalGauge > 0 && Number(result.damage) > 0) {
    result.casterGaugeGain = (Number(result.casterGaugeGain) || 0) + berserkerCriticalGauge;
  }

  if (Number(result.damage) > 0 && Number(player.stats.lifesteal || 0) > 0) {
    const raw = Math.max(0, Math.floor(Number(result.damage) * Number(player.stats.lifesteal)));
    const actual = Math.max(0, Math.min(raw, player.maxHp - player.hp));
    const overheal = Math.max(0, raw - actual);
    if (actual > 0) {
      player.hp += actual;
      player.stats.hpoints = player.hp;
      result.playerHP = player.hp;
      result.healing = (Number(result.healing) || 0) + actual;
      await db.query(`UPDATE players SET hpoints=? WHERE id=?`, [player.hp, playerId]);
    }
    await convertBerserkerLifestealOverhealToShield(playerId, overheal);
  }

  await processJudgmentSpellHit(spellEnemy, {
    playerId,
    spellId: Number(spell.id),
    spellName: String(spell.name),
    damage:
      Number(result.damage) ||
      (["dot", "damage_dot"].includes(String(spell.type)) ? 1 : 0),
    crit: Boolean(result.crit),
  });

  const restoredMana = Math.max(
    0,
    Number(result.manaRestored) ||
      Math.floor(
        (player.maxSp * (Number(result.restoreManaPercent) || 0)) / 100,
      ),
  );
  if (restoredMana > 0) {
    player.sp = Math.min(player.maxSp, player.sp + restoredMana);
    player.stats.spoints = player.sp;
    await db.query(`UPDATE players SET spoints = ? WHERE id = ?`, [
      player.sp,
      playerId,
    ]);
  }

  // Toxic Precision refreshes the caster's active Poison Arrow DOT. Resetting
  // ticksApplied restores the complete remaining poison package instead of
  // merely extending an already exhausted effect shell.
  const refreshPoisonDuration = Math.max(
    0,
    Number(result.refreshPoisonDuration) || 0,
  );

  if (refreshPoisonDuration > 0) {
    const poison = session.dots.find(
      (effect) => effect.sourcePlayerId === playerId && effect.spellId === 62,
    );

    if (poison) {
      poison.ticksApplied = 0;
      poison.nextTickAt = Date.now() + poison.tickIntervalMs;
      poison.expiresAt = Date.now() + refreshPoisonDuration * 1000;
      result.log = `${result.log ?? ""} ☠ Poison Arrow is refreshed.`;
    }
  }

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
  if (result.enemyHP !== undefined) {
    const returnedEnemyHP = Math.max(
      0,
      Math.floor(Number(result.enemyHP) || 0),
    );

    if (returnedEnemyHP !== session.enemy.hp) {
      if (spellEnemy.setHP) {
        await spellEnemy.setHP(returnedEnemyHP);
      } else {
        session.enemy.hp = returnedEnemyHP;

        session.enemy.stats.hpoints = returnedEnemyHP;
      }
    }
  }

  /*
   * Ensure local Hunt representation remains
   * valid after the handler runs.
   */
  session.enemy.hp = Math.max(0, Number(session.enemy.hp) || 0);

  session.enemy.stats.hpoints = session.enemy.hp;

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
  const damage = Math.max(0, enemyHPBeforeCast - session.enemy.hp);

  if (damage > 0) {
    const markedHit = await processWarlordMarkedHit(
      spellEnemy as any,
      player.playerId,
      damage,
    );
    result.casterGaugeGain =
      (Number(result.casterGaugeGain) || 0) + markedHit.gaugeGain;
  }

  if (session.enemy.hp <= 0) {
    const livingIds = Array.from(session.players.values())
      .filter((member) => member.hp > 0)
      .map((member) => member.playerId);
    const claim = await processWarlordClaimThePrize(spellEnemy as any, livingIds);
    const bonuses = { ...((result as any).playerGaugeBonuses ?? {}) };
    for (const claimed of claim.players) {
      const member = session.players.get(claimed.playerId);
      if (!member) continue;
      member.hp = claimed.hp;
      member.sp = claimed.sp;
      member.stats.hpoints = claimed.hp;
      member.stats.spoints = claimed.sp;
      bonuses[claimed.playerId] =
        (Number(bonuses[claimed.playerId]) || 0) + claim.gaugeGain;
    }
    (result as any).playerGaugeBonuses = bonuses;
  }

  const crit = Boolean(result.crit);

  const dodged = Boolean(result.dodged);

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
  const refreshHuntPlayer = async (member: HuntCombatPlayer) => {
    const refreshed = await getFinalPlayerStats(member.playerId);

    if (!refreshed) {
      return;
    }

    member.stats = refreshed;

    member.maxHp = Math.max(1, Number(refreshed.maxhp ?? member.maxHp));

    member.maxSp = Math.max(0, Number(refreshed.maxspoints ?? member.maxSp));

    member.hp = Math.max(
      0,
      Math.min(
        member.maxHp,

        Number(refreshed.hpoints ?? member.hp),
      ),
    );

    member.sp = Math.max(
      0,
      Math.min(
        member.maxSp,

        Number(refreshed.spoints ?? member.sp),
      ),
    );
  };

  // =====================================================
  // SYNCHRONIZE FRIENDLY PLAYER STATE
  // =====================================================

  if (targetType === "all_allies") {
    /*
     * Party-wide spells can affect every
     * player simultaneously.
     */
    for (const member of session.players.values()) {
      await refreshHuntPlayer(member);
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
    await refreshHuntPlayer(player);

    /*
     * Refresh an explicitly selected ally.
     */
    if (targetPlayer && targetPlayer.playerId !== player.playerId) {
      await refreshHuntPlayer(targetPlayer);
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
    result.playerHP !== undefined &&
    (targetType === "self" || targetType === "enemy")
  ) {
    player.hp = Math.max(
      0,
      Math.min(
        player.maxHp,

        Number(result.playerHP) || 0,
      ),
    );

    player.stats.hpoints = player.hp;
  }

  const effectiveHealing = Array.from(session.players.values()).reduce(
    (total, member) =>
      total +
      Math.max(
        0,
        member.hp - (playerHPBeforeCast.get(member.playerId) ?? member.hp),
      ),
    0,
  );

  const persistentThreatMultiplier = await getPlayerCombatThreatMultiplier(
    player.playerId,
  );

  const generatedThreat = calculateCombatThreat({
    damage,
    effectiveHealing,
    threatMultiplier:
      Math.max(0, Number(result.threatMultiplier) || 1) *
      persistentThreatMultiplier,
    bonusThreat: result.threatGenerated,
  });

  addCombatThreat(
    session.enemy,
    session.players.values(),
    player.playerId,
    generatedThreat,
  );

  if (Number(result.forceThreatTargetPlayerId) === player.playerId) {
    const highestThreat = Math.max(
      0,
      ...Object.values(session.enemy.threat).map((value) => Number(value) || 0),
    );
    session.enemy.threat[player.playerId] = highestThreat + 1;
    session.enemy.targetPlayerId = player.playerId;
    session.log.push(
      `🌿 ${player.name} forces ${session.enemy.name} to focus on them!`,
    );
  }

  // =====================================================
  // GLOBAL PLAYER STATE
  // =====================================================

  /*
   * Shared spell handlers can change the caster,
   * one selected ally, or the whole party.
   *
   * At this point those Hunt members have already
   * been refreshed from the authoritative stat engine,
   * so publish their vitals to each player's global HUD.
   */
  if (targetType === "all_allies") {
    for (const member of session.players.values()) {
      publishHuntPlayerVitals(member);
    }
  } else {
    publishHuntPlayerVitals(player);

    if (targetPlayer && targetPlayer.playerId !== player.playerId) {
      publishHuntPlayerVitals(targetPlayer);
    }
  }

  // =====================================================
  // COOLDOWN
  // =====================================================

  const cooldownSeconds = Math.max(
    0,
    Number(preparedCast.castState.cooldownSeconds ?? 0),
  );

  const currentCooldownReduction = Math.max(
    0,
    Number(result.reduceCurrentCooldownSeconds) || 0,
  );

  player.cooldowns[cooldownKey] =
    now + Math.max(0, cooldownSeconds - currentCooldownReduction) * 1000;

  if (Number(result.resetSpellCooldown) === Number(spell.id))
    player.cooldowns[cooldownKey] = now;

  const resetSpellIds = Array.isArray(result.resetSpellIds)
    ? result.resetSpellIds.map(Number).filter(Number.isFinite)
    : [];
  for (const resetSpellId of resetSpellIds) {
    player.cooldowns[`spell:${resetSpellId}`] = now;
  }

  // Relentless Pace reduces only other spell cooldowns. The newly assigned
  // Quick Shot cooldown and all item cooldowns remain unchanged.
  const reduceOtherCooldownsSeconds = Math.max(
    0,
    Number(result.reduceOtherCooldownsSeconds) || 0,
  );

  if (reduceOtherCooldownsSeconds > 0) {
    reduceCombatSpellCooldowns(player, reduceOtherCooldownsSeconds, [Number(spell.id)], now);
  }

  const reducePartyCooldownsSeconds = Math.max(
    0,
    Number((result as any).reducePartyCooldownsSeconds) || 0,
  );

  if (reducePartyCooldownsSeconds > 0) {
    for (const member of session.players.values()) {
      reduceCombatSpellCooldowns(member, reducePartyCooldownsSeconds, [18], now);
    }
  }

  // =====================================================
  // CONSUME PLAYER ATB
  // =====================================================

  player.gauge = 0;

  player.ready = false;

  player.recoveryUntil = now + HUNT_SPELL_RECOVERY_MS;

  if (Number.isFinite(Number(result.setGaugeTo))) {
    player.gauge = Math.max(0, Math.min(100, Number(result.setGaugeTo)));
    player.ready = player.gauge >= 100;
  }

  // Party-wide ATB advances are applied after consuming
  // the caster's action so the caster also ends at the
  // configured post-cast gauge instead of being reset to 0.
  const partyGaugeGain = Math.max(0, Number(result.partyGaugeGain) || 0);

  const casterGaugeGain = Math.max(0, Number(result.casterGaugeGain) || 0);
  const targetGaugeGain = Math.max(0, Number(result.targetGaugeGain) || 0);
  const targetGaugePlayerId = Number(result.targetGaugePlayerId);
  const enemyGaugeReduction = Math.max(
    0,
    Number(result.enemyGaugeReduction) || 0,
  );

  if (partyGaugeGain > 0) {
    for (const member of session.players.values()) {
      if (member.hp <= 0) {
        continue;
      }

      member.gauge = Math.min(100, member.gauge + partyGaugeGain);

      member.ready = member.gauge >= 100;
    }
  }

  if (casterGaugeGain > 0 && player.hp > 0) {
    player.gauge = Math.min(100, player.gauge + casterGaugeGain);
    player.ready = player.gauge >= 100;
  }
  if (targetGaugeGain > 0 && Number.isFinite(targetGaugePlayerId)) {
    for (const member of session.players.values()) {
      if (Number(member.playerId) === targetGaugePlayerId && member.hp > 0) {
        member.gauge = Math.min(100, member.gauge + targetGaugeGain);
        member.ready = member.gauge >= 100;
        break;
      }
    }
  }

  if (enemyGaugeReduction > 0) {
    session.enemy.gauge = Math.max(
      0,
      session.enemy.gauge - enemyGaugeReduction,
    );
    session.enemy.ready = session.enemy.gauge >= 100;
  }

  const playerGaugeBonuses = (result as any).playerGaugeBonuses ?? {};
  const playerGaugeOverrides = (result as any).playerGaugeOverrides ?? {};

  for (const member of session.players.values()) {
    const bonus = Math.max(0, Number(playerGaugeBonuses[member.playerId]) || 0);
    if (bonus > 0 && member.hp > 0) {
      member.gauge = Math.min(100, member.gauge + bonus);
      member.ready = member.gauge >= 100;
    }

    if (Number.isFinite(Number(playerGaugeOverrides[member.playerId])) && member.hp > 0) {
      member.gauge = Math.max(0, Math.min(100, Number(playerGaugeOverrides[member.playerId])));
      member.ready = member.gauge >= 100;
    }
  }

  if (damage > 0) {
    await db.query(
      `DELETE FROM player_buffs WHERE player_id=? AND source LIKE 'knight-answer:%'`,
      [player.playerId]
    );
  }

  // =====================================================
  // COMBAT LOG
  // =====================================================

  if (result.log) {
    session.log.push(result.log);
  } else {
    session.log.push(`✨ ${player.name} casts ${spellName}.`);
  }

  // =====================================================
  // DIRECT DAMAGE EVENT
  // =====================================================

  if (damage > 0) {
    session.damageEvents.push({
      id: session.nextDamageEventId++,

      type: "damage",

      source: "player",

      playerId: player.playerId,

      target: "enemy",

      amount: damage,

      crit,

      spellId: Number(spell.id),

      spellName,

      kind: "spell",

      createdAt: now,
    });

    if (session.damageEvents.length > 40) {
      session.damageEvents = session.damageEvents.slice(-40);
    }
  }

  // =====================================================
  // TRIM COMBAT LOG
  // =====================================================

  if (session.log.length > 60) {
    session.log = session.log.slice(-60);
  }

  // =====================================================
  // VICTORY
  // =====================================================

  if (result.killedEnemy || session.enemy.hp <= 0) {
    await completeHuntVictory(session);
  }

  // =====================================================
  // FINALIZE
  // =====================================================

  session.updatedAt = Date.now();

  return {
    ok: true,

    spellId: Number(spell.id),

    spellName,

    damage,

    crit,

    dodged,

    snapshot: buildHuntCombatSnapshot(session),
  };
}

export async function castHuntSpell(
  session: HuntCombatSession,
  playerId: number,
  spellId: number,
  targetPlayerId: number | null = null,
): Promise<HuntSpellCastResult> {
  return withHuntCombatLock(session.encounterId, () =>
    castHuntSpellUnlocked(session, playerId, spellId, targetPlayerId),
  );
}

async function advanceHuntCombatSessionUnlocked(session: HuntCombatSession) {
  if (session.state !== "active") {
    return session;
  }

  if (session.enemy.hp <= 0) {
    await completeHuntVictory(session);
    return session;
  }

  const now = Date.now();

  /*
   * Process persistent player healing-over-time effects before
   * advancing combat actions. The HoT service updates authoritative
   * player HP; synchronize those results into the Hunt session.
   */
  const hotTicks = await processDuePlayerHots(
    Array.from(session.players.keys()),
  );

  for (const tick of hotTicks) {
    const member = session.players.get(tick.playerId);

    if (!member) {
      continue;
    }

    member.maxHp = Math.max(1, Number(tick.maxHP) || member.maxHp);

    member.hp = Math.max(0, Math.min(member.maxHp, Number(tick.newHP) || 0));

    member.stats.hpoints = member.hp;

    const gaugeGain = Math.max(0, Number(tick.gaugeGain) || 0);

    if (member.hp > 0 && gaugeGain > 0) {
      member.gauge = Math.min(100, member.gauge + gaugeGain);

      member.ready = member.gauge >= 100;
    }

    if (tick.healing > 0) {
      session.log.push(
        `✨ ${tick.displayName} restores ${tick.healing} HP to ${member.name}!`,
      );
    }

    if (tick.refreshed) {
      session.log.push(
        `🌟 ${tick.displayName} renews itself on ${member.name}!`,
      );
    }

    const casterEcho = tick.casterEchoPlayerId
      ? session.players.get(tick.casterEchoPlayerId)
      : null;
    if (casterEcho && tick.casterEchoHealing > 0) {
      casterEcho.hp = Math.min(
        casterEcho.maxHp,
        casterEcho.hp + tick.casterEchoHealing,
      );
      casterEcho.stats.hpoints = casterEcho.hp;
      publishHuntPlayerVitals(casterEcho);
      session.log.push(
        `🌱 Symbiotic Growth restores ${tick.casterEchoHealing} HP to ${casterEcho.name}!`,
      );
    }

    const partyEchoHealing = Math.max(0, Number(tick.partyEchoHealing) || 0);
    if (partyEchoHealing > 0) {
      for (const ally of session.players.values()) {
        if (ally.playerId === tick.playerId || ally.hp <= 0) continue;
        const before = ally.hp;
        ally.hp = Math.min(ally.maxHp, ally.hp + partyEchoHealing);
        ally.stats.hpoints = ally.hp;
        const actualEcho = Math.max(0, ally.hp - before);
        if (actualEcho > 0) {
          await db.query(`UPDATE players SET hpoints=? WHERE id=?`, [
            ally.hp,
            ally.playerId,
          ]);
          publishHuntPlayerVitals(ally);
          session.log.push(
            `🌲 Awakening Grove restores ${actualEcho} HP to ${ally.name}!`,
          );
        }
      }
    }

    publishHuntPlayerVitals(member);
  }

  for (const member of session.players.values()) {
    const bannerGauge = await processWarlordBannerGaugeTick(member.playerId);
    if (bannerGauge > 0 && member.hp > 0) {
      member.gauge = Math.min(100, member.gauge + bannerGauge);
      member.ready = member.gauge >= 100;
    }
  }

  /*
   * Expire timed debuffs before calculating
   * this advancement's combat stats.
   */
  removeExpiredHuntDebuffs(session, now);

  /*
   * Action gauges.
   */
  advancePlayerATBs(session, now);

  advanceEnemyATB(session, now);

  /*
   * Damage-over-time effects.
   */
  await processHuntDots(session, now);

  if (session.state !== "active") {
    session.updatedAt = now;

    return session;
  }

  /*
   * Automatic party weapon attacks.
   */
  await processPlayerAutoAttacks(session);

  if (session.state !== "active") {
    session.updatedAt = now;

    return session;
  }

  /*
   * Hunt target action.
   */
  await processEnemyAttack(session);

  session.updatedAt = now;

  return session;
}

export async function advanceHuntCombatSession(session: HuntCombatSession) {
  return withHuntCombatLock(session.encounterId, () =>
    advanceHuntCombatSessionUnlocked(session),
  );
}

export function buildHuntCombatSnapshot(session: HuntCombatSession) {
  const now = Date.now();

  return {
    encounterId: session.encounterId,

    partyHuntId: session.partyHuntId,

    partyId: session.partyId,

    state: session.state,

    enemy: {
      name: session.enemy.name,

      level: session.enemy.level,

      description: session.enemy.description,

      image: session.enemy.image,

      hp: session.enemy.hp,

      maxHp: session.enemy.maxHp,

      gauge: session.enemy.gauge,

      ready: session.enemy.ready,

      recoveryMs: Math.max(0, session.enemy.recoveryUntil - now),

      readyInMs: getHuntEnemyReadyInMs(session, now),

      targetPlayerId: session.enemy.targetPlayerId,
    },

    players: Array.from(session.players.values()).map((player) => ({
      playerId: player.playerId,

      name: player.name,

      hp: player.hp,

      maxHp: player.maxHp,

      sp: player.sp,

      maxSp: player.maxSp,

      gauge: player.gauge,

      ready: player.ready,

      recoveryMs: Math.max(0, player.recoveryUntil - now),

      readyInMs: getHuntPlayerReadyInMs(player, now),

      autoAttackMs: Math.max(0, player.nextAutoAttackAt - now),

      autoAttackTotalMs: PLAYER_AUTO_ATTACK_MS,

      cooldowns: player.cooldowns,

      threat: getCombatThreat(session.enemy, player.playerId),
    })),

    log: session.log,

    damageEvents: session.damageEvents,

    effects: {
      dots: session.dots.map((dot) => ({
        id: dot.id,

        sourcePlayerId: dot.sourcePlayerId,

        spellId: dot.spellId,

        spellName: dot.spellName,

        ticksApplied: dot.ticksApplied,

        totalTicks: dot.totalTicks,

        nextTickMs: getEffectRemainingMs(dot.nextTickAt, now),

        remainingMs: getEffectRemainingMs(dot.expiresAt, now),
      })),

      debuffs: session.debuffs
        .filter((debuff) => debuff.expiresAt > now)
        .map((debuff) => ({
          id: debuff.id,

          sourcePlayerId: debuff.sourcePlayerId,

          spellId: debuff.spellId,

          spellName: debuff.spellName,

          stat: debuff.stat,

          value: debuff.value,

          remainingMs: getEffectRemainingMs(debuff.expiresAt, now),
        })),
    },

    rewards: session.rewards,
  };
}

function advanceEnemyATB(session: HuntCombatSession, now: number) {
  const enemy = session.enemy;

  if (session.state !== "active") {
    return;
  }

  if (enemy.hp <= 0) {
    return;
  }

  if (enemy.ready) {
    return;
  }

  const effectiveStats = getEffectiveHuntEnemyStats(session, now);
  const atbRateMult = getHuntEnemyAtbRateMult(session, now);
  const timingActor = { ...enemy, stats: effectiveStats, atbRateMult };
  advanceCombatActorGauge(timingActor, session.updatedAt, now);
  enemy.gauge = timingActor.gauge;
  enemy.ready = timingActor.ready;
}

function getLivingHuntPlayers(session: HuntCombatSession) {
  return Array.from(session.players.values()).filter((player) => player.hp > 0);
}

async function completeHuntCombatDefeat(session: HuntCombatSession) {
  if (session.state !== "active") {
    return;
  }

  session.state = "defeat";

  await db.query(
    `
      UPDATE hunt_encounters

      SET
        status = 'defeat',
        completed_at = NOW()

      WHERE id = ?
    `,
    [session.encounterId],
  );

  session.log.push(`☠ Your party has been defeated by ${session.enemy.name}.`);

  if (session.log.length > 60) {
    session.log = session.log.slice(-60);
  }
}

async function processEnemyAttack(session: HuntCombatSession) {
  if (session.state !== "active") {
    return;
  }

  const enemy = session.enemy;

  if (enemy.hp <= 0 || !enemy.ready) {
    return;
  }

  const livingPlayers = getLivingHuntPlayers(session);

  if (livingPlayers.length === 0) {
    await completeHuntCombatDefeat(session);

    return;
  }

  const target = getHighestThreatTarget(
    session.enemy,
    session.players.values(),
  );

  if (!target) {
    await completeHuntCombatDefeat(session);
    return;
  }

  enemy.targetPlayerId = target.playerId;

  /*
   * Apply active Hunt debuffs before
   * resolving the boss attack.
   */
  const effectiveEnemyStats = getEffectiveHuntEnemyStats(session);

  const result = resolveAttack(effectiveEnemyStats as any, target.stats as any);

  /*
   * Damage after normal combat-engine
   * defense/dodge calculations, but before
   * shields and defensive statuses.
   */
  const incomingDamage = result.dodged
    ? 0
    : Math.max(0, Math.floor(Number(result.damage ?? 0)));

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
    !result.dodged && incomingDamage > 0
      ? await mitigateIncomingPlayerDamage(
          target.playerId,
          target.hp,
          incomingDamage,
          target.maxHp,
        )
      : null;

  const damage = mitigation ? mitigation.finalDamage : incomingDamage;

  /*
   * Consume enemy turn regardless
   * of hit/miss/absorption.
   */
  enemy.gauge = 0;
  enemy.ready = false;

  enemy.recoveryUntil = Date.now() + HUNT_ENEMY_RECOVERY_MS;

  // =====================================================
  // MISS
  // =====================================================

  if (result.dodged) {
    session.log.push(`🛡 ${target.name} evades ${enemy.name}'s attack!`);
  } else {
    // =====================================================
    // APPLY FINAL HP DAMAGE
    // =====================================================

    target.hp = Math.max(
      0,
      Math.min(
        target.maxHp,
        target.hp -
          damage +
          (mitigation?.aegisHealing ?? 0) +
          (mitigation?.shieldBreakHealing ?? 0) +
          (mitigation?.thornsHealing ?? 0),
      ),
    );

    target.stats.hpoints = target.hp;

    if ((mitigation?.sageTriggerGaugeGain ?? 0) > 0) {
      target.gauge = Math.min(100, target.gauge + mitigation!.sageTriggerGaugeGain);
      target.ready = target.gauge >= 100;
      session.log.push(
        `🌳 Undying Grove restores ${mitigation!.sageReviveHealing} HP to ${target.name} and grants ${mitigation!.sageTriggerGaugeGain} action gauge!`,
      );
    }

    if (
      (mitigation?.redirectedDamage ?? 0) > 0 &&
      mitigation?.redirectPlayerId
    ) {
      const redirectTarget = session.players.get(mitigation.redirectPlayerId);
      if (redirectTarget && redirectTarget.hp > 0) {
        const redirectedMitigation = await mitigateIncomingPlayerDamage(
          redirectTarget.playerId,
          redirectTarget.hp,
          mitigation.redirectedDamage,
          redirectTarget.maxHp,
        );
        redirectTarget.hp = Math.max(
          0,
          Math.min(
            redirectTarget.maxHp,
            redirectTarget.hp -
              redirectedMitigation.finalDamage +
              (redirectedMitigation.aegisHealing ?? 0) +
              (redirectedMitigation.shieldBreakHealing ?? 0) +
              (redirectedMitigation.thornsHealing ?? 0),
          ),
        );
        redirectTarget.stats.hpoints = redirectTarget.hp;
        await db.query(`UPDATE players SET hpoints=? WHERE id=?`, [
          redirectTarget.hp,
          redirectTarget.playerId,
        ]);
        if (mitigation.spatialGaugeGain > 0) {
          target.gauge = Math.min(
            100,
            target.gauge + mitigation.spatialGaugeGain,
          );
          redirectTarget.gauge = Math.min(
            100,
            redirectTarget.gauge + mitigation.spatialGaugeGain,
          );
        }
        session.log.push(
          mitigation.sentinelInterceptTriggered
            ? `🌲 Ancient Protector intercepts ${mitigation.redirectedDamage} damage from ${target.name}!`
            : `🌀 Spatial Exchange redirects ${mitigation.redirectedDamage} damage from ${target.name} to ${redirectTarget.name}!`,
        );

        const redirectedThorns = redirectedMitigation.thornsDamage ?? 0;
        if (redirectedThorns > 0) {
          const reflected = Math.min(enemy.hp, redirectedThorns);
          enemy.hp = Math.max(0, enemy.hp - reflected);
          enemy.stats.hpoints = enemy.hp;
          await db.query(`UPDATE hunt_encounters SET hp = ? WHERE id = ?`, [
            enemy.hp,
            session.encounterId,
          ]);
          session.log.push(
            redirectedMitigation.knightThornsTriggered
              ? `🛡️ ${redirectTarget.name}'s defenses retaliate against ${enemy.name} for ${reflected} damage!`
              : `🌿 Ironbark retaliates against ${enemy.name} for ${reflected} damage!`,
          );
        }
        if ((redirectedMitigation.thornsHealing ?? 0) > 0) {
          session.log.push(
            `🌱 Living Bark restores ${redirectedMitigation.thornsHealing} HP to ${redirectTarget.name}!`,
          );
        }
        const redirectedPartyHeal =
          redirectedMitigation.shieldBreakPartyHealPercent ?? 0;
        if (redirectedPartyHeal > 0) {
          for (const ally of session.players.values()) {
            if (ally.hp <= 0) continue;
            const amount = Math.max(
              1,
              Math.floor((ally.maxHp * redirectedPartyHeal) / 100),
            );
            ally.hp = Math.min(ally.maxHp, ally.hp + amount);
            ally.stats.hpoints = ally.hp;
            await db.query(`UPDATE players SET hpoints=? WHERE id=?`, [
              ally.hp,
              ally.playerId,
            ]);
            publishHuntPlayerVitals(ally);
          }
          session.log.push(`🌸 Blooming Aegis restores the party!`);
        }
        if (redirectedMitigation.shieldReformed)
          session.log.push(
            redirectedMitigation.knightShieldReformed
              ? `🛡️ Layered Plating reforms Bulwark on ${redirectTarget.name}!`
              : `🌿 Layered Canopy reforms Nature's Aegis on ${redirectTarget.name}!`,
          );
        if (redirectedMitigation.knightSecondWindTriggered)
          session.log.push(
            `🛡️ Second Wind restores ${redirectedMitigation.aegisHealing} HP to ${redirectTarget.name}!`,
          );
        if (redirectedMitigation.shieldBreakReductionApplied)
          session.log.push(
            `🌳 Barkskin Aftermath protects ${redirectTarget.name}!`,
          );
        if (redirectedMitigation.shieldBreakHotApplied)
          session.log.push(
            `🌱 Seeds of Renewal begins healing ${redirectTarget.name}!`,
          );
      }
    }

    const voidFeedbackDamage = mitigation?.voidFeedbackDamage ?? 0;

    if (voidFeedbackDamage > 0) {
      const reflected = Math.min(enemy.hp, voidFeedbackDamage);

      enemy.hp = Math.max(0, enemy.hp - reflected);

      enemy.stats.hpoints = enemy.hp;

      await db.query(
        `
      UPDATE hunt_encounters
      SET hp = ?
      WHERE id = ?
    `,
        [enemy.hp, session.encounterId],
      );

      session.log.push(
        `🌌 Void Feedback strikes ${enemy.name} for ${reflected} damage!`,
      );
    }

    const thornsDamage = mitigation?.thornsDamage ?? 0;
    if (thornsDamage > 0) {
      const reflected = Math.min(enemy.hp, thornsDamage);
      enemy.hp = Math.max(0, enemy.hp - reflected);
      enemy.stats.hpoints = enemy.hp;
      await db.query(`UPDATE hunt_encounters SET hp = ? WHERE id = ?`, [
        enemy.hp,
        session.encounterId,
      ]);
      session.log.push(
        mitigation?.knightThornsTriggered
          ? `🛡️ ${target.name}'s defenses retaliate against ${enemy.name} for ${reflected} damage!`
          : `🌿 Ironbark retaliates against ${enemy.name} for ${reflected} damage!`,
      );
    }

    if ((mitigation?.shieldBreakHealing ?? 0) > 0) {
      session.log.push(
        `🌱 Nature's Aegis blooms, restoring ${mitigation!.shieldBreakHealing} HP to ${target.name}!`,
      );
    }

    if ((mitigation?.thornsHealing ?? 0) > 0) {
      session.log.push(
        `🌱 Living Bark restores ${mitigation!.thornsHealing} HP to ${target.name}!`,
      );
    }

    const partyBreakHealPercent = mitigation?.shieldBreakPartyHealPercent ?? 0;
    if (partyBreakHealPercent > 0) {
      for (const ally of session.players.values()) {
        if (ally.hp <= 0) continue;
        const amount = Math.max(
          1,
          Math.floor((ally.maxHp * partyBreakHealPercent) / 100),
        );
        const before = ally.hp;
        ally.hp = Math.min(ally.maxHp, ally.hp + amount);
        ally.stats.hpoints = ally.hp;
        if (ally.hp > before) {
          await db.query(`UPDATE players SET hpoints=? WHERE id=?`, [
            ally.hp,
            ally.playerId,
          ]);
          publishHuntPlayerVitals(ally);
        }
      }
      session.log.push(`🌸 Blooming Aegis restores the party!`);
    }

    if (mitigation?.shieldReformed)
      session.log.push(
        mitigation.knightShieldReformed
          ? `🛡️ Layered Plating reforms Bulwark on ${target.name}!`
          : `🌿 Layered Canopy reforms Nature's Aegis on ${target.name}!`,
      );
    if (mitigation?.knightSecondWindTriggered)
      session.log.push(
        `🛡️ Second Wind restores ${mitigation.aegisHealing} HP to ${target.name}!`,
      );
    if (mitigation?.berserkerRefuseToFallTriggered)
      session.log.push(`🩸 Refuse to Fall saves ${target.name}, but Blood Rage ends!`);
    if (mitigation?.shieldBreakReductionApplied)
      session.log.push(`🌳 Barkskin Aftermath protects ${target.name}!`);
    if (mitigation?.shieldBreakHotApplied)
      session.log.push(`🌱 Seeds of Renewal begins healing ${target.name}!`);

    if (mitigation?.sentinelDeathProtectionTriggered) {
      session.log.push(
        `🌲 Ancient Protector prevents a lethal blow against ${target.name}!`,
      );
    }

    await db.query(
      `
        UPDATE players

        SET hpoints = ?

        WHERE id = ?
      `,
      [target.hp, target.playerId],
    );

    /*
     * Keep this player's global HUD synchronized
     * even though the Hunt boss action happened
     * inside the server-owned encounter loop.
     */
    publishHuntPlayerVitals(target);

    // =====================================================
    // MAIN ATTACK LOG
    // =====================================================

    if (damage > 0) {
      session.log.push(
        `☠ ${enemy.name} attacks ${target.name} for ${damage} damage${
          result.crit ? " (CRITICAL!)" : ""
        }`,
      );
    } else if (mitigation?.absorbedDamage) {
      session.log.push(
        `☠ ${enemy.name} attacks ${target.name}, but the blow is absorbed!`,
      );
    } else {
      session.log.push(
        `☠ ${enemy.name} attacks ${target.name}, but deals no damage.`,
      );
    }

    // =====================================================
    // DEFENSIVE EFFECT LOGS
    // =====================================================

    if (mitigation?.absorbedDamage) {
      session.log.push(
        `🛡 ${target.name}'s shield absorbs ${mitigation.absorbedDamage} damage.`,
      );
    }

    if (mitigation?.shieldBroken) {
      session.log.push(`💥 ${target.name}'s shield shatters!`);
    }

    if (mitigation?.interceptTriggered) {
      session.log.push(
        `🛡 Intercept reduces the attack against ${target.name} by ${mitigation.interceptReductionPercent}%!`,
      );
    }

    if (mitigation?.aegisTriggered) {
      session.log.push(
        `✨ Aegis of Faith reduces the attack against ${target.name} by ${mitigation.aegisReductionPercent}%!`,
      );
    }

    if (mitigation?.aegisPreventedDeath) {
      session.log.push(
        `🕊 Aegis of Faith prevents a lethal blow against ${target.name}!`,
      );
    }

    // =====================================================
    // DAMAGE EVENT
    // =====================================================

    /*
     * Only actual HP loss should create
     * floating damage.
     */
    if (damage > 0) {
      session.damageEvents.push({
        id: session.nextDamageEventId++,

        type: "damage",

        source: "enemy",

        target: "player",

        playerId: target.playerId,

        amount: damage,

        crit: Boolean(result.crit),

        kind: "attack",

        createdAt: Date.now(),
      });

      if (session.damageEvents.length > 40) {
        session.damageEvents = session.damageEvents.slice(-40);
      }
    }

    // =====================================================
    // PLAYER DEFEATED
    // =====================================================

    if (target.hp <= 0) {
      target.hp = 0;

      target.gauge = 0;
      target.ready = false;

      session.log.push(`💀 ${target.name} has fallen!`);

      enemy.targetPlayerId =
        refreshCombatThreatTarget(enemy, session.players.values())?.playerId ??
        null;
    }
  }

  if (session.log.length > 60) {
    session.log = session.log.slice(-60);
  }

  /*
   * Last living party member defeated?
   */
  const survivors = getLivingHuntPlayers(session);

  if (survivors.length === 0) {
    await completeHuntCombatDefeat(session);
  }
}

export function findHuntCombatSessionForPlayer(
  playerId: number,
): HuntCombatSession | null {
  const pid = Number(playerId);

  for (const session of huntCombatSessions.values()) {
    if (session.players.has(pid)) {
      return session;
    }
  }

  return null;
}

function rollHuntItemRewards(rows: any[]): HuntCombatRewardItem[] {
  const rewards: HuntCombatRewardItem[] = [];

  for (const row of rows || []) {
    const dropChance = Math.max(0, Math.min(100, Number(row.drop_chance ?? 0)));

    const roll = Math.random() * 100;

    if (roll >= dropChance) {
      continue;
    }

    const minQty = Math.max(1, Math.floor(Number(row.min_qty ?? 1)));

    const maxQty = Math.max(minQty, Math.floor(Number(row.max_qty ?? minQty)));

    const quantity = minQty + Math.floor(Math.random() * (maxQty - minQty + 1));

    rewards.push({
      itemId: Number(row.item_id),

      name: String(row.name || "Unknown Item"),

      quantity,
    });
  }

  return rewards;
}

async function completeHuntVictory(session: HuntCombatSession) {
  if (session.state === "victory") {
    return;
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [[encounter]]: any = await connection.query(
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
      [session.encounterId],
    );

    if (!encounter) {
      throw new Error("Hunt encounter not found.");
    }

    const [[hunt]]: any = await connection.query(
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
      [session.encounterId, session.partyHuntId],
    );

    if (!hunt) {
      throw new Error("Active Hunt not found.");
    }

    const [participants]: any = await connection.query(
      `
          SELECT
            hp.player_id

          FROM hunt_participants hp

          WHERE hp.party_hunt_id = ?
        `,
      [session.partyHuntId],
    );

    const expReward = Math.max(0, Number(hunt.exp_reward ?? 0));

    const goldReward = Math.max(0, Number(hunt.gold_reward ?? 0));

    /*
     * Load the Hunt's personal item
     * reward pool.
     */
    const [huntRewardRows]: any = await connection.query(
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
      [Number(hunt.hunt_id)],
    );

    const pendingRewards: HuntCombatReward[] = [];

    for (const participant of participants) {
      const playerId = Number(participant.player_id);

      /*
       * EXPERIENCE / LEVEL PROGRESSION
       */
      const experienceResult = await grantExperienceTx(
        connection,
        playerId,
        expReward,
      );

      /*
       * GOLD
       */
      if (goldReward > 0) {
        await connection.query(
          `
            UPDATE players

            SET gold = gold + ?

            WHERE id = ?
          `,
          [goldReward, playerId],
        );
      }

      /*
       * PERSONAL HUNT MATERIAL ROLLS
       */
      const materialRewards = rollHuntItemRewards(huntRewardRows);

      /*
       * PERSONAL EQUIPMENT ROLL
       *
       * Each eligible player rolls
       * independently.
       */
      const generatedEquipment = await generateLootForCreature(
        {
          id: Number(encounter.creature_id),

          name: session.enemy.name,

          level: session.enemy.level,

          rarity: "boss",
        },

        {
          id: playerId,

          level: session.enemy.level,
        },

        1,

        {
          sourceType: "hunt",

          /*
           * Use hunt_id instead of
           * party_hunt_id because the
           * active party Hunt is deleted
           * during victory cleanup.
           */
          sourceId: Number(hunt.hunt_id),

          conn: connection,
        },
      );

      /*
       * BUILD CHEST DROPS
       */
      const chestDrops: DropLine[] = [];

      /*
       * Static crafting materials.
       */
      for (const material of materialRewards) {
        chestDrops.push({
          item_id: material.itemId,

          qty: material.quantity,
        });
      }

      /*
       * Generated equipment.
       *
       * The player_items records were
       * created above, but remain unclaimed
       * until the chest is claimed.
       */
      for (const equipment of generatedEquipment) {
        chestDrops.push({
          player_item_id: equipment.playerItemId,

          qty: 1,

          roll_json: equipment.affixes,
        });
      }

      /*
       * CREATE PERSONAL HUNT CHEST
       */
      const chest = await createChestFromDrops({
        playerId,

        sourceType: "hunt",

        sourceId: Number(hunt.hunt_id),

        drops: chestDrops,

        conn: connection,
      });

      /*
       * FINAL CLIENT-FACING REWARD DATA
       */
      const rewardItems: HuntCombatRewardItem[] = [
        ...materialRewards.map((item) => ({
          itemId: item.itemId,

          playerItemId: null,

          name: item.name,

          quantity: item.quantity,

          rarity: null,

          isEquipment: false,
        })),

        ...generatedEquipment.map((item) => ({
          itemId: null,

          playerItemId: item.playerItemId,

          name: item.name,

          quantity: 1,

          rarity: item.rarity,

          isEquipment: true,
        })),
      ];

      pendingRewards.push({
        playerId,

        exp: experienceResult.expGained,

        gold: goldReward,

        items: rewardItems,

        chestId: chest?.chestId ?? null,

        levelUp: experienceResult.levelUp ?? null,
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
      [session.partyHuntId],
    );

    /*
     * Remove combat participants.
     */
    await connection.query(
      `
        DELETE FROM hunt_encounter_players

        WHERE hunt_encounter_id = ?
      `,
      [session.encounterId],
    );

    /*
     * Remove combat encounter.
     */
    await connection.query(
      `
        DELETE FROM hunt_encounters

        WHERE id = ?
      `,
      [session.encounterId],
    );

    /*
     * Remove Hunt participants.
     */
    await connection.query(
      `
        DELETE FROM hunt_participants

        WHERE party_hunt_id = ?
      `,
      [session.partyHuntId],
    );

    /*
     * Remove ready-check player records
     * before deleting their parent checks.
     */
    await connection.query(
      `
        DELETE hrcp

        FROM hunt_ready_check_players hrcp

        JOIN hunt_ready_checks hrc
          ON hrc.id =
            hrcp.ready_check_id

        WHERE hrc.party_hunt_id = ?
      `,
      [session.partyHuntId],
    );

    /*
     * Remove ready checks before deleting
     * the party Hunt they reference.
     */
    await connection.query(
      `
        DELETE FROM hunt_ready_checks

        WHERE party_hunt_id = ?
      `,
      [session.partyHuntId],
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
      [session.partyHuntId],
    );

    await connection.commit();

    /*
     * Database completion succeeded.
     * Preserve a short-lived victory
     * snapshot for all combat clients.
     */
    session.rewards = pendingRewards;

    /*
     * Rewards were just committed transactionally.
     *
     * Reconcile every eligible player's global HUD so
     * EXP, gold, level, stat points, skill points and
     * any level-up HP/SP changes appear immediately.
     */
    for (const reward of pendingRewards) {
      publishPlayerStatePatch(reward.playerId, {
        refreshDerivedStats: true,
      });

      if (reward.levelUp) {
        publishPlayerLevelUp(reward.playerId, reward.levelUp);
      }
    }

    session.enemy.hp = 0;
    session.enemy.stats.hpoints = 0;

    session.enemy.gauge = 0;
    session.enemy.ready = false;

    session.state = "victory";

    session.updatedAt = Date.now();

    session.log.push(`🏆 ${session.enemy.name} has been defeated!`);

    session.log.push("🎖 The Hunt is complete!");

    session.log.push(
      `✨ Each eligible adventurer receives ${expReward} EXP and ${goldReward} gold.`,
    );

    if (session.log.length > 60) {
      session.log = session.log.slice(-60);
    }

    /*
     * Keep the final snapshot alive long
     * enough for every party client to
     * receive the victory response.
     */
    scheduleHuntSessionCleanup(session.encounterId);
  } catch (err) {
    await connection.rollback();

    console.error("Hunt victory completion failed:", err);

    throw err;
  } finally {
    connection.release();
  }
}
