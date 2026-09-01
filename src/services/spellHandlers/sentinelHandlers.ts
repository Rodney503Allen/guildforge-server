// src/services/spellHandlers/sentinelHandlers.ts

import { db } from "../../db";
import { applyBuff } from "../buffService";

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applyHealingReceivedMultiplier,
  applySpellDebuff,
  calculateScaledSpellAmount,
  getConfiguredBuff,
  getConfiguredDebuff,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";

const TANK_ATTACK_THREAT_MULTIPLIER = 3;
const TANK_BONUS_THREAT_SCALE = 5;
const SENTINEL_THREAT_GENERATION_PERCENT = 100;

function rankNumber(
  spell: any,
  key: string,
  fallback = 0
): number {
  const value =
    Number(
      spell?.rank_config?.[key]
    );

  return Number.isFinite(
    value
  )
    ? value
    : fallback;
}

function scaledThreatBonus(
  spell: any,
  key: string,
  minimum: number
): number {
  const configured =
    Math.max(
      0,
      rankNumber(
        spell,
        key,
        0
      )
    );

  return Math.max(
    minimum,
    configured *
      TANK_BONUS_THREAT_SCALE
  );
}

async function applyStatus(
  playerId: number,
  effectKey: string,
  value: number,
  charges: number,
  duration: number,
  source: string
) {
  await db.query(
    `
      INSERT INTO player_status_effects
        (player_id, effect_key, value, charges, expires_at, source)
      VALUES
        (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND), ?)
      ON DUPLICATE KEY UPDATE
        value = VALUES(value),
        charges = VALUES(charges),
        expires_at = VALUES(expires_at),
        source = VALUES(source)
    `,
    [
      playerId,
      effectKey,
      value,
      charges,
      duration,
      source
    ]
  );
}

function livingTargets(
  context: any
) {
  const allies =
    (context.allies ?? [])
      .filter(
        (ally: any) =>
          Number(
            ally.hp
          ) > 0
      );

  return allies.length > 0
    ? allies
    : [{
        playerId:
          context.playerId,

        hp:
          context.currentPlayerHP ??
          context.player?.hpoints ??
          1,

        maxHp:
          context.maxPlayerHP ??
          context.player?.maxhp ??
          1,

        stats:
          context.player
      }];
}

// =====================================================
// BRAMBLE STRIKE
//
// Dedicated Sentinel threat attack.
// =====================================================

export const brambleStrikeHandler:
SpellHandlerDefinition = {
  requiresEnemy:
    true,

  validate(spell) {
    const baseDamage =
      Number(
        spell.damage
      ) || 0;

    const debuff =
      getConfiguredDebuff(
        spell
      );

    if (
      baseDamage <= 0
    ) {
      return `${spell.name} has invalid damage configuration`;
    }

    if (
      debuff.stat !==
      "damage_dealt_pct"
    ) {
      return `${spell.name} must use damage_dealt_pct`;
    }

    if (
      debuff.value <= 0
    ) {
      return `${spell.name} has an invalid weakening value`;
    }

    if (
      debuff.duration <= 0
    ) {
      return `${spell.name} has an invalid weakening duration`;
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
        "Bramble Strike handler received no enemy"
      );
    }

    const scaledDamage =
      calculateScaledSpellAmount(
        player,
        Number(
          spell.damage
        ) || 0
      );

    const damageResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDamage
      );

    const dodged =
      Boolean(
        damageResult.dodged
      );

    const damage =
      dodged
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

    const debuff =
      getConfiguredDebuff(
        spell
      );

    let appliedStatus =
      false;

    if (
      !dodged &&
      enemyHP > 0
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
              spell.name ||
              "Bramble Strike"
            ),

          stat:
            debuff.stat,

          value:
            debuff.value,

          durationSeconds:
            debuff.duration
        }
      );

      appliedStatus =
        true;
    }

    let log:
      string;

    if (dodged) {
      log =
        `🌿 ${spell.name} misses the enemy!`;

    } else if (
      damageResult.crit
    ) {
      log =
        `🌿 Critical! ${spell.name} strikes for ${damage} damage!`;

    } else {
      log =
        `🌿 ${spell.name} strikes for ${damage} damage!`;
    }

    if (
      appliedStatus
    ) {
      log +=
        ` The enemy deals ${debuff.value}% less damage for ${debuff.duration}s!`;
    }

    return {
      log,
      damage,
      enemyHP,
      appliedStatus,

      killedEnemy:
        enemyHP <= 0,

      crit:
        Boolean(
          damageResult.crit
        ),

      dodged,

      threatMultiplier:
        TANK_ATTACK_THREAT_MULTIPLIER,

      threatGenerated:
        dodged
          ? 0
          : scaledThreatBonus(
              spell,
              "bonusThreat",
              100
            )
    };
  }
};

// =====================================================
// IRONBARK
// =====================================================

export const ironbarkHandler:
SpellHandlerDefinition = {
  requiresEnemy:
    false,

  validate(spell) {
    const buff =
      getConfiguredBuff(
        spell
      );

    if (
      buff.stat !==
      "defense"
    ) {
      return `${spell.name} must use defense`;
    }

    if (
      buff.value <= 0 ||
      buff.duration <= 0
    ) {
      return `${spell.name} has invalid buff configuration`;
    }

    return null;
  },

  async execute(
    context
  ): Promise<SpellHandlerResult> {
    const {
      playerId,
      spell,
      targetPlayerId
    } = context;

    const buff =
      getConfiguredBuff(
        spell
      );

    const targetId =
      Number(
        targetPlayerId ??
        playerId
      );

    const thornsPercent =
      Math.max(
        0,
        rankNumber(
          spell,
          "thornsDamagePercent",
          0
        )
      );

    const source =
      `spell:${spell.id}:ironbark`;

    await applyBuff(
      targetId,
      "defense",
      buff.value,
      buff.duration,
      source
    );

    await applyStatus(
      targetId,
      "sentinel_thorns_pct",
      thornsPercent,
      99,
      buff.duration,
      source
    );

    return {
      log:
        `🌳 ${spell.name} grants ${buff.value} Defense and reflects ${thornsPercent}% of incoming HP damage for ${buff.duration}s!`,

      appliedStatus:
        true,

      buffedTargetId:
        targetId
    };
  }
};

// =====================================================
// ROOTSNARE
// =====================================================

export const rootsnareHandler:
SpellHandlerDefinition = {
  requiresEnemy:
    true,

  validate(spell) {
    const debuff =
      getConfiguredDebuff(
        spell
      );

    if (
      debuff.stat !==
      "attack_speed_pct"
    ) {
      return `${spell.name} must use attack_speed_pct`;
    }

    if (
      debuff.value <= 0 ||
      debuff.duration <= 0
    ) {
      return `${spell.name} has invalid debuff configuration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    enemy
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Rootsnare handler received no enemy"
      );
    }

    const debuff =
      getConfiguredDebuff(
        spell
      );

    const enemyGaugeReduction =
      Math.max(
        0,
        rankNumber(
          spell,
          "enemyGaugeReduction",
          0
        )
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
            spell.name
          ),

        stat:
          debuff.stat,

        value:
          debuff.value,

        durationSeconds:
          debuff.duration
      }
    );

    return {
      log:
        `🌿 ${spell.name} slows the enemy by ${debuff.value}% for ${debuff.duration}s and removes ${enemyGaugeReduction} action gauge!`,

      enemyHP:
        Number(
          enemy.hp
        ),

      enemyGaugeReduction,

      appliedStatus:
        true
    };
  }
};

// =====================================================
// GUARDIAN GROVE
// =====================================================

export const guardianGroveHandler:
SpellHandlerDefinition = {
  requiresEnemy:
    false,

  validate(spell) {
    const buff =
      getConfiguredBuff(
        spell
      );

    if (
      buff.stat !==
      "damage_reduction"
    ) {
      return `${spell.name} must use damage_reduction`;
    }

    if (
      buff.value <= 0 ||
      buff.duration <= 0
    ) {
      return `${spell.name} has invalid buff configuration`;
    }

    return null;
  },

  async execute(
    context
  ): Promise<SpellHandlerResult> {
    const {
      spell
    } = context;

    const buff =
      getConfiguredBuff(
        spell
      );

    const healingReceived =
      Math.max(
        0,
        rankNumber(
          spell,
          "healingReceivedPercent",
          0
        )
      );

    const targets =
      livingTargets(
        context
      );

    for (
      const ally of
      targets
    ) {
      await applyBuff(
        ally.playerId,
        "damage_reduction",
        buff.value,
        buff.duration,
        `spell:${spell.id}:grove`
      );

      await applyBuff(
        ally.playerId,
        "healing_received_pct",
        healingReceived,
        buff.duration,
        `spell:${spell.id}:grove-healing`
      );
    }

    return {
      log:
        `🌲 ${spell.name} protects ${targets.length > 1 ? "the party" : "you"}, ` +
        `granting ${buff.value}% damage reduction and ${healingReceived}% increased healing received for ${buff.duration}s!`,

      appliedStatus:
        true
    };
  }
};

// =====================================================
// NATURE'S AEGIS
// =====================================================

export const naturesAegisHandler:
SpellHandlerDefinition = {
  requiresEnemy:
    false,

  validate(spell) {
    const buff =
      getConfiguredBuff(
        spell
      );

    if (
      buff.stat !==
      "shield_maxhp_pct"
    ) {
      return `${spell.name} must use shield_maxhp_pct`;
    }

    if (
      buff.value <= 0
    ) {
      return `${spell.name} has an invalid shield percentage`;
    }

    if (
      buff.duration <= 0
    ) {
      return `${spell.name} has an invalid shield duration`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player,
    maxPlayerHP,
    allies
  }): Promise<SpellHandlerResult> {
    const buff =
      getConfiguredBuff(
        spell
      );

    const targets =
      allies &&
      allies.length > 0
        ? allies.filter(
            ally =>
              Number(
                ally.hp
              ) > 0
          )
        : [{
            playerId,

            maxHp:
              Math.max(
                1,
                Number(
                  maxPlayerHP ??
                  player?.maxhp ??
                  1
                )
              )
          }];

    if (
      targets.length === 0
    ) {
      return {
        log:
          `🌳 You cast ${spell.name}, but there are no living allies to shield.`,

        appliedStatus:
          false
      };
    }

    const expiresAt =
      new Date(
        Date.now() +
        buff.duration *
        1000
      );

    const source =
      `spell:${spell.id}`;

    let totalShield =
      0;

    for (
      const ally of
      targets
    ) {
      const maximumHP =
        Math.max(
          1,
          Number(
            ally.maxHp ??
            1
          )
        );

      const shieldAmount =
        Math.max(
          1,
          Math.floor(
            maximumHP *
            (
              buff.value /
              100
            )
          )
        );

      await db.query(
        `
          INSERT INTO player_shields
          (
            player_id,
            max_absorb,
            remaining_absorb,
            expires_at,
            source
          )
          VALUES
          (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            max_absorb = VALUES(max_absorb),
            remaining_absorb = VALUES(remaining_absorb),
            expires_at = VALUES(expires_at)
        `,
        [
          ally.playerId,
          shieldAmount,
          shieldAmount,
          expiresAt,
          source
        ]
      );

      totalShield +=
        shieldAmount;

      const breakHealPercent =
        Math.max(
          0,
          rankNumber(
            spell,
            "shieldBreakHealMaxHpPercent",
            0
          )
        );

      if (
        breakHealPercent > 0
      ) {
        await applyStatus(
          Number(
            ally.playerId
          ),
          "natures_aegis_break_heal_pct",
          breakHealPercent,
          1,
          buff.duration,
          `shield:${source}`
        );
      }
    }

    return {
      log:
        targets.length > 1
          ? `🌳 You cast ${spell.name}, surrounding your company with natural barriers worth ${buff.value}% of each ally's maximum HP for ${buff.duration}s!`
          : `🌳 You cast ${spell.name}, gaining a ${totalShield}-point natural barrier for ${buff.duration}s!`,

      appliedStatus:
        true
    };
  }
};

// =====================================================
// ANCIENT PROTECTOR
// Self tank cooldown + persistent threat generation.
// =====================================================

export const ancientProtectorHandler:
SpellHandlerDefinition = {
  requiresEnemy:
    false,

  validate(spell) {
    const buff =
      getConfiguredBuff(
        spell
      );

    const baseTotalHealing =
      Number(
        spell.heal
      ) || 0;

    const hotDuration =
      Number(
        spell.dot_duration
      ) || 0;

    const tickInterval =
      Number(
        spell.dot_tick_rate
      ) || 0;

    if (
      buff.stat !==
      "damage_reduction"
    ) {
      return `${spell.name} must use damage_reduction`;
    }

    if (
      buff.value <= 0
    ) {
      return `${spell.name} has an invalid mitigation value`;
    }

    if (
      buff.duration <= 0
    ) {
      return `${spell.name} has an invalid buff duration`;
    }

    if (
      baseTotalHealing <= 0
    ) {
      return `${spell.name} has invalid healing configuration`;
    }

    if (
      hotDuration <= 0
    ) {
      return `${spell.name} has an invalid HOT duration`;
    }

    if (
      tickInterval <= 0
    ) {
      return `${spell.name} has an invalid HOT interval`;
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player,
    allies
  }): Promise<SpellHandlerResult> {
    const buff =
      getConfiguredBuff(
        spell
      );

    await applyBuff(
      playerId,
      buff.stat,
      buff.value,
      buff.duration,
      `spell:${spell.id}:protection`
    );

    const configuredThreatPercent =
      Math.max(
        0,
        rankNumber(
          spell,
          "threatGenerationPercent",
          0
        )
      );

    const threatGenerationPercent =
      Math.max(
        SENTINEL_THREAT_GENERATION_PERCENT,
        configuredThreatPercent
      );

    const allyInterceptPercent =
      Math.max(
        0,
        rankNumber(
          spell,
          "allyInterceptPercent",
          0
        )
      );

    const redirectedDamageReductionPercent =
      Math.max(
        0,
        rankNumber(
          spell,
          "redirectedDamageReductionPercent",
          0
        )
      );

    const deathPreventionCharges =
      Math.max(
        0,
        Math.floor(
          rankNumber(
            spell,
            "deathPreventionCharges",
            0
          )
        )
      );

    const deathPreventionHealPercent =
      Math.max(
        0,
        rankNumber(
          spell,
          "deathPreventionHealMaxHpPercent",
          0
        )
      );

    await applyStatus(
      playerId,
      "sentinel_threat_generation_pct",
      threatGenerationPercent,
      99,
      buff.duration,
      `spell:${spell.id}:ancient`
    );

    if (
      deathPreventionCharges > 0
    ) {
      await applyStatus(
        playerId,
        "sentinel_death_prevention",
        deathPreventionHealPercent,
        deathPreventionCharges,
        buff.duration,
        `spell:${spell.id}:ancient`
      );
    }

    for (
      const ally of
      (allies ?? [])
    ) {
      if (
        Number(
          ally.playerId
        ) ===
          Number(
            playerId
          ) ||
        Number(
          ally.hp
        ) <= 0
      ) {
        continue;
      }

      await applyStatus(
        Number(
          ally.playerId
        ),
        "sentinel_ancient_intercept",
        allyInterceptPercent,
        99,
        buff.duration,
        `ancient_protector:${playerId}`
      );

      if (
        redirectedDamageReductionPercent > 0
      ) {
        await applyStatus(
          Number(
            ally.playerId
          ),
          "sentinel_intercept_damage_reduction_pct",
          redirectedDamageReductionPercent,
          99,
          buff.duration,
          `ancient_protector:${playerId}`
        );
      }
    }

    const baseTotalHealing =
      Number(
        spell.heal
      ) || 0;

    const hotDuration =
      Number(
        spell.dot_duration
      ) || 0;

    const tickInterval =
      Number(
        spell.dot_tick_rate
      ) || 1;

    const totalTicks =
      Math.max(
        1,
        Math.floor(
          hotDuration /
          tickInterval
        )
      );

    const baseScaledHealing =
      calculateScaledSpellAmount(
        player,
        baseTotalHealing
      );

    const totalHealing =
      applyHealingReceivedMultiplier(
        player,
        baseScaledHealing
      );

    const healingPerTick =
      Math.max(
        1,
        Math.floor(
          totalHealing /
          totalTicks
        )
      );

    const expectedHealing =
      healingPerTick *
      totalTicks;

    const source =
      `spell:${spell.id}:hot`;

    await db.query(
      `
        DELETE FROM player_hots
        WHERE player_id = ?
          AND source = ?
      `,
      [
        playerId,
        source
      ]
    );

    await db.query(
      `
        INSERT INTO player_hots
        (
          player_id,
          healing,
          tick_interval,
          next_tick_at,
          expires_at,
          source,
          display_name
        )
        VALUES
        (
          ?,
          ?,
          ?,
          DATE_ADD(NOW(3), INTERVAL ? SECOND),
          DATE_ADD(NOW(3), INTERVAL ? SECOND),
          ?,
          ?
        )
      `,
      [
        playerId,
        healingPerTick,
        tickInterval,
        tickInterval,
        hotDuration,
        source,
        spell.name
      ]
    );

    return {
      log:
        `🌲 You invoke ${spell.name}, gaining ${buff.value}% damage reduction for ` +
        `${buff.duration}s, ${threatGenerationPercent}% increased threat, ally interception, ` +
        `one lethal-blow safeguard, and restoring up to ${expectedHealing} HP over ${hotDuration}s!`,

      appliedStatus:
        true,

      /*
       * Ancient Protector now gives an immediate burst
       * of threat as well as its persistent multiplier.
       */
      threatGenerated:
        Math.max(
          100,
          threatGenerationPercent
        )
    };
  }
};
