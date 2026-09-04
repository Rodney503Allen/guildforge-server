// src/services/spellHandlers/rangerHandlers.ts
import {
  SpellEnemy,
  SpellHandlerDefinition,
  SpellHandlerResult,
} from "./types";
import {
  applySpellDebuff,
  applySpellDot,
  calculateScaledSpellAmount,
  getConfiguredDot,
  getSpellEnemyDebuffValue,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP,
} from "./helpers";

function rankNumber(spell: any, key: string, fallback = 0): number {
  const value = Number(spell?.rank_config?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function validateDamage(spell: any): string | null {
  return (Number(spell.damage) || 0) > 0
    ? null
    : `${spell.name} has invalid damage configuration`;
}

async function isPoisoned(enemy: SpellEnemy): Promise<boolean> {
  return (await getSpellEnemyDebuffValue(enemy, "poisoned")) > 0;
}

async function dealRangerDamage(
  spell: any,
  player: any,
  enemy: SpellEnemy,
  options: {
    damageMultiplier?: number;
    defenseIgnorePct?: number;
    critChanceBonusPct?: number;
    forceCrit?: boolean;
  } = {},
) {
  const multiplier = Math.max(0, Number(options.damageMultiplier) || 1);
  const defenseIgnore = Math.max(
    0,
    Math.min(100, Number(options.defenseIgnorePct) || 0),
  );
  const critBonus = Math.max(0, Number(options.critChanceBonusPct) || 0) / 100;
  const scaled = calculateScaledSpellAmount(player, Number(spell.damage) || 0);
  const amount = Math.max(1, Math.floor(scaled * multiplier));
  const defense = Math.max(
    0,
    Number(enemy.stats?.defense ?? enemy.defense ?? 0) || 0,
  );
  const reducedDefense = Math.max(
    0,
    Math.floor(defense * (1 - defenseIgnore / 100)),
  );
  const modifiedEnemy: SpellEnemy = {
    ...enemy,
    defense: reducedDefense,
    stats: enemy.stats
      ? { ...enemy.stats, defense: reducedDefense }
      : enemy.stats,
  };
  const modifiedPlayer =
    critBonus > 0
      ? {
          ...player,
          crit: Math.min(1, Math.max(0, Number(player?.crit) || 0) + critBonus),
        }
      : player;
  let resolution = resolveDamageAgainstEnemy(
    modifiedPlayer,
    modifiedEnemy,
    amount,
  );

  if (options.forceCrit && !resolution.crit && !resolution.dodged) {
    const critMultiplier = Math.max(1, Number(player?.critDamageMult) || 1.5);
    resolution = {
      ...resolution,
      damage: Math.max(
        1,
        Math.floor((Number(resolution.damage) || 1) * critMultiplier),
      ),
      crit: true,
    };
  }

  const dodged = Boolean(resolution.dodged);
  const damage = dodged ? 0 : Math.max(1, Number(resolution.damage) || 1);
  const enemyHP = Math.max(0, Number(enemy.hp) - damage);
  await setSpellEnemyHP(enemy, enemyHP);
  return { damage, enemyHP, critical: Boolean(resolution.crit), dodged };
}

function damageResult(
  spell: any,
  result: Awaited<ReturnType<typeof dealRangerDamage>>,
  hitText: string,
  extraLog = "",
): SpellHandlerResult {
  const log = result.dodged
    ? `🏹 ${spell.name} misses the enemy!`
    : result.critical
      ? `🏹 Critical! ${spell.name} ${hitText} for ${result.damage} damage!${extraLog}`
      : `🏹 ${spell.name} ${hitText} for ${result.damage} damage!${extraLog}`;
  return {
    log,
    damage: result.damage,
    enemyHP: result.enemyHP,
    killedEnemy: result.enemyHP <= 0,
    crit: result.critical,
    dodged: result.dodged,
  };
}

export const quickShotHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate: validateDamage,
  async execute({ spell, player, enemy }): Promise<SpellHandlerResult> {
    if (!enemy) throw new Error("Quick Shot handler received no enemy");
    const result = await dealRangerDamage(spell, player, enemy);
    const base = damageResult(spell, result, "strikes");
    const gauge = result.dodged
      ? 0
      : Math.max(0, rankNumber(spell, "casterGaugeGain", 10));
    return {
      ...base,
      casterGaugeGain: gauge,
      log: result.dodged
        ? base.log
        : `${base.log} You gain ${gauge} action gauge.`,
    };
  },
};

export const poisonArrowHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate(spell) {
    const dot = getConfiguredDot(spell);
    if (dot.damage <= 0) return `${spell.name} has invalid poison damage`;
    if (dot.duration <= 0 || dot.tickRate <= 0)
      return `${spell.name} has invalid poison duration`;
    return null;
  },
  async execute({
    playerId,
    spell,
    player,
    enemy,
  }): Promise<SpellHandlerResult> {
    if (!enemy) throw new Error("Poison Arrow handler received no enemy");
    const dot = getConfiguredDot(spell);
    const scaled = calculateScaledSpellAmount(player, dot.damage);
    const resolution = resolveDamageAgainstEnemy(player, enemy, scaled);
    const totalDamage = Math.max(1, Number(resolution.damage) || 1);
    await applySpellDot(enemy, {
      sourcePlayerId: playerId,
      spellId: Number(spell.id),
      spellName: String(spell.name),
      totalDamage,
      durationSeconds: dot.duration,
      tickRateSeconds: dot.tickRate,
      immediateFirstTick: Boolean(spell.rank_config?.immediateFirstTick),
    });
    await applySpellDebuff(enemy, {
      sourcePlayerId: playerId,
      spellId: Number(spell.id),
      spellName: String(spell.name),
      stat: "poisoned",
      value: 1,
      durationSeconds: dot.duration,
    });
    return {
      log: `☠ ${spell.name} poisons the enemy for ${totalDamage} damage over ${dot.duration}s!`,
      enemyHP: Number(enemy.hp),
      appliedStatus: true,
      killedEnemy: false,
      crit: Boolean(resolution.crit),
      dodged: false,
    };
  },
};

export const aimedShotHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate: validateDamage,
  async execute({ spell, player, enemy }): Promise<SpellHandlerResult> {
    if (!enemy) throw new Error("Aimed Shot handler received no enemy");
    const poisoned = await isPoisoned(enemy);
    const poisonBonus = Math.max(
      0,
      rankNumber(spell, "poisonedDamageBonusPercent", 20),
    );
    const critBonus = Math.max(
      0,
      rankNumber(spell, "critChanceBonusPercent", 15),
    );
    const result = await dealRangerDamage(spell, player, enemy, {
      damageMultiplier: poisoned ? 1 + poisonBonus / 100 : 1,
      critChanceBonusPct: critBonus,
      defenseIgnorePct: Math.max(
        0,
        rankNumber(spell, "talentDefenseIgnorePercent", 0),
      ),
    });
    return damageResult(
      spell,
      result,
      "finds its mark",
      poisoned && !result.dodged
        ? ` Poison increases the hit by ${poisonBonus}%.`
        : "",
    );
  },
};

export const volleyHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate: validateDamage,

  async execute({
    playerId,
    spell,
    player,
    enemy,
    enemies,
  }): Promise<SpellHandlerResult> {
    if (!enemy) {
      throw new Error(
        "Volley handler received no enemy"
      );
    }

    const targets =
      (
        Array.isArray(
          enemies
        ) &&
        enemies.length
          ? enemies
          : [
              enemy
            ]
      )
        .filter(
          target =>
            Number(
              target.hp
            ) > 0
        );

    const poisonBonus =
      Math.max(
        0,
        rankNumber(
          spell,
          "poisonedDamageBonusPercent",
          20
        ),
      );

    const venomousRainPercent =
      Math.max(
        0,
        rankNumber(
          spell,
          "venomousRainEffectivenessPercent",
          0
        ),
      );

    const enemyResults:
      any[] =
      [];

    let totalDamage =
      0;

    let statusTargets =
      0;

    for (
      const target of
      targets
    ) {
      const poisoned =
        await isPoisoned(
          target
        );

      const result =
        await dealRangerDamage(
          spell,
          player,
          target,
          {
            damageMultiplier:
              poisoned
                ? 1 +
                  poisonBonus /
                  100
                : 1,
          }
        );

      totalDamage +=
        result.damage;

      if (
        !result.dodged &&
        result.enemyHP > 0 &&
        venomousRainPercent > 0
      ) {
        const poisonDamage =
          Math.max(
            1,
            Math.floor(
              (
                result.damage *
                venomousRainPercent
              ) /
              100
            ),
          );

        await applySpellDot(
          target,
          {
            sourcePlayerId:
              playerId,

            spellId:
              Number(
                spell.id
              ),

            spellName:
              `${spell.name} — Venomous Rain`,

            totalDamage:
              poisonDamage,

            durationSeconds:
              12,

            tickRateSeconds:
              2,
          }
        );

        await applySpellDebuff(
          target,
          {
            sourcePlayerId:
              playerId,

            spellId:
              Number(
                spell.id
              ),

            spellName:
              `${spell.name} — Venomous Rain`,

            stat:
              "poisoned",

            value:
              1,

            durationSeconds:
              12,
          }
        );

        statusTargets++;
      }

      enemyResults.push({
        enemyId:
          Number(
            target.id
          ),

        enemyName:
          target.name,

        damage:
          result.damage,

        enemyHP:
          result.enemyHP,

        killedEnemy:
          result.enemyHP <= 0,

        crit:
          result.critical,

        dodged:
          result.dodged,
      });
    }

    return {
      log:
        `🏹 ${spell.name} rains across ${targets.length} enem${targets.length === 1 ? "y" : "ies"} for ${totalDamage} total damage${statusTargets > 0 ? ` and poisons ${statusTargets}` : ""}!`,

      damage:
        totalDamage,

      enemyHP:
        enemyResults[0]
          ?.enemyHP ??
        Number(
          enemy.hp
        ),

      enemyResults,

      targetsHit:
        enemyResults.filter(
          hit =>
            !hit.dodged
        ).length,

      appliedStatus:
        statusTargets > 0,

      killedEnemy:
        Boolean(
          enemyResults[0]
            ?.killedEnemy
        ),

      crit:
        enemyResults.some(
          hit =>
            hit.crit
        ),

      dodged:
        enemyResults.every(
          hit =>
            hit.dodged
        ),
    };
  },
};

export const piercingArrowHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate: validateDamage,
  async execute({
    playerId,
    spell,
    player,
    enemy,
  }): Promise<SpellHandlerResult> {
    if (!enemy) throw new Error("Piercing Arrow handler received no enemy");
    const ignore = Math.max(0, rankNumber(spell, "defenseIgnorePercent", 40));
    const armorBreak = Math.max(0, rankNumber(spell, "armorBreakPercent", 10));
    const duration = Math.max(
      1,
      rankNumber(spell, "armorBreakDurationSeconds", 8),
    );
    const result = await dealRangerDamage(spell, player, enemy, {
      defenseIgnorePct: ignore,
    });
    if (!result.dodged && result.enemyHP > 0) {
      await applySpellDebuff(enemy, {
        sourcePlayerId: playerId,
        spellId: Number(spell.id),
        spellName: String(spell.name),
        stat: "damage_taken_pct",
        value: armorBreak,
        durationSeconds: duration,
      });
    }
    return {
      ...damageResult(
        spell,
        result,
        "pierces the enemy",
        !result.dodged
          ? ` It ignores ${ignore}% Defense and breaks its armor by ${armorBreak}% for ${duration}s.`
          : "",
      ),
      appliedStatus: !result.dodged && result.enemyHP > 0,
    };
  },
};

export const deadeyeHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate: validateDamage,
  async execute({ spell, player, enemy }): Promise<SpellHandlerResult> {
    if (!enemy) throw new Error("Deadeye handler received no enemy");
    const currentHP = Math.max(0, Number(enemy.hp) || 0);
    const maxHP = Math.max(1, Number(enemy.maxhp) || 1);
    const healthFraction = Math.max(0, Math.min(1, currentHP / maxHP));
    const missingHealthMax = Math.max(
      0,
      rankNumber(spell, "missingHealthDamageBonusMaxPercent", 50),
    );
    const threshold = Math.max(
      0,
      Math.min(100, rankNumber(spell, "executeThresholdPercent", 30)),
    );
    const executeBonus = Math.max(
      0,
      rankNumber(spell, "executeDamageBonusPercent", 75),
    );
    const defenseIgnore = Math.max(
      0,
      rankNumber(spell, "defenseIgnorePercent", 50),
    );
    const executeActive = healthFraction <= threshold / 100;
    const missingHealthBonus = (1 - healthFraction) * missingHealthMax;
    const result = await dealRangerDamage(spell, player, enemy, {
      damageMultiplier:
        1 + missingHealthBonus / 100 + (executeActive ? executeBonus / 100 : 0),
      defenseIgnorePct: defenseIgnore,
      forceCrit:
        executeActive && Boolean(spell?.rank_config?.executeGuaranteedCrit),
    });
    return damageResult(
      spell,
      result,
      "strikes",
      executeActive && !result.dodged
        ? " Deadeye's lethal precision executes the critically wounded target!"
        : !result.dodged
          ? ` Missing health increases the shot by ${Math.floor(missingHealthBonus)}%.`
          : "",
    );
  },
};
