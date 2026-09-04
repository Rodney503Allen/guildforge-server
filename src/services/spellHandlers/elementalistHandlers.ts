// src/services/spellHandlers/elementalistHandlers.ts

import {
  SpellHandlerDefinition,
  SpellHandlerResult
} from "./types";

import {
  applySpellDebuff,
  applySpellDot,
  calculateScaledSpellAmount,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";


// =====================================================
// FROST LANCE
// Deals direct damage and slows enemy ATB speed.
// =====================================================

export const frostLanceHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,


  validate(spell) {

    const baseDamage =
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
      baseDamage <= 0
    ) {
      return (
        `${spell.name} has invalid damage configuration`
      );
    }


    if (
      debuffStat !==
      "attack_speed_pct"
    ) {
      return (
        `${spell.name} must use attack_speed_pct`
      );
    }


    if (
      debuffValue <= 0
    ) {
      return (
        `${spell.name} has an invalid slow percentage`
      );
    }


    if (
      debuffDuration <= 0
    ) {
      return (
        `${spell.name} has an invalid slow duration`
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

    if (
      !enemy
    ) {
      throw new Error(
        "Frost Lance handler received no enemy"
      );
    }


    const baseDamage =
      Number(
        spell.damage
      ) || 0;


    const scaledDamage =
      calculateScaledSpellAmount(
        player,
        baseDamage
      );


    const damageResult =
      resolveDamageAgainstEnemy(
        player,
        enemy,
        scaledDamage
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


    /*
     * Universal enemy persistence.
     *
     * Normal combat:
     * player_creatures
     *
     * Hunt:
     * Hunt encounter session
     */
    await setSpellEnemyHP(
      enemy,
      enemyHP
    );


    let appliedStatus =
      false;


    /*
     * Do not apply the slow if:
     * - the attack missed
     * - the enemy died
     */
    if (
      enemyHP > 0 &&
      !damageResult.dodged
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
              "Frost Lance"
            ),

          stat:
            "attack_speed_pct",

          value:
            Number(
              spell.debuff_value
            ) || 15,

          durationSeconds:
            Number(
              spell.debuff_duration
            ) || 8
        }
      );


      appliedStatus =
        true;
    }


    const slowPercent =
      Number(
        spell.debuff_value
      ) || 15;


    const slowDuration =
      Number(
        spell.debuff_duration
      ) || 8;


    let log:
      string;


    if (
      damageResult.dodged
    ) {

      log =
        `❄️ ${spell.name} misses the enemy!`;

    } else if (
      damageResult.crit
    ) {

      log =
        `❄️ Critical! ${spell.name} pierces the enemy ` +
        `for ${damage} damage!`;

    } else {

      log =
        `❄️ You cast ${spell.name} for ` +
        `${damage} damage!`;
    }


    if (
      appliedStatus
    ) {

      log +=
        ` The enemy is slowed by ${slowPercent}% ` +
        `for ${slowDuration}s!`;
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

      dodged:
        Boolean(
          damageResult.dodged
        )
    };
  }
};


// =====================================================
// CHAIN LIGHTNING
//
// Current behavior:
// Strikes the current enemy.
//
// Hunt combat currently contains one Hunt target,
// so this naturally hits that target.
//
// Future dungeon/raid behavior:
// Bounce to multiple active enemies.
// =====================================================

export const chainLightningHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,

  validate(spell) {
    const baseDamage =
      Number(
        spell.damage
      ) || 0;

    if (
      baseDamage <= 0
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
    enemy,
    enemies
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {
      throw new Error(
        "Chain Lightning handler received no enemy"
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
        )
        .slice(
          0,
          3
        );

    const baseDamage =
      Number(
        spell.damage
      ) || 0;

    const bounceMultipliers =
      [
        1,
        0.75,
        0.5
      ];

    const enemyResults:
      any[] =
      [];

    let totalDamage =
      0;

    for (
      let index = 0;
      index <
      targets.length;
      index++
    ) {
      const target =
        targets[index];

      const scaledDamage =
        calculateScaledSpellAmount(
          player,
          baseDamage
        );

      const bounceDamage =
        Math.max(
          1,
          Math.floor(
            scaledDamage *
            (
              bounceMultipliers[
                index
              ] ??
              0.5
            )
          )
        );

      const damageResult =
        resolveDamageAgainstEnemy(
          player,
          target,
          bounceDamage
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
            target.hp
          ) -
          damage
        );

      await setSpellEnemyHP(
        target,
        enemyHP
      );

      totalDamage +=
        damage;

      enemyResults.push({
        enemyId:
          Number(
            target.id
          ),

        enemyName:
          target.name,

        damage,

        enemyHP,

        killedEnemy:
          enemyHP <= 0,

        crit:
          Boolean(
            damageResult.crit
          ),

        dodged:
          Boolean(
            damageResult.dodged
          ),
      });
    }

    const hits =
      enemyResults.filter(
        hit =>
          !hit.dodged
      ).length;

    return {
      log:
        targets.length > 1
          ? `⚡ ${spell.name} arcs through ${targets.length} enemies for ${totalDamage} total damage!`
          : enemyResults[0]?.dodged
            ? `⚡ ${spell.name} misses the enemy!`
            : `⚡ ${spell.name} strikes the enemy for ${totalDamage} damage!`,

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
        hits,

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
        hits === 0,
    };
  }
};


// =====================================================
// INFERNO
//
// Deals immediate damage and applies a burn to all living enemies
// when the owning combat mode supplies a hostile collection.
// =====================================================

export const infernoHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,

  validate(spell) {
    const directDamage =
      Number(
        spell.damage
      ) || 0;

    const dotDamage =
      Number(
        spell.dot_damage
      ) || 0;

    const dotDuration =
      Number(
        spell.dot_duration
      ) || 0;

    const tickInterval =
      Number(
        spell.dot_tick_rate
      ) || 0;

    if (
      directDamage <= 0
    ) {
      return (
        `${spell.name} has invalid direct damage`
      );
    }

    if (
      dotDamage <= 0
    ) {
      return (
        `${spell.name} has invalid burn damage`
      );
    }

    if (
      dotDuration <= 0
    ) {
      return (
        `${spell.name} has invalid burn duration`
      );
    }

    if (
      tickInterval <= 0
    ) {
      return (
        `${spell.name} has invalid burn tick interval`
      );
    }

    return null;
  },

  async execute({
    playerId,
    spell,
    player,
    enemy,
    enemies
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {
      throw new Error(
        "Inferno handler received no enemy"
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

    const dotDuration =
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
          dotDuration /
          tickInterval
        )
      );

    const enemyResults:
      any[] =
      [];

    let totalDirectDamage =
      0;

    let burnedTargets =
      0;

    for (
      const target of
      targets
    ) {
      const scaledDirectDamage =
        calculateScaledSpellAmount(
          player,
          Number(
            spell.damage
          ) || 0
        );

      const directResult =
        resolveDamageAgainstEnemy(
          player,
          target,
          scaledDirectDamage
        );

      const directDamage =
        directResult.dodged
          ? 0
          : Math.max(
              1,
              Number(
                directResult.damage
              ) || 1
            );

      const enemyHP =
        Math.max(
          0,
          Number(
            target.hp
          ) -
          directDamage
        );

      await setSpellEnemyHP(
        target,
        enemyHP
      );

      totalDirectDamage +=
        directDamage;

      if (
        !directResult.dodged &&
        enemyHP > 0
      ) {
        const scaledDamagePerTick =
          calculateScaledSpellAmount(
            player,
            Number(
              spell.dot_damage
            ) || 0,
            0.15
          );

        const dotResult =
          resolveDamageAgainstEnemy(
            player,
            target,
            scaledDamagePerTick
          );

        const damagePerTick =
          Math.max(
            1,
            Number(
              dotResult.damage
            ) || 1
          );

        const totalDotDamage =
          damagePerTick *
          totalTicks;

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
              String(
                spell.name ||
                "Inferno"
              ),

            totalDamage:
              totalDotDamage,

            durationSeconds:
              dotDuration,

            tickRateSeconds:
              tickInterval,

            escalationPercentPerTick:
              Number(
                spell.rank_config
                  ?.dotEscalationPercent
              ) || 0,

            escalationMaxPercent:
              Number(
                spell.rank_config
                  ?.dotEscalationCap
              ) || 0,

            healingReductionPercent:
              Number(
                spell.rank_config
                  ?.dotHealingReductionPercent
              ) || 0
          } as any
        );

        burnedTargets++;
      }

      enemyResults.push({
        enemyId:
          Number(
            target.id
          ),

        enemyName:
          target.name,

        damage:
          directDamage,

        enemyHP,

        killedEnemy:
          enemyHP <= 0,

        crit:
          Boolean(
            directResult.crit
          ),

        dodged:
          Boolean(
            directResult.dodged
          ),
      });
    }

    return {
      log:
        `🔥 ${spell.name} engulfs ${targets.length} enem${targets.length === 1 ? "y" : "ies"} for ${totalDirectDamage} total damage${burnedTargets > 0 ? ` and burns ${burnedTargets}` : ""}!`,

      damage:
        totalDirectDamage,

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
        burnedTargets > 0,

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
  }
};


// =====================================================
// CATACLYSM
//
// Massive elemental damage to all living enemies.
// =====================================================

export const cataclysmHandler:
SpellHandlerDefinition = {

  requiresEnemy:
    true,

  validate(spell) {
    const baseDamage =
      Number(
        spell.damage
      ) || 0;

    if (
      baseDamage <= 0
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
    enemy,
    enemies
  }): Promise<SpellHandlerResult> {

    if (
      !enemy
    ) {
      throw new Error(
        "Cataclysm handler received no enemy"
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

    const enemyResults:
      any[] =
      [];

    let totalDamage =
      0;

    for (
      const target of
      targets
    ) {
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
          target,
          scaledDamage
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
            target.hp
          ) -
          damage
        );

      await setSpellEnemyHP(
        target,
        enemyHP
      );

      totalDamage +=
        damage;

      enemyResults.push({
        enemyId:
          Number(
            target.id
          ),

        enemyName:
          target.name,

        damage,

        enemyHP,

        killedEnemy:
          enemyHP <= 0,

        crit:
          Boolean(
            damageResult.crit
          ),

        dodged:
          Boolean(
            damageResult.dodged
          ),
      });
    }

    return {
      log:
        `🌩️ ${spell.name} tears through ${targets.length} enem${targets.length === 1 ? "y" : "ies"} for ${totalDamage} total damage!`,

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
  }
};
