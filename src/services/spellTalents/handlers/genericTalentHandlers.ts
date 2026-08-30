import type { SpellRecord } from "../../spellHandlers/types";
import type {
  SpellTalentHandler,
  TalentConfig
} from "../types";

function configNumber(
  config: TalentConfig,
  key: string
): number {
  const value = Number(config[key]);

  if (!Number.isFinite(value)) {
    throw new Error(`TALENT_CONFIG_INVALID_NUMBER:${key}`);
  }

  return value;
}

function currentNumber(
  spell: SpellRecord,
  field: keyof SpellRecord
): number {
  return Number(spell[field] ?? 0) || 0;
}

function percentIncrease(
  spell: SpellRecord,
  field: keyof SpellRecord,
  percent: number
): void {
  const current = currentNumber(spell, field);
  spell[field] = Math.max(
    0,
    Math.round(current * (1 + percent / 100))
  );
}

function addSeconds(
  spell: SpellRecord,
  field: keyof SpellRecord,
  seconds: number
): void {
  spell[field] = Math.max(
    0,
    currentNumber(spell, field) + seconds
  );
}

export const increaseDamagePercentTalent: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    percentIncrease(
      spell,
      "damage",
      configNumber(talent.config, "percent")
    );
  }
};

export const increaseHealingPercentTalent: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    percentIncrease(
      spell,
      "heal",
      configNumber(talent.config, "percent")
    );
  }
};

export const reduceManaCostPercentTalent: SpellTalentHandler = {
  modifySpell({ spell, talent, castState }) {
    const percent = configNumber(talent.config, "percent");
    const current = currentNumber(spell, "mana_cost");
    const next = Math.max(
      0,
      Math.ceil(current * (1 - percent / 100))
    );

    spell.mana_cost = next;
    castState.manaCost = next;
  }
};

export const reduceCooldownSecondsTalent: SpellTalentHandler = {
  modifySpell({ spell, talent, castState }) {
    const seconds = configNumber(talent.config, "seconds");
    const next = Math.max(
      0,
      currentNumber(spell, "cooldown") - seconds
    );

    spell.cooldown = next;
    castState.cooldownSeconds = next;
  }
};

export const increaseDotDamagePercentTalent: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    percentIncrease(
      spell,
      "dot_damage",
      configNumber(talent.config, "percent")
    );
  }
};

export const increaseDotDurationTalent: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    addSeconds(
      spell,
      "dot_duration",
      configNumber(talent.config, "seconds")
    );
  }
};

export const increaseBuffValuePercentTalent: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    percentIncrease(
      spell,
      "buff_value",
      configNumber(talent.config, "percent")
    );
  }
};

export const increaseBuffDurationTalent: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    addSeconds(
      spell,
      "buff_duration",
      configNumber(talent.config, "seconds")
    );
  }
};

export const increaseDebuffValuePercentTalent: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    percentIncrease(
      spell,
      "debuff_value",
      configNumber(talent.config, "percent")
    );
  }
};

export const increaseDebuffDurationTalent: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    addSeconds(
      spell,
      "debuff_duration",
      configNumber(talent.config, "seconds")
    );
  }
};

export const changeTargetTypeTalent: SpellTalentHandler = {
  modifySpell({ spell, talent }) {
    const targetType = String(
      talent.config.targetType ?? ""
    )
      .trim()
      .toLowerCase();

    const allowed = new Set([
      "self",
      "enemy",
      "ally",
      "all_enemies",
      "all_allies"
    ]);

    if (!allowed.has(targetType)) {
      throw new Error("TALENT_CONFIG_INVALID_TARGET_TYPE");
    }

    spell.target_type = targetType;
  }
};

