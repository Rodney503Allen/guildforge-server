// src/services/spellHandlers/genericHandlers.ts

import { db } from "../../db";
import { applyBuff } from "../buffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  applySpellDebuff,
  applySpellDot,
  calculateScaledSpellAmount,
  getConfiguredBuff,
  getConfiguredDebuff,
  getConfiguredDot,
  resolveDamageAgainstEnemy,
  resolveDirectSpellDamage,
  setSpellEnemyHP
} from "./helpers";


// =====================================================
// SHARED DEBUFF LOG
// =====================================================

function appendDebuffLog(
  log: string,
  spell: any
): string {

  const debuff =
    getConfiguredDebuff(
      spell
    );

  if (
    !debuff.stat ||
    debuff.duration <= 0 ||
    debuff.value === 0
  ) {
    return log;
  }

  const valueText =
    debuff.value > 0
      ? `+${debuff.value}`
      : `${debuff.value}`;

  return (
    `${log} 🕸 ${debuff.stat.toUpperCase()} ` +
    `${valueText} for ${debuff.duration}s!`
  );
}


// =====================================================
// OPTIONAL SPELL DEBUFF
// =====================================================

async function applyOptionalSpellDebuff(
  args: {
    playerId: number;
    spell: any;
    enemy: any;
  }
): Promise<boolean> {

  const {
    playerId,
    spell,
    enemy
  } = args;

  if (!enemy) {
    return false;
  }

  const debuff =
    getConfiguredDebuff(
      spell
    );

  /*
   * Some damage/buff/etc spells may have
   * no secondary debuff configured.
   */
  if (
    !debuff.stat ||
    debuff.duration <= 0 ||
    debuff.value === 0
  ) {
    return false;
  }

  await applySpellDebuff(
    enemy,
    {
      sourcePlayerId:
        playerId,

      spellId:
        Number(
          spell.id
        ),

      spellName:
        String(
          spell.name ||
          "Spell"
        ),

      stat:
        debuff.stat,

      value:
        debuff.value,

      durationSeconds:
        debuff.duration
    }
  );

  return true;
}


// =====================================================
// DIRECT DAMAGE
// =====================================================

export const damageHandler:
SpellHandlerDefinition = {

  requiresEnemy: true,


  validate(spell) {

    const baseDamage =
      Number(
        spell.damage
      ) || 0;

    if (
      baseDamage <= 0
    ) {
      return (
        `${spell.name} has invalid ` +
        `damage configuration`
      );
    }

    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {

    if (!enemy) {
      throw new Error(
        "Damage handler received no enemy"
      );
    }


    /*
     * Resolve shared Guildforge spell
     * damage against the supplied enemy.
     */
    const damageResult =
      resolveDirectSpellDamage(
        player,
        enemy,
        Number(
          spell.damage ?? 0
        )
      );


    const damage =
      damageResult.damage;


    const enemyHP =
      Math.max(
        0,
        Number(
          enemy.hp
        ) - damage
      );


    /*
     * IMPORTANT:
     *
     * No direct player_creatures query.
     *
     * The SpellEnemy adapter decides
     * where HP is persisted.
     */
    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    /*
     * Damage spells may optionally also
     * contain a configured debuff.
     */
    const appliedStatus =
      await applyOptionalSpellDebuff({
        playerId,
        spell,
        enemy
      });


    let log =
      damageResult.crit
        ? (
            `✨ Critical! ${spell.name} hits ` +
            `for ${damage} damage!`
          )
        : (
            `✨ You cast ${spell.name} for ` +
            `${damage} damage!`
          );


    if (
      appliedStatus
    ) {
      log =
        appendDebuffLog(
          log,
          spell
        );
    }


    return {
      log,

      enemyHP,

      appliedStatus,

      killedEnemy:
        enemyHP <= 0,

      crit:
        Boolean(
          damageResult.crit
        )
    };
  }
};


// =====================================================
// DIRECT HEALING
// =====================================================

export const healHandler:
SpellHandlerDefinition = {

  requiresEnemy: false,


  validate(spell) {

    const baseHeal =
      Number(
        spell.heal
      ) || 0;

    if (
      baseHeal <= 0
    ) {
      return (
        `${spell.name} has invalid ` +
        `healing configuration`
      );
    }

    return null;
  },


  async execute({
    playerId,
    spell,
    player,

    currentPlayerHP,
    maxPlayerHP,

    targetPlayerId,
    targetPlayer,

    currentTargetHP,
    maxTargetHP,

    allies
  }): Promise<SpellHandlerResult> {

    const baseHeal =
      Number(
        spell.heal
      ) || 0;


    const targetType =
      String(
        spell.target_type ||
        "self"
      )
        .trim()
        .toLowerCase();


    /*
     * Healing amount is always based on the
     * caster's scaling stats.
     */
    const baseScaledHealing =
      calculateScaledSpellAmount(
        player,
        baseHeal
      );


    // =================================================
    // PARTY-WIDE HEAL
    // =================================================

    if (
      targetType ===
      "all_allies"
    ) {

      const targets =
        (allies ?? [])
          .filter(
            ally =>
              ally.hp > 0
          );


      if (
        targets.length === 0
      ) {
        return {
          log:
            `✨ You cast ${spell.name}, but there are ` +
            `no living allies to heal.`,

          healing:
            0
        };
      }


      let totalHealing =
        0;

      let healedPlayers =
        0;


      for (
        const ally of
        targets
      ) {

        /*
         * Healing-received modifiers belong
         * to the recipient.
         */
        const scaledHealing =
          applyHealingReceivedMultiplier(
            ally.stats,
            baseScaledHealing
          );


        const currentHP =
          Math.max(
            0,
            Number(
              ally.hp
            ) || 0
          );


        const maximumHP =
          Math.max(
            1,
            Number(
              ally.maxHp
            ) || 1
          );


        const finalHP =
          Math.min(
            maximumHP,
            currentHP +
            scaledHealing
          );


        const actualHealing =
          Math.max(
            0,
            finalHP -
            currentHP
          );


        await db.query(
          `
            UPDATE players

            SET hpoints = ?

            WHERE id = ?
          `,
          [
            finalHP,
            ally.playerId
          ]
        );


        /*
         * Keep the context copy synchronized too.
         */
        ally.hp =
          finalHP;

        if (
          ally.stats
        ) {
          ally.stats.hpoints =
            finalHP;
        }


        if (
          actualHealing > 0
        ) {
          totalHealing +=
            actualHealing;

          healedPlayers++;
        }
      }


      const log =
        healedPlayers > 0
          ? (
              `✨ You cast ${spell.name}, restoring ` +
              `${totalHealing} total HP across ` +
              `${healedPlayers} ${
                healedPlayers === 1
                  ? "ally"
                  : "allies"
              }!`
            )
          : (
              `✨ You cast ${spell.name}, but your ` +
              `party is already at full health!`
            );


      return {
        log,

        healing:
          totalHealing
      };
    }


    // =================================================
    // SINGLE FRIENDLY TARGET / SELF
    // =================================================

    /*
     * If no explicit target exists, use the caster.
     *
     * This preserves normal solo combat behavior.
     */
    const healTargetId =
      targetPlayerId ??
      playerId;


    const healTarget =
      targetPlayer ??
      player;


    const currentHP =
      Math.max(
        0,
        Number(
          currentTargetHP ??
          currentPlayerHP ??
          healTarget?.hpoints ??
          0
        )
      );


    const maximumHP =
      Math.max(
        1,
        Number(
          maxTargetHP ??
          maxPlayerHP ??
          healTarget?.maxhp ??
          1
        )
      );


    /*
     * Recipient controls healing-received
     * modifiers.
     */
    const scaledHealing =
      applyHealingReceivedMultiplier(
        healTarget,
        baseScaledHealing
      );


    const finalHP =
      Math.min(
        maximumHP,
        currentHP +
        scaledHealing
      );


    const actualHealing =
      Math.max(
        0,
        finalHP -
        currentHP
      );


    await db.query(
      `
        UPDATE players

        SET hpoints = ?

        WHERE id = ?
      `,
      [
        finalHP,
        healTargetId
      ]
    );


    const targetingSelf =
      Number(
        healTargetId
      ) ===
      Number(
        playerId
      );


    const log =
      actualHealing > 0
        ? targetingSelf
          ? (
              `✨ You cast ${spell.name} and ` +
              `restore ${actualHealing} HP!`
            )
          : (
              `✨ You cast ${spell.name}, restoring ` +
              `${actualHealing} HP to your ally!`
            )
        : targetingSelf
          ? (
              `✨ You cast ${spell.name}, but ` +
              `you are already at full health!`
            )
          : (
              `✨ You cast ${spell.name}, but ` +
              `your ally is already at full health!`
            );


    return {
      log,

      /*
       * Do not return playerHP here.
       *
       * The Hunt system now refreshes the
       * affected player(s) from authoritative
       * storage after casting.
       */
      healing:
        actualHealing
    };
  }
};


// =====================================================
// DAMAGE OVER TIME
// =====================================================

export const dotHandler:
SpellHandlerDefinition = {

  requiresEnemy: true,


  validate(spell) {

    const dot =
      getConfiguredDot(
        spell
      );


    if (
      dot.damage <= 0
    ) {
      return (
        `${spell.name} has invalid DOT damage`
      );
    }


    if (
      dot.duration <= 0
    ) {
      return (
        `${spell.name} has invalid DOT duration`
      );
    }


    if (
      dot.tickRate <= 0
    ) {
      return (
        `${spell.name} has invalid DOT tick rate`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {

    if (!enemy) {
      throw new Error(
        "DOT handler received no enemy"
      );
    }


    const dot =
      getConfiguredDot(
        spell
      );


    /*
     * DOT uses normal spell scaling and
     * mitigation once to determine the
     * total effect damage.
     */
    const scaledDotDamage =
      calculateScaledSpellAmount(
        player,
        dot.damage
      );


    const dotResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDotDamage
      );


    const totalDotDamage =
      Math.max(
        1,
        Number(
          dotResult.damage
        ) || 1
      );


    /*
     * Let the enemy adapter decide how
     * the DOT is represented.
     *
     * Normal combat:
     *   player_creature_dots
     *
     * Hunt combat:
     *   in-memory Hunt DOT
     *
     * Dungeon/Raid:
     *   their own encounter effect state
     */
    await applySpellDot(
      enemy,
      {
        sourcePlayerId:
          playerId,

        spellId:
          Number(
            spell.id
          ),

        spellName:
          String(
            spell.name ||
            "Spell"
          ),

        totalDamage:
          totalDotDamage,

        durationSeconds:
          dot.duration,

        tickRateSeconds:
          dot.tickRate
      }
    );


    /*
     * DOT spells may also include a
     * secondary configured debuff.
     */
    const appliedDebuff =
      await applyOptionalSpellDebuff({
        playerId,
        spell,
        enemy
      });


    let log =
      dotResult.crit
        ? (
            `☠ Critical! ${spell.name} afflicts ` +
            `the enemy for ${totalDotDamage} ` +
            `damage over ${dot.duration}s!`
          )
        : (
            `☠ ${spell.name} afflicts the enemy ` +
            `for ${totalDotDamage} damage over ` +
            `${dot.duration}s!`
          );


    if (
      appliedDebuff
    ) {
      log =
        appendDebuffLog(
          log,
          spell
        );
    }


    return {
      log,

      enemyHP:
        Number(
          enemy.hp
        ),

      appliedStatus:
        true,

      killedEnemy:
        false,

      crit:
        Boolean(
          dotResult.crit
        )
    };
  }
};


// =====================================================
// DIRECT DAMAGE + DAMAGE OVER TIME
// =====================================================

export const damageDotHandler:
SpellHandlerDefinition = {

  requiresEnemy: true,


  validate(spell) {

    const directDamage =
      Number(
        spell.damage
      ) || 0;


    const dot =
      getConfiguredDot(
        spell
      );


    if (
      directDamage <= 0
    ) {
      return (
        `${spell.name} has invalid direct damage`
      );
    }


    if (
      dot.damage <= 0
    ) {
      return (
        `${spell.name} has invalid DOT damage`
      );
    }


    if (
      dot.duration <= 0
    ) {
      return (
        `${spell.name} has invalid DOT duration`
      );
    }


    if (
      dot.tickRate <= 0
    ) {
      return (
        `${spell.name} has invalid DOT tick rate`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {

    if (!enemy) {
      throw new Error(
        "Damage-DOT handler received no enemy"
      );
    }


    // =================================================
    // DIRECT HIT
    // =================================================

    const directResult =
      resolveDirectSpellDamage(
        player,
        enemy,
        Number(
          spell.damage ?? 0
        )
      );


    const directDamage =
      directResult.damage;


    const enemyHP =
      Math.max(
        0,
        Number(
          enemy.hp
        ) -
        directDamage
      );


    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    /*
     * Do not attach lingering effects to
     * something the direct hit already killed.
     */
    if (
      enemyHP <= 0
    ) {

      return {
        log:
          directResult.crit
            ? (
                `✨ Critical! ${spell.name} hits ` +
                `for ${directDamage} damage!`
              )
            : (
                `✨ You cast ${spell.name} for ` +
                `${directDamage} damage!`
              ),

        enemyHP,

        killedEnemy:
          true,

        appliedStatus:
          false,

        crit:
          Boolean(
            directResult.crit
          )
      };
    }


    // =================================================
    // DOT PORTION
    // =================================================

    const dot =
      getConfiguredDot(
        spell
      );


    const scaledDotDamage =
      calculateScaledSpellAmount(
        player,
        dot.damage
      );


    /*
     * enemy.hp was synchronized by
     * setSpellEnemyHP above.
     */
    const dotResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDotDamage
      );


    const totalDotDamage =
      Math.max(
        1,
        Number(
          dotResult.damage
        ) || 1
      );


    await applySpellDot(
      enemy,
      {
        sourcePlayerId:
          playerId,

        spellId:
          Number(
            spell.id
          ),

        spellName:
          String(
            spell.name ||
            "Spell"
          ),

        totalDamage:
          totalDotDamage,

        durationSeconds:
          dot.duration,

        tickRateSeconds:
          dot.tickRate
      }
    );


    // =================================================
    // OPTIONAL DEBUFF
    // =================================================

    const appliedDebuff =
      await applyOptionalSpellDebuff({
        playerId,
        spell,
        enemy
      });


    let log =
      directResult.crit
        ? (
            `✨ Critical! ${spell.name} hits for ` +
            `${directDamage} damage and afflicts ` +
            `the enemy for ${totalDotDamage} damage ` +
            `over ${dot.duration}s!`
          )
        : (
            `✨ You cast ${spell.name} for ` +
            `${directDamage} damage and afflict ` +
            `the enemy for ${totalDotDamage} damage ` +
            `over ${dot.duration}s!`
          );


    if (
      dotResult.crit
    ) {
      log +=
        " ☠ The lingering effect was critical!";
    }


    if (
      appliedDebuff
    ) {
      log =
        appendDebuffLog(
          log,
          spell
        );
    }


    return {
      log,

      enemyHP,

      /*
       * The DOT itself counts as an
       * applied status even when there
       * is no separate debuff.
       */
      appliedStatus:
        true,

      killedEnemy:
        false,

      crit:
        Boolean(
          directResult.crit
        )
    };
  }
};


// =====================================================
// PLAYER BUFF
// =====================================================

export const buffHandler:
SpellHandlerDefinition = {

  requiresEnemy: false,


  validate(spell) {

    const buff =
      getConfiguredBuff(
        spell
      );


    if (
      !buff.stat
    ) {
      return (
        `${spell.name} has no buff stat`
      );
    }


    if (
      buff.value === 0
    ) {
      return (
        `${spell.name} has no buff value`
      );
    }


    if (
      buff.duration <= 0
    ) {
      return (
        `${spell.name} has invalid buff duration`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    enemy,

    targetPlayerId,

    allies
  }): Promise<SpellHandlerResult> {

    const buff =
      getConfiguredBuff(
        spell
      );


    const targetType =
      String(
        spell.target_type ||
        "self"
      )
        .trim()
        .toLowerCase();


    // =================================================
    // PARTY-WIDE BUFF
    // =================================================

    if (
      targetType ===
      "all_allies"
    ) {

      const targets =
        (allies ?? [])
          .filter(
            ally =>
              ally.hp > 0
          );


      if (
        targets.length === 0
      ) {
        return {
          log:
            `✨ You cast ${spell.name}, but there are ` +
            `no living allies to affect.`,

          appliedStatus:
            false
        };
      }


      for (
        const ally of
        targets
      ) {

        await applyBuff(
          ally.playerId,
          buff.stat,
          buff.value,
          buff.duration,
          `spell:${spell.id}`
        );
      }


      let log =
        `✨ You cast ${spell.name}, granting the party ` +
        `${buff.stat.toUpperCase()} ` +
        `${buff.value > 0 ? "+" : ""}${buff.value} ` +
        `for ${buff.duration}s!`;


      /*
       * A spell may theoretically contain both
       * a party buff and an enemy debuff.
       */
      if (
        enemy
      ) {

        const appliedDebuff =
          await applyOptionalSpellDebuff({
            playerId,
            spell,
            enemy
          });


        if (
          appliedDebuff
        ) {

          log =
            appendDebuffLog(
              log,
              spell
            );
        }
      }


      return {
        log,

        appliedStatus:
          true
      };
    }


    // =================================================
    // SINGLE TARGET / SELF BUFF
    // =================================================

    /*
     * Selected friendly target if supplied.
     *
     * Otherwise preserve original solo behavior
     * by targeting the caster.
     */
    const buffTargetId =
      targetPlayerId ??
      playerId;


    await applyBuff(
      buffTargetId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}`
    );


    const targetingSelf =
      Number(
        buffTargetId
      ) ===
      Number(
        playerId
      );


    let log =
      targetingSelf
        ? (
            `✨ You cast ${spell.name} and gain ` +
            `${buff.stat.toUpperCase()} ` +
            `${buff.value > 0 ? "+" : ""}${buff.value} ` +
            `for ${buff.duration}s!`
          )
        : (
            `✨ You cast ${spell.name}, granting your ally ` +
            `${buff.stat.toUpperCase()} ` +
            `${buff.value > 0 ? "+" : ""}${buff.value} ` +
            `for ${buff.duration}s!`
          );


    /*
     * Some support abilities may also contain
     * an enemy debuff.
     */
    if (
      enemy
    ) {

      const appliedDebuff =
        await applyOptionalSpellDebuff({
          playerId,
          spell,
          enemy
        });


      if (
        appliedDebuff
      ) {

        log =
          appendDebuffLog(
            log,
            spell
          );
      }
    }


    return {
      log,

      appliedStatus:
        true
    };
  }
};

// =====================================================
// ENEMY DEBUFF
// =====================================================

export const debuffHandler:
SpellHandlerDefinition = {

  requiresEnemy: true,


  validate(spell) {

    const debuff =
      getConfiguredDebuff(
        spell
      );


    if (
      !debuff.stat
    ) {
      return (
        `${spell.name} has no debuff stat`
      );
    }


    if (
      debuff.value === 0
    ) {
      return (
        `${spell.name} has no debuff value`
      );
    }


    if (
      debuff.duration <= 0
    ) {
      return (
        `${spell.name} has invalid debuff duration`
      );
    }


    return null;
  },


  async execute({
    playerId,
    spell,
    enemy
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {
      throw new Error(
        "Debuff handler received no enemy"
      );
    }


    const debuff =
      getConfiguredDebuff(
        spell
      );


    await applySpellDebuff(
      enemy,
      {
        sourcePlayerId:
          playerId,

        spellId:
          Number(
            spell.id
          ),

        spellName:
          String(
            spell.name ||
            "Spell"
          ),

        stat:
          debuff.stat,

        value:
          debuff.value,

        durationSeconds:
          debuff.duration
      }
    );


    const valueText =
      debuff.value > 0
        ? `+${debuff.value}`
        : `${debuff.value}`;


    const log =
      `🕸 You cast ${spell.name}! ` +
      `${debuff.stat.toUpperCase()} ` +
      `${valueText} for ` +
      `${debuff.duration}s!`;


    return {
      log,

      enemyHP:
        Number(
          enemy.hp
        ),

      appliedStatus:
        true
    };
  }
};