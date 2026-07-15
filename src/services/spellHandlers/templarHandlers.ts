import { db } from "../../db";

import {
  applyCreatureDebuff
} from "../creatureDebuffService";

import {
  SpellEnemy,
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  calculateScaledSpellAmount,
  resolveDamageAgainstEnemy
} from "./helpers";

type JudgmentState = {
  active: boolean;
  value: number;
};

/**
 * Returns the strongest active Judgment mark.
 */
async function getJudgmentState(
  enemyId: number
): Promise<JudgmentState> {
  const [[row]]: any = await db.query(
    `
    SELECT
      MAX(value) AS judgment_value
    FROM player_creature_debuffs
    WHERE player_creature_id = ?
      AND stat = 'judgment'
      AND expires_at > NOW()
    `,
    [enemyId]
  );

  const value = Math.max(
    0,
    Number(row?.judgment_value) || 0
  );

  return {
    active: value > 0,
    value
  };
}

/**
 * Shared direct-damage execution for Templar handlers.
 */
async function dealTemplarDamage(
  spell: any,
  player: any,
  enemy: SpellEnemy,
  damageMultiplier = 1
) {
  const baseDamage = Number(spell.damage) || 0;

  const scaledDamage =
    calculateScaledSpellAmount(
      player,
      baseDamage
    );

  const modifiedDamage = Math.max(
    1,
    Math.floor(
      scaledDamage * damageMultiplier
    )
  );

  const damageResult =
    resolveDamageAgainstEnemy(
      player,
      enemy,
      modifiedDamage
    );

  const damage = Math.max(
    1,
    Number(damageResult.damage) || 1
  );

  const enemyHP = Math.max(
    0,
    Number(enemy.hp) - damage
  );

  await db.query(
    `
    UPDATE player_creatures
    SET hp = ?
    WHERE id = ?
    `,
    [enemyHP, enemy.id]
  );

  return {
    damage,
    enemyHP,
    critical: Boolean(damageResult.crit)
  };
}

// =====================================================
// JUDGMENT
// Deals damage and applies the Judgment mark.
// =====================================================

export const judgmentHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    const damage = Number(spell.damage) || 0;
    const debuffStat = String(
      spell.debuff_stat || ""
    )
      .trim()
      .toLowerCase();

    const debuffValue =
      Number(spell.debuff_value) || 0;

    const debuffDuration =
      Number(spell.debuff_duration) || 0;

    if (damage <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    if (debuffStat !== "judgment") {
      return `${spell.name} must apply the judgment mark`;
    }

    if (debuffValue <= 0) {
      return `${spell.name} has an invalid Judgment value`;
    }

    if (debuffDuration <= 0) {
      return `${spell.name} has an invalid Judgment duration`;
    }

    return null;
  },

  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
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

    if (damageResult.enemyHP > 0) {
      await applyCreatureDebuff(
        enemy.id,
        "judgment",
        Number(spell.debuff_value) || 1,
        Number(spell.debuff_duration) || 10,
        `spell:${spell.id}`
      );
    }

    const log = damageResult.critical
      ? (
          `✨ Critical! ${spell.name} strikes for ` +
          `${damageResult.damage} damage and marks the enemy!`
        )
      : (
          `⚖️ ${spell.name} strikes for ` +
          `${damageResult.damage} damage and marks the enemy!`
        );

    return {
      log,
      enemyHP: damageResult.enemyHP,
      appliedStatus:
        damageResult.enemyHP > 0,
      killedEnemy:
        damageResult.enemyHP <= 0
    };
  }
};

// =====================================================
// CRUSADER'S WRATH
// Deals bonus damage against judged enemies.
//
// Judgment 1: +50% damage
// Judgment 2+: +75% damage
// =====================================================

export const crusadersWrathHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    if ((Number(spell.damage) || 0) <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    return null;
  },

  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Crusader's Wrath handler received no enemy"
      );
    }

    const judgment =
      await getJudgmentState(enemy.id);

    let damageMultiplier = 1;

    if (judgment.value >= 2) {
      damageMultiplier = 1.75;
    } else if (judgment.active) {
      damageMultiplier = 1.5;
    }

    const damageResult =
      await dealTemplarDamage(
        spell,
        player,
        enemy,
        damageMultiplier
      );

    let log = damageResult.critical
      ? (
          `✨ Critical! ${spell.name} strikes for ` +
          `${damageResult.damage} damage!`
        )
      : (
          `⚔️ ${spell.name} strikes for ` +
          `${damageResult.damage} damage!`
        );

    if (judgment.active) {
      const bonusPercent =
        Math.round(
          (damageMultiplier - 1) * 100
        );

      log +=
        ` ⚖️ Judgment increases the damage by ` +
        `${bonusPercent}%!`;
    }

    return {
      log,
      enemyHP: damageResult.enemyHP,
      killedEnemy:
        damageResult.enemyHP <= 0
    };
  }
};

// =====================================================
// DIVINE RECKONING
// Heavy damage.
//
// Against a judged enemy:
// - deals 25% bonus damage
// - intensifies Judgment to value 2
// - refreshes Judgment to 10 seconds
// =====================================================

export const divineReckoningHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    if ((Number(spell.damage) || 0) <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    return null;
  },

  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Divine Reckoning handler received no enemy"
      );
    }

    const judgment =
      await getJudgmentState(enemy.id);

    const damageMultiplier =
      judgment.active ? 1.25 : 1;

    const damageResult =
      await dealTemplarDamage(
        spell,
        player,
        enemy,
        damageMultiplier
      );

    let intensifiedJudgment = false;

    if (
      judgment.active &&
      damageResult.enemyHP > 0
    ) {
      await applyCreatureDebuff(
        enemy.id,
        "judgment",
        2,
        10,
        `spell:${spell.id}`
      );

      intensifiedJudgment = true;
    }

    let log = damageResult.critical
      ? (
          `✨ Critical! ${spell.name} crashes into the enemy ` +
          `for ${damageResult.damage} damage!`
        )
      : (
          `⚡ ${spell.name} deals ` +
          `${damageResult.damage} damage!`
        );

    if (intensifiedJudgment) {
      log +=
        " ⚖️ Judgment intensifies!";
    }

    return {
      log,
      enemyHP: damageResult.enemyHP,
      appliedStatus:
        intensifiedJudgment,
      killedEnemy:
        damageResult.enemyHP <= 0
    };
  }
};

// =====================================================
// FINAL JUDGMENT
// Damage increases based on the enemy's missing health.
//
// Full health: 1.0x
// Half health: 1.5x
// Near death: approaches 2.0x
// =====================================================

export const finalJudgmentHandler: SpellHandlerDefinition = {
  requiresEnemy: true,

  validate(spell) {
    if ((Number(spell.damage) || 0) <= 0) {
      return `${spell.name} has invalid damage configuration`;
    }

    return null;
  },

  async execute({
    spell,
    player,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Final Judgment handler received no enemy"
      );
    }

    const currentHP = Math.max(
      0,
      Number(enemy.hp) || 0
    );

    const maxHP = Math.max(
      1,
      Number(enemy.maxhp) || 1
    );

    const healthPercent = Math.max(
      0,
      Math.min(1, currentHP / maxHP)
    );

    const missingHealthPercent =
      1 - healthPercent;

    const damageMultiplier =
      1 + missingHealthPercent;

    const damageResult =
      await dealTemplarDamage(
        spell,
        player,
        enemy,
        damageMultiplier
      );

    const bonusPercent = Math.floor(
      missingHealthPercent * 100
    );

    let log = damageResult.critical
      ? (
          `✨ Critical! ${spell.name} passes sentence for ` +
          `${damageResult.damage} damage!`
        )
      : (
          `⚖️ ${spell.name} deals ` +
          `${damageResult.damage} damage!`
        );

    if (bonusPercent > 0) {
      log +=
        ` Missing health increases the damage by ` +
        `${bonusPercent}%!`;
    }

    return {
      log,
      enemyHP: damageResult.enemyHP,
      killedEnemy:
        damageResult.enemyHP <= 0
    };
  }
};