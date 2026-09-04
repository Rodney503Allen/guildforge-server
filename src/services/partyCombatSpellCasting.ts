// src/services/partyCombatSpellCasting.ts
//
// Shared player spell-casting pipeline for party combat.
//
// This is the Hunt spell pipeline extracted without changing its
// gameplay behavior. Hunts and Dungeons provide only lifecycle/
// snapshot adapters while the actual spell/talent/threat/gauge
// execution remains shared.

import { db } from "../db";

import {
  publishCombatPlayerVitals,
  reduceCombatSpellCooldowns,
} from "./combat";

import { getFinalPlayerStats } from "./playerService";

import type {
  PartyCombatDebuffEffect,
  PartyCombatDotEffect,
  PartyCombatEnemy,
  PartyCombatPlayer,
} from "./partyCombatRuntime";

import {
  isPartyCombatEnemyDefeated,
} from "./partyCombatAttackCore";

import { getSpellHandler } from "./spellHandlers";

import {
  prepareSpellForCast,
  runAfterCastTalents,
  runBeforeCastTalents,
  validatePreparedSpellTalents,
} from "./spellTalents";

import type {
  SpellEnemy,
  SpellHandlerContext,
} from "./spellHandlers/types";

import {
  getActiveBerserkerDamageMultiplier,
  processBerserkerCriticalGauge,
  convertBerserkerLifestealOverhealToShield,
} from "./spellTalents/handlers/berserkerTalentHandlers";

import {
  getWarlordNextSpellOrder,
  consumeWarlordNextSpellOrder,
  processWarlordMarkedHit,
  processWarlordClaimThePrize,
} from "./spellTalents/handlers/warlordTalentHandlers";

import {
  processJudgmentSpellHit,
} from "./spellHandlers/helpers";

import {
  addCombatThreat,
  calculateCombatThreat,
  getPlayerCombatThreatMultiplier,
} from "./combatThreatService";

export type PartyCombatSpellSession = {
  state:
    | "active"
    | "victory"
    | "defeat";

  updatedAt: number;

  players:
    Map<number, PartyCombatPlayer>;

  enemy:
    PartyCombatEnemy;

  nextEffectId: number;
  dots: PartyCombatDotEffect[];
  debuffs: PartyCombatDebuffEffect[];

  nextDamageEventId: number;
  damageEvents: any[];

  log: string[];
};

export type PartyCombatSpellCastResult<
  TSnapshot = unknown
> = {
  ok: boolean;
  error?: string;

  spellId?: number;
  spellName?: string;

  damage?: number;
  crit?: boolean;
  dodged?: boolean;

  snapshot?: TSnapshot;
};

export type PartyCombatSpellCastOptions<
  TSession extends PartyCombatSpellSession,
  TSnapshot
> = {
  contextLabel: string;
  enemyLabel: string;

  notParticipantMessage: string;
  invalidAllyMessage: string;
  noEnemyMessage: string;

  spellRecoveryMs: number;

  advanceSessionUnlocked:
    (
      session: TSession
    ) => Promise<TSession>;

  buildSpellEnemy:
    (
      session: TSession
    ) => SpellEnemy;

  /*
   * Optional multi-hostile surface.
   * The selected/primary target should be first.
   */
  buildSpellEnemies?:
    (
      session: TSession,
      playerId: number
    ) => SpellEnemy[];

  /*
   * Dungeon/raid adapters can award threat directly to the runtime
   * enemy represented by enemyId. Hunts continue using session.enemy.
   */
  addThreatForEnemy?:
    (
      session: TSession,
      enemyId: number,
      playerId: number,
      threat: number
    ) => void;

  completeEnemyDefeat:
    (
      session: TSession
    ) => Promise<void>;

  completeEnemyDefeatById?:
    (
      session: TSession,
      enemyId: number
    ) => Promise<void>;

  buildSnapshot:
    (
      session: TSession
    ) => TSnapshot;
};

export async function castPartyCombatSpellUnlocked<
  TSession extends PartyCombatSpellSession,
  TSnapshot
>(
  session: TSession,
  playerId: number,
  spellId: number,
  targetPlayerId: number | null = null,
  options: PartyCombatSpellCastOptions<TSession, TSnapshot>,
): Promise<PartyCombatSpellCastResult<TSnapshot>> {
  if (
    session.state !==
    "active"
  ) {
    return {
      ok: false,
      error:
        `${options.contextLabel} combat is no longer active.`,
    };
  }

  await options.advanceSessionUnlocked(
    session
  );

  if (
    session.state !==
    "active"
  ) {
    return {
      ok: false,
      error:
        `${options.enemyLabel} has already been defeated.`,
      snapshot:
        options.buildSnapshot(
          session
        ),
    };
  }

  const player =
    session.players.get(
      Number(playerId)
    );

  if (!player) {
    return {
      ok: false,
      error:
        `${options.notParticipantMessage}`,
    };
  }

  if (
    player.hp <= 0
  ) {
    return {
      ok: false,
      error:
        "You cannot act while defeated.",
    };
  }

  if (
    !player.ready
  ) {
    return {
      ok: false,
      error:
        "Your action gauge is not ready.",
    };
  }

  if (
    session.enemy.hp <= 0
  ) {
    return {
      ok: false,
      error:
        `${options.enemyLabel} has already been defeated.`,
    };
  }

  const [[baseSpell]]: any =
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
      ],
    );

  if (!baseSpell) {
    return {
      ok: false,
      error:
        "That spell is not equipped.",
    };
  }

  const preparedCast =
    await prepareSpellForCast(
      playerId,
      baseSpell
    );

  const spell =
    preparedCast.spell;

  const warlordOrder =
    await getWarlordNextSpellOrder(
      playerId
    );

  const isDamagingSpell =
    Number(spell.damage) > 0 ||
    Number(spell.dot_damage) > 0 ||
    [
      "damage",
      "dot",
      "damage_dot"
    ].includes(
      String(spell.type)
    );

  if (
    isDamagingSpell &&
    warlordOrder.damagePercent >
    0
  ) {
    const multiplier =
      1 +
      warlordOrder.damagePercent /
      100;

    if (
      Number(spell.damage) >
      0
    ) {
      spell.damage =
        Math.round(
          Number(spell.damage) *
          multiplier
        );
    }

    if (
      Number(spell.dot_damage) >
      0
    ) {
      spell.dot_damage =
        Math.round(
          Number(
            spell.dot_damage
          ) *
          multiplier
        );
    }
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

  let targetPlayer:
    PartyCombatPlayer |
    null =
    null;

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
          "Choose an ally to target.",
      };
    }

    const selectedTarget =
      session.players.get(
        Number(
          targetPlayerId
        )
      );

    if (!selectedTarget) {
      return {
        ok: false,
        error:
          `${options.invalidAllyMessage}`,
      };
    }

    if (
      selectedTarget.hp <= 0
    ) {
      return {
        ok: false,
        error:
          "That ally is defeated.",
      };
    }

    targetPlayer =
      selectedTarget;
  }

  if (
    targetType ===
    "self"
  ) {
    targetPlayer =
      player;
  }

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
            member.maxSp,
        })
      );

  const handler =
    getSpellHandler(
      spell
    );

  if (!handler) {
    return {
      ok: false,
      error:
        `No spell handler exists for ${spellName}.`,
    };
  }

  const spellEnemy =
    options.buildSpellEnemy(
      session
    );

  const spellEnemies =
    (
      options.buildSpellEnemies
        ? options.buildSpellEnemies(
            session,
            playerId
          )
        : [
            spellEnemy
          ]
    )
      .filter(
        (
          candidate
        ): candidate is SpellEnemy =>
          Boolean(
            candidate
          ) &&
          Number(
            candidate.hp
          ) > 0
      );

  if (
    handler.requiresEnemy &&
    !spellEnemy
  ) {
    return {
      ok: false,
      error:
        `${options.noEnemyMessage}`,
    };
  }

  const configurationError =
    handler.validate?.(
      spell
    ) ??
    null;

  if (
    configurationError
  ) {
    console.error(
      "Invalid party-combat spell configuration:",
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

        configurationError,
      }
    );

    return {
      ok: false,
      error:
        configurationError,
    };
  }

  const spellContext:
    SpellHandlerContext = {
      playerId:
        player.playerId,

      spell,

      player:
        player.stats,

      enemy:
        spellEnemy,

      enemies:
        spellEnemies,

      currentPlayerHP:
        player.hp,

      currentPlayerSP:
        player.sp,

      maxPlayerHP:
        player.maxHp,

      maxPlayerSP:
        player.maxSp,

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

      allies:
        alliedPlayers,

      talents:
        preparedCast.talents,

      castState:
        preparedCast.castState,

      hasTalent:
        preparedCast.hasTalent,

      getTalent:
        preparedCast.getTalent,

      getTalentConfig:
        preparedCast.getTalentConfig,
    };

  (spellContext as any).alliesIncludingDefeated =
    Array.from(
      session.players.values()
    ).map(
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

  const talentValidationError =
    await validatePreparedSpellTalents(
      preparedCast,
      spellContext,
    );

  if (
    talentValidationError
  ) {
    return {
      ok: false,
      error:
        talentValidationError,
    };
  }

  const manaCost =
    warlordOrder.free
      ? 0
      : Math.max(
          0,
          Number(
            preparedCast.castState.manaCost ??
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
        "Not enough SP.",
    };
  }

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
        "That spell is still on cooldown.",
    };
  }

  if (
    warlordOrder.free ||
    isDamagingSpell
  ) {
    await consumeWarlordNextSpellOrder(
      playerId,
      warlordOrder
    );
  }

  const enemyHPBeforeCast =
    Math.max(
      0,
      Number(
        spellEnemy.hp
      ) || 0
    );

  const enemyHPBeforeCastById =
    new Map<
      number,
      number
    >(
      spellEnemies.map(
        target => [
          Number(
            target.id
          ),
          Math.max(
            0,
            Number(
              target.hp
            ) || 0
          ),
        ]
      )
    );

  const playerHPBeforeCast =
    new Map(
      Array.from(
        session.players.values()
      ).map(
        member => [
          member.playerId,
          member.hp,
        ]
      ),
    );

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
    ],
  );

  spellContext.currentPlayerSP =
    player.sp;

  await runBeforeCastTalents(
    preparedCast,
    spellContext
  );

  const berserkerDamageMultiplier =
    await getActiveBerserkerDamageMultiplier(
      playerId,
      player.hp,
      player.maxHp
    );

  if (
    berserkerDamageMultiplier >
    1
  ) {
    if (
      Number(spell.damage) >
      0
    ) {
      spell.damage =
        Math.round(
          Number(spell.damage) *
          berserkerDamageMultiplier
        );
    }

    if (
      Number(
        spell.dot_damage
      ) >
      0
    ) {
      spell.dot_damage =
        Math.round(
          Number(
            spell.dot_damage
          ) *
          berserkerDamageMultiplier
        );
    }
  }

  let result =
    await handler.execute(
      spellContext
    );

  result =
    await runAfterCastTalents(
      preparedCast,
      spellContext,
      result
    );

  const berserkerCriticalGauge =
    await processBerserkerCriticalGauge(
      playerId,
      Boolean(
        result.crit
      )
    );

  if (
    berserkerCriticalGauge >
      0 &&
    Number(
      result.damage
    ) >
      0
  ) {
    result.casterGaugeGain =
      (
        Number(
          result.casterGaugeGain
        ) ||
        0
      ) +
      berserkerCriticalGauge;
  }

  if (
    Number(
      result.damage
    ) >
      0 &&
    Number(
      player.stats.lifesteal ||
      0
    ) >
      0
  ) {
    const raw =
      Math.max(
        0,
        Math.floor(
          Number(
            result.damage
          ) *
          Number(
            player.stats.lifesteal
          )
        )
      );

    const actual =
      Math.max(
        0,
        Math.min(
          raw,
          player.maxHp -
          player.hp
        )
      );

    const overheal =
      Math.max(
        0,
        raw -
        actual
      );

    if (
      actual >
      0
    ) {
      player.hp +=
        actual;

      player.stats.hpoints =
        player.hp;

      result.playerHP =
        player.hp;

      result.healing =
        (
          Number(
            result.healing
          ) ||
          0
        ) +
        actual;

      await db.query(
        `UPDATE players SET hpoints=? WHERE id=?`,
        [
          player.hp,
          playerId
        ]
      );
    }

    await convertBerserkerLifestealOverhealToShield(
      playerId,
      overheal
    );
  }

  const handlerEnemyResults =
    Array.isArray(
      (result as any)
        .enemyResults
    )
      ? (
          (result as any)
            .enemyResults as any[]
        )
      : [];

  if (
    handlerEnemyResults.length >
    0
  ) {
    for (
      const hit of
      handlerEnemyResults
    ) {
      const affectedEnemy =
        spellEnemies.find(
          candidate =>
            Number(
              candidate.id
            ) ===
            Number(
              hit.enemyId
            )
        );

      if (
        !affectedEnemy
      ) {
        continue;
      }

      await processJudgmentSpellHit(
        affectedEnemy,
        {
          playerId,

          spellId:
            Number(
              spell.id
            ),

          spellName:
            String(
              spell.name
            ),

          damage:
            Number(
              hit.damage
            ) || 0,

          crit:
            Boolean(
              hit.crit
            ),
        }
      );
    }
  } else {
    await processJudgmentSpellHit(
      spellEnemy,
      {
        playerId,

        spellId:
          Number(
            spell.id
          ),

        spellName:
          String(
            spell.name
          ),

        damage:
          Number(
            result.damage
          ) ||
          (
            [
              "dot",
              "damage_dot"
            ].includes(
              String(
                spell.type
              )
            )
              ? 1
              : 0
          ),

        crit:
          Boolean(
            result.crit
          ),
      }
    );
  }

  const restoredMana =
    Math.max(
      0,
      Number(
        result.manaRestored
      ) ||
      Math.floor(
        (
          player.maxSp *
          (
            Number(
              result.restoreManaPercent
            ) ||
            0
          )
        ) /
        100,
      ),
    );

  if (
    restoredMana >
    0
  ) {
    player.sp =
      Math.min(
        player.maxSp,
        player.sp +
        restoredMana
      );

    player.stats.spoints =
      player.sp;

    await db.query(
      `UPDATE players SET spoints = ? WHERE id = ?`,
      [
        player.sp,
        playerId,
      ],
    );
  }

  const refreshPoisonDuration =
    Math.max(
      0,
      Number(
        result.refreshPoisonDuration
      ) || 0,
    );

  if (
    refreshPoisonDuration >
    0
  ) {
    const poison =
      session.dots.find(
        effect =>
          effect.sourcePlayerId ===
            playerId &&
          effect.spellId ===
            62
      );

    if (poison) {
      poison.ticksApplied =
        0;

      poison.nextTickAt =
        Date.now() +
        poison.tickIntervalMs;

      poison.expiresAt =
        Date.now() +
        refreshPoisonDuration *
        1000;

      result.log =
        `${result.log ?? ""} ☠ Poison Arrow is refreshed.`;
    }
  }

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
          ) || 0
        ),
      );

    if (
      returnedEnemyHP !==
      Number(
        spellEnemy.hp
      )
    ) {
      if (
        spellEnemy.setHP
      ) {
        await spellEnemy.setHP(
          returnedEnemyHP
        );
      } else {
        spellEnemy.hp =
          returnedEnemyHP;
      }
    }
  }

  /*
   * SpellEnemy is the authoritative target adapter. In single-enemy
   * Hunts it maps to session.enemy; in multi-enemy Dungeons it may be
   * a stable adapter for the player's selected runtime enemy.
   */
  spellEnemy.hp =
    Math.max(
      0,
      Number(
        spellEnemy.hp
      ) || 0
    );

  const computedEnemyResults =
    handlerEnemyResults.length >
      0
      ? handlerEnemyResults
      : spellEnemies.map(
          target => {
            const before =
              enemyHPBeforeCastById.get(
                Number(
                  target.id
                )
              ) ??
              Number(
                target.hp
              ) ??
              0;

            const after =
              Math.max(
                0,
                Number(
                  target.hp
                ) || 0
              );

            return {
              enemyId:
                Number(
                  target.id
                ),

              enemyName:
                target.name,

              damage:
                Math.max(
                  0,
                  before -
                  after
                ),

              enemyHP:
                after,

              killedEnemy:
                after <= 0,

              crit:
                false,

              dodged:
                false,
            };
          }
        );

  const damage =
    handlerEnemyResults.length >
      0
      ? handlerEnemyResults.reduce(
          (
            total,
            hit
          ) =>
            total +
            Math.max(
              0,
              Number(
                hit.damage
              ) || 0
            ),
          0
        )
      : Math.max(
          0,
          enemyHPBeforeCast -
          Number(
            spellEnemy.hp
          )
        );

  if (
    damage >
    0
  ) {
    let totalMarkedGauge =
      0;

    if (
      handlerEnemyResults.length >
      0
    ) {
      for (
        const hit of
        handlerEnemyResults
      ) {
        const affectedEnemy =
          spellEnemies.find(
            candidate =>
              Number(
                candidate.id
              ) ===
              Number(
                hit.enemyId
              )
          );

        if (
          !affectedEnemy ||
          Number(
            hit.damage
          ) <= 0
        ) {
          continue;
        }

        const markedHit =
          await processWarlordMarkedHit(
            affectedEnemy as any,
            player.playerId,
            Number(
              hit.damage
            ),
          );

        totalMarkedGauge +=
          markedHit.gaugeGain;
      }
    } else {
      const markedHit =
        await processWarlordMarkedHit(
          spellEnemy as any,
          player.playerId,
          damage,
        );

      totalMarkedGauge +=
        markedHit.gaugeGain;
    }

    result.casterGaugeGain =
      (
        Number(
          result.casterGaugeGain
        ) ||
        0
      ) +
      totalMarkedGauge;
  }

  if (
    isPartyCombatEnemyDefeated(
      session.enemy
    )
  ) {
    const livingIds =
      Array.from(
        session.players.values()
      )
        .filter(
          member =>
            member.hp > 0
        )
        .map(
          member =>
            member.playerId
        );

    const claim =
      await processWarlordClaimThePrize(
        spellEnemy as any,
        livingIds
      );

    const bonuses = {
      ...(
        (result as any).playerGaugeBonuses ??
        {}
      )
    };

    for (
      const claimed of
      claim.players
    ) {
      const member =
        session.players.get(
          claimed.playerId
        );

      if (!member) continue;

      member.hp =
        claimed.hp;

      member.sp =
        claimed.sp;

      member.stats.hpoints =
        claimed.hp;

      member.stats.spoints =
        claimed.sp;

      bonuses[
        claimed.playerId
      ] =
        (
          Number(
            bonuses[
              claimed.playerId
            ]
          ) ||
          0
        ) +
        claim.gaugeGain;
    }

    (result as any).playerGaugeBonuses =
      bonuses;
  }

  const crit =
    Boolean(
      result.crit
    );

  const dodged =
    Boolean(
      result.dodged
    );

  const refreshHuntPlayer =
    async (
      member: PartyCombatPlayer
    ) => {
      const refreshed =
        await getFinalPlayerStats(
          member.playerId
        );

      if (!refreshed) {
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
            ),
          ),
        );

      member.sp =
        Math.max(
          0,
          Math.min(
            member.maxSp,
            Number(
              refreshed.spoints ??
              member.sp
            ),
          ),
        );
    };

  if (
    targetType ===
    "all_allies"
  ) {
    for (
      const member of
      session.players.values()
    ) {
      await refreshHuntPlayer(
        member
      );
    }
  } else {
    await refreshHuntPlayer(
      player
    );

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
          ) || 0,
        ),
      );

    player.stats.hpoints =
      player.hp;
  }

  const effectiveHealing =
    Array.from(
      session.players.values()
    ).reduce(
      (
        total,
        member
      ) =>
        total +
        Math.max(
          0,
          member.hp -
          (
            playerHPBeforeCast.get(
              member.playerId
            ) ??
            member.hp
          ),
        ),
      0,
    );

  const persistentThreatMultiplier =
    await getPlayerCombatThreatMultiplier(
      player.playerId,
    );

  const combinedThreatMultiplier =
    Math.max(
      0,
      Number(
        result.threatMultiplier
      ) ||
      1
    ) *
    persistentThreatMultiplier;

  if (
    handlerEnemyResults.length >
      0 &&
    options.addThreatForEnemy
  ) {
    for (
      const hit of
      handlerEnemyResults
    ) {
      const generatedThreat =
        calculateCombatThreat({
          damage:
            Math.max(
              0,
              Number(
                hit.damage
              ) || 0
            ),

          /*
           * Healing threat is generated against every enemy that the
           * AoE interacted with. Threat tables are enemy-local.
           */
          effectiveHealing,

          threatMultiplier:
            combinedThreatMultiplier,

          bonusThreat:
            result.threatGenerated,
        });

      options.addThreatForEnemy(
        session,
        Number(
          hit.enemyId
        ),
        player.playerId,
        generatedThreat,
      );
    }
  } else {
    const generatedThreat =
      calculateCombatThreat({
        damage,

        effectiveHealing,

        threatMultiplier:
          combinedThreatMultiplier,

        bonusThreat:
          result.threatGenerated,
      });

    addCombatThreat(
      session.enemy,
      session.players.values(),
      player.playerId,
      generatedThreat,
    );
  }

  if (
    Number(
      result.forceThreatTargetPlayerId
    ) ===
    player.playerId
  ) {
    const highestThreat =
      Math.max(
        0,
        ...Object.values(
          session.enemy.threat
        ).map(
          value =>
            Number(value) ||
            0
        ),
      );

    session.enemy.threat[
      player.playerId
    ] =
      highestThreat +
      1;

    session.enemy.targetPlayerId =
      player.playerId;

    session.log.push(
      `🌿 ${player.name} forces ${session.enemy.name} to focus on them!`,
    );
  }

  if (
    targetType ===
    "all_allies"
  ) {
    for (
      const member of
      session.players.values()
    ) {
      publishCombatPlayerVitals(
        member
      );
    }
  } else {
    publishCombatPlayerVitals(
      player
    );

    if (
      targetPlayer &&
      targetPlayer.playerId !==
      player.playerId
    ) {
      publishCombatPlayerVitals(
        targetPlayer
      );
    }
  }

  const cooldownSeconds =
    Math.max(
      0,
      Number(
        preparedCast.castState.cooldownSeconds ??
        0
      ),
    );

  const currentCooldownReduction =
    Math.max(
      0,
      Number(
        result.reduceCurrentCooldownSeconds
      ) || 0,
    );

  player.cooldowns[
    cooldownKey
  ] =
    now +
    Math.max(
      0,
      cooldownSeconds -
      currentCooldownReduction
    ) *
    1000;

  if (
    Number(
      result.resetSpellCooldown
    ) ===
    Number(
      spell.id
    )
  ) {
    player.cooldowns[
      cooldownKey
    ] =
      now;
  }

  const resetSpellIds =
    Array.isArray(
      result.resetSpellIds
    )
      ? result.resetSpellIds
          .map(Number)
          .filter(
            Number.isFinite
          )
      : [];

  for (
    const resetSpellId of
    resetSpellIds
  ) {
    player.cooldowns[
      `spell:${resetSpellId}`
    ] =
      now;
  }

  const reduceOtherCooldownsSeconds =
    Math.max(
      0,
      Number(
        result.reduceOtherCooldownsSeconds
      ) || 0,
    );

  if (
    reduceOtherCooldownsSeconds >
    0
  ) {
    reduceCombatSpellCooldowns(
      player,
      reduceOtherCooldownsSeconds,
      [
        Number(
          spell.id
        )
      ],
      now
    );
  }

  const reducePartyCooldownsSeconds =
    Math.max(
      0,
      Number(
        (result as any).reducePartyCooldownsSeconds
      ) || 0,
    );

  if (
    reducePartyCooldownsSeconds >
    0
  ) {
    for (
      const member of
      session.players.values()
    ) {
      reduceCombatSpellCooldowns(
        member,
        reducePartyCooldownsSeconds,
        [18],
        now
      );
    }
  }

  player.gauge =
    0;

  player.ready =
    false;

  player.recoveryUntil =
    now +
    options.spellRecoveryMs;

  if (
    Number.isFinite(
      Number(
        result.setGaugeTo
      )
    )
  ) {
    player.gauge =
      Math.max(
        0,
        Math.min(
          100,
          Number(
            result.setGaugeTo
          )
        )
      );

    player.ready =
      player.gauge >=
      100;
  }

  const partyGaugeGain =
    Math.max(
      0,
      Number(
        result.partyGaugeGain
      ) || 0
    );

  const casterGaugeGain =
    Math.max(
      0,
      Number(
        result.casterGaugeGain
      ) || 0
    );

  const targetGaugeGain =
    Math.max(
      0,
      Number(
        result.targetGaugeGain
      ) || 0
    );

  const targetGaugePlayerId =
    Number(
      result.targetGaugePlayerId
    );

  const enemyGaugeReduction =
    Math.max(
      0,
      Number(
        result.enemyGaugeReduction
      ) || 0,
    );

  if (
    partyGaugeGain >
    0
  ) {
    for (
      const member of
      session.players.values()
    ) {
      if (
        member.hp <= 0
      ) {
        continue;
      }

      member.gauge =
        Math.min(
          100,
          member.gauge +
          partyGaugeGain
        );

      member.ready =
        member.gauge >=
        100;
    }
  }

  if (
    casterGaugeGain >
      0 &&
    player.hp >
      0
  ) {
    player.gauge =
      Math.min(
        100,
        player.gauge +
        casterGaugeGain
      );

    player.ready =
      player.gauge >=
      100;
  }

  if (
    targetGaugeGain >
      0 &&
    Number.isFinite(
      targetGaugePlayerId
    )
  ) {
    for (
      const member of
      session.players.values()
    ) {
      if (
        Number(
          member.playerId
        ) ===
          targetGaugePlayerId &&
        member.hp >
          0
      ) {
        member.gauge =
          Math.min(
            100,
            member.gauge +
            targetGaugeGain
          );

        member.ready =
          member.gauge >=
          100;

        break;
      }
    }
  }

  if (
    enemyGaugeReduction >
    0
  ) {
    session.enemy.gauge =
      Math.max(
        0,
        session.enemy.gauge -
        enemyGaugeReduction,
      );

    session.enemy.ready =
      session.enemy.gauge >=
      100;
  }

  const playerGaugeBonuses =
    (result as any).playerGaugeBonuses ??
    {};

  const playerGaugeOverrides =
    (result as any).playerGaugeOverrides ??
    {};

  for (
    const member of
    session.players.values()
  ) {
    const bonus =
      Math.max(
        0,
        Number(
          playerGaugeBonuses[
            member.playerId
          ]
        ) || 0
      );

    if (
      bonus >
        0 &&
      member.hp >
        0
    ) {
      member.gauge =
        Math.min(
          100,
          member.gauge +
          bonus
        );

      member.ready =
        member.gauge >=
        100;
    }

    if (
      Number.isFinite(
        Number(
          playerGaugeOverrides[
            member.playerId
          ]
        )
      ) &&
      member.hp >
        0
    ) {
      member.gauge =
        Math.max(
          0,
          Math.min(
            100,
            Number(
              playerGaugeOverrides[
                member.playerId
              ]
            )
          )
        );

      member.ready =
        member.gauge >=
        100;
    }
  }

  if (
    damage >
    0
  ) {
    await db.query(
      `DELETE FROM player_buffs WHERE player_id=? AND source LIKE 'knight-answer:%'`,
      [
        player.playerId
      ]
    );
  }

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

  if (
    damage >
    0
  ) {
    if (
      handlerEnemyResults.length >
      0
    ) {
      for (
        const hit of
        handlerEnemyResults
      ) {
        if (
          Number(
            hit.damage
          ) <= 0
        ) {
          continue;
        }

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

          targetEnemyId:
            Number(
              hit.enemyId
            ),

          amount:
            Number(
              hit.damage
            ),

          crit:
            Boolean(
              hit.crit
            ),

          spellId:
            Number(
              spell.id
            ),

          spellName,

          kind:
            "spell",

          createdAt:
            now,
        });
      }
    } else {
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
          now,
      });
    }

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

  if (
    session.log.length >
    60
  ) {
    session.log =
      session.log.slice(
        -60
      );
  }

  if (
    handlerEnemyResults.length >
      0 &&
    options.completeEnemyDefeatById
  ) {
    const defeatedEnemyIds =
      Array.from(
        new Set(
          handlerEnemyResults
            .filter(
              hit =>
                Boolean(
                  hit.killedEnemy
                ) ||
                Number(
                  hit.enemyHP
                ) <= 0
            )
            .map(
              hit =>
                Number(
                  hit.enemyId
                )
            )
        )
      );

    for (
      const defeatedEnemyId of
      defeatedEnemyIds
    ) {
      if (
        session.state !==
        "active"
      ) {
        break;
      }

      await options.completeEnemyDefeatById(
        session,
        defeatedEnemyId,
      );
    }
  } else if (
    result.killedEnemy ||
    session.enemy.hp <=
      0
  ) {
    await options.completeEnemyDefeat(
      session
    );
  }

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
      options.buildSnapshot(
        session
      ),
  };
}

