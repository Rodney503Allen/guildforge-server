import { applyBuff } from "../../buffService";
import { applySpellDebuff,applySpellDot,setSpellEnemyHP } from "../../spellHandlers/helpers";
import type { SpellHandlerResult } from "../../spellHandlers/types";
import type { SpellTalentHandler,TalentConfig } from "../types";
const n=(c:TalentConfig,k:string,d=0)=>{const v=Number(c[k]);return Number.isFinite(v)?v:d;};
const cfg=(c:any)=>{if(!c.spell.rank_config||typeof c.spell.rank_config!=="object")c.spell.rank_config={};return c.spell.rank_config as Record<string,any>;};
const living=(c:any)=>{const a=(c.allies??[]).filter((x:any)=>Number(x.hp)>0);return a.length?a:[{playerId:c.playerId,hp:c.currentPlayerHP??c.player?.hpoints??1,maxHp:c.maxPlayerHP??c.player?.maxhp??1,stats:c.player}];};
async function debuff(c:any,stat:string,value:number,seconds:number){if(c.enemy)await applySpellDebuff(c.enemy,{sourcePlayerId:c.playerId,spellId:Number(c.spell.id),spellName:String(c.spell.name),stat,value,durationSeconds:seconds});}
async function repeat(c:any,r:SpellHandlerResult,pct:number,label:string){if(!c.enemy||r.dodged||!r.damage||Number(r.enemyHP)<=0)return r;const extra=Math.max(1,Math.floor(Number(r.damage)*pct/100));const hp=Math.max(0,Number(r.enemyHP)-extra);await setSpellEnemyHP(c.enemy,hp);return{...r,damage:Number(r.damage)+extra,enemyHP:hp,killedEnemy:hp<=0,log:`${r.log??""} ⚡ ${label} deals ${extra} additional damage!`};}
export const elementalistTalentHandlers:Record<string,SpellTalentHandler>={
 elementalist_echoing_spark:{afterCast(c,r){return Math.random()<n(c.talent.config,"chance",35)/100?repeat(c,r,n(c.talent.config,"repeatDamagePercent",50),"Echoing Spark"):r;}},
 elementalist_kinetic_spark:{afterCast(c,r){return r.crit?{...r,casterGaugeGain:(Number(r.casterGaugeGain)||0)+n(c.talent.config,"gaugeGain",15)}:r;}},
 elementalist_stored_charge:{async afterCast(c,r){if(!r.dodged)await applyBuff(c.playerId,"spell_damage_dealt_pct",n(c.talent.config,"damagePercent",20),n(c.talent.config,"durationSeconds",12),`talent:${c.talent.id}:next-spell`);return r;}},
 elementalist_arcane_recycling:{afterCast(c,r){return r.killedEnemy?{...r,manaRestored:(Number(r.manaRestored)||0)+Math.floor(c.castState.manaCost*n(c.talent.config,"refundPercent",100)/100),resetSpellCooldown:Number(c.spell.id)}:r;}},
 elementalist_shatterpoint:{async beforeCast(c){if(Number(await c.enemy?.getDebuffValue?.("attack_speed_pct"))>0)c.spell.damage=Math.round(Number(c.spell.damage)*(1+n(c.talent.config,"damagePercent",40)/100));}},
 elementalist_brittle_ice:{async afterCast(c,r){if(r.appliedStatus)await debuff(c,"defense_pct",n(c.talent.config,"defenseReductionPercent",15),Number(c.spell.debuff_duration));return r;}},
 elementalist_frozen_momentum:{afterCast(c,r){return r.appliedStatus?{...r,casterGaugeGain:(Number(r.casterGaugeGain)||0)+n(c.talent.config,"gaugeGain",12)}:r;}},
 elementalist_explosive_impact:{afterCast(c,r){return{...r,splashDamagePercent:n(c.talent.config,"splashPercent",35)};}},
 elementalist_lingering_flame:{async afterCast(c,r){if(!r.dodged&&Number(r.enemyHP)>0&&c.enemy)await applySpellDot(c.enemy,{sourcePlayerId:c.playerId,spellId:Number(c.spell.id),spellName:`${c.spell.name} — Lingering Flame`,totalDamage:Math.floor(Number(r.damage)*n(c.talent.config,"dotPercent",30)/100),durationSeconds:n(c.talent.config,"durationSeconds",6),tickRateSeconds:n(c.talent.config,"tickRate",2)});return r;}},
 elementalist_searing_core:{beforeCast(c){if(!c.enemy)return;const pct=n(c.talent.config,"defensePenetrationPercent",20);c.castState.values.set("searing_core_defense",{enemy:Number(c.enemy.defense)||0,stats:Number(c.enemy.stats?.defense)||0});c.enemy.defense=(Number(c.enemy.defense)||0)*(1-pct/100);if(c.enemy.stats)c.enemy.stats.defense=(Number(c.enemy.stats.defense)||0)*(1-pct/100);},afterCast(c,r){const old:any=c.castState.values.get("searing_core_defense");if(old&&c.enemy){c.enemy.defense=old.enemy;if(c.enemy.stats)c.enemy.stats.defense=old.stats;}return r;}},
 elementalist_concussive_blast:{async afterCast(c,r){if(!r.dodged)await debuff(c,"damage_dealt_pct",n(c.talent.config,"damageReductionPercent",15),n(c.talent.config,"durationSeconds",6));return r;}},
 elementalist_wildfire:{afterCast(c,r){return{...r,splashDamagePercent:n(c.talent.config,"splashPercent",60)};}},
 elementalist_conductive_current:{async afterCast(c,r){if(!r.dodged)await debuff(c,"spell_damage_taken_pct",n(c.talent.config,"spellDamageTakenPercent",12),n(c.talent.config,"durationSeconds",8));return r;}},
 elementalist_overload:{afterCast(c,r){return Math.random()<n(c.talent.config,"chance",25)/100?repeat(c,r,n(c.talent.config,"repeatDamagePercent",50),"Overload"):r;}},
 elementalist_storm_momentum:{afterCast(c,r){const hits=Math.max(1,Number(r.targetsHit)||1);return{...r,casterGaugeGain:(Number(r.casterGaugeGain)||0)+Math.min(n(c.talent.config,"maxGauge",20),hits*n(c.talent.config,"gaugePerTarget",4))};}},
 elementalist_static_recovery:{afterCast(c,r){const hits=Math.max(1,Number(r.targetsHit)||1);return{...r,restoreManaPercent:(Number(r.restoreManaPercent)||0)+Math.min(n(c.talent.config,"maxManaPercent",20),hits*n(c.talent.config,"manaPerTargetPercent",5))};}},
 elementalist_arcing_vulnerability:{async afterCast(c,r){if(!r.dodged)await debuff(c,"defense_pct",n(c.talent.config,"defenseReductionPercent",10),n(c.talent.config,"durationSeconds",8));return r;}},
 elementalist_rising_heat:{modifySpell(c){const x=cfg(c);x.dotEscalationPercent=n(c.talent.config,"increasePerTickPercent",10);x.dotEscalationCap=n(c.talent.config,"maxIncreasePercent",50);}},
 elementalist_scorching_shockwave:{afterCast(c,r){return!r.dodged?{...r,enemyGaugeReduction:(Number(r.enemyGaugeReduction)||0)+n(c.talent.config,"gaugeReduction",15)}:r;}},
 elementalist_cauterizing_flame:{modifySpell(c){cfg(c).dotHealingReductionPercent=n(c.talent.config,"healingReductionPercent",30);},async afterCast(c,r){if(r.appliedStatus)await debuff(c,"healing_received_pct",n(c.talent.config,"healingReductionPercent",30),Number(c.spell.dot_duration));return r;}},
 elementalist_elemental_aftermath:{async afterCast(c,r){if(!r.dodged)await debuff(c,"damage_taken_pct",n(c.talent.config,"damageTakenPercent",20),n(c.talent.config,"durationSeconds",10));return r;}},
 elementalist_triple_calamity:{async afterCast(c,r){let next=r;for(let i=0;i<n(c.talent.config,"additionalHits",2);i++)next=await repeat(c,next,n(c.talent.config,"damagePerHitPercent",30),"Cataclysm");return next;}},
 elementalist_elemental_ascendance:{async afterCast(c,r){for(const a of living(c)){await applyBuff(a.playerId,"damage_dealt_pct",n(c.talent.config,"damagePercent",20),n(c.talent.config,"durationSeconds",10),`talent:${c.talent.id}:damage`);await applyBuff(a.playerId,"crit_damage_pct",n(c.talent.config,"critDamagePercent",20),n(c.talent.config,"durationSeconds",10),`talent:${c.talent.id}:crit`);}return r;}},
 elementalist_eye_of_storm:{afterCast(c,r){return{...r,partyGaugeGain:(Number(r.partyGaugeGain)||0)+n(c.talent.config,"gaugeGain",30)};}}
};
