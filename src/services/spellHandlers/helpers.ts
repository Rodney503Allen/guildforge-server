// src/services/spellHandlers/helpers.ts

import { resolveSpellDamage } from "../combatEngine";

import type {
  SpellEnemy
} from "./types";


// =====================================================
// PLAYER SPELL SCALING
//
// All Guildforge spells scale from Intellect.
//
// Attack:
//   Weapon / basic attack damage
//
// Agility:
//   ATB speed, dodge, crit contribution
//
// Intellect:
//   Spell damage and spell healing
// =====================================================

export function getPlayerScalingStat(
  player: any
): number {

  return Math.max(
    0,
    Number(
      player?.intellect ??
      player?.stats?.intellect ??
      0
    ) || 0
  );
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

/**
 * Applies the caster's outgoing-healing modifier after normal spell scaling.
 * Recipient-side healing modifiers are intentionally applied separately.
 */
export function calculateScaledHealingAmount(
  player: any,
  baseAmount: number,
  coefficient = 0.5
): number {
  const scaled = calculateScaledSpellAmount(player, baseAmount, coefficient);
  const rawMultiplier = Number(
    player?.healingDealtMult ?? player?.stats?.healingDealtMult ?? 1
  );
  const multiplier = Number.isFinite(rawMultiplier)
    ? Math.max(0, rawMultiplier)
    : 1;

  return Math.max(0, Math.floor(scaled * multiplier));
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

    const combatStats = stats as
  | (typeof stats & {
      critChanceTakenPercent?: number;
      criticalDamageTakenPercent?: number;
    })
  | undefined;

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

    healingDealtMult:
      Number(
        stats?.healingDealtMult ??
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
      ),

    spellDamageTakenMult:
      Number(
        stats?.spellDamageTakenMult ??
        1
      ),

    critChanceTakenPercent:
      Number(
        combatStats?.critChanceTakenPercent ?? 0
      ),

    criticalDamageTakenPercent:
      Number(
        combatStats?.criticalDamageTakenPercent ?? 0
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
    immediateFirstTick?: boolean;
    defenseReductionPerTick?: number;
    defenseReductionMaxStacks?: number;
    manaRestorePercentPerTick?: number;
    escalationPercentPerTick?: number;
    escalationMaxPercent?: number;
    healingReductionPercent?: number;
    tickHealingPercent?: number;
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

    tickRateSeconds,
    immediateFirstTick: Boolean(args.immediateFirstTick),
    defenseReductionPerTick: Number(args.defenseReductionPerTick) || 0,
    defenseReductionMaxStacks: Number(args.defenseReductionMaxStacks) || 0,
    manaRestorePercentPerTick: Number(args.manaRestorePercentPerTick) || 0
    ,escalationPercentPerTick: Number(args.escalationPercentPerTick) || 0
    ,escalationMaxPercent: Number(args.escalationMaxPercent) || 0
    ,healingReductionPercent: Number(args.healingReductionPercent) || 0
    ,tickHealingPercent: Number(args.tickHealingPercent) || 0
  } as any);
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

export async function processJudgmentSpellHit(
  enemy: SpellEnemy | null | undefined,
  args: {
    playerId: number;
    spellId: number;
    spellName: string;
    damage: number;
    crit: boolean;
  }
) {
  if (!enemy || args.damage <= 0 || args.spellId === 26) return;
  const current = await getSpellEnemyDebuffValue(enemy, "judgment");
  if (current <= 0) return;

  const upgrade = await getSpellEnemyDebuffValue(enemy, "judgment_crit_upgrade");
  if (args.crit && upgrade >= 2) {
    await applySpellDebuff(enemy, {
      sourcePlayerId: args.playerId, spellId: args.spellId,
      spellName: args.spellName, stat: "judgment", value: 2,
      durationSeconds: 14
    });
    return;
  }

  const duration = await getSpellEnemyDebuffValue(enemy, "judgment_refresh_on_spell");
  const onCooldown = await getSpellEnemyDebuffValue(enemy, "judgment_refresh_icd");
  if (duration > 0 && onCooldown <= 0) {
    await applySpellDebuff(enemy, {
      sourcePlayerId: args.playerId, spellId: args.spellId,
      spellName: args.spellName, stat: "judgment", value: current,
      durationSeconds: duration
    });
    await applySpellDebuff(enemy, {
      sourcePlayerId: args.playerId, spellId: args.spellId,
      spellName: args.spellName, stat: "judgment_refresh_icd", value: 1,
      durationSeconds: 4
    });
  }
}
