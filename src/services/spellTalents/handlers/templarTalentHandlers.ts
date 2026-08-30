import { applyBuff } from "../../buffService";
import { applySpellDebuff, getSpellEnemyDebuffValue } from "../../spellHandlers/helpers";
import type { SpellHandlerResult } from "../../spellHandlers/types";
import type { SpellTalentHandler, TalentConfig } from "../types";

function number(config: TalentConfig, key: string, fallback = 0) {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
}

function rankConfig(spell: any) {
  if (!spell.rank_config || typeof spell.rank_config !== "object") spell.rank_config = {};
  return spell.rank_config as Record<string, any>;
}

async function judgment(enemy: any) {
  return getSpellEnemyDebuffValue(enemy, "judgment");
}

async function debuff(context: any, stat: string, value: number, duration: number) {
  if (!context.enemy) return;
  await applySpellDebuff(context.enemy, {
    sourcePlayerId: context.playerId,
    spellId: Number(context.spell.id),
    spellName: String(context.spell.name),
    stat,
    value,
    durationSeconds: duration
  });
}

async function repeatDamage(context: any, result: SpellHandlerResult, percent: number) {
  if (!context.enemy || result.dodged || !result.damage || Number(result.enemyHP) <= 0) return result;
  const extra = Math.max(1, Math.floor(Number(result.damage) * percent / 100));
  const hp = Math.max(0, Number(result.enemyHP) - extra);
  await context.enemy.setHP?.(hp);
  context.enemy.hp = hp;
  return {
    ...result,
    damage: Number(result.damage) + extra,
    enemyHP: hp,
    killedEnemy: hp <= 0,
    log: `${result.log ?? ""} ✨ An echo strikes for ${extra} damage!`
  };
}

export const echoingSmite: SpellTalentHandler = {
  async afterCast(context, result) {
    return Math.random() < number(context.talent.config, "chance", 30) / 100
      ? repeatDamage(context, result, number(context.talent.config, "repeatDamagePercent", 50))
      : result;
  }
};

export const righteousMomentum: SpellTalentHandler = {
  afterCast({ talent }, result) {
    if (!result.crit) return result;
    return { ...result, casterGaugeGain: (Number(result.casterGaugeGain) || 0) + number(talent.config, "gaugeGain", 15) };
  }
};

export const purgingLight: SpellTalentHandler = {
  async beforeCast(context) {
    if (!context.enemy) return;
    const hasDebuff = await context.enemy.getDebuffValue?.("__any__");
    if (Number(hasDebuff) > 0) {
      context.spell.damage = Math.round(Number(context.spell.damage) * (1 + number(context.talent.config, "percent", 30) / 100));
    }
  }
};

export const radiantImpact: SpellTalentHandler = {
  afterCast({ talent }, result) {
    return { ...result, splashDamagePercent: number(talent.config, "splashPercent", 35) };
  }
};

export const sentenceOfVulnerability: SpellTalentHandler = {
  async afterCast(context, result) {
    if (!result.appliedStatus) return result;
    await applyBuff(context.playerId, "spell_damage_dealt_pct", number(context.talent.config, "percent", 15), Number(context.spell.debuff_duration), `judgment:${context.enemy?.id}`);
    return { ...result, appliedStatus: true };
  }
};

export const collectiveCondemnation: SpellTalentHandler = {
  async afterCast(context, result) {
    if (result.appliedStatus) await debuff(context, "spell_damage_taken_pct", number(context.talent.config, "percent", 8), Number(context.spell.debuff_duration));
    return result;
  }
};

export const unrelentingVerdict: SpellTalentHandler = {
  async afterCast(context, result) {
    if (result.appliedStatus) await debuff(context, "judgment_refresh_on_spell", Number(context.spell.debuff_duration), Number(context.spell.debuff_duration));
    return result;
  }
};

export const harshSentence: SpellTalentHandler = {
  async afterCast(context, result) {
    if (result.appliedStatus) await debuff(context, "judgment_crit_upgrade", 2, Number(context.spell.debuff_duration));
    return result;
  }
};

export const exposingJudgment: SpellTalentHandler = {
  async afterCast(context, result) {
    if (result.appliedStatus && context.enemy) {
      const defense = Number(context.enemy.stats?.defense ?? context.enemy.defense ?? 0);
      await debuff(context, "defense", -Math.max(1, Math.floor(defense * number(context.talent.config, "percent", 12) / 100)), Number(context.spell.debuff_duration));
    }
    return result;
  }
};

export const rallyingVerdict: SpellTalentHandler = {
  afterCast({ talent }, result) {
    return result.appliedStatus
      ? { ...result, partyGaugeGain: (Number(result.partyGaugeGain) || 0) + number(talent.config, "gaugeGain", 10) }
      : result;
  }
};

export const brandOfCensure: SpellTalentHandler = {
  async afterCast(context, result) {
    await debuff(context, "damage_dealt_pct", number(context.talent.config, "reductionPercent", 12), Number(context.spell.dot_duration));
    return { ...result, appliedStatus: true };
  }
};

export const accelerant: SpellTalentHandler = {
  modifySpell({ spell }) { rankConfig(spell).immediateFirstTick = true; }
};

export const searingExposure: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    Object.assign(rankConfig(spell), {
      brandDefenseReductionPerTick: number(talent.config, "percentPerTick", 3),
      brandDefenseReductionMaxStacks: number(talent.config, "maxStacks", 4)
    });
  }
};

export const cleansingFlame: SpellTalentHandler = {
  modifySpell({ spell, talent }) { rankConfig(spell).brandManaRestorePercent = number(talent.config, "manaPercent", 2); }
};

export const wrathfulSentence: SpellTalentHandler = {
  modifySpell({ spell, talent }) { rankConfig(spell).judgmentBonusExtra = number(talent.config, "percentagePoints", 25) / 100; }
};

export const shatteringVerdict: SpellTalentHandler = {
  modifySpell({ spell, talent }) { rankConfig(spell).judgedDefensePenetration = number(talent.config, "percent", 30); }
};

export const sentenceRenewed: SpellTalentHandler = {
  modifySpell({ spell }) { rankConfig(spell).refreshJudgment = true; }
};

export const zealousRecovery: SpellTalentHandler = {
  async afterCast(context, result) {
    if (!result.dodged && context.enemy && await judgment(context.enemy) <= 0) {
      const restore = Math.floor(Number(context.spell.mana_cost) * number(context.talent.config, "manaRefundPercent", 20) / 100);
      if (restore > 0) return { ...result, manaRestored: restore };
    }
    return result;
  }
};

export const crushingWrath: SpellTalentHandler = {
  modifySpell({ spell, talent }) { rankConfig(spell).bonusCritDamagePercent = number(talent.config, "percent", 40); }
};

export const absoluteDecree: SpellTalentHandler = {
  modifySpell({ spell }) { rankConfig(spell).applyJudgmentWhenMissing = 1; }
};

export const reckoningsEcho: SpellTalentHandler = {
  async afterCast(context, result) {
    return context.enemy && await judgment(context.enemy) >= 2
      ? repeatDamage(context, result, number(context.talent.config, "repeatDamagePercent", 40))
      : result;
  }
};

export const divineRuin: SpellTalentHandler = {
  modifySpell({ spell, talent }) { rankConfig(spell).defensePenetration = number(talent.config, "percent", 25); }
};

export const condemnUnworthy: SpellTalentHandler = {
  modifySpell({ spell }) { rankConfig(spell).applyJudgmentWhenMissing = 2; }
};

export const unendingJudgment: SpellTalentHandler = {
  modifySpell({ spell, talent }) { rankConfig(spell).judgmentDurationBonus = number(talent.config, "seconds", 8); }
};

export const sentenceOfAnnihilation: SpellTalentHandler = {
  modifySpell({ spell, talent }) { rankConfig(spell).maxMissingHealthBonus = number(talent.config, "maxBonusPercent", 150) / 100; }
};

export const divineDeliverance: SpellTalentHandler = {
  afterCast({ talent }, result) { return { ...result, partyGaugeGain: (Number(result.partyGaugeGain) || 0) + number(talent.config, "gaugeGain", 20) }; }
};

export const noAppeal: SpellTalentHandler = {
  modifySpell({ spell }) { rankConfig(spell).treatJudgmentOneAsTwo = true; }
};

export const eradication: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    Object.assign(rankConfig(spell), {
      executeThresholdPercent: number(talent.config, "executeThresholdPercent", 30),
      bossLowHealthBonus: number(talent.config, "bossBonusPercent", 75) / 100
    });
  }
};

export const rallyToVerdict: SpellTalentHandler = {
  async afterCast(context, result) {
    const duration = number(context.talent.config, "durationSeconds", 10);
    const value = number(context.talent.config, "damagePercent", 20);
    const allies = context.allies?.filter((a: any) => a.hp > 0) ?? [{ playerId: context.playerId }];
    await Promise.all(allies.map((a: any) => applyBuff(a.playerId, "damage_dealt_pct", value, duration, `talent:${context.talent.id}`)));
    return { ...result, appliedStatus: true };
  }
};

export const finalDecree: SpellTalentHandler = {
  afterCast({ talent }, result) {
    if (!result.killedEnemy) return result;
    return { ...result, restoreManaPercent: number(talent.config, "manaPercent", 30), casterGaugeGain: 100 };
  }
};
