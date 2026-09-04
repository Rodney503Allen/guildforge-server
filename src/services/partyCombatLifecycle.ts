// src/services/partyCombatLifecycle.ts
import type {
  PartyCombatEnemy,
  PartyCombatPlayer,
} from "./partyCombatRuntime";

export type PartyCombatLifecycleContext = {
  encounterId: number;
  players: Map<number, PartyCombatPlayer>;
  enemy: PartyCombatEnemy;
};

export type PartyCombatLifecycleAdapter = {
  /**
   * Persist the current enemy HP to whatever backing store
   * owns this encounter.
   *
   * Hunt:
   *   UPDATE hunt_encounters
   *
   * Dungeon:
   *   UPDATE dungeon encounter runtime
   *
   * World/Raid:
   *   their own persistence implementation
   */
  persistEnemyHp:
    (
      context: PartyCombatLifecycleContext
    ) => Promise<void>;

  /**
   * Called once the shared combat layer determines that
   * the current enemy has been defeated.
   *
   * The context decides what victory means.
   */
  onEnemyDefeated:
    (
      context: PartyCombatLifecycleContext
    ) => Promise<void>;

  /**
   * Called once no living player remains.
   */
  onPartyDefeated:
    (
      context: PartyCombatLifecycleContext
    ) => Promise<void>;
};

export async function persistPartyCombatEnemyHp(
  adapter: PartyCombatLifecycleAdapter,
  context: PartyCombatLifecycleContext,
) {
  await adapter.persistEnemyHp(
    context
  );
}

export async function completePartyCombatEnemyDefeat(
  adapter: PartyCombatLifecycleAdapter,
  context: PartyCombatLifecycleContext,
) {
  await adapter.onEnemyDefeated(
    context
  );
}

export async function completePartyCombatPartyDefeat(
  adapter: PartyCombatLifecycleAdapter,
  context: PartyCombatLifecycleContext,
) {
  await adapter.onPartyDefeated(
    context
  );
}
