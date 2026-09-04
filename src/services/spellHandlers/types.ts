// src/services/spellHandlers/types.ts

import type {
  DerivedStats
} from "../statEngine";

import type {
  ActiveSpellTalent,
  SpellCastState,
  TalentConfig
} from "../spellTalents/types";


// =====================================================
// ENEMY SOURCE
// =====================================================

export type SpellEnemySourceType =
  | "player_creature"
  | "hunt"
  | "dungeon"
  | "raid";


// =====================================================
// DOT APPLICATION
// =====================================================

export type SpellDotApplication = {
  sourcePlayerId: number;

  spellId: number;
  spellName: string;

  totalDamage: number;

  durationSeconds: number;
  tickRateSeconds: number;
  immediateFirstTick?: boolean;
  defenseReductionPerTick?: number;
  defenseReductionMaxStacks?: number;
  manaRestorePercentPerTick?: number;
};


// =====================================================
// DEBUFF APPLICATION
// =====================================================

export type SpellDebuffApplication = {
  sourcePlayerId: number;

  spellId: number;
  spellName: string;

  stat: string;
  value: number;

  durationSeconds: number;
};


// =====================================================
// SPELL ENEMY
// =====================================================

export type SpellEnemy = {
  /*
   * Combat-system-specific instance ID.
   *
   * Normal combat:
   * player_creatures.id
   *
   * Hunt:
   * hunt_encounters.id
   *
   * Dungeon/Raid:
   * future encounter instance IDs
   */
  id: number;

  name: string;

  hp: number;
  maxhp: number;

  /*
   * These are useful fallbacks when a complete
   * DerivedStats object has not been supplied.
   */
  level?: number;

  attack?: number;
  defense?: number;
  agility?: number;

  vitality?: number;
  intellect?: number;
  crit?: number;

  /*
   * Preferred combat-stat representation.
   *
   * Hunt combat can pass:
   * session.enemy.stats
   *
   * Normal combat can pass its current
   * refreshed DerivedStats.
   */
  stats?: DerivedStats;

  /*
   * Identifies which combat system owns
   * this enemy.
   */
  sourceType?:
    SpellEnemySourceType;

  /*
   * Persist enemy HP through whichever
   * combat system owns the enemy.
   */
  setHP?: (
    hp: number
  ) => Promise<void>;

  /*
   * Apply DOT through the owning
   * combat system.
   */
  applyDot?: (
    args: SpellDotApplication
  ) => Promise<any>;

  /*
   * Apply debuff through the owning
   * combat system.
   */
  applyDebuff?: (
    args: SpellDebuffApplication
  ) => Promise<any>;

  getDebuffValue?: (
  stat: string
  ) => Promise<number>;

  removeDebuff?: (
    stat: string
  ) => void | Promise<void>;
};


// =====================================================
// SPELL RECORD
// =====================================================

export type SpellRecord = {
  id: number;

  name: string;
  description?: string | null;

  type:
    | "damage"
    | "dot"
    | "damage_dot"
    | "heal"
    | "buff"
    | "debuff";

  handler_key?: string | null;

  damage?: number | null;
  heal?: number | null;

  dot_damage?: number | null;
  dot_duration?: number | null;
  dot_tick_rate?: number | null;

  buff_stat?: string | null;
  buff_value?: number | null;
  buff_duration?: number | null;

  debuff_stat?: string | null;
  debuff_value?: number | null;
  debuff_duration?: number | null;

  mana_cost?: number;
  cooldown?: number;

  target_type?: string;
  effect_type?: string;

  [key: string]: any;
};


// =====================================================
// SPELL HANDLER RESULT
// =====================================================

export type SpellEnemyHitResult = {
  enemyId: number;
  enemyName?: string;

  damage: number;
  enemyHP: number;

  killedEnemy?: boolean;
  crit?: boolean;
  dodged?: boolean;
};

export type SpellHandlerResult = {
  log?: string;

  damage?: number;

  /*
   * Multi-hostile spells populate this with the exact result for
   * each enemy they affected. Single-target handlers may omit it.
   */
  enemyResults?: SpellEnemyHitResult[];
  healing?: number;

  enemyHP?: number;
  playerHP?: number;

  killedEnemy?: boolean;

  appliedStatus?: boolean;

  crit?: boolean;
  dodged?: boolean;

  // Applied by the owning combat session after the
  // caster's action has been consumed.
  partyGaugeGain?: number;
  casterGaugeGain?: number;
  manaRestored?: number;
  restoreManaPercent?: number;
  splashDamagePercent?: number;

  // Extra threat added after normal damage/healing threat.
  threatGenerated?: number;

  // Multiplies normal damage and effective-healing threat.
  // It does not multiply threatGenerated.
  threatMultiplier?: number;

  [key: string]: any;
};

// =====================================================
// FRIENDLY SPELL TARGET
// =====================================================

export type SpellFriendlyTarget = {
  playerId: number;

  name?: string;

  stats: any;

  hp: number;
  maxHp: number;

  sp: number;
  maxSp: number;
};
// =====================================================
// SPELL HANDLER CONTEXT
// =====================================================

export type SpellHandlerContext = {
  playerId: number;

  spell: SpellRecord;

  player: any;

  enemy?: SpellEnemy | null;

  /*
   * Optional hostile collection for multi-enemy combat.
   *
   * Hunts / normal combat may omit this and continue using `enemy`.
   * Dungeons / raids can provide every living hostile, with the
   * player's selected target placed first.
   */
  enemies?: SpellEnemy[];

  currentPlayerHP?: number;
  currentPlayerSP?: number;

  maxPlayerHP?: number;
  maxPlayerSP?: number;

  // Single friendly target.
  targetPlayerId?: number;
  targetPlayer?: any;

  currentTargetHP?: number;
  currentTargetSP?: number;

  maxTargetHP?: number;
  maxTargetSP?: number;

  // Party / raid friendly targets.
  allies?: SpellFriendlyTarget[];

  // Prepared spell-talent runtime. These remain optional until every
  // combat mode has moved to the shared preparation pipeline.
  talents?: ActiveSpellTalent[];
  castState?: SpellCastState;

  hasTalent?: (
    handlerKey: string
  ) => boolean;

  getTalent?: (
    handlerKey: string
  ) => ActiveSpellTalent | null;

  getTalentConfig?: <
    T extends TalentConfig = TalentConfig
  >(
    handlerKey: string
  ) => T | null;
};


// =====================================================
// SPELL HANDLER DEFINITION
// =====================================================

export type SpellHandlerDefinition = {
  requiresEnemy: boolean;

  validate?: (
    spell: SpellRecord
  ) => string | null;

  execute: (
    context: SpellHandlerContext
  ) => Promise<SpellHandlerResult>;
};
