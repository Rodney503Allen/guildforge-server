export type EnemyMechanicSourceType =
  | "creature"
  | "hunt_target"
  | "dungeon_enemy"
  | "raid_enemy"
  | "tower_enemy";

export type EnemyMechanicTargetRule =
  | "highest_threat"
  | "second_highest_threat"
  | "lowest_threat"
  | "random_living_player"
  | "lowest_hp_player"
  | "highest_hp_player"
  | "all_living_players"
  | "self";

export type EnemyMechanicDefinition = {
  id: number;
  mechanicKey: string;
  name: string;
  description: string;
  handlerKey: string;
  targetRule: EnemyMechanicTargetRule;
  castTimeMs: number;
  cooldownMs: number;
  recoveryMs: number;
  priority: number;
  weight: number;
  interruptible: boolean;
  telegraph: string | null;
  config: Record<string, unknown>;
  minimumHpPercent: number;
  maximumHpPercent: number;
  availableAfterMs: number;
  maximumUses: number | null;
};

export type EnemyMechanicParticipant = {
  playerId: number;
  name: string;
  hp: number;
  maxHp: number;
  gauge: number;
  ready: boolean;
};

export type EnemyMechanicThreatState = {
  threat: Record<number, number>;
  targetPlayerId: number | null;
};

export type ActiveEnemyMechanicCast = {
  mechanicId: number;
  mechanicKey: string;
  name: string;
  description: string;
  handlerKey: string;
  targetRule: EnemyMechanicTargetRule;
  targetPlayerIds: number[];
  startedAt: number;
  resolvesAt: number;
  interruptible: boolean;
  telegraph: string | null;
  config: Record<string, unknown>;
};

export type EnemyMechanicRuntime = {
  definitions: EnemyMechanicDefinition[];
  cooldowns: Record<string, number>;
  uses: Record<string, number>;
  activeCast: ActiveEnemyMechanicCast | null;
  lastMechanicKey: string | null;
  sequence: number;
};

export type EnemyMechanicExecutionResult = {
  ok: boolean;
  log?: string | string[];
};

export type EnemyMechanicAdapter = {
  enemyName: string;
  enemyMaxHp: number;
  participants: EnemyMechanicParticipant[];
  threatState: EnemyMechanicThreatState;
  attackPlayer(
    playerId: number,
    options: {
      damageMultiplier?: number;
      abilityName?: string;
    },
  ): Promise<void>;
  healEnemy(amount: number, abilityName?: string): Promise<number>;
  changePlayerGauge(playerId: number, amount: number): Promise<number>;
  appendLog(line: string): void;
};

export type EnemyMechanicHandlerContext = {
  definition: EnemyMechanicDefinition;
  cast: ActiveEnemyMechanicCast;
  targets: EnemyMechanicParticipant[];
  adapter: EnemyMechanicAdapter;
  now: number;
};

export type EnemyMechanicHandler = (
  context: EnemyMechanicHandlerContext,
) => Promise<EnemyMechanicExecutionResult>;

export type EnemyMechanicAdvanceResult =
  | { kind: "none" }
  | { kind: "casting"; cast: ActiveEnemyMechanicCast }
  | { kind: "started"; cast: ActiveEnemyMechanicCast }
  | {
      kind: "resolved";
      cast: ActiveEnemyMechanicCast;
      definition: EnemyMechanicDefinition;
      recoveryMs: number;
    };

export type EnemyMechanicInterruptResult = {
  interrupted: boolean;
  cast: ActiveEnemyMechanicCast | null;
};
