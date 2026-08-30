//spell.routes.ts
import express from "express";
import { db } from "./db";
import { getFinalPlayerStats } from "./services/playerService";
import { handleCreatureKill } from "./services/killService";
import { getSpellHandler } from "./services/spellHandlers";

import {
  ensureCombatSession,
  createCombatSession,
  advanceCombatSession,
  buildCombatSnapshot,
  consumeActorTurn,
  getActorReadyInMs,
  isCooldownReady,
  setCooldown,
  pushDamageEvent,
  reduceOtherSpellCooldowns,
  refreshPlayerCreatureDot
} from "./services/combatSessionService";
import { getEquippedSpells } from "./services/spellLoadoutService";
import { publishWorldCombatSnapshot } from "./combatSocket";
import { emitPlayerStatePatch, getSocketServer } from "./socketServer";
import { publishPlayerLevelUp } from "./playerStateEvents";

import {
  prepareSpellForCast,
  runAfterCastTalents,
  runBeforeCastTalents,
  validatePreparedSpellTalents
} from "./services/spellTalents";

import type {
  SpellEnemy,
  SpellHandlerContext
} from "./services/spellHandlers/types";
import { processJudgmentSpellHit } from "./services/spellHandlers/helpers";
import {
  getActiveBerserkerDamageMultiplier,
  processBerserkerCriticalGauge,
  convertBerserkerLifestealOverhealToShield
} from "./services/spellTalents/handlers/berserkerTalentHandlers";
import {
  getWarlordNextSpellOrder,
  consumeWarlordNextSpellOrder,
  processWarlordMarkedHit,
  processWarlordClaimThePrize
} from "./services/spellTalents/handlers/warlordTalentHandlers";
import { extendWarlordMarkDebuffs } from "./services/creatureDebuffService";

import {
  applyCreatureDebuff
} from "./services/creatureBuffService";



const router = express.Router();
async function getOrCreateSession(pid: number) {
  let session = ensureCombatSession(pid);
  if (!session) {
    session = await createCombatSession(pid);
  }
  return session;
}
// ⏱️ playerId:spellId -> timestamp

function buildPlayerCreatureSpellEnemy(
  enemy: any
): SpellEnemy {

  const spellEnemy = {
    id:
      Number(enemy.id),

    name:
      String(
        enemy.name ??
        "Enemy"
      ),

    sourceType:
      "player_creature",

    hp:
      Number(
        enemy.hp ?? 0
      ),

    maxhp:
      Math.max(
        1,
        Number(
          enemy.maxhp ?? 1
        )
      ),

    level:
      Number(
        enemy.level ?? 1
      ),

    attack:
      Number(
        enemy.attack ?? 0
      ),

    defense:
      Number(
        enemy.defense ?? 0
      ),

    agility:
      Number(
        enemy.agility ?? 0
      ),


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

        await db.query(
          `
            UPDATE player_creatures

            SET hp = ?

            WHERE id = ?
          `,
          [
            finalHP,
            Number(enemy.id)
          ]
        );

        spellEnemy.hp =
          finalHP;

        enemy.hp =
          finalHP;
      },

getDebuffValue:
  async (
    stat: string
  ) => {

    if (String(stat).trim().toLowerCase() === "__any__") {
      const [[anyRow]]: any = await db.query(
        `SELECT EXISTS(SELECT 1 FROM player_creature_debuffs WHERE player_creature_id = ? AND expires_at > NOW(3)) AS value`,
        [Number(enemy.id)]
      );
      return Number(anyRow?.value) || 0;
    }

    const [[row]]: any =
      await db.query(
        `
          SELECT
            MAX(value) AS value

          FROM player_creature_debuffs

          WHERE player_creature_id = ?
            AND stat = ?
            AND expires_at > NOW(3)
        `,
        [
          Number(enemy.id),
          String(stat)
        ]
      );

    return Math.max(
      0,
      Number(
        row?.value
      ) || 0
    );
  },

removeDebuff:
  async (stat: string) => {
    await db.query(
      `DELETE FROM player_creature_debuffs WHERE player_creature_id = ? AND stat = ?`,
      [Number(enemy.id), String(stat).trim().toLowerCase()]
    );
  },
    extendWarlordMark: async (maximumExtensionSeconds: number) =>
      extendWarlordMarkDebuffs(Number(enemy.id), maximumExtensionSeconds),
    consumeDot: async (_sourcePlayerId: number, spellId: number) => {
      const [[dot]]: any = await db.query(
        `SELECT id,total_damage,total_ticks,ticks_applied FROM player_creature_dots
         WHERE player_creature_id=? AND source LIKE ? ORDER BY id DESC LIMIT 1`,
        [Number(enemy.id), `spell:${spellId}|%`]
      );
      if (!dot) return 0;
      const dealt = Math.floor(Number(dot.total_damage || 0) * Number(dot.ticks_applied || 0) / Math.max(1, Number(dot.total_ticks || 1)));
      const remaining = Math.max(0, Number(dot.total_damage || 0) - dealt);
      await db.query(`DELETE FROM player_creature_dots WHERE id=?`, [dot.id]);
      return remaining;
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

        const totalTicks =
          Math.max(
            1,
            Math.floor(
              durationSeconds /
              tickRateSeconds
            )
          );

        /*
         * Keep the legacy damage column populated
         * even though processEnemyDots now uses
         * total_damage / total_ticks for exact
         * fractional distribution.
         */
        const initialTickDamage =
          Math.max(
            1,
            Math.floor(
              totalDamage /
              totalTicks
            )
          );

        const source = [
          `spell:${args.spellId}`,
          `dr:${Number(args.defenseReductionPerTick) || 0}`,
          `ds:${Number(args.defenseReductionMaxStacks) || 0}`,
          `mp:${Number(args.manaRestorePercentPerTick) || 0}`,
          `ep:${Number((args as any).escalationPercentPerTick) || 0}`,
          `ec:${Number((args as any).escalationMaxPercent) || 0}`,
          `hr:${Number((args as any).healingReductionPercent) || 0}`
          ,`th:${Number((args as any).tickHealingPercent) || 0}`
        ].join("|");


        /*
         * Refresh the same spell's DOT rather than
         * stacking duplicate copies from one caster.
         */
        await db.query(
          `
            DELETE FROM player_creature_dots

            WHERE player_creature_id = ?
              AND source LIKE ?
          `,
          [
            Number(enemy.id),
            `spell:${args.spellId}|%`
          ]
        );


        await db.query(
          `
            INSERT INTO player_creature_dots
            (
              player_creature_id,
              damage,
              total_damage,
              total_ticks,
              ticks_applied,
              tick_interval,
              next_tick_at,
              expires_at,
              source
            )

            VALUES
            (
              ?,
              ?,
              ?,
              ?,
              0,
              ?,
              DATE_ADD(NOW(3), INTERVAL ? SECOND),
              DATE_ADD(
                NOW(3),
                INTERVAL ? SECOND
              ),
              ?
            )
          `,
          [
            Number(enemy.id),
            initialTickDamage,
            totalDamage,
            totalTicks,
            tickRateSeconds,
            args.immediateFirstTick ? 0 : tickRateSeconds,
            durationSeconds,
            source
          ]
        );


        return {
          totalDamage,
          totalTicks,
          tickRateSeconds,
          durationSeconds
        };
      },


    // =================================================
    // DEBUFF APPLICATION
    // =================================================

    applyDebuff:
      async (args) => {

        await applyCreatureDebuff(
          Number(enemy.id),

          String(
            args.stat
          ),

          Number(
            args.value
          ),

          Number(
            args.durationSeconds
          ),

          `spell:${args.spellId}`
        );


        return {
          stat:
            String(
              args.stat
            ),

          value:
            Number(
              args.value
            ),

          durationSeconds:
            Number(
              args.durationSeconds
            )
        };
      }
  } as SpellEnemy & {
    consumeDot: (
      sourcePlayerId: number,
      spellId: number
    ) => Promise<number>;
  };


  return spellEnemy;
}

// =======================
// GET COMBAT HOTBAR SPELLS
// =======================
router.get("/combat/spells", async (req, res) => {
  try {
    const pid = Number((req.session as any)?.playerId || 0);

    if (!pid) {
      return res.status(401).json({
        error: "Not logged in"
      });
    }

    const slots = await getEquippedSpells(pid);

    return res.json({
      success: true,
      maxSlots: 6,
      slots
    });
  } catch (err) {
    console.error("GET /combat/spells failed", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
});

router.post("/spells/cast", async (req, res) => {
  try {
    const pid = Number(
      (req.session as any)?.playerId || 0
    );

    const spellId = Number(req.body?.spellId);

    let reward: any = null;

    if (!pid) {
      return res.status(401).json({
        error: "Not logged in"
      });
    }

    if (
      !Number.isInteger(spellId) ||
      spellId <= 0
    ) {
      return res.status(400).json({
        error: "Invalid spellId"
      });
    }

    const session = await getOrCreateSession(pid);

    if (!session) {
      return res.status(404).json({
        error: "No enemy"
      });
    }

    // Refresh the session using authoritative player stats.
    const player = await getFinalPlayerStats(pid);

    if (!player) {
      return res.status(404).json({
        error: "Player not found"
      });
    }

    session.player.stats = player;
    session.player.name = player.name ?? "Player";
    session.player.hp = Number(player.hpoints ?? 0);
    session.player.maxHp = Number(player.maxhp ?? 1);
    session.player.sp = Number(player.spoints ?? 0);
    session.player.maxSp = Number(
      player.maxspoints ?? 0
    );

    await advanceCombatSession(
      session
    );

    if (session.state !== "active") {
      return res.json({
        error: "combat_over",
        snapshot: buildCombatSnapshot(session)
      });
    }

    if (!session.player.ready) {
      return res.json({
        error: "not_ready",
        remainingMs: getActorReadyInMs(
          session.player
        ),
        snapshot: buildCombatSnapshot(session)
      });
    }

    // Verify that the spell is learned, equipped,
    // and usable in combat.
    const [[baseSpell]]: any = await db.query(
      `
      SELECT
        s.*,
        pes.slot
      FROM player_equipped_spells pes

      JOIN player_spells ps
        ON ps.player_id = pes.player_id
       AND ps.spell_id = pes.spell_id

      JOIN spells s
        ON s.id = pes.spell_id

      WHERE pes.player_id = ?
        AND pes.spell_id = ?
        AND s.is_combat = 1

      LIMIT 1
      `,
      [pid, spellId]
    );

    if (!baseSpell) {
      return res.status(403).json({
        error: "Spell not equipped"
      });
    }

    /*
     * Build the authoritative spell used for this cast:
     *
     * base spell + purchased rank + selected talents.
     *
     * From this point forward, validation and execution must use
     * the prepared spell rather than the raw database row.
     */
    const preparedCast =
      await prepareSpellForCast(
        pid,
        baseSpell
      );

    const spell = preparedCast.spell;

    const warlordOrder = await getWarlordNextSpellOrder(pid);
    const isDamagingSpell =
      Number(spell.damage) > 0 ||
      Number(spell.dot_damage) > 0 ||
      ["damage", "dot", "damage_dot"].includes(String(spell.type));

    if (isDamagingSpell && warlordOrder.damagePercent > 0) {
      const multiplier = 1 + warlordOrder.damagePercent / 100;
      if (Number(spell.damage) > 0) spell.damage = Math.round(Number(spell.damage) * multiplier);
      if (Number(spell.dot_damage) > 0) spell.dot_damage = Math.round(Number(spell.dot_damage) * multiplier);
    }

    let manaCost = Math.max(
      0,
      Number(preparedCast.castState.manaCost) || 0
    );

    if (warlordOrder.free) manaCost = 0;

    let cooldownSec = Math.max(
      0,
      Number(preparedCast.castState.cooldownSeconds) || 0
    );

    const cooldownKey = `spell:${spellId}`;

    // Cooldown failure does not consume SP or the turn.
    if (
      !isCooldownReady(
        session.player,
        cooldownKey
      )
    ) {
      const now = Date.now();

      const readyAt =
        session.player.cooldowns[cooldownKey] ||
        now;

      return res.json({
        error: "cooldown",
        remaining: Math.max(
          1,
          Math.ceil((readyAt - now) / 1000)
        ),
        snapshot: buildCombatSnapshot(session)
      });
    }

    // Load the current enemy.
const [[enemy]]: any = await db.query(
  `
    SELECT
      pc.id,
      pc.hp,

      c.name,
      c.level,

      c.maxhp,

      c.attack,
      c.defense,
      c.agility

    FROM player_creatures pc

    JOIN creatures c
      ON c.id = pc.creature_id

    WHERE pc.player_id = ?

    LIMIT 1
  `,
  [
    pid
  ]
);

const spellEnemy =
  enemy
    ? buildPlayerCreatureSpellEnemy(
        enemy
      )
    : null;

    const enemyHPBeforeCast =
  enemy
    ? Math.max(
        0,
        Number(enemy.hp) || 0
      )
    : null;

    // Find the generic spell handler.
    const handler = getSpellHandler(spell);

    if (!handler) {
      console.error(
        `No spell handler for type "${spell.type}"`,
        {
          spellId: spell.id,
          spellName: spell.name
        }
      );

      return res.status(500).json({
        error:
          `No handler exists for spell type: ${spell.type}`
      });
    }

    // Target validation happens before SP is spent.
    if (handler.requiresEnemy && !enemy) {
      return res.json({
        error: "No enemy to target",
        snapshot: buildCombatSnapshot(session)
      });
    }

    // Configuration validation happens before SP is spent.
    const configurationError =
      handler.validate?.(spell) ??
      null;

    if (configurationError) {
      console.error(
        "Invalid spell configuration",
        {
          spellId: spell.id,
          spellName: spell.name,
          spellType: spell.type,
          configurationError
        }
      );

      return res.status(500).json({
        error: configurationError
      });
    }

    /*
     * One shared handler context is used by custom spell handlers and
     * talent lifecycle hooks. It deliberately contains combat-mode-neutral
     * player and enemy adapters.
     */
    const spellContext: SpellHandlerContext = {
      playerId: pid,
      spell,
      player,
      enemy: spellEnemy,
      currentPlayerHP: Number(session.player.hp),
      currentPlayerSP: Number(session.player.sp),
      maxPlayerHP: Number(session.player.maxHp),
      maxPlayerSP: Number(session.player.maxSp),
      talents: preparedCast.talents,
      castState: preparedCast.castState,
      hasTalent: preparedCast.hasTalent,
      getTalent: preparedCast.getTalent,
      getTalentConfig: preparedCast.getTalentConfig
    };

    // Talent-specific casting rules fail before SP or the ATB turn is spent.
    const talentValidationError =
      await validatePreparedSpellTalents(
        preparedCast,
        spellContext
      );

    if (talentValidationError) {
      return res.json({
        error: talentValidationError,
        snapshot: buildCombatSnapshot(session)
      });
    }

    // SP failure does not consume the turn.
    if (
      Number(session.player.sp) < manaCost
    ) {
      return res.json({
        error: "Not enough SP",
        snapshot: buildCombatSnapshot(session)
      });
    }

    if (warlordOrder.free || isDamagingSpell) {
      await consumeWarlordNextSpellOrder(pid, warlordOrder);
    }

    // Spend SP only after all normal validation passes.
    const newSP =
      Number(session.player.sp) - manaCost;

    session.player.sp = newSP;

    await db.query(
      `
      UPDATE players
      SET spoints = ?
      WHERE id = ?
      `,
      [newSP, pid]
    );

    emitPlayerStatePatch(
      pid,
      {
        spoints: newSP,
        maxspoints: session.player.maxSp
      }
    );

    /*
     * Side-effecting pre-cast talent hooks run only after the cast has
     * passed validation and paid its normal SP cost.
     */
    spellContext.currentPlayerSP = newSP;

    await runBeforeCastTalents(
      preparedCast,
      spellContext
    );

    const berserkerDamageMultiplier = await getActiveBerserkerDamageMultiplier(
      pid,
      Number(session.player.hp),
      Number(session.player.maxHp)
    );
    if (berserkerDamageMultiplier > 1) {
      if (Number(spell.damage) > 0) spell.damage = Math.round(Number(spell.damage) * berserkerDamageMultiplier);
      if (Number(spell.dot_damage) > 0) spell.dot_damage = Math.round(Number(spell.dot_damage) * berserkerDamageMultiplier);
    }

    // Execute the actual spell effect, then allow talents to react to it.
    let result =
      await handler.execute(
        spellContext
      );

    result = await runAfterCastTalents(
      preparedCast,
      spellContext,
      result
    );

    const berserkerCriticalGauge = await processBerserkerCriticalGauge(pid, Boolean(result.crit));
    if (berserkerCriticalGauge > 0 && Number(result.damage) > 0) {
      result.casterGaugeGain = (Number(result.casterGaugeGain) || 0) + berserkerCriticalGauge;
    }

    if (Number(result.damage) > 0 && Number(session.player.stats?.lifesteal || 0) > 0) {
      const raw = Math.max(0, Math.floor(Number(result.damage) * Number(session.player.stats.lifesteal)));
      const actual = Math.max(0, Math.min(raw, session.player.maxHp - session.player.hp));
      const overheal = Math.max(0, raw - actual);
      if (actual > 0) {
        session.player.hp += actual;
        result.playerHP = session.player.hp;
        result.healing = (Number(result.healing) || 0) + actual;
        await db.query(`UPDATE players SET hpoints=? WHERE id=?`, [session.player.hp, pid]);
      }
      await convertBerserkerLifestealOverhealToShield(pid, overheal);
    }

    await processJudgmentSpellHit(enemy, {
      playerId: pid,
      spellId: Number(spell.id),
      spellName: String(spell.name),
      damage: Number(result.damage) || (["dot", "damage_dot"].includes(String(spell.type)) ? 1 : 0),
      crit: Boolean(result.crit)
    });

    const restoredMana = Math.max(
      0,
      Number(result.manaRestored) ||
      Math.floor(session.player.maxSp * (Number(result.restoreManaPercent) || 0) / 100)
    );
    if (restoredMana > 0) {
      session.player.sp = Math.min(session.player.maxSp, newSP + restoredMana);
      await db.query(`UPDATE players SET spoints = ? WHERE id = ?`, [session.player.sp, pid]);
    }

    // Toxic Precision refreshes the active Poison Arrow DOT on the current
    // creature. The service resets both its duration and complete tick count.
    const refreshPoisonDuration =
      Math.max(
        0,
        Number(
          result.refreshPoisonDuration
        ) || 0
      );

    if (
      refreshPoisonDuration > 0 &&
      enemy
    ) {
      const refreshedPoison =
        await refreshPlayerCreatureDot(
          Number(enemy.id),
          62,
          refreshPoisonDuration
        );

      if (refreshedPoison) {
        result.log =
          `${result.log ?? ""} ☠ Poison Arrow is refreshed.`;
      }
    }

if (result.appliedStatus) {
  const refreshedPlayer =
    await getFinalPlayerStats(pid);

  if (refreshedPlayer) {
    session.player.stats =
      refreshedPlayer;

    session.player.maxHp =
      Number(refreshedPlayer.maxhp ?? 1);

    session.player.maxSp =
      Number(refreshedPlayer.maxspoints ?? 0);

    session.player.hp = Math.min(
      Number(refreshedPlayer.hpoints ?? session.player.hp),
      session.player.maxHp
    );

    session.player.sp = Math.min(
      Number(refreshedPlayer.spoints ?? session.player.sp),
      session.player.maxSp
    );
  }
}

    let enemyHP =
      result.enemyHP !== undefined
        ? Number(result.enemyHP)
        : enemy
          ? Number(enemy.hp)
          : undefined;

    let playerHP =
      result.playerHP !== undefined
        ? Number(result.playerHP)
        : Number(session.player.hp);

    const appliedStatus =
      result.appliedStatus ?? false;

    if (result.playerHP !== undefined) {
      session.player.hp = playerHP;
    }

    /*
     * Re-publish current combat vitals after the spell effect.
     *
     * This covers direct healing and any handler that refreshes
     * the player's authoritative HP/SP/max values.
     */
    emitPlayerStatePatch(
      pid,
      {
        hpoints: session.player.hp,
        maxhp: session.player.maxHp,
        spoints: session.player.sp,
        maxspoints: session.player.maxSp
      }
    );

    let actualDamage = 0;

    if (
      result.enemyHP !== undefined &&
      session.enemy &&
      enemy
    ) {

const previousEnemyHP =
  Math.max(
    0,
    Number(
      enemyHPBeforeCast ?? 0
    )
  );

      const updatedEnemyHP = Math.max(
        0,
        Number(result.enemyHP) || 0
      );

      // Calculate actual HP removed so overkill damage
      // does not produce an inflated floating number.
      actualDamage = Math.max(
        0,
        previousEnemyHP - updatedEnemyHP
      );

      session.enemy.hp = updatedEnemyHP;
      enemyHP = updatedEnemyHP;

      if (actualDamage > 0) {
        pushDamageEvent(session, {
          target: "enemy",
          amount: actualDamage,
          crit: Boolean(result.crit),
          kind: "spell"
        });
      }
    }

    if (spellEnemy && actualDamage > 0) {
      const markedHit = await processWarlordMarkedHit(spellEnemy as any, pid, actualDamage);
      result.casterGaugeGain =
        (Number(result.casterGaugeGain) || 0) + markedHit.gaugeGain;
    }

    // Process direct-hit kills.
    if (
      result.killedEnemy &&
      enemy
    ) {
      const claim = await processWarlordClaimThePrize(spellEnemy as any, [pid]);
      const claimedPlayer = claim.players.find((entry) => entry.playerId === pid);
      if (claimedPlayer) {
        session.player.hp = claimedPlayer.hp;
        session.player.sp = claimedPlayer.sp;
        session.player.stats.hpoints = claimedPlayer.hp;
        session.player.stats.spoints = claimedPlayer.sp;
        emitPlayerStatePatch(pid, {
          hpoints: claimedPlayer.hp,
          spoints: claimedPlayer.sp,
          maxhp: session.player.maxHp,
          maxspoints: session.player.maxSp,
        });
      }
      result.casterGaugeGain =
        (Number(result.casterGaugeGain) || 0) + claim.gaugeGain;
      reward = await handleCreatureKill(
        pid,
        enemy.id
      );
    }

    /*
     * A post-cast custom talent may adjust the cooldown as part of its
     * mechanic, so read the final value only after all talent hooks finish.
     */
    cooldownSec = Math.max(
      0,
      Number(preparedCast.castState.cooldownSeconds) || 0
    );

    // A successful cast receives its cooldown.
    if (cooldownSec > 0) {
      setCooldown(
        session.player,
        cooldownKey,
        Math.max(0, cooldownSec - Math.max(0, Number(result.reduceCurrentCooldownSeconds) || 0))
      );
    }

    if(Number(result.resetSpellCooldown)===Number(spell.id)) setCooldown(session.player,cooldownKey,0);

    const resetSpellIds = Array.isArray(result.resetSpellIds)
      ? result.resetSpellIds.map(Number).filter(Number.isFinite)
      : [];
    for (const resetSpellId of resetSpellIds) {
      setCooldown(session.player, `spell:${resetSpellId}`, 0);
    }

    // Relentless Pace affects active spell cooldowns other than Quick Shot.
    // Item cooldowns and the spell which triggered the talent are untouched.
    const reduceOtherCooldownsSeconds =
      Math.max(
        0,
        Number(
          result.reduceOtherCooldownsSeconds
        ) || 0
      );

    if (reduceOtherCooldownsSeconds > 0) {
      reduceOtherSpellCooldowns(
        session.player,
        Number(spell.id),
        reduceOtherCooldownsSeconds
      );
    }

    const reducePartyCooldownsSeconds = Math.max(0, Number((result as any).reducePartyCooldownsSeconds) || 0);
    if (reducePartyCooldownsSeconds > 0) {
      reduceOtherSpellCooldowns(session.player, Number(spell.id), reducePartyCooldownsSeconds);
    }

    // A successful cast consumes the player's ATB turn.
    consumeActorTurn(
      session.player,
      450
    );

    if (Number.isFinite(Number(result.setGaugeTo))) {
      session.player.gauge = Math.max(0, Math.min(100, Number(result.setGaugeTo)));
      session.player.ready = session.player.gauge >= 100;
    }

    const enemyGaugeReduction=Math.max(0,Number(result.enemyGaugeReduction)||0);
    if(enemyGaugeReduction>0&&session.enemy){session.enemy.gauge=Math.max(0,session.enemy.gauge-enemyGaugeReduction);session.enemy.ready=session.enemy.gauge>=100;}

    const partyGaugeGain =
      Math.max(
        0,
        Number(result.partyGaugeGain) || 0
      );

    const casterGaugeGain = Math.max(
      0,
      Number(result.casterGaugeGain) || 0
    );

    const targetGaugeGain =
      Number(result.targetGaugePlayerId) === Number(req.session.playerId)
        ? Math.max(0, Number(result.targetGaugeGain) || 0)
        : 0;

    if (partyGaugeGain > 0 || casterGaugeGain > 0 || targetGaugeGain > 0) {
      session.player.gauge = Math.min(
        100,
        session.player.gauge + partyGaugeGain + casterGaugeGain + targetGaugeGain
      );

      session.player.ready =
        session.player.gauge >= 100;
    }

    const playerGaugeBonuses = (result as any).playerGaugeBonuses ?? {};
    const personalGaugeBonus = Math.max(0, Number(playerGaugeBonuses[pid]) || 0);
    if (personalGaugeBonus > 0) {
      session.player.gauge = Math.min(100, session.player.gauge + personalGaugeBonus);
      session.player.ready = session.player.gauge >= 100;
    }

    const playerGaugeOverrides = (result as any).playerGaugeOverrides ?? {};
    if (Number.isFinite(Number(playerGaugeOverrides[pid]))) {
      session.player.gauge = Math.max(0, Math.min(100, Number(playerGaugeOverrides[pid])));
      session.player.ready = session.player.gauge >= 100;
    }

    if (Number(result.damage) > 0) {
      await db.query(
        `DELETE FROM player_buffs WHERE player_id=? AND source LIKE 'knight-answer:%'`,
        [pid]
      );
    }

    if (reward) {
      session.state = "victory";

      session.rewards = {
        exp: reward?.expGained,
        gold: reward?.goldGained,
        levelUp: reward?.levelUp,
        chest: reward?.chest ?? null,
        quest: reward?.quest ?? null,
        huntProgress: reward?.huntProgress ?? null
      };

      /*
       * Direct spell kills grant their rewards here.
       * Trigger the same one-shot global HUD refresh
       * used by auto-attack and DOT kills.
       */
      emitPlayerStatePatch(
        pid,
        {
          refreshDerivedStats: true
        }
      );


      if (reward?.levelUp) {
        publishPlayerLevelUp(
          pid,
          reward.levelUp
        );
      }
    }

    if (result.log) {
      session.log.push(
        result.log
      );
    }

    if (reward) {
      session.log.push(
        "🏆 Enemy defeated!"
      );

      if (reward?.expGained) {
        session.log.push(
          `✨ You gained ${reward.expGained} EXP!`
        );
      }

      if (reward?.goldGained) {
        session.log.push(
          `💰 You gained ${reward.goldGained} gold!`
        );
      }

      if (reward?.levelUp) {
        session.log.push(
          "⬆ LEVEL UP!"
        );
      }
    }

    const snapshot =
      buildCombatSnapshot(
        session
      );

    publishWorldCombatSnapshot(
      getSocketServer(),
      pid,
      snapshot,
    );

    return res.json({
      log: result.log,

      enemyHP,
      enemyMaxHP: enemy?.maxhp,

      playerHP,
      playerSP: newSP,

      appliedStatus,

      dead:
        enemyHP !== undefined &&
        enemyHP <= 0,

      exp: reward?.expGained,
      gold: reward?.goldGained,
      levelUp: reward?.levelUp,

      chest: reward?.chest ?? null,
      quest: reward?.quest ?? null,

      huntProgress:
        reward?.huntProgress ?? null,

      cooldown: cooldownSec,

      snapshot
    });
  } catch (err) {
    console.error(
      "POST /spells/cast failed",
      err
    );

    return res.status(500).json({
      error: "Server error"
    });
  }
});


export default router;
