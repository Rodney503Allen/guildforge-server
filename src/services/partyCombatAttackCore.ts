// src/services/partyCombatAttackCore.ts
import { resolveAttack } from "./combatEngine";
import {
  refreshCombatThreatTarget,
} from "./combatThreatService";

import type {
  PartyCombatEnemy,
  PartyCombatPlayer,
} from "./partyCombatRuntime";

import type { DerivedStats } from "./statEngine";

export type PartyCombatAttackRoll = {
  damage: number;
  crit: boolean;
  dodged: boolean;
};

export function resolvePartyCombatPlayerAttack(
  player: PartyCombatPlayer,
  effectiveEnemyStats: DerivedStats,
): PartyCombatAttackRoll {
  const result =
    resolveAttack(
      player.stats as any,
      effectiveEnemyStats as any,
    );

  return {
    damage:
      result.dodged
        ? 0
        : Math.max(
            0,
            Math.floor(
              Number(
                result.damage ??
                0
              )
            )
          ),

    crit:
      Boolean(
        result.crit
      ),

    dodged:
      Boolean(
        result.dodged
      ),
  };
}

export function resolvePartyCombatEnemyAttack(
  enemyStats: DerivedStats,
  target: PartyCombatPlayer,
  options: {
    damageMultiplier?: number;
  } = {},
): PartyCombatAttackRoll {
  const damageMultiplier =
    Math.max(
      0,
      Number(
        options.damageMultiplier ??
        1
      ) || 0,
    );

  const effectiveEnemyStats: DerivedStats = {
    ...enemyStats,

    attack:
      Math.max(
        0,
        Number(
          enemyStats.attack ??
          0
        ) *
        damageMultiplier,
      ),
  };

  const result =
    resolveAttack(
      effectiveEnemyStats as any,
      target.stats as any,
    );

  return {
    damage:
      result.dodged
        ? 0
        : Math.max(
            0,
            Math.floor(
              Number(
                result.damage ??
                0
              )
            )
          ),

    crit:
      Boolean(
        result.crit
      ),

    dodged:
      Boolean(
        result.dodged
      ),
  };
}

export function selectPartyCombatThreatTarget<
  T extends PartyCombatPlayer
>(
  enemy: PartyCombatEnemy,
  players: Iterable<T>,
): T | null {
  return (
    refreshCombatThreatTarget(
      enemy,
      players
    ) as T | null
  );
}

export function isPartyCombatEnemyDefeated(
  enemy: PartyCombatEnemy,
) {
  return Number(enemy.hp) <= 0;
}

export function isPartyCombatPartyDefeated(
  players: Iterable<PartyCombatPlayer>,
) {
  for (const player of players) {
    if (Number(player.hp) > 0) {
      return false;
    }
  }

  return true;
}

export function applyPartyCombatEnemyDamage(
  enemy: PartyCombatEnemy,
  amount: number,
) {
  const damage =
    Math.max(
      0,
      Math.floor(
        Number(amount) || 0
      )
    );

  const previousHp =
    Math.max(
      0,
      Number(
        enemy.hp
      ) || 0
    );

  const nextHp =
    Math.max(
      0,
      previousHp -
      damage
    );

  enemy.hp =
    nextHp;

  enemy.stats.hpoints =
    nextHp;

  return {
    previousHp,
    nextHp,
    damage:
      previousHp -
      nextHp,
    defeated:
      nextHp <= 0,
  };
}
