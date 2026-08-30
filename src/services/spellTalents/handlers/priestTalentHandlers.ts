import { db } from "../../../db";
import { applyBuff } from "../../buffService";
import type { SpellHandlerResult } from "../../spellHandlers/types";
import type { SpellTalentHandler, TalentConfig } from "../types";

const n = (c: TalentConfig, k: string, d = 0) => {
  const value = Number(c[k]);
  return Number.isFinite(value) ? value : d;
};
const targetId = (c: any, r?: any) => Number(r?.healedTargetId ?? c.targetPlayerId ?? c.playerId);
const targetMaxHp = (c: any, r?: any) => Math.max(1, Number(r?.healedTargetMaxHP ?? c.maxTargetHP ?? c.maxPlayerHP ?? c.targetPlayer?.maxhp ?? c.player?.maxhp ?? 1));
const living = (c: any) => (c.allies ?? []).filter((a: any) => Number(a.hp) > 0);
const append = (r: SpellHandlerResult, message: string) => ({ ...r, log: `${r.log ?? ""} ${message}`.trim() });

async function healPercent(playerId: number, maxHp: number, percent: number) {
  const amount = Math.max(1, Math.floor(maxHp * percent / 100));
  const [rows]: any = await db.query(`SELECT hpoints FROM players WHERE id = ? LIMIT 1`, [playerId]);
  const before = Math.max(0, Number(rows[0]?.hpoints) || 0);
  await db.query(`UPDATE players SET hpoints = LEAST(?, hpoints + ?) WHERE id = ?`, [maxHp, amount, playerId]);
  return Math.max(0, Math.min(maxHp, before + amount) - before);
}

async function shield(playerId: number, amount: number, duration: number, source: string) {
  if (amount <= 0) return;
  await db.query(`
    INSERT INTO player_shields (player_id,max_absorb,remaining_absorb,expires_at,source)
    VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL ? SECOND),?)
    ON DUPLICATE KEY UPDATE max_absorb=VALUES(max_absorb),remaining_absorb=VALUES(remaining_absorb),expires_at=VALUES(expires_at)
  `, [playerId, amount, amount, duration, source]);
}

export const restorativeOverflow: SpellTalentHandler = { async afterCast(c, r) {
  const amount = Math.min(Math.floor(targetMaxHp(c,r) * n(c.talent.config,"capMaxHpPercent",10)/100), Math.max(0, Number(r.overhealing)||0));
  await shield(targetId(c,r), amount, 8, `talent:${c.talent.id}`);
  return amount ? append({...r, overflowShield: amount}, `✨ Restorative Overflow forms a ${amount}-point shield!`) : r;
}};
export const healingHands: SpellTalentHandler = { beforeCast(c) {
  const hp=Number(c.currentTargetHP ?? c.currentPlayerHP ?? 0), max=targetMaxHp(c);
  if (hp/max < n(c.talent.config,"healthThresholdPercent",40)/100) c.spell.heal=Math.round(Number(c.spell.heal)*(1+n(c.talent.config,"healingPercent",30)/100));
}};
export const invigoratingMend: SpellTalentHandler = { afterCast(c,r) { return {...r,targetGaugeGain:(Number(r.targetGaugeGain)||0)+n(c.talent.config,"gaugeGain",12),targetGaugePlayerId:targetId(c,r)}; }};
export const conservedLight: SpellTalentHandler = { afterCast(c,r) { return Number(r.overhealing)>0 ? r : {...r,manaRestored:(Number(r.manaRestored)||0)+Math.floor(Number(c.castState.manaCost)*n(c.talent.config,"refundPercent",30)/100)}; }};

export const immediateRelief: SpellTalentHandler = { async afterCast(c,r) { const amount=Math.max(0,Number(r.renewHealingPerTick)||0); if(amount) await db.query(`UPDATE players SET hpoints=LEAST(?,hpoints+?) WHERE id=?`,[targetMaxHp(c,r),amount,targetId(c,r)]); return amount?append({...r,healing:(Number(r.healing)||0)+amount},`✨ Renew immediately restores ${amount} HP.`):r; }};
export const gracefulRenew: SpellTalentHandler = { modifySpell(c) { const cfg=(c.spell.rank_config ??= {}); cfg.renewLowHealthThreshold=n(c.talent.config,"healthThresholdPercent",50); cfg.renewLowHealthBonus=n(c.talent.config,"healingPercent",30); }};
export const perpetualLight: SpellTalentHandler = { modifySpell(c) { const cfg=(c.spell.rank_config ??= {}); cfg.renewRefreshPercent=n(c.talent.config,"refreshPercent",50); cfg.renewRefreshes=1; }};
export const restoringRhythm: SpellTalentHandler = { modifySpell(c) { const cfg=(c.spell.rank_config ??= {}); cfg.renewGaugePerTick=n(c.talent.config,"gaugeGain",3); }};

export const empoweringFortitude: SpellTalentHandler = { async afterCast(c,r) { await applyBuff(targetId(c,r),"damage_dealt_pct",n(c.talent.config,"damagePercent",10),Number(c.spell.buff_duration),`talent:${c.talent.id}`); return {...r,appliedStatus:true}; }};
export const fortifiedSpirit: SpellTalentHandler = { async afterCast(c,r) { await applyBuff(targetId(c,r),"damage_reduction",n(c.talent.config,"reductionPercent",12),Number(c.spell.buff_duration),`talent:${c.talent.id}`); return {...r,appliedStatus:true}; }};
export const spiritualVigor: SpellTalentHandler = { async afterCast(c,r) { await applyBuff(targetId(c,r),"healing_received_pct",n(c.talent.config,"percent",15),Number(c.spell.buff_duration),`talent:${c.talent.id}`); return {...r,appliedStatus:true}; }};
export const sharedBlessing: SpellTalentHandler = { async afterCast(c,r) { if(targetId(c,r)!==c.playerId) await applyBuff(c.playerId,String(c.spell.buff_stat),Math.floor(Number(c.spell.buff_value)*n(c.talent.config,"copyPercent",50)/100),Number(c.spell.buff_duration),`talent:${c.talent.id}`); return {...r,appliedStatus:true}; }};

export const cleansingGrace: SpellTalentHandler = { async afterCast(c,r) { if(!Number(r.cleansedCount)) return r; const healed=await healPercent(targetId(c,r),targetMaxHp(c,r),n(c.talent.config,"maxHpPercent",12)); return append({...r,healing:(Number(r.healing)||0)+healed},`✨ Cleansing Grace restores ${healed} HP.`); }};
export const purifyingWave: SpellTalentHandler = { modifySpell(c) { c.spell.target_type="all_allies"; c.castState.cooldownSeconds+=n(c.talent.config,"cooldownIncrease",4); }};
export const lingeringPurity: SpellTalentHandler = { async afterCast(c,r) { if(Number(r.cleansedCount)) await applyBuff(targetId(c,r),"damage_reduction",n(c.talent.config,"reductionPercent",20),n(c.talent.config,"durationSeconds",6),`talent:${c.talent.id}`); return r; }};
export const reclaimedStrength: SpellTalentHandler = { afterCast(c,r) { return Number(r.cleansedCount)?{...r,restoreManaPercent:(Number(r.restoreManaPercent)||0)+n(c.talent.config,"maxManaPercent",15)}:r; }};
export const massRestoration: SpellTalentHandler = { async afterCast(c,r) { if(!Number(r.cleansedCount)) return r; const healed=await healPercent(targetId(c,r),targetMaxHp(c,r),n(c.talent.config,"maxHpPercent",8)); return {...r,healing:(Number(r.healing)||0)+healed}; }};
export const sacredImmunity: SpellTalentHandler = { async afterCast(c,r) { if(!Number(r.cleansedCount)) return r; await db.query(`INSERT INTO player_status_effects(player_id,effect_key,value,charges,expires_at,source) VALUES(?, 'cleanse_immunity_all',1,1,DATE_ADD(NOW(),INTERVAL ? SECOND),?) ON DUPLICATE KEY UPDATE expires_at=VALUES(expires_at)`,[targetId(c,r),n(c.talent.config,"durationSeconds",8),`talent:${c.talent.id}`]); return {...r,appliedStatus:true}; }};

export const miracleWorker: SpellTalentHandler = { beforeCast(c) { if(Math.random()<n(c.talent.config,"critChance",25)/100){ c.spell.heal=Math.round(Number(c.spell.heal)*1.5); c.castState.flags.add("priest_critical_heal"); } }, afterCast(c,r){ return c.castState.flags.has("priest_critical_heal")?append({...r,crit:true},"✨ Critical heal!"):r; }};
export const salvation: SpellTalentHandler = { beforeCast(c) { const hp=Number(c.currentTargetHP ?? c.currentPlayerHP ?? 0),max=targetMaxHp(c); if(hp/max<n(c.talent.config,"healthThresholdPercent",25)/100)c.spell.heal=Math.round(Number(c.spell.heal)*(1+n(c.talent.config,"healingPercent",50)/100)); }};
export const echoOfGrace: SpellTalentHandler = { async afterCast(c,r) { const amount=Math.floor((Number(r.healing)||0)*n(c.talent.config,"repeatPercent",35)/100); if(amount) await db.query(`INSERT INTO player_hots(player_id,healing,tick_interval,next_tick_at,expires_at,source,display_name) VALUES(?,?,2,DATE_ADD(NOW(3),INTERVAL 2 SECOND),DATE_ADD(NOW(3),INTERVAL 3 SECOND),?,?)`,[targetId(c,r),amount,`talent:${c.talent.id}`,"Echo of Grace"]); return r; }};
export const sharedRestoration: SpellTalentHandler = { async afterCast(c,r) { if(targetId(c,r)===c.playerId)return r; const max=Math.max(1,Number(c.maxPlayerHP ?? c.player?.maxhp)); const amount=Math.floor((Number(r.healing)||0)*n(c.talent.config,"selfHealPercent",40)/100); await db.query(`UPDATE players SET hpoints=LEAST(?,hpoints+?) WHERE id=?`,[max,amount,c.playerId]); return {...r,healing:(Number(r.healing)||0)+amount}; }};

export const handOfSalvation: SpellTalentHandler = { async afterCast(c,r) { const other=living(c).filter((a:any)=>Number(a.playerId)!==targetId(c,r)).sort((a:any,b:any)=>a.hp/a.maxHp-b.hp/b.maxHp)[0]; if(!other)return r; const amount=Math.floor((Number(r.potentialHealing ?? r.healing)||0)*n(c.talent.config,"secondaryPercent",50)/100); await db.query(`UPDATE players SET hpoints=LEAST(?,hpoints+?) WHERE id=?`,[other.maxHp,amount,other.playerId]); return {...r,healing:(Number(r.healing)||0)+amount}; }};
export const defyDeath: SpellTalentHandler = { modifySpell(c) { (c.spell.rank_config ??= {}).interventionRevivePercent=n(c.talent.config,"revivePercent",60); }};
export const divineResonance: SpellTalentHandler = { async afterCast(c,r) { let total=0; for(const a of living(c)) total+=await healPercent(a.playerId,a.maxHp,n(c.talent.config,"maxHpPercent",20)); return {...r,healing:(Number(r.healing)||0)+total}; }};
export const rallyFromBrink: SpellTalentHandler = { afterCast(c,r) { return {...r,partyGaugeGain:(Number(r.partyGaugeGain)||0)+n(c.talent.config,"gaugeGain",25)}; }};
export const immortalSoul: SpellTalentHandler = { modifySpell(c) { const cfg=(c.spell.rank_config ??={}); cfg.interventionCharges=n(c.talent.config,"charges",2); cfg.interventionDurationBonus=n(c.talent.config,"durationBonus",4); }};
export const vengefulResurrection: SpellTalentHandler = { modifySpell(c) { const cfg=(c.spell.rank_config ??={}); cfg.interventionTriggerDamagePercent=n(c.talent.config,"damagePercent",30); cfg.interventionTriggerDamageDuration=n(c.talent.config,"durationSeconds",10); cfg.interventionTriggerGauge=100; }};
