// src/services/partyCombatDotProcessor.ts
//
// Shared DoT processing for party combat.
//
// Hunts and Dungeons both use this processor so spell-applied DoTs,
// DoT threat, Warlord mark interactions, mana restoration, tick healing,
// and enemy-defeat handling remain identical across encounter types.

import { db } from "../db";

import {
  calculateDistributedTickDamage,
  publishCombatPlayerVitals,
} from "./combat";

import type {
  PartyCombatDebuffEffect,
  PartyCombatDotEffect,
  PartyCombatEnemy,
  PartyCombatPlayer,
} from "./partyCombatRuntime";

import type {
  SpellEnemy,
} from "./spellHandlers/types";

import {
  processWarlordMarkedHit,
  processWarlordClaimThePrize,
} from "./spellTalents/handlers/warlordTalentHandlers";

import {
  addCombatThreat,
  getPlayerCombatThreatMultiplier,
} from "./combatThreatService";

export type PartyCombatDotSession = {
  state:
    | "active"
    | "victory"
    | "defeat";

  players:
    Map<number, PartyCombatPlayer>;

  enemy:
    PartyCombatEnemy;

  nextEffectId: number;

  dots:
    PartyCombatDotEffect[];

  debuffs:
    PartyCombatDebuffEffect[];

  nextDamageEventId:
    number;

  damageEvents:
    any[];

  log:
    string[];
};

export type PartyCombatDotProcessorOptions<
  TSession extends PartyCombatDotSession
> = {
  buildSpellEnemy:
    (
      session: TSession
    ) => SpellEnemy;

  persistEnemyHp:
    (
      session: TSession
    ) => Promise<void>;

  completeEnemyDefeat:
    (
      session: TSession
    ) => Promise<void>;
};

export async function processPartyCombatDots<
  TSession extends PartyCombatDotSession
>(
  session: TSession,
  now: number,
  options:
    PartyCombatDotProcessorOptions<TSession>,
) {
  if (
    session.state !==
      "active" ||
    session.enemy.hp <=
      0 ||
    session.dots.length ===
      0
  ) {
    return;
  }

  let enemyHP =
    session.enemy.hp;

  for (
    const dot of
    session.dots
  ) {
    while (
      dot.ticksApplied <
        dot.totalTicks &&
      dot.nextTickAt <=
        now &&
      enemyHP >
        0
    ) {
      const tickDamage =
        calculateDistributedTickDamage(
          dot.totalDamage,
          dot.totalTicks,
          dot.ticksApplied,
        );

      dot.ticksApplied++;

      if (
        (
          dot.defenseReductionPerTick ||
          0
        ) >
          0 &&
        (
          dot.defenseReductionMaxStacks ||
          0
        ) >
          0
      ) {
        const stacks =
          Math.min(
            Number(
              dot.defenseReductionMaxStacks
            ),
            dot.ticksApplied,
          );

        const reduction =
          -Math.max(
            1,
            Math.floor(
              (
                Number(
                  session.enemy.stats.defense ||
                  0
                ) *
                Number(
                  dot.defenseReductionPerTick
                ) *
                stacks
              ) /
              100,
            ),
          );

        session.debuffs =
          session.debuffs.filter(
            effect =>
              !(
                effect.sourcePlayerId ===
                  dot.sourcePlayerId &&
                effect.spellId ===
                  dot.spellId &&
                effect.stat ===
                  "defense"
              ),
          );

        session.debuffs.push({
          id:
            session.nextEffectId++,

          sourcePlayerId:
            dot.sourcePlayerId,

          spellId:
            dot.spellId,

          spellName:
            dot.spellName,

          stat:
            "defense",

          value:
            reduction,

          appliedAt:
            now,

          expiresAt:
            dot.expiresAt,
        });
      }

      if (
        (
          dot.manaRestorePercentPerTick ||
          0
        ) >
        0
      ) {
        const source =
          session.players.get(
            dot.sourcePlayerId
          );

        if (source) {
          const restored =
            Math.max(
              1,
              Math.floor(
                (
                  source.maxSp *
                  Number(
                    dot.manaRestorePercentPerTick
                  )
                ) /
                100,
              ),
            );

          source.sp =
            Math.min(
              source.maxSp,
              source.sp +
                restored
            );

          source.stats.spoints =
            source.sp;

          await db.query(
            `
              UPDATE players
              SET spoints = ?
              WHERE id = ?
            `,
            [
              source.sp,
              source.playerId,
            ],
          );

          publishCombatPlayerVitals(
            source
          );
        }
      }

      if (
        (
          dot.tickHealingPercent ||
          0
        ) >
          0 &&
        tickDamage >
          0
      ) {
        const source =
          session.players.get(
            dot.sourcePlayerId
          );

        if (
          source &&
          source.hp >
            0
        ) {
          const healing =
            Math.max(
              1,
              Math.floor(
                tickDamage *
                Number(
                  dot.tickHealingPercent
                ) /
                100,
              ),
            );

          source.hp =
            Math.min(
              source.maxHp,
              source.hp +
                healing
            );

          source.stats.hpoints =
            source.hp;

          await db.query(
            `
              UPDATE players
              SET hpoints = ?
              WHERE id = ?
            `,
            [
              source.hp,
              source.playerId,
            ],
          );

          publishCombatPlayerVitals(
            source
          );

          session.log.push(
            `🩸 Scent of Blood restores ${healing} HP to ${source.name}.`,
          );
        }
      }

      dot.nextTickAt +=
        dot.tickIntervalMs;

      if (
        tickDamage <=
        0
      ) {
        continue;
      }

      enemyHP =
        Math.max(
          0,
          enemyHP -
            tickDamage
        );

      /*
       * Keep the runtime enemy HP synchronized before
       * talent hooks inspect the SpellEnemy adapter.
       */
      session.enemy.hp =
        enemyHP;

      session.enemy.stats.hpoints =
        enemyHP;

      const markedHit =
        await processWarlordMarkedHit(
          options.buildSpellEnemy(
            session
          ) as any,
          dot.sourcePlayerId,
          tickDamage,
        );

      const markedAttacker =
        session.players.get(
          dot.sourcePlayerId
        );

      if (markedAttacker) {
        markedAttacker.gauge =
          Math.min(
            100,
            markedAttacker.gauge +
              markedHit.gaugeGain,
          );

        markedAttacker.ready =
          markedAttacker.gauge >=
          100;
      }

      const threatMultiplier =
        await getPlayerCombatThreatMultiplier(
          dot.sourcePlayerId,
        );

      addCombatThreat(
        session.enemy,
        session.players.values(),
        dot.sourcePlayerId,
        tickDamage *
          threatMultiplier,
      );

      session.log.push(
        `🔥 ${session.enemy.name} takes ${tickDamage} damage from ${dot.spellName}.`,
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
          Date.now(),
      });

      if (
        enemyHP <=
        0
      ) {
        break;
      }
    }
  }

  session.enemy.hp =
    enemyHP;

  session.enemy.stats.hpoints =
    enemyHP;

  session.dots =
    session.dots.filter(
      dot =>
        dot.ticksApplied <
        dot.totalTicks
    );

  await options.persistEnemyHp(
    session
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

  if (
    enemyHP <=
    0
  ) {
    const claim =
      await processWarlordClaimThePrize(
        options.buildSpellEnemy(
          session
        ) as any,
        Array.from(
          session.players.values()
        )
          .filter(
            member =>
              member.hp >
              0
          )
          .map(
            member =>
              member.playerId
          ),
      );

    for (
      const claimed of
      claim.players
    ) {
      const member =
        session.players.get(
          claimed.playerId
        );

      if (!member) {
        continue;
      }

      member.hp =
        claimed.hp;

      member.sp =
        claimed.sp;

      member.stats.hpoints =
        claimed.hp;

      member.stats.spoints =
        claimed.sp;

      member.gauge =
        Math.min(
          100,
          member.gauge +
            claim.gaugeGain
        );

      member.ready =
        member.gauge >=
        100;

      publishCombatPlayerVitals(
        member
      );
    }

    await options.completeEnemyDefeat(
      session
    );
  }
}
