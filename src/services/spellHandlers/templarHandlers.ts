import {
  SpellEnemy,
  SpellHandlerDefinition
} from "./types";

import {
  applySpellDebuff,
  calculateScaledSpellAmount,
  getSpellEnemyDebuffValue,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";


type JudgmentState = {
  active: boolean;
  value: number;
};


// =====================================================
// JUDGMENT STATE
// =====================================================

/*
 * Combat-mode agnostic.
 *
 * Normal combat:
 *   reads player_creature_debuffs
 *
 * Hunt combat:
 *   reads session.debuffs
 *
 * Future dungeon/raid combat:
 *   their SpellEnemy adapter decides.
 */
async function getJudgmentState(
  enemy: SpellEnemy
): Promise<JudgmentState> {

  const value =
    await getSpellEnemyDebuffValue(
      enemy,
      "judgment"
    );

  return {
    active:
      value > 0,

    value:
      Math.max(
        0,
        Number(value) || 0
      )
  };
}


// =====================================================
// SHARED TEMPLAR DAMAGE
// =====================================================

async function dealTemplarDamage(
  spell: any,
  player: any,
  enemy: SpellEnemy,
  damageMultiplier = 1
) {

  const baseDamage =
    Number(
      spell.damage
    ) || 0;

  const scaledDamage =
    calculateScaledSpellAmount(
      player,
      baseDamage
    );

  const modifiedDamage =
    Math.max(
      1,
      Math.floor(
        scaledDamage *
        damageMultiplier
      )
    );

  const damageResult =
    resolveDamageAgainstEnemy(
      player,
      enemy,
      modifiedDamage
    );

  const damage =
    damageResult.dodged
      ? 0
      : Math.max(
          1,
          Number(
            damageResult.damage
          ) || 1
        );

  const enemyHP =
    Math.max(
      0,
      Number(
        enemy.hp
      ) -
      damage
    );

  await setSpellEnemyHP(
    enemy,
    enemyHP
  );

  return {
    damage,

    enemyHP,

    critical:
      Boolean(
        damageResult.crit
      ),

    dodged:
      Boolean(
        damageResult.dodged
      )
  };
}


// =====================================================
// JUDGMENT
// Deals damage and applies the Judgment mark.
// =====================================================

export const judgmentHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,

  validate(spell) {

    const damage =
      Number(
        spell.damage
      ) || 0;

    const debuffStat =
      String(
        spell.debuff_stat ||
        ""
      )
        .trim()
        .toLowerCase();

    const debuffValue =
      Number(
        spell.debuff_value
      ) || 0;

    const debuffDuration =
      Number(
        spell.debuff_duration
      ) || 0;

    if (
      damage <= 0
    ) {
      return (
        `${spell.name} has invalid damage configuration`
      );
    }

    if (
      debuffStat !==
      "judgment"
    ) {
      return (
        `${spell.name} must apply the judgment mark`
      );
    }

    if (
      debuffValue <= 0
    ) {
      return (
        `${spell.name} has an invalid Judgment value`
      );
    }

    if (
      debuffDuration <= 0
    ) {
      return (
        `${spell.name} has an invalid Judgment duration`
      );
    }

    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    enemy
  }) {

    if (!enemy) {
      throw new Error(
        "Judgment handler received no enemy"
      );
    }

    const damageResult =
      await dealTemplarDamage(
        spell,
        player,
        enemy
      );

    let appliedStatus =
      false;

    if (
      damageResult.enemyHP >
      0
    ) {

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
              spell.name
            ),

          stat:
            "judgment",

          value:
            Math.max(
              1,
              Number(
                spell.debuff_value
              ) || 1
            ),

          durationSeconds:
            Math.max(
              1,
              Number(
                spell.debuff_duration
              ) || 10
            )
        }
      );

      appliedStatus =
        true;
    }

    let log: string;

    if (
      damageResult.dodged
    ) {

      log =
        `⚖️ ${spell.name} misses the enemy!`;

    } else if (
      damageResult.critical
    ) {

      log =
        `✨ Critical! ${spell.name} strikes for ` +
        `${damageResult.damage} damage`;

      if (
        appliedStatus
      ) {
        log +=
          " and marks the enemy!";
      } else {
        log += "!";
      }

    } else {

      log =
        `⚖️ ${spell.name} strikes for ` +
        `${damageResult.damage} damage`;

      if (
        appliedStatus
      ) {
        log +=
          " and marks the enemy!";
      } else {
        log += "!";
      }
    }

    return {
      log,

      enemyHP:
        damageResult.enemyHP,

      appliedStatus,

      killedEnemy:
        damageResult.enemyHP <=
        0,

      crit:
        damageResult.critical,

      dodged:
        damageResult.dodged
    };
  }
};


// =====================================================
// CRUSADER'S WRATH
//
// Judgment 1: +50% damage
// Judgment 2+: +75% damage
// =====================================================

export const crusadersWrathHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,

  validate(spell) {

    if (
      (
        Number(
          spell.damage
        ) || 0
      ) <= 0
    ) {
      return (
        `${spell.name} has invalid damage configuration`
      );
    }

    return null;
  },


  async execute({
    spell,
    player,
    enemy
  }) {

    if (!enemy) {
      throw new Error(
        "Crusader's Wrath handler received no enemy"
      );
    }

    const judgment =
      await getJudgmentState(
        enemy
      );

    let damageMultiplier =
      1;

    if (
      judgment.value >= 2
    ) {

      damageMultiplier =
        1.75;

    } else if (
      judgment.active
    ) {

      damageMultiplier =
        1.5;
    }

    const damageResult =
      await dealTemplarDamage(
        spell,
        player,
        enemy,
        damageMultiplier
      );

    let log =
      damageResult.dodged
        ? (
            `⚔️ ${spell.name} misses the enemy!`
          )
        : damageResult.critical
          ? (
              `✨ Critical! ${spell.name} strikes for ` +
              `${damageResult.damage} damage!`
            )
          : (
              `⚔️ ${spell.name} strikes for ` +
              `${damageResult.damage} damage!`
            );

    if (
      judgment.active &&
      !damageResult.dodged
    ) {

      const bonusPercent =
        Math.round(
          (
            damageMultiplier -
            1
          ) *
          100
        );

      log +=
        ` ⚖️ Judgment increases the damage by ` +
        `${bonusPercent}%!`;
    }

    return {
      log,

      enemyHP:
        damageResult.enemyHP,

      killedEnemy:
        damageResult.enemyHP <=
        0,

      crit:
        damageResult.critical,

      dodged:
        damageResult.dodged
    };
  }
};


// =====================================================
// DIVINE RECKONING
//
// Against a judged enemy:
// - +25% damage
// - Judgment becomes value 2
// - Judgment refreshes to 10 seconds
// =====================================================

export const divineReckoningHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,

  validate(spell) {

    if (
      (
        Number(
          spell.damage
        ) || 0
      ) <= 0
    ) {
      return (
        `${spell.name} has invalid damage configuration`
      );
    }

    return null;
  },


  async execute({
    playerId,
    spell,
    player,
    enemy
  }) {

    if (!enemy) {
      throw new Error(
        "Divine Reckoning handler received no enemy"
      );
    }

    const judgment =
      await getJudgmentState(
        enemy
      );

    const damageMultiplier =
      judgment.active
        ? 1.25
        : 1;

    const damageResult =
      await dealTemplarDamage(
        spell,
        player,
        enemy,
        damageMultiplier
      );

    let intensifiedJudgment =
      false;

    if (
      judgment.active &&
      damageResult.enemyHP > 0
    ) {

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
              spell.name
            ),

          stat:
            "judgment",

          value:
            2,

          durationSeconds:
            10
        }
      );

      intensifiedJudgment =
        true;
    }

    let log =
      damageResult.dodged
        ? (
            `⚡ ${spell.name} misses the enemy!`
          )
        : damageResult.critical
          ? (
              `✨ Critical! ${spell.name} crashes into the enemy ` +
              `for ${damageResult.damage} damage!`
            )
          : (
              `⚡ ${spell.name} deals ` +
              `${damageResult.damage} damage!`
            );

    if (
      intensifiedJudgment
    ) {
      log +=
        " ⚖️ Judgment intensifies!";
    }

    return {
      log,

      enemyHP:
        damageResult.enemyHP,

      appliedStatus:
        intensifiedJudgment,

      killedEnemy:
        damageResult.enemyHP <=
        0,

      crit:
        damageResult.critical,

      dodged:
        damageResult.dodged
    };
  }
};


// =====================================================
// FINAL JUDGMENT
//
// Full HP: 1x
// Half HP: 1.5x
// Near death: approaches 2x
// =====================================================

export const finalJudgmentHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,

  validate(spell) {

    if (
      (
        Number(
          spell.damage
        ) || 0
      ) <= 0
    ) {
      return (
        `${spell.name} has invalid damage configuration`
      );
    }

    return null;
  },


  async execute({
    spell,
    player,
    enemy
  }) {

    if (!enemy) {
      throw new Error(
        "Final Judgment handler received no enemy"
      );
    }

    const currentHP =
      Math.max(
        0,
        Number(
          enemy.hp
        ) || 0
      );

    const maxHP =
      Math.max(
        1,
        Number(
          enemy.maxhp
        ) || 1
      );

    const healthPercent =
      Math.max(
        0,
        Math.min(
          1,
          currentHP /
          maxHP
        )
      );

    const missingHealthPercent =
      1 -
      healthPercent;

    const damageMultiplier =
      1 +
      missingHealthPercent;

    const damageResult =
      await dealTemplarDamage(
        spell,
        player,
        enemy,
        damageMultiplier
      );

    const bonusPercent =
      Math.floor(
        missingHealthPercent *
        100
      );

    let log =
      damageResult.dodged
        ? (
            `⚖️ ${spell.name} misses the enemy!`
          )
        : damageResult.critical
          ? (
              `✨ Critical! ${spell.name} passes sentence for ` +
              `${damageResult.damage} damage!`
            )
          : (
              `⚖️ ${spell.name} deals ` +
              `${damageResult.damage} damage!`
            );

    if (
      bonusPercent > 0 &&
      !damageResult.dodged
    ) {
      log +=
        ` Missing health increases the damage by ` +
        `${bonusPercent}%!`;
    }

    return {
      log,

      enemyHP:
        damageResult.enemyHP,

      killedEnemy:
        damageResult.enemyHP <=
        0,

      crit:
        damageResult.critical,

      dodged:
        damageResult.dodged
    };
  }
};