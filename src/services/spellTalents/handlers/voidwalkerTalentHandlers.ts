import { db } from "../../../db";
import { applyBuff } from "../../buffService";
import { applySpellDebuff, setSpellEnemyHP } from "../../spellHandlers/helpers";
import type { SpellHandlerResult } from "../../spellHandlers/types";
import type { SpellTalentHandler, TalentConfig } from "../types";

const n=(c:TalentConfig,k:string,d=0)=>{const v=Number(c[k]);return Number.isFinite(v)?v:d;};
const target=(c:any,r?:any)=>Number(r?.shieldedTargetId ?? r?.healedTargetId ?? c.targetPlayerId ?? c.playerId);
const duration=(c:any,r?:any)=>Math.max(1,Number(r?.shieldDuration ?? c.spell.buff_duration ?? c.spell.debuff_duration ?? 1));
const living=(c:any)=>{const a=(c.allies??[]).filter((x:any)=>Number(x.hp)>0);return a.length?a:[{playerId:c.playerId,hp:c.currentPlayerHP??c.player?.hpoints??1,maxHp:c.maxPlayerHP??c.player?.maxhp??1,stats:c.player}];};
async function shield(pid:number,amount:number,seconds:number,source:string){if(amount<=0)return;await db.query(`INSERT INTO player_shields(player_id,max_absorb,remaining_absorb,expires_at,source) VALUES(?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?) ON DUPLICATE KEY UPDATE max_absorb=VALUES(max_absorb),remaining_absorb=VALUES(remaining_absorb),expires_at=VALUES(expires_at)`,[pid,amount,amount,seconds,source]);}
async function status(pid:number,key:string,value:number,charges:number,seconds:number,source:string){await db.query(`INSERT INTO player_status_effects(player_id,effect_key,value,charges,expires_at,source) VALUES(?,?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),?) ON DUPLICATE KEY UPDATE value=VALUES(value),charges=VALUES(charges),expires_at=VALUES(expires_at)`,[pid,key,value,charges,seconds,source]);}
async function debuff(c:any,stat:string,value:number,seconds:number){if(!c.enemy)return;await applySpellDebuff(c.enemy,{sourcePlayerId:c.playerId,spellId:Number(c.spell.id),spellName:String(c.spell.name),stat,value,durationSeconds:seconds});}
async function repeat(c:any,r:SpellHandlerResult,pct:number,label:string){if(!c.enemy||r.dodged||!r.damage||Number(r.enemyHP)<=0)return r;const extra=Math.max(1,Math.floor(Number(r.damage)*pct/100));const hp=Math.max(0,Number(r.enemyHP)-extra);await setSpellEnemyHP(c.enemy,hp);return{...r,damage:Number(r.damage)+extra,enemyHP:hp,killedEnemy:hp<=0,log:`${r.log??""} 🌌 ${label} deals ${extra} additional damage!`};}

export const voidwalkerTalentHandlers:Record<string,SpellTalentHandler>={
  voidwalker_void_resonance:{async afterCast(c,r){const amount=Math.floor((Number(r.damage)||0)*n(c.talent.config,"damageShieldPercent",25)/100);await shield(c.playerId,amount,n(c.talent.config,"durationSeconds",6),`talent:${c.talent.id}`);return{...r,resonanceShield:amount,appliedStatus:r.appliedStatus||amount>0};}},
  voidwalker_fractured_reality:{async afterCast(c,r){if(!r.dodged&&Number(r.enemyHP)>0)await debuff(c,"defense_pct",n(c.talent.config,"defenseReductionPercent",12),n(c.talent.config,"durationSeconds",8));return r;}},
  voidwalker_lance_barrage:{afterCast(c,r){return Math.random()<n(c.talent.config,"chance",30)/100?repeat(c,r,n(c.talent.config,"repeatDamagePercent",50),"Lance Barrage"):r;}},
  voidwalker_null_charge:{afterCast(c,r){return Number(r.resonanceShield)>0?{...r,casterGaugeGain:(Number(r.casterGaugeGain)||0)+n(c.talent.config,"gaugeGain",12)}:r;}},
  voidwalker_entropic_challenge:{afterCast(c,r){return Number(r.resonanceShield)>0?{...r,threatGenerated:(Number(r.threatGenerated)||0)+n(c.talent.config,"bonusThreat",50)}:r;}},

  voidwalker_void_feedback:{async afterCast(c,r){const pid=target(c,r),sec=duration(c,r),source=`shield:spell:${c.spell.id}`;await status(pid,"void_feedback_percent",n(c.talent.config,"returnPercent",35),1,sec,source);await status(pid,"void_feedback_stored",0,1,sec,source);return r;}},
  voidwalker_null_empowerment:{async afterCast(c,r){await applyBuff(target(c,r),"damage_dealt_pct",n(c.talent.config,"damagePercent",10),duration(c,r),`shield:spell:${c.spell.id}`);return{...r,appliedStatus:true};}},
  voidwalker_collapse_burst:{async afterCast(c,r){await status(target(c,r),"void_feedback_splash_pct",n(c.talent.config,"splashPercent",50),1,duration(c,r),`shield:spell:${c.spell.id}`);return r;}},

  voidwalker_exposed_under_pressure:{async afterCast(c,r){if(r.appliedStatus)await debuff(c,"damage_taken_pct",n(c.talent.config,"damageTakenPercent",12),Number(c.spell.debuff_duration));return r;}},
  voidwalker_heavy_burden:{async afterCast(c,r){if(r.appliedStatus)await debuff(c,"defense_pct",n(c.talent.config,"defenseReductionPercent",15),Number(c.spell.debuff_duration));return r;}},
  voidwalker_time_dilation:{afterCast(c,r){return r.appliedStatus?{...r,enemyGaugeReduction:(Number(r.enemyGaugeReduction)||0)+n(c.talent.config,"gaugeReduction",20)}:r;}},
  voidwalker_gravitic_field:{modifySpell(c){c.spell.target_type=String(c.talent.config.targetType||"all_enemies");c.castState.cooldownSeconds+=n(c.talent.config,"cooldownIncrease",4);}},

  voidwalker_folded_refuge:{async afterCast(c,r){await applyBuff(c.playerId,"damage_reduction",n(c.talent.config,"reductionPercent",15),duration(c,r),`talent:${c.talent.id}`);return{...r,appliedStatus:true};}},
  voidwalker_shared_power:{async afterCast(c,r){await applyBuff(target(c,r),"damage_dealt_pct",n(c.talent.config,"damagePercent",12),duration(c,r),`talent:${c.talent.id}`);return r;}},
  voidwalker_emergency_translation:{async afterCast(c,r){const pid=target(c,r);if(pid!==c.playerId)await status(pid,"spatial_emergency_translation",c.playerId,n(c.talent.config,"charges",1),duration(c,r),`spell:${c.spell.id}`);return r;}},
  voidwalker_reciprocal_flow:{async afterCast(c,r){const pid=target(c,r);if(pid!==c.playerId)await status(pid,"spatial_gauge_gain",n(c.talent.config,"gaugeGain",5),99,duration(c,r),`spell:${c.spell.id}`);return r;}},

  voidwalker_gravitic_shelter:{async afterCast(c,r){for(const a of living(c))await applyBuff(a.playerId,"damage_reduction",n(c.talent.config,"reductionPercent",12),duration(c,r),`talent:${c.talent.id}`);return{...r,appliedStatus:true};}},
  voidwalker_abyssal_retaliation:{async afterCast(c,r){for(const a of living(c))await applyBuff(a.playerId,"damage_dealt_pct",n(c.talent.config,"damagePercent",12),duration(c,r),`talent:${c.talent.id}`);return r;}},
  voidwalker_center_of_gravity:{afterCast(c,r){return{...r,threatGenerated:(Number(r.threatGenerated)||0)+living(c).length*n(c.talent.config,"threatPerAlly",80)};}},
  voidwalker_void_mobilization:{afterCast(c,r){return{...r,partyGaugeGain:(Number(r.partyGaugeGain)||0)+n(c.talent.config,"gaugeGain",15)};}},

  voidwalker_protective_singularity:{async afterCast(c,r){const pct=n(c.talent.config,"shieldMaxHpPercent",20);for(const a of living(c))await shield(a.playerId,Math.floor(Number(a.maxHp)*pct/100),Number(c.spell.debuff_duration),`talent:${c.talent.id}`);return{...r,appliedStatus:true};}},
  voidwalker_crushing_singularity:{async afterCast(c,r){if(r.appliedStatus)await debuff(c,"attack_speed_pct",n(c.talent.config,"attackSpeedReductionPercent",40),Number(c.spell.debuff_duration));return r;}},
  voidwalker_power_from_void:{async afterCast(c,r){for(const a of living(c))await applyBuff(a.playerId,"damage_dealt_pct",n(c.talent.config,"damagePercent",20),n(c.talent.config,"durationSeconds",10),`talent:${c.talent.id}`);return r;}},
  voidwalker_beyond_time:{afterCast(c,r){return{...r,partyGaugeGain:(Number(r.partyGaugeGain)||0)+n(c.talent.config,"allyGaugeGain",30),enemyGaugeReduction:(Number(r.enemyGaugeReduction)||0)+n(c.talent.config,"enemyGaugeReduction",30)};}}
};
