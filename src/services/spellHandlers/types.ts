export interface SpellRecord {
  id: number;
  name: string;
  type: string;
  handler_key?: string | null;

  damage?: number | string | null;
  heal?: number | string | null;

  dot_damage?: number | string | null;
  dot_duration?: number | string | null;
  dot_tick_rate?: number | string | null;

  buff_stat?: string | null;
  buff_value?: number | string | null;
  buff_duration?: number | string | null;

  debuff_stat?: string | null;
  debuff_value?: number | string | null;
  debuff_duration?: number | string | null;
}

export interface SpellEnemy {
  id: number;
  hp: number;
  maxhp: number;
  defense: number;
}

export interface SpellHandlerContext {
  playerId: number;
  spell: SpellRecord;
  player: any;
  enemy: SpellEnemy | null;

  currentPlayerHP: number;
  maxPlayerHP: number;
}

export interface SpellHandlerResult {
  log: string;

  enemyHP?: number;
  playerHP?: number;

  appliedStatus?: boolean;
  killedEnemy?: boolean;
}

export interface SpellHandlerDefinition {
  requiresEnemy: boolean;

  validate: (
    spell: SpellRecord
  ) => string | null;

  execute: (
    context: SpellHandlerContext
  ) => Promise<SpellHandlerResult>;
}