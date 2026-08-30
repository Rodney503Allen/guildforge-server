// src/services/spellHandlers/knightHandlers.ts
import { db } from "../../db";
import { applyBuff } from "../buffService";
import { SpellHandlerContext, SpellHandlerDefinition, SpellHandlerResult } from "./types";
import {
  applySpellDebuff,
  getConfiguredBuff,
  getConfiguredDebuff,
  resolveDirectSpellDamage,
  setSpellEnemyHP
} from "./helpers";

function configNumber(spell: any, key: string, fallback = 0): number {
  const value = Number(spell?.rank_config?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function maximumHP(player: any, supplied?: number): number {
  return Math.max(1, Number(supplied ?? player?.maxhp ?? player?.maxHp ?? 1) || 1);
}

function livingAllies(context: SpellHandlerContext) {
  const allies = (context.allies ?? []).filter(ally => Number(ally.hp) > 0);
  return allies.length > 0 ? allies : [{
    playerId: context.playerId,
    name: context.player?.name,
    stats: context.player,
    hp: Number(context.currentPlayerHP ?? context.player?.hpoints ?? 1),
    maxHp: maximumHP(context.player, context.maxPlayerHP),
    sp: Number(context.currentPlayerSP ?? context.player?.spoints ?? 0),
    maxSp: Number(context.maxPlayerSP ?? context.player?.maxspoints ?? 0)
  }];
}

async function applyShield(playerId: number, amount: number, seconds: number, source: string) {
  const absorb = Math.max(1, Math.floor(amount));
  const duration = Math.max(1, Math.floor(seconds));
  await db.query(
    `INSERT INTO player_shields
       (player_id,max_absorb,remaining_absorb,expires_at,source)
     VALUES(?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
     ON DUPLICATE KEY UPDATE
       max_absorb=VALUES(max_absorb),remaining_absorb=VALUES(remaining_absorb),
       expires_at=VALUES(expires_at)`,
    [playerId, absorb, absorb, duration, source]
  );
  return absorb;
}

async function applyStatus(
  playerId: number,
  effectKey: string,
  charges: number,
  value: number,
  seconds: number,
  source: string
) {
  await db.query(
    `INSERT INTO player_status_effects
       (player_id,effect_key,charges,value,expires_at,source)
     VALUES(?,?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
     ON DUPLICATE KEY UPDATE
       charges=VALUES(charges),value=VALUES(value),
       expires_at=VALUES(expires_at),source=VALUES(source)`,
    [playerId, effectKey, Math.max(1, Math.floor(charges)), Number(value) || 0,
      Math.max(1, Math.floor(seconds)), source]
  );
}

// Damage, weakening, threat, and action-gauge disruption.
export const shieldBashHandler: SpellHandlerDefinition = {
  requiresEnemy: true,
  validate(spell) {
    const debuff = getConfiguredDebuff(spell);
    if ((Number(spell.damage) || 0) <= 0) return `${spell.name} has invalid damage configuration`;
    if (debuff.stat !== "damage_dealt_pct") return `${spell.name} must use damage_dealt_pct`;
    if (debuff.value <= 0 || debuff.duration <= 0) return `${spell.name} has invalid weakening configuration`;
    return null;
  },
  async execute({ playerId, player, enemy, spell }): Promise<SpellHandlerResult> {
    if (!enemy) throw new Error(`${spell.name} requires an enemy`);
    const result = resolveDirectSpellDamage(player, enemy, Number(spell.damage) || 0);
    const damage = result.dodged ? 0 : Math.max(0, Number(result.damage) || 0);
    const enemyHP = Math.max(0, Number(enemy.hp) - damage);
    await setSpellEnemyHP(enemy, enemyHP);

    const debuff = getConfiguredDebuff(spell);
    const appliedStatus = !result.dodged && enemyHP > 0;
    if (appliedStatus) {
      await applySpellDebuff(enemy, {
        sourcePlayerId: playerId,
        spellId: Number(spell.id),
        spellName: String(spell.name || "Shield Bash"),
        stat: debuff.stat,
        value: debuff.value,
        durationSeconds: debuff.duration
      });
    }

    let log = result.dodged
      ? `🛡️ ${spell.name} misses the enemy!`
      : `🛡️ ${spell.name} slams the enemy for ${damage} damage${result.crit ? " (CRITICAL!)" : ""}!`;
    if (appliedStatus) log += ` Its damage is reduced by ${debuff.value}% for ${debuff.duration}s.`;

    return {
      log, damage, enemyHP, appliedStatus, killedEnemy: enemyHP <= 0,
      crit: Boolean(result.crit), dodged: Boolean(result.dodged),
      threatGenerated: Math.max(0, configNumber(spell, "bonusThreat")),
      enemyGaugeReduction: result.dodged ? 0 : Math.max(0, configNumber(spell, "enemyGaugeReduction")),
      sourcePlayerId: playerId
    };
  }
};

// Protects one ally and grants the Knight partial protection.
export const guardHandler: SpellHandlerDefinition = {
  requiresEnemy: false,
  validate(spell) {
    const buff = getConfiguredBuff(spell);
    if (buff.stat !== "damage_reduction") return `${spell.name} must use damage_reduction`;
    if (buff.value <= 0 || buff.duration <= 0) return `${spell.name} has invalid protection configuration`;
    return null;
  },
  async execute({ playerId, spell, targetPlayerId }): Promise<SpellHandlerResult> {
    const buff = getConfiguredBuff(spell);
    const targetId = Number(targetPlayerId ?? playerId);
    const targetingSelf = targetId === Number(playerId);
    await applyBuff(targetId, buff.stat, buff.value, buff.duration, `spell:${spell.id}:guard`);

    let casterReduction = 0;
    if (!targetingSelf) {
      casterReduction = Math.max(1, Math.floor(
        buff.value * Math.max(0, configNumber(spell, "casterReductionPercent", 50)) / 100
      ));
      await applyBuff(playerId, "damage_reduction", casterReduction, buff.duration, `spell:${spell.id}:caster`);
    }

    return {
      log: targetingSelf
        ? `🛡️ ${spell.name} reduces your incoming damage by ${buff.value}% for ${buff.duration}s!`
        : `🛡️ ${spell.name} reduces your ally's damage taken by ${buff.value}% and yours by ${casterReduction}% for ${buff.duration}s!`,
      appliedStatus: true,
      threatGenerated: Math.max(0, configNumber(spell, "bonusThreat")),
      protectedPlayerId: targetId,
      casterReductionPercent: casterReduction
    };
  }
};

// Personal Defense stance, absorb shield, and threat multiplier.
export const bulwarkHandler: SpellHandlerDefinition = {
  requiresEnemy: false,
  validate(spell) {
    const buff = getConfiguredBuff(spell);
    if (buff.stat !== "defense") return `${spell.name} must use defense`;
    if (buff.value <= 0 || buff.duration <= 0) return `${spell.name} has invalid Bulwark configuration`;
    if (configNumber(spell, "shieldMaxHpPercent") <= 0) return `${spell.name} has invalid shield configuration`;
    return null;
  },
  async execute(context): Promise<SpellHandlerResult> {
    const { playerId, player, spell } = context;
    const buff = getConfiguredBuff(spell);
    const shieldAmount = await applyShield(
      playerId,
      maximumHP(player, context.maxPlayerHP) * configNumber(spell, "shieldMaxHpPercent") / 100,
      buff.duration,
      `spell:${spell.id}`
    );
    await applyBuff(playerId, buff.stat, buff.value, buff.duration, `spell:${spell.id}:defense`);
    const threatMultiplier = Math.max(1, configNumber(spell, "threatMultiplier", 1));
    await applyStatus(
      playerId,
      "knight_threat_generation_pct",
      1,
      Math.max(0, Math.round((threatMultiplier - 1) * 100)),
      buff.duration,
      `spell:${spell.id}`
    );
    return {
      log: `🛡️ You brace behind ${spell.name}, gaining ${buff.value} Defense and a ${shieldAmount}-point shield for ${buff.duration}s!`,
      appliedStatus: true,
      absorbShield: shieldAmount,
      threatMultiplier
    };
  }
};

// Arms the next-hit protection and records its Knight source.
export const interceptHandler: SpellHandlerDefinition = {
  requiresEnemy: false,
  validate(spell) {
    const buff = getConfiguredBuff(spell);
    if (buff.stat !== "intercept") return `${spell.name} must use intercept`;
    if (buff.value <= 0 || buff.duration <= 0) return `${spell.name} has invalid Intercept configuration`;
    return null;
  },
  async execute({ playerId, spell, targetPlayerId }): Promise<SpellHandlerResult> {
    const buff = getConfiguredBuff(spell);
    const targetId = Number(targetPlayerId ?? playerId);
    const redirectedReduction = Math.max(0, Math.min(90,
      configNumber(spell, "redirectedDamageReductionPercent")
    ));
    const source = `knight:${playerId}:spell:${spell.id}`;
    await applyStatus(targetId, "intercept", 1, Math.max(0, Math.min(90, buff.value)), buff.duration, source);
    await applyStatus(targetId, "knight_intercept_redirect_reduction", 1, redirectedReduction, buff.duration, source);

    return {
      log: targetId === Number(playerId)
        ? `🛡️ ${spell.name} reduces your next incoming attack by ${buff.value}%.`
        : `🛡️ You prepare to intercept ${buff.value}% of the next attack against your ally; redirected damage is reduced by ${redirectedReduction}%.`,
      appliedStatus: true,
      protectedPlayerId: targetId,
      interceptPlayerId: playerId,
      threatGenerated: Math.max(0, configNumber(spell, "bonusThreat"))
    };
  }
};

// Major party-wide mitigation cooldown.
export const shieldWallHandler: SpellHandlerDefinition = {
  requiresEnemy: false,
  validate(spell) {
    const buff = getConfiguredBuff(spell);
    if (buff.stat !== "damage_reduction") return `${spell.name} must use damage_reduction`;
    if (buff.value <= 0 || buff.duration <= 0) return `${spell.name} has invalid party mitigation configuration`;
    return null;
  },
  async execute(context): Promise<SpellHandlerResult> {
    const buff = getConfiguredBuff(context.spell);
    const targets = livingAllies(context);
    for (const ally of targets) {
      await applyBuff(ally.playerId, buff.stat, buff.value, buff.duration, `spell:${context.spell.id}:wall`);
    }
    return {
      log: `🛡️ ${context.spell.name} reduces incoming damage for ${targets.length} living ${targets.length === 1 ? "ally" : "allies"} by ${buff.value}% for ${buff.duration}s!`,
      appliedStatus: true,
      protectedPlayerIds: targets.map(ally => ally.playerId),
      threatGenerated: targets.length * Math.max(0, configNumber(context.spell, "bonusThreatPerAlly"))
    };
  }
};

// Personal ultimate: mitigation, shield, death prevention, and taunt.
export const unbreakableHandler: SpellHandlerDefinition = {
  requiresEnemy: false,
  validate(spell) {
    const buff = getConfiguredBuff(spell);
    if (buff.stat !== "damage_reduction") return `${spell.name} must use damage_reduction`;
    if (buff.value <= 0 || buff.duration <= 0) return `${spell.name} has invalid ultimate mitigation`;
    if (configNumber(spell, "shieldMaxHpPercent") <= 0) return `${spell.name} has invalid ultimate shield`;
    if (configNumber(spell, "deathPreventionCharges") <= 0) return `${spell.name} has invalid death prevention`;
    return null;
  },
  async execute(context): Promise<SpellHandlerResult> {
    const { playerId, player, spell } = context;
    const buff = getConfiguredBuff(spell);
    const charges = Math.max(1, Math.floor(configNumber(spell, "deathPreventionCharges", 1)));
    const shieldAmount = await applyShield(
      playerId,
      maximumHP(player, context.maxPlayerHP) * configNumber(spell, "shieldMaxHpPercent") / 100,
      buff.duration,
      `spell:${spell.id}`
    );
    await applyBuff(playerId, buff.stat, buff.value, buff.duration, `spell:${spell.id}:unbreakable`);
    await applyStatus(
      playerId,
      "knight_unbreakable_reduction_pct",
      1,
      buff.value,
      buff.duration,
      `spell:${spell.id}`
    );
    await applyStatus(playerId, "death_prevention", charges, 1, buff.duration, `spell:${spell.id}`);

    return {
      log: `🛡️ UNBREAKABLE! You gain ${buff.value}% damage reduction, a ${shieldAmount}-point shield, and ${charges} death-prevention ${charges === 1 ? "charge" : "charges"} for ${buff.duration}s!`,
      appliedStatus: true,
      absorbShield: shieldAmount,
      deathPreventionCharges: charges,
      forceThreatTargetPlayerId: configNumber(spell, "forceThreatTarget", 1) ? playerId : undefined
    };
  }
};
