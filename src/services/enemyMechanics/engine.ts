import { getEnemyMechanicHandler } from "./registry";
import { selectEnemyMechanicTargets } from "./targeting";
import type {
  ActiveEnemyMechanicCast,
  EnemyMechanicAdapter,
  EnemyMechanicAdvanceResult,
  EnemyMechanicDefinition,
  EnemyMechanicInterruptResult,
  EnemyMechanicRuntime,
} from "./types";

export function createEnemyMechanicRuntime(
  definitions: EnemyMechanicDefinition[] = [],
): EnemyMechanicRuntime {
  return {
    definitions: [...definitions],
    cooldowns: {},
    uses: {},
    activeCast: null,
    lastMechanicKey: null,
    sequence: 0,
  };
}

function isEligible(
  definition: EnemyMechanicDefinition,
  runtime: EnemyMechanicRuntime,
  enemyHpPercent: number,
  encounterAgeMs: number,
  now: number,
): boolean {
  if (!definition.handlerKey || !getEnemyMechanicHandler(definition.handlerKey)) {
    return false;
  }
  if (enemyHpPercent < definition.minimumHpPercent) return false;
  if (enemyHpPercent > definition.maximumHpPercent) return false;
  if (encounterAgeMs < definition.availableAfterMs) return false;
  if ((runtime.cooldowns[definition.mechanicKey] ?? 0) > now) return false;

  const uses = runtime.uses[definition.mechanicKey] ?? 0;
  return definition.maximumUses == null || uses < definition.maximumUses;
}

function chooseDefinition(
  definitions: EnemyMechanicDefinition[],
): EnemyMechanicDefinition | null {
  if (definitions.length === 0) return null;
  const priority = Math.max(...definitions.map((entry) => entry.priority));
  const candidates = definitions.filter((entry) => entry.priority === priority);
  const totalWeight = candidates.reduce(
    (total, entry) => total + Math.max(0, entry.weight),
    0,
  );
  if (totalWeight <= 0) return candidates[0] ?? null;

  let roll = Math.random() * totalWeight;
  for (const candidate of candidates) {
    roll -= Math.max(0, candidate.weight);
    if (roll <= 0) return candidate;
  }
  return candidates[candidates.length - 1] ?? null;
}

function definitionForCast(
  runtime: EnemyMechanicRuntime,
  cast: ActiveEnemyMechanicCast,
): EnemyMechanicDefinition | null {
  return (
    runtime.definitions.find(
      (definition) => definition.mechanicKey === cast.mechanicKey,
    ) ?? null
  );
}

function appendLines(adapter: EnemyMechanicAdapter, lines?: string | string[]) {
  if (!lines) return;
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    if (line) adapter.appendLog(line);
  }
}

async function resolveCast(
  runtime: EnemyMechanicRuntime,
  cast: ActiveEnemyMechanicCast,
  definition: EnemyMechanicDefinition,
  adapter: EnemyMechanicAdapter,
  now: number,
): Promise<EnemyMechanicAdvanceResult> {
  const handler = getEnemyMechanicHandler(cast.handlerKey);
  runtime.activeCast = null;
  runtime.cooldowns[definition.mechanicKey] = now + definition.cooldownMs;
  runtime.uses[definition.mechanicKey] =
    (runtime.uses[definition.mechanicKey] ?? 0) + 1;
  runtime.lastMechanicKey = definition.mechanicKey;

  if (!handler) {
    adapter.appendLog(
      `⚠ ${definition.name} fails because its mechanic handler is unavailable.`,
    );
    return { kind: "resolved", cast, definition, recoveryMs: definition.recoveryMs };
  }

  const targets = cast.targetPlayerIds
    .map((playerId) =>
      adapter.participants.find(
        (participant) => participant.playerId === playerId && participant.hp > 0,
      ),
    )
    .filter((target): target is NonNullable<typeof target> => Boolean(target));

  const result = await handler({ definition, cast, targets, adapter, now });
  appendLines(adapter, result.log);
  return { kind: "resolved", cast, definition, recoveryMs: definition.recoveryMs };
}

export async function advanceEnemyMechanics(args: {
  runtime: EnemyMechanicRuntime;
  adapter: EnemyMechanicAdapter;
  enemyHp: number;
  encounterStartedAt: number;
  now?: number;
}): Promise<EnemyMechanicAdvanceResult> {
  const { runtime, adapter } = args;
  const now = args.now ?? Date.now();

  if (runtime.activeCast) {
    const cast = runtime.activeCast;
    if (cast.resolvesAt > now) return { kind: "casting", cast };
    const definition = definitionForCast(runtime, cast);
    if (!definition) {
      runtime.activeCast = null;
      return { kind: "none" };
    }
    return resolveCast(runtime, cast, definition, adapter, now);
  }

  const enemyHpPercent =
    Math.max(0, args.enemyHp) / Math.max(1, adapter.enemyMaxHp) * 100;
  const encounterAgeMs = Math.max(0, now - args.encounterStartedAt);
  const definition = chooseDefinition(
    runtime.definitions.filter((entry) =>
      isEligible(entry, runtime, enemyHpPercent, encounterAgeMs, now),
    ),
  );
  if (!definition) return { kind: "none" };

  const targets = selectEnemyMechanicTargets(
    definition.targetRule,
    adapter.participants,
    adapter.threatState,
  );
  if (definition.targetRule !== "self" && targets.length === 0) {
    return { kind: "none" };
  }

  const cast: ActiveEnemyMechanicCast = {
    mechanicId: definition.id,
    mechanicKey: definition.mechanicKey,
    name: definition.name,
    description: definition.description,
    handlerKey: definition.handlerKey,
    targetRule: definition.targetRule,
    targetPlayerIds: targets.map((target) => target.playerId),
    startedAt: now,
    resolvesAt: now + definition.castTimeMs,
    interruptible: definition.interruptible,
    telegraph: definition.telegraph,
    config: { ...definition.config },
  };
  runtime.activeCast = cast;
  runtime.sequence += 1;

  adapter.appendLog(
    definition.telegraph || `⚠ ${adapter.enemyName} begins ${definition.name}!`,
  );
  if (definition.castTimeMs <= 0) {
    return resolveCast(runtime, cast, definition, adapter, now);
  }
  return { kind: "started", cast };
}

export function interruptEnemyMechanic(
  runtime: EnemyMechanicRuntime,
): EnemyMechanicInterruptResult {
  const cast = runtime.activeCast;
  if (!cast || !cast.interruptible) return { interrupted: false, cast };
  runtime.activeCast = null;
  return { interrupted: true, cast };
}

export function buildEnemyMechanicSnapshot(
  runtime: EnemyMechanicRuntime,
  now: number = Date.now(),
  encounterStartedAt: number = now,
) {
  const cast = runtime.activeCast;

  const mechanics = runtime.definitions.map((definition) => {
    const firstAvailableAt =
      encounterStartedAt + Math.max(0, Number(definition.availableAfterMs) || 0);

    const cooldownUntil = Math.max(
      firstAvailableAt,
      Number(runtime.cooldowns[definition.mechanicKey] ?? 0),
    );

    const uses = Math.max(
      0,
      Number(runtime.uses[definition.mechanicKey] ?? 0) || 0,
    );

    const exhausted =
      definition.maximumUses != null &&
      uses >= definition.maximumUses;

    const casting =
      cast?.mechanicKey === definition.mechanicKey;

    const remainingMs =
      exhausted || casting
        ? 0
        : Math.max(0, cooldownUntil - now);

    return {
      mechanicKey: definition.mechanicKey,
      name: definition.name,
      description: definition.description,
      interruptible: definition.interruptible,
      cooldownMs: Math.max(0, Number(definition.cooldownMs) || 0),
      remainingMs,
      ready: !exhausted && !casting && remainingMs <= 0,
      casting,
      exhausted,
      uses,
      maximumUses: definition.maximumUses,
    };
  });

  return {
    activeCast: cast
      ? {
          mechanicKey: cast.mechanicKey,
          name: cast.name,
          description: cast.description,
          targetPlayerIds: cast.targetPlayerIds,
          interruptible: cast.interruptible,
          remainingMs: Math.max(0, cast.resolvesAt - now),
          totalMs: Math.max(0, cast.resolvesAt - cast.startedAt),
        }
      : null,
    sequence: runtime.sequence,
    mechanics,
  };
}
