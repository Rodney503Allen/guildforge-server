/** Creature-inflicted status effects for world combat. */
export type CreatureEffectType = 'frost' | 'fire' | 'lightning' | 'blight' | 'bleed';
export type ActiveCreatureEffect = {
  type: CreatureEffectType;
  stacks: number;
  expiresAt: number;
  nextTickAt: number | null;
  appliedAt: number;
  immunityUntil?: number;
  /** Bleed damage remaining from the triggering hit (post-mitigation). */
  bleedRemainingDamage?: number;
  bleedTicksRemaining?: number;
};
export type CreatureEffectDefinition = {
  label: string;
  procChance: number;
  durationMs: number;
  maxStacks: number;
  tickIntervalMs: number | null;
  tickMaxHpPercent: number;
  icon: string;
};
export const CREATURE_EFFECTS: Record<CreatureEffectType, CreatureEffectDefinition> = {
  frost: { label: 'Chilled', procChance: 0.15, durationMs: 10000, maxStacks: 2, tickIntervalMs: null, tickMaxHpPercent: 0, icon: '❄️' },
  fire: { label: 'Burning', procChance: 0.15, durationMs: 9000, maxStacks: 1, tickIntervalMs: 3000, tickMaxHpPercent: 0.02, icon: '🔥' },
  lightning: { label: 'Stunned', procChance: 0.10, durationMs: 1500, maxStacks: 1, tickIntervalMs: null, tickMaxHpPercent: 0, icon: '⚡' },
  blight: { label: 'Poisoned', procChance: 0.15, durationMs: 12000, maxStacks: 3, tickIntervalMs: 3000, tickMaxHpPercent: 0.01, icon: '☠️' },
  // Bleed: 15% on hit; deals 100% of triggering hit damage over 3 ticks / 9 seconds. Reapplications replace the pool.
  bleed: { label: 'Bleeding', procChance: 0.15, durationMs: 9000, maxStacks: 1, tickIntervalMs: 3000, tickMaxHpPercent: 0, icon: '🩸' },
};
export function parseCreatureEffect(value: unknown): CreatureEffectType | null {
  const key = String(value ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CREATURE_EFFECTS, key) ? key as CreatureEffectType : null;
}
export function isStunned(effects: ActiveCreatureEffect[], now = Date.now()): boolean {
  return effects.some(effect =>
    effect.expiresAt > now &&
    (effect.type === 'lightning' || (effect.type === 'frost' && effect.stacks >= 2))
  );
}
export function hasDeepFreeze(effects: ActiveCreatureEffect[], now = Date.now()): boolean {
  return effects.some(effect => effect.type === 'frost' && effect.stacks >= 1 && effect.expiresAt > now);
}
export function applyCreatureEffect(effects: ActiveCreatureEffect[], type: CreatureEffectType, now = Date.now(), random = Math.random): { applied: boolean; effect: ActiveCreatureEffect | null; triggered: boolean } {
  const definition = CREATURE_EFFECTS[type];
  if (random() >= definition.procChance) return { applied: false, effect: null, triggered: false };
  if (type === 'lightning' && effects.some(e => e.type === 'lightning' && (e.immunityUntil ?? 0) > now)) return { applied: false, effect: null, triggered: false };
  const current = effects.find(effect => effect.type === type && effect.expiresAt > now);
  if (current) {
    // First stack slows ATB; second stack freezes for 6 seconds.
    current.stacks = Math.min(definition.maxStacks, current.stacks + 1);
    current.expiresAt = now + (type === 'frost' && current.stacks >= 2 ? 6000 : definition.durationMs);
    // Refresh Bleed's three-tick cycle when reapplied, rather than producing
    // an immediate extra tick or carrying over an old pending tick.
    if (type === 'bleed' && definition.tickIntervalMs) {
      current.nextTickAt = now + definition.tickIntervalMs;
    }
    return { applied: true, effect: current, triggered: type === 'frost' && current.stacks === 2 };
  }
  const effect: ActiveCreatureEffect = {
    type, stacks: 1, appliedAt: now, expiresAt: now + definition.durationMs,
    nextTickAt: definition.tickIntervalMs ? now + definition.tickIntervalMs : null,
    immunityUntil: type === 'lightning' ? now + 6000 : undefined,
  };
  effects.push(effect);
  return { applied: true, effect, triggered: false };
}
export function snapshotCreatureEffects(effects: ActiveCreatureEffect[], now = Date.now()) {
  return effects.filter(effect => effect.expiresAt > now).map(effect => ({
    type: effect.type,
    kind: 'debuff' as const,
    displayName: effect.type === 'frost' && effect.stacks >= 2 ? 'Frozen' : CREATURE_EFFECTS[effect.type].label,
    icon: CREATURE_EFFECTS[effect.type].icon,
    stacks: effect.stacks,
    remainingMs: Math.max(0, effect.expiresAt - now),
    description: effect.type === 'frost' ? (effect.stacks >= 2 ? 'Frozen: ATB and auto attack paused; cannot act for 6 seconds.' : 'ATB and auto attack fill 50% slower. A second stack freezes you for 6 seconds.') :
      effect.type === 'lightning' ? 'Stunned for 1.5 seconds: ATB and auto attack paused. Immune to new Lightning stuns for 6 seconds after application.' :
      effect.type === 'bleed' ? 'Bleeding: takes 100% of the triggering attack’s HP damage over 9 seconds (3 ticks). A new bleed replaces the remaining damage; does not stack.' : 'Takes periodic damage.',
  }));
}
