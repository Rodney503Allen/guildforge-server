import { getFinalPlayerStats } from "../playerService";
import { publishPlayerStatePatch } from "../../playerStateEvents";
import type { DerivedStats } from "../statEngine";

export type MutableCombatPlayer = {
  playerId: number;
  name?: string;
  hp: number;
  maxHp: number;
  sp: number;
  maxSp: number;
  stats: DerivedStats;
  atbRateMult?: number;
};

export async function refreshCombatPlayer(actor: MutableCombatPlayer): Promise<DerivedStats | null> {
  const stats = await getFinalPlayerStats(actor.playerId);
  if (!stats) return null;
  actor.stats = stats;
  actor.name = stats.name ?? actor.name;
  actor.maxHp = Math.max(1, Number(stats.maxhp) || actor.maxHp);
  actor.maxSp = Math.max(0, Number(stats.maxspoints) || actor.maxSp);
  actor.hp = Math.max(0, Math.min(actor.maxHp, Number(stats.hpoints) || 0));
  actor.sp = Math.max(0, Math.min(actor.maxSp, Number(stats.spoints) || 0));
  actor.atbRateMult = Math.max(0.01, Number(stats.atbRateMult) || 1);
  return stats;
}

export function publishCombatPlayerVitals(actor: MutableCombatPlayer): void {
  publishPlayerStatePatch(actor.playerId, {
    hpoints: actor.hp,
    maxhp: actor.maxHp,
    spoints: actor.sp,
    maxspoints: actor.maxSp,
  });
}
