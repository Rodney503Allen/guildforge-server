import { db } from "../../db";
import type {
  EnemyMechanicDefinition,
  EnemyMechanicSourceType,
  EnemyMechanicTargetRule,
} from "./types";

export type EnemyMechanicSourceReference = {
  sourceType: EnemyMechanicSourceType;
  sourceId: number;
};

const targetRules = new Set<EnemyMechanicTargetRule>([
  "highest_threat",
  "second_highest_threat",
  "lowest_threat",
  "random_living_player",
  "lowest_hp_player",
  "highest_hp_player",
  "all_living_players",
  "self",
]);

function parseConfig(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizeTargetRule(value: unknown): EnemyMechanicTargetRule {
  const rule = String(value || "highest_threat") as EnemyMechanicTargetRule;
  return targetRules.has(rule) ? rule : "highest_threat";
}

export async function loadEnemyMechanicDefinitions(
  sourceReferences: EnemyMechanicSourceReference[],
): Promise<EnemyMechanicDefinition[]> {
  const references = sourceReferences.filter(
    (reference) =>
      Number.isInteger(Number(reference.sourceId)) &&
      Number(reference.sourceId) > 0,
  );
  if (references.length === 0) return [];

  const where = references
    .map(() => "(assignment.source_type = ? AND assignment.source_id = ?)")
    .join(" OR ");
  const parameters = references.flatMap((reference) => [
    reference.sourceType,
    Number(reference.sourceId),
  ]);

  const [rows]: any = await db.query(
    `
      SELECT
        mechanic.id,
        mechanic.mechanic_key,
        mechanic.name,
        mechanic.description,
        mechanic.handler_key,
        mechanic.target_rule,
        mechanic.cast_time_ms,
        mechanic.cooldown_ms,
        mechanic.recovery_ms,
        mechanic.priority,
        mechanic.weight,
        mechanic.interruptible,
        mechanic.telegraph,
        mechanic.config AS mechanic_config,
        assignment.minimum_hp_percent,
        assignment.maximum_hp_percent,
        assignment.available_after_ms,
        assignment.maximum_uses,
        assignment.config AS assignment_config
      FROM enemy_mechanic_assignments assignment
      JOIN enemy_mechanics mechanic
        ON mechanic.id = assignment.enemy_mechanic_id
      WHERE assignment.is_active = 1
        AND mechanic.is_active = 1
        AND (${where})
      ORDER BY mechanic.priority DESC, assignment.id ASC
    `,
    parameters,
  );

  const definitions = new Map<string, EnemyMechanicDefinition>();
  for (const row of rows ?? []) {
    const mechanicKey = String(row.mechanic_key || "").trim();
    if (!mechanicKey) continue;
    const config = {
      ...parseConfig(row.mechanic_config),
      ...parseConfig(row.assignment_config),
    };

    definitions.set(mechanicKey, {
      id: Number(row.id),
      mechanicKey,
      name: String(row.name || mechanicKey),
      description: String(row.description || ""),
      handlerKey: String(row.handler_key || "").trim(),
      targetRule: normalizeTargetRule(row.target_rule),
      castTimeMs: Math.max(0, Number(row.cast_time_ms) || 0),
      cooldownMs: Math.max(0, Number(row.cooldown_ms) || 0),
      recoveryMs: Math.max(0, Number(row.recovery_ms) || 350),
      priority: Number(row.priority) || 0,
      weight: Math.max(0, Number(row.weight) || 1),
      interruptible: Boolean(row.interruptible),
      telegraph: row.telegraph ? String(row.telegraph) : null,
      config,
      minimumHpPercent: Math.max(0, Number(row.minimum_hp_percent) || 0),
      maximumHpPercent: Math.min(100, Number(row.maximum_hp_percent) || 100),
      availableAfterMs: Math.max(0, Number(row.available_after_ms) || 0),
      maximumUses:
        row.maximum_uses == null
          ? null
          : Math.max(0, Number(row.maximum_uses) || 0),
    });
  }

  return Array.from(definitions.values());
}
