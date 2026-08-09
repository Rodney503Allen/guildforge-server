// src/services/spellHandlers/helpers.ts

import { ARCHETYPE_SCALING } from "../archetypeScaling";
import { resolveSpellDamage } from "../combatEngine";

import type {
  SpellEnemy
} from "./types";


// =====================================================
// PLAYER SCALING
// =====================================================

export function getPlayerScalingStat(
  player: any
): number {

  const archetype =
    String(
      player.archetype ||
      ""
    );

  if (
    !(
      archetype in
      ARCHETYPE_SCALING
    )
  ) {

    console.warn(
      `Unknown player archetype "${archetype}"`
    );

    return 0;
  }

  const scalingStat =
    ARCHETYPE_SCALING[
      archetype as keyof typeof ARCHETYPE_SCALING
    ];

  switch (
    scalingStat
  ) {

    case "attack":
      return (
        Number(
          player.attack
        ) || 0
      );

    case "agility":
      return (
        Number(
          player.agility
        ) || 0
      );

    case "intellect":
      return (
        Number(
          player.intellect
        ) || 0
      );

    default:
      return 0;
  }
}


// =====================================================
// ENEMY HP
// =====================================================

export async function setSpellEnemyHP(
  enemy: SpellEnemy,
  hp: number
) {

  const finalHP =
    Math.max(
      0,
      Math.floor(
        Number(hp) || 0
      )
    );

  /*
   * Let the combat system persist its
   * own authoritative enemy state.
   *
   * Normal combat:
   *   player_creatures
   *
   * Hunt combat:
   *   hunt_encounters
   *
   * Future:
   *   dungeon / raid encounter state
   */
  if (
    enemy.setHP
  ) {

    await enemy.setHP(
      finalHP
    );
  }

  /*
   * Always synchronize the handler-facing
   * representation too.
   */
  enemy.hp =
    finalHP;

  if (
    enemy.stats
  ) {

    enemy.stats.hpoints =
      finalHP;
  }

  return finalHP;
}


// =====================================================
// SPELL SCALING
// =====================================================

export function calculateScaledSpellAmount(
  player: any,
  baseAmount: number,
  coefficient = 0.5
): number {

  const statValue =
    getPlayerScalingStat(
      player
    );

  return Math.max(
    1,
    Math.floor(
      (
        Number(baseAmount) ||
        0
      ) +
      statValue *
        coefficient
    )
  );
}


// =====================================================
// DAMAGE RESOLUTION
// =====================================================

export function resolveDamageAgainstEnemy(
  player: any,
  enemy: SpellEnemy,
  amount: number
) {

  const stats =
    enemy.stats;

  const defender = {

    level:
      Number(
        stats?.level ??
        enemy.level ??
        1
      ),

    attack:
      Number(
        stats?.attack ??
        enemy.attack ??
        0
      ),

    defense:
      Number(
        stats?.defense ??
        enemy.defense ??
        0
      ),

    agility:
      Number(
        stats?.agility ??
        enemy.agility ??
        0
      ),

    vitality:
      Number(
        stats?.vitality ??
        0
      ),

    intellect:
      Number(
        stats?.intellect ??
        0
      ),

    crit:
      Number(
        stats?.crit ??
        0
      ),

    hpoints:
      Number(
        enemy.hp ??
        stats?.hpoints ??
        0
      ),

    spoints:
      Number(
        stats?.spoints ??
        0
      ),

    maxhp:
      Number(
        enemy.maxhp ??
        stats?.maxhp ??
        1
      ),

    maxspoints:
      Number(
        stats?.maxspoints ??
        0
      ),

    spellPower:
      Number(
        stats?.spellPower ??
        1
      ),

    dodgeChance:
      Number(
        stats?.dodgeChance ??
        0
      ),

    critDamageMult:
      Number(
        stats?.critDamageMult ??
        1.5
      ),

    damageReduction:
      Number(
        stats?.damageReduction ??
        0
      ),

    lifesteal:
      Number(
        stats?.lifesteal ??
        0
      ),

    healingReceivedMult:
      Number(
        stats?.healingReceivedMult ??
        1
      ),

    atbRateMult:
      Number(
        stats?.atbRateMult ??
        1
      ),

    damageTakenMult:
      Number(
        stats?.damageTakenMult ??
        1
      )
  };

  return resolveSpellDamage(
    player,
    defender,
    Math.max(
      0,
      Number(amount) || 0
    )
  );
}

// =====================================================
// DIRECT SPELL DAMAGE
// =====================================================

export function resolveDirectSpellDamage(
  player: any,
  enemy: SpellEnemy,
  baseDamage: number
) {

  const scaledDamage =
    calculateScaledSpellAmount(
      player,
      Math.max(
        0,
        Number(
          baseDamage
        ) || 0
      )
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

  return {
    damage,

    crit:
      Boolean(
        damageResult.crit
      ),

    dodged
  };
}


// =====================================================
// DOT CONFIGURATION
// =====================================================

export function getConfiguredDot(
  spell: any
) {

  return {
    damage:
      Math.max(
        0,
        Number(
          spell.dot_damage
        ) || 0
      ),

    duration:
      Math.max(
        0,
        Number(
          spell.dot_duration
        ) || 0
      ),

    tickRate:
      Math.max(
        0.1,
        Number(
          spell.dot_tick_rate
        ) || 1
      )
  };
}


// =====================================================
// DEBUFF CONFIGURATION
// =====================================================

export function getConfiguredDebuff(
  spell: any
) {

  return {
    stat:
      String(
        spell.debuff_stat ||
        ""
      )
        .trim()
        .toLowerCase(),

    value:
      Number(
        spell.debuff_value
      ) || 0,

    duration:
      Math.max(
        0,
        Number(
          spell.debuff_duration
        ) || 0
      )
  };
}


// =====================================================
// BUFF CONFIGURATION
// =====================================================

export function getConfiguredBuff(
  spell: any
) {

  return {
    stat:
      String(
        spell.buff_stat ||
        ""
      )
        .trim()
        .toLowerCase(),

    value:
      Number(
        spell.buff_value
      ) || 0,

    duration:
      Math.max(
        0,
        Number(
          spell.buff_duration
        ) || 0
      )
  };
}


// =====================================================
// APPLY DOT
// =====================================================

export async function applySpellDot(
  enemy: SpellEnemy,
  args: {
    sourcePlayerId: number;

    spellId: number;
    spellName: string;

    totalDamage: number;

    durationSeconds: number;
    tickRateSeconds: number;
  }
) {

  if (
    !enemy.applyDot
  ) {

    throw new Error(
      `DOT effects are not supported by enemy source "${
        enemy.sourceType ??
        "unknown"
      }".`
    );
  }

  const totalDamage =
    Math.max(
      0,
      Math.floor(
        Number(
          args.totalDamage
        ) || 0
      )
    );

  const durationSeconds =
    Math.max(
      0,
      Number(
        args.durationSeconds
      ) || 0
    );

  const tickRateSeconds =
    Math.max(
      0.1,
      Number(
        args.tickRateSeconds
      ) || 1
    );

  if (
    totalDamage <= 0 ||
    durationSeconds <= 0
  ) {

    throw new Error(
      `Invalid DOT configuration for ${args.spellName}.`
    );
  }

  return enemy.applyDot({
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

    durationSeconds,

    tickRateSeconds
  });
}


// =====================================================
// APPLY DEBUFF
// =====================================================

export async function applySpellDebuff(
  enemy: SpellEnemy,
  args: {
    sourcePlayerId: number;

    spellId: number;
    spellName: string;

    stat: string;
    value: number;

    durationSeconds: number;
  }
) {

  if (
    !enemy.applyDebuff
  ) {

    throw new Error(
      `Debuff effects are not supported by enemy source "${
        enemy.sourceType ??
        "unknown"
      }".`
    );
  }

  const stat =
    String(
      args.stat ||
      ""
    )
      .trim()
      .toLowerCase();

  const value =
    Number(
      args.value
    ) || 0;

  const durationSeconds =
    Math.max(
      0,
      Number(
        args.durationSeconds
      ) || 0
    );

  if (
    !stat ||
    durationSeconds <= 0
  ) {

    throw new Error(
      `Invalid debuff configuration for ${args.spellName}.`
    );
  }

  return enemy.applyDebuff({
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

    durationSeconds
  });
}


export async function getSpellEnemyDebuffValue(
  enemy: SpellEnemy,
  stat: string
): Promise<number> {

  if (
    !enemy.getDebuffValue
  ) {
    return 0;
  }

  return Math.max(
    0,
    Number(
      await enemy.getDebuffValue(
        String(stat)
          .trim()
          .toLowerCase()
      )
    ) || 0
  );
}


// =====================================================
// HEALING MODIFIER
// =====================================================

export function applyHealingReceivedMultiplier(
  player: any,
  healing: number
): number {

  const multiplier =
    Math.max(
      0,
      Number(
        player.healingReceivedMult
      ) || 1
    );

  return Math.max(
    1,
    Math.floor(
      (
        Number(
          healing
        ) || 0
      ) *
      multiplier
    )
  );
}