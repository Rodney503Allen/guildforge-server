// src/services/spellHandlers/berserkerHandlers.ts
import { db } from "../../db";
import { applyBuff } from "../buffService";
import type { SpellEnemy, SpellHandlerContext, SpellHandlerDefinition, SpellHandlerResult } from "./types";
import {
  applySpellDot,
  calculateScaledSpellAmount,
  getConfiguredDot,
  resolveDamageAgainstEnemy,
  setSpellEnemyHP
} from "./helpers";

function configNumber(spell: any, key: string, fallback = 0): number {
  const value = Number(spell?.rank_config?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function maximumHP(context: SpellHandlerContext): number {
  return Math.max(1, Number(context.maxPlayerHP ?? context.player?.maxhp ?? 1));
}

function maximumMana(context: SpellHandlerContext): number {
  return Math.max(1, Number(context.maxPlayerSP ?? context.player?.maxspoints ?? 1));
}

async function dealBerserkerDamage(spell: any, player: any, enemy: SpellEnemy, multiplier = 1, defensePenetrationPercent = 0) {
  const scaled = calculateScaledSpellAmount(player, Number(spell.damage) || 0);
  const penetration = Math.max(0, Math.min(100, defensePenetrationPercent));
  const effectiveEnemy: any = penetration > 0
    ? { ...enemy, defense: Number(enemy.defense || 0) * (1 - penetration / 100), stats: enemy.stats ? { ...enemy.stats, defense: Number(enemy.stats.defense || 0) * (1 - penetration / 100) } : undefined }
    : enemy;
  const result = resolveDamageAgainstEnemy(player, effectiveEnemy, Math.max(1, Math.floor(scaled * multiplier)));
  const dodged = Boolean(result.dodged);
  const damage = dodged ? 0 : Math.max(1, Number(result.damage) || 1);
  const enemyHP = Math.max(0, Number(enemy.hp) - damage);
  await setSpellEnemyHP(enemy, enemyHP);
  return { damage, enemyHP, critical: Boolean(result.crit), dodged };
}

export const frenziedSlashHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate(spell) {
    return (Number(spell.damage) || 0) > 0 ? null : `${spell.name} has invalid damage configuration`;
  },
  async execute({ playerId, spell, player, enemy }): Promise<SpellHandlerResult> {
    if (!enemy) throw new Error("Frenzied Slash received no enemy");
    const result = await dealBerserkerDamage(spell, player, enemy);
    const gaugeGain = result.dodged ? 0 : Math.max(0, configNumber(spell, "casterGaugeGain", 8));
    return {
      log: result.dodged
        ? `🪓 ${spell.name} misses the enemy!`
        : `🪓 ${spell.name} tears into the enemy for ${result.damage} damage${result.critical ? " (CRITICAL!)" : ""}!${gaugeGain ? ` You gain ${gaugeGain} action gauge.` : ""}`,
      damage: result.damage,
      enemyHP: result.enemyHP,
      killedEnemy: result.enemyHP <= 0,
      crit: result.critical,
      dodged: result.dodged,
      casterGaugeGain: gaugeGain,
      sourcePlayerId: playerId
    };
  }
};

export const rendHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate(spell) {
    const dot = getConfiguredDot(spell);
    if (dot.damage <= 0) return `${spell.name} has invalid bleed damage`;
    if (dot.duration <= 0 || dot.tickRate <= 0) return `${spell.name} has invalid bleed timing`;
    return null;
  },
  async execute({ playerId, spell, player, enemy }): Promise<SpellHandlerResult> {
    if (!enemy) throw new Error("Rend received no enemy");
    const dot = getConfiguredDot(spell);
    const resolved = resolveDamageAgainstEnemy(player, enemy, calculateScaledSpellAmount(player, dot.damage));
    const totalDamage = Math.max(1, Number(resolved.damage) || 1);
    const rupturePercent = Math.max(0, configNumber(spell, "rendRupturePercent"));
    const consumed = rupturePercent > 0 && (enemy as any).consumeDot
      ? Math.max(0, Number(await (enemy as any).consumeDot(playerId, Number(spell.id))) || 0)
      : 0;
    const ruptureDamage = Math.floor(consumed * rupturePercent / 100);
    const immediateDamage = Math.floor(totalDamage * Math.max(0, configNumber(spell, "rendImmediateDamagePercent")) / 100);
    const directDamage = ruptureDamage + immediateDamage;
    let enemyHP = Number(enemy.hp);
    if (directDamage > 0) {
      enemyHP = Math.max(0, enemyHP - directDamage);
      await setSpellEnemyHP(enemy, enemyHP);
    }
    if (enemyHP <= 0) return { log: `🩸 ${spell.name} ruptures the wound for ${directDamage} damage!`, damage: directDamage, enemyHP, killedEnemy: true, appliedStatus: false };
    await applySpellDot(enemy, {
      sourcePlayerId: playerId,
      spellId: Number(spell.id),
      spellName: String(spell.name || "Rend"),
      totalDamage,
      durationSeconds: dot.duration,
      tickRateSeconds: dot.tickRate,
      immediateFirstTick: Boolean(spell.rank_config?.immediateFirstTick),
      tickHealingPercent: configNumber(spell, "rendTickHealingPercent")
    });
    return {
      log: `🩸 ${spell.name}${ruptureDamage > 0 ? ` ruptures the old wound for ${ruptureDamage} damage and` : ""}${immediateDamage > 0 ? ` strikes for ${immediateDamage} damage, then` : ""} applies ${totalDamage} bleed damage over ${dot.duration}s!`,
      damage: directDamage,
      enemyHP,
      appliedStatus: true,
      killedEnemy: false,
      crit: Boolean(resolved.crit),
      sourcePlayerId: playerId
    };
  }
};

export const bloodRageHandler: SpellHandlerDefinition = {
  requiresEnemy: false,
  validate(spell) {
    return (Number(spell.buff_duration) || 0) > 0 ? null : `${spell.name} has an invalid duration`;
  },
  async execute({ playerId, spell }): Promise<SpellHandlerResult> {
    const duration = Math.max(1, Number(spell.buff_duration) || 10);
    const attack = configNumber(spell, "attackPercent", Number(spell.buff_value) || 25);
    const lifesteal = configNumber(spell, "lifestealPercent", 5);
    const damageTaken = configNumber(spell, "damageTakenPercent", 10);
    await applyBuff(playerId, "attack_pct", attack, duration, `spell:${spell.id}:attack`);
    await applyBuff(playerId, "lifesteal", lifesteal, duration, `spell:${spell.id}:lifesteal`);
    await applyBuff(playerId, "damage_reduction", -damageTaken, duration, `spell:${spell.id}:reckless`);
    return {
      log: `🩸 ${spell.name} grants ${attack}% Attack and ${lifesteal}% lifesteal, but causes you to take ${damageTaken}% increased damage for ${duration}s!`,
      appliedStatus: true
    };
  }
};

export const savageBlowHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate(spell) {
    return (Number(spell.damage) || 0) > 0 ? null : `${spell.name} has invalid damage configuration`;
  },
  async execute({ spell, player, enemy }): Promise<SpellHandlerResult> {
    if (!enemy) throw new Error("Savage Blow received no enemy");
    const healthPercent = Number(enemy.hp) / Math.max(1, Number(enemy.maxhp) || 1) * 100;
    const threshold = configNumber(spell, "woundedThresholdPercent", 50);
    const bonus = configNumber(spell, "woundedBonusPercent", 50);
    const wounded = healthPercent <= threshold;
    const result = await dealBerserkerDamage(spell, player, enemy, wounded ? 1 + bonus / 100 : 1, configNumber(spell, "defensePenetrationPercent"));
    return {
      log: result.dodged
        ? `🪓 ${spell.name} misses the enemy!`
        : `🪓 ${spell.name} crushes the enemy for ${result.damage} damage${result.critical ? " (CRITICAL!)" : ""}!${wounded ? ` The wounded target takes ${bonus}% bonus damage!` : ""}`,
      damage: result.damage,
      enemyHP: result.enemyHP,
      killedEnemy: result.enemyHP <= 0,
      crit: result.critical,
      dodged: result.dodged,
      woundedTarget: wounded
    };
  }
};

export const battleFrenzyHandler: SpellHandlerDefinition = {
  requiresEnemy: false,
  validate(spell) {
    return (Number(spell.buff_duration) || 0) > 0 ? null : `${spell.name} has an invalid duration`;
  },
  async execute(context): Promise<SpellHandlerResult> {
    const { playerId, spell } = context;
    const duration = Math.max(1, Number(spell.buff_duration) || 8);
    const crit = configNumber(spell, "critChancePercent", 10);
    const atb = configNumber(spell, "atbRatePercent", Number(spell.buff_value) || 20);
    const gauge = Math.max(0, configNumber(spell, "casterGaugeGain", 15));
    await applyBuff(playerId, "crit_chance", crit, duration, `spell:${spell.id}:crit`);
    await applyBuff(playerId, "atb_rate_pct", atb, duration, `spell:${spell.id}:atb`);
    const shared = Math.max(0, configNumber(spell, "sharedBonusPercent"));
    if (shared > 0) {
      for (const ally of (context.allies ?? []).filter(ally => Number(ally.hp) > 0)) {
        if (Number(ally.playerId) === Number(playerId)) continue;
        await applyBuff(ally.playerId, "crit_chance", Math.floor(crit * shared / 100), duration, `spell:${spell.id}:warpath:crit`);
        await applyBuff(ally.playerId, "atb_rate_pct", Math.floor(atb * shared / 100), duration, `spell:${spell.id}:warpath:atb`);
      }
    }
    return {
      log: `🔥 ${spell.name} grants ${crit}% critical chance, ${atb}% action speed, and ${gauge} action gauge for ${duration}s!`,
      appliedStatus: true,
      casterGaugeGain: gauge
    };
  }
};

export const decapitateHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate(spell) {
    return (Number(spell.damage) || 0) > 0 ? null : `${spell.name} has invalid damage configuration`;
  },
  async execute(context): Promise<SpellHandlerResult> {
    const { playerId, spell, player, enemy } = context;
    if (!enemy) throw new Error("Decapitate received no enemy");
    const healthPercent = Number(enemy.hp) / Math.max(1, Number(enemy.maxhp) || 1) * 100;
    const threshold = configNumber(spell, "executeThresholdPercent", 20);
    const multiplier = configNumber(spell, "executeMultiplier", 2);
    const executeActive = healthPercent <= threshold;
    const result = await dealBerserkerDamage(spell, player, enemy, executeActive ? multiplier : 1, executeActive ? configNumber(spell, "executeDefensePenetrationPercent") : 0);
    const killed = result.enemyHP <= 0;
    let restoredHP = 0;
    let restoredMana = 0;
    let finalHP: number | undefined;
    let finalMana: number | undefined;

    if (killed) {
      const maxHP = maximumHP(context);
      const maxMana = maximumMana(context);
      const currentHP = Math.max(0, Number(context.currentPlayerHP ?? player?.hpoints ?? 0));
      const currentMana = Math.max(0, Number(context.currentPlayerSP ?? player?.spoints ?? 0));
      finalHP = Math.min(maxHP, currentHP + Math.floor(maxHP * configNumber(spell, "killHealMaxHpPercent", 20) / 100));
      finalMana = Math.min(maxMana, currentMana + Math.floor(maxMana * configNumber(spell, "killManaMaxPercent", 25) / 100));
      restoredHP = Math.max(0, finalHP - currentHP);
      restoredMana = Math.max(0, finalMana - currentMana);
      await db.query(`UPDATE players SET hpoints=?,spoints=? WHERE id=?`, [finalHP, finalMana, playerId]);
    }

    return {
      log: result.dodged
        ? `💀 ${spell.name} misses the enemy!`
        : `💀 ${spell.name} strikes for ${result.damage} damage${result.critical ? " (CRITICAL!)" : ""}!${executeActive ? ` EXECUTE ×${multiplier}!` : ""}${killed ? ` The execution restores ${restoredHP} HP and ${restoredMana} mana and readies your next action!` : ""}`,
      damage: result.damage,
      enemyHP: result.enemyHP,
      killedEnemy: killed,
      crit: result.critical,
      dodged: result.dodged,
      playerHP: finalHP,
      playerSP: finalMana,
      healing: restoredHP,
      manaRestored: restoredMana,
      setGaugeTo: killed ? configNumber(spell, "killGauge", 100) : undefined
    };
  }
};
