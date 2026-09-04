// src/services/partyCombatSpellEnemy.ts
//
// Shared SpellEnemy adapter for party-based combat.
//
// Hunts and Dungeons both use the same spell handlers/talents.
// This adapter gives those handlers one common enemy surface while
// leaving persistence and encounter lifecycle in the owning system.

import type { DerivedStats } from "./statEngine";

import type {
  PartyCombatDebuffEffect,
  PartyCombatDotEffect,
  PartyCombatEnemy,
} from "./partyCombatRuntime";

import type {
  SpellEnemy,
  SpellEnemySourceType,
} from "./spellHandlers/types";

export type PartyCombatSpellEnemy =
  SpellEnemy & {
    consumeDot: (
      sourcePlayerId: number,
      spellId: number,
    ) => Promise<number>;

    extendWarlordMark: (
      maximumExtensionSeconds: number,
    ) => Promise<number>;
  };

export type PartyCombatSpellEnemyHost = {
  enemy: PartyCombatEnemy;

  dots: PartyCombatDotEffect[];
  debuffs: PartyCombatDebuffEffect[];

  nextEffectId: number;
};

export type CreatePartyCombatSpellEnemyOptions<
  THost extends PartyCombatSpellEnemyHost
> = {
  host: THost;

  enemyId: number;

  sourceType:
    SpellEnemySourceType;

  getEffectiveStats: (
    host: THost,
    now: number,
  ) => DerivedStats;

  persistEnemyHp: (
    host: THost,
  ) => Promise<void>;
};

export function createPartyCombatSpellEnemy<
  THost extends PartyCombatSpellEnemyHost
>(
  options:
    CreatePartyCombatSpellEnemyOptions<THost>,
): PartyCombatSpellEnemy {
  const {
    host,
    enemyId,
    sourceType,
    getEffectiveStats,
    persistEnemyHp,
  } = options;

  const now =
    Date.now();

  const effectiveStats =
    getEffectiveStats(
      host,
      now,
    );

  const spellEnemy =
    {
      id:
        Number(enemyId),

      name:
        host.enemy.name,

      sourceType,

      hp:
        host.enemy.hp,

      maxhp:
        host.enemy.maxHp,

      level:
        host.enemy.level,

      attack:
        Number(
          effectiveStats.attack ??
          0
        ),

      defense:
        Number(
          effectiveStats.defense ??
          0
        ),

      agility:
        Number(
          effectiveStats.agility ??
          0
        ),

      stats:
        effectiveStats,

      setHP:
        async (
          newHP: number,
        ) => {
          const finalHP =
            Math.max(
              0,
              Math.min(
                host.enemy.maxHp,
                Math.floor(
                  Number(newHP) ||
                  0
                ),
              ),
            );

          host.enemy.hp =
            finalHP;

          host.enemy.stats.hpoints =
            finalHP;

          spellEnemy.hp =
            finalHP;

          await persistEnemyHp(
            host
          );
        },

      getDebuffValue:
        async (
          stat: string,
        ) => {
          const normalizedStat =
            String(stat)
              .trim()
              .toLowerCase();

          const currentTime =
            Date.now();

          if (
            normalizedStat ===
            "__any__"
          ) {
            return host.debuffs.some(
              effect =>
                effect.expiresAt >
                currentTime
            )
              ? 1
              : 0;
          }

          let strongestValue =
            0;

          for (
            const effect of
            host.debuffs
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
                ) ||
                0,
              );
          }

          return strongestValue;
        },

      removeDebuff:
        async (
          stat: string,
        ) => {
          const normalized =
            String(stat)
              .trim()
              .toLowerCase();

          host.debuffs =
            host.debuffs.filter(
              effect =>
                String(
                  effect.stat
                )
                  .trim()
                  .toLowerCase() !==
                normalized
            );
        },

      extendWarlordMark:
        async (
          maximumExtensionSeconds:
            number,
        ) => {
          const currentTime =
            Date.now();

          const marker =
            host.debuffs
              .filter(
                effect =>
                  effect.stat ===
                    "warlord_mark_extension" &&
                  effect.expiresAt >
                    currentTime
              )
              .sort(
                (a, b) =>
                  b.expiresAt -
                  a.expiresAt
              )[0];

          if (!marker) {
            return 0;
          }

          const cap =
            marker.expiresAt +
            Math.max(
              0,
              Number(
                maximumExtensionSeconds
              ) ||
              0,
            ) *
            1000;

          let changed =
            false;

          for (
            const effect of
            host.debuffs
          ) {
            if (
              effect.spellId ===
                16 &&
              effect.stat !==
                "warlord_mark_extension" &&
              effect.expiresAt >
                currentTime
            ) {
              const nextExpiry =
                Math.min(
                  cap,
                  effect.expiresAt +
                    1000,
                );

              changed ||=
                nextExpiry >
                effect.expiresAt;

              effect.expiresAt =
                nextExpiry;
            }
          }

          return changed
            ? 1
            : 0;
        },

      consumeDot:
        async (
          sourcePlayerId:
            number,
          spellId:
            number,
        ) => {
          const existing =
            host.dots.find(
              effect =>
                effect.sourcePlayerId ===
                  Number(
                    sourcePlayerId
                  ) &&
                effect.spellId ===
                  Number(
                    spellId
                  )
            );

          if (!existing) {
            return 0;
          }

          const dealt =
            Math.floor(
              existing.totalDamage *
              existing.ticksApplied /
              Math.max(
                1,
                existing.totalTicks
              )
            );

          const remaining =
            Math.max(
              0,
              existing.totalDamage -
              dealt
            );

          host.dots =
            host.dots.filter(
              effect =>
                effect.id !==
                existing.id
            );

          return remaining;
        },

      applyDot:
        async args => {
          const totalDamage =
            Math.max(
              1,
              Math.floor(
                Number(
                  args.totalDamage
                ) ||
                1
              ),
            );

          const durationSeconds =
            Math.max(
              0.1,
              Number(
                args.durationSeconds
              ) ||
              1,
            );

          const tickRateSeconds =
            Math.max(
              0.1,
              Number(
                args.tickRateSeconds
              ) ||
              1,
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
              ),
            );

          host.dots =
            host.dots.filter(
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
            PartyCombatDotEffect =
            {
              id:
                host.nextEffectId++,

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

              nextTickAt:
                Date.now() +
                (
                  (args as any)
                    .immediateFirstTick
                    ? 0
                    : tickIntervalMs
                ),

              expiresAt:
                Date.now() +
                durationMs,

              defenseReductionPerTick:
                Number(
                  (args as any)
                    .defenseReductionPerTick
                ) ||
                0,

              defenseReductionMaxStacks:
                Number(
                  (args as any)
                    .defenseReductionMaxStacks
                ) ||
                0,

              manaRestorePercentPerTick:
                Number(
                  (args as any)
                    .manaRestorePercentPerTick
                ) ||
                0,

              tickHealingPercent:
                Number(
                  (args as any)
                    .tickHealingPercent
                ) ||
                0,
            };

          host.dots.push(
            effect
          );

          return effect;
        },

      applyDebuff:
        async args => {
          const stat =
            String(
              args.stat ||
              ""
            )
              .trim()
              .toLowerCase() as
              PartyCombatDebuffEffect["stat"];

          const value =
            Number(
              args.value
            ) ||
            0;

          const durationSeconds =
            Math.max(
              0.1,
              Number(
                args.durationSeconds
              ) ||
              1,
            );

          host.debuffs =
            host.debuffs.filter(
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
            PartyCombatDebuffEffect =
            {
              id:
                host.nextEffectId++,

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
                1000,
            };

          host.debuffs.push(
            effect
          );

          return effect;
        },
    } as PartyCombatSpellEnemy;

  return spellEnemy;
}
