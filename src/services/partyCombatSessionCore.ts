// src/services/partyCombatSessionCore.ts
import type { DerivedStats } from "./statEngine";
import type {
  PartyCombatPlayer,
  PartyCombatEnemy,
  PartyCombatDebuffEffect,
} from "./partyCombatRuntime";

import {
  advanceCombatActorGauge,
  applyEnemyDebuffs,
  getCombatActorReadyInMs,
  getEnemyAtbRateMultiplier,
} from "./combat";

export type PartyCombatSessionState =
  | "active"
  | "victory"
  | "defeat";

export type PartyCombatSessionBase = {
  createdAt: number;
  updatedAt: number;

  state: PartyCombatSessionState;

  players: Map<number, PartyCombatPlayer>;
  enemy: PartyCombatEnemy;

  debuffs: PartyCombatDebuffEffect[];
};

export function removeExpiredPartyCombatDebuffs(
  session: Pick<PartyCombatSessionBase, "debuffs">,
  now: number = Date.now(),
) {
  session.debuffs =
    session.debuffs.filter(
      debuff =>
        debuff.expiresAt > now
    );
}

export function getPartyCombatDebuffTotals(
  session: Pick<PartyCombatSessionBase, "debuffs">,
  now: number = Date.now(),
) {
  removeExpiredPartyCombatDebuffs(
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
    damage_taken_pct: 0,
    spell_damage_taken_pct: 0,
    crit_chance_taken_pct: 0,
    critical_damage_taken_pct: 0,
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
          debuff.value ||
          0
        );
    }
  }

  return totals;
}

export function getEffectivePartyCombatEnemyStats(
  session: Pick<
    PartyCombatSessionBase,
    "enemy" | "debuffs"
  >,
  now: number = Date.now(),
): DerivedStats {
  const base =
    session.enemy.stats;

  const debuffs =
    getPartyCombatDebuffTotals(
      session,
      now
    );

  return {
    ...applyEnemyDebuffs(
      base,
      debuffs
    ),

    hpoints:
      session.enemy.hp,

    maxhp:
      session.enemy.maxHp,
  } as DerivedStats;
}

export function getPartyCombatEnemyAtbRateMult(
  session: Pick<
    PartyCombatSessionBase,
    "enemy" | "debuffs"
  >,
  now: number = Date.now(),
) {
  const debuffs =
    getPartyCombatDebuffTotals(
      session,
      now
    );

  return getEnemyAtbRateMultiplier(
    debuffs
  );
}

export function getPartyCombatPlayerReadyInMs(
  player: PartyCombatPlayer,
  now: number = Date.now(),
) {
  return getCombatActorReadyInMs(
    player,
    now
  );
}

export function getPartyCombatEnemyReadyInMs(
  session: Pick<
    PartyCombatSessionBase,
    "enemy" | "debuffs"
  >,
  now: number = Date.now(),
) {
  const effectiveStats =
    getEffectivePartyCombatEnemyStats(
      session,
      now
    );

  const atbRateMult =
    getPartyCombatEnemyAtbRateMult(
      session,
      now
    );

  return getCombatActorReadyInMs(
    {
      ...session.enemy,
      stats:
        effectiveStats,
      atbRateMult,
    },
    now,
  );
}

export function advancePartyCombatPlayerATBs(
  session: Pick<
    PartyCombatSessionBase,
    "players" | "updatedAt"
  >,
  now: number,
) {
  for (
    const player of
    session.players.values()
  ) {
    advanceCombatActorGauge(
      player,
      session.updatedAt,
      now
    );
  }
}

export function advancePartyCombatEnemyATB(
  session: Pick<
    PartyCombatSessionBase,
    "enemy" | "debuffs" | "updatedAt" | "state"
  >,
  now: number,
  options: {
    pause?: boolean;
  } = {},
) {
  const enemy =
    session.enemy;

  if (
    session.state !==
      "active" ||
    enemy.hp <= 0 ||
    enemy.ready ||
    options.pause
  ) {
    return;
  }

  const effectiveStats =
    getEffectivePartyCombatEnemyStats(
      session,
      now
    );

  const atbRateMult =
    getPartyCombatEnemyAtbRateMult(
      session,
      now
    );

  const timingActor = {
    ...enemy,
    stats:
      effectiveStats,
    atbRateMult,
  };

  advanceCombatActorGauge(
    timingActor,
    session.updatedAt,
    now
  );

  enemy.gauge =
    timingActor.gauge;

  enemy.ready =
    timingActor.ready;
}
