import type {
  EnemyMechanicHandler,
  EnemyMechanicHandlerContext,
} from "../types";

function configNumber(
  context: EnemyMechanicHandlerContext,
  key: string,
  fallback: number,
): number {
  const value = Number(context.definition.config[key]);
  return Number.isFinite(value) ? value : fallback;
}

export const enemySingleTargetAttack: EnemyMechanicHandler = async (
  context,
) => {
  const target = context.targets[0];
  if (!target) return { ok: false, log: "The mechanic has no living target." };

  await context.adapter.attackPlayer(target.playerId, {
    damageMultiplier: Math.max(0, configNumber(context, "damageMultiplier", 1)),
    abilityName: context.definition.name,
  });

  return { ok: true };
};

export const enemyPartyAttack: EnemyMechanicHandler = async (context) => {
  const damageMultiplier = Math.max(
    0,
    configNumber(context, "damageMultiplier", 0.65),
  );

  for (const target of context.targets) {
    await context.adapter.attackPlayer(target.playerId, {
      damageMultiplier,
      abilityName: context.definition.name,
    });
  }

  return { ok: context.targets.length > 0 };
};

export const enemySelfHeal: EnemyMechanicHandler = async (context) => {
  const flatHealing = Math.max(0, configNumber(context, "healFlat", 0));
  const maximumHpPercent = Math.max(
    0,
    configNumber(context, "healMaxHpPercent", 0),
  );
  const requestedHealing = Math.max(
    flatHealing,
    Math.floor(context.adapter.enemyMaxHp * maximumHpPercent / 100),
  );
  const actualHealing = await context.adapter.healEnemy(
    requestedHealing,
    context.definition.name,
  );

  return {
    ok: actualHealing > 0,
    log:
      actualHealing > 0
        ? `✨ ${context.adapter.enemyName} restores ${actualHealing} HP with ${context.definition.name}!`
        : undefined,
  };
};

export const enemyGaugeDisruption: EnemyMechanicHandler = async (context) => {
  const gaugeChange = configNumber(context, "gaugeChange", -20);
  for (const target of context.targets) {
    await context.adapter.changePlayerGauge(target.playerId, gaugeChange);
  }

  return {
    ok: context.targets.length > 0,
    log:
      context.targets.length > 0
        ? `⏳ ${context.definition.name} disrupts the party's momentum!`
        : undefined,
  };
};

export const genericEnemyMechanicHandlers: Record<
  string,
  EnemyMechanicHandler
> = {
  enemy_single_target_attack: enemySingleTargetAttack,
  enemy_party_attack: enemyPartyAttack,
  enemy_self_heal: enemySelfHeal,
  enemy_gauge_disruption: enemyGaugeDisruption,
};
