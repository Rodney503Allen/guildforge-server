import { db } from "../db";

export type PlayerHotTickResult={playerId:number;healing:number;newHP:number;maxHP:number;gaugeGain:number;partyEchoHealing:number;casterEchoPlayerId:number|null;casterEchoHealing:number;displayName:string;refreshed:boolean};

export async function processDuePlayerHots(playerIds?:number|number[]):Promise<PlayerHotTickResult[]>{
 const ids=(Array.isArray(playerIds)?playerIds:playerIds===undefined?[]:[playerIds]).map(Number).filter(Number.isFinite);
 const filter=ids.length?` AND player_id IN (${ids.map(()=>'?').join(',')})`:'';
 const [rows]:any=await db.query(`SELECT id FROM player_hots WHERE next_tick_at<=NOW(3) AND expires_at>=NOW(3)${filter} ORDER BY next_tick_at ASC LIMIT 250`,ids);
 const results:PlayerHotTickResult[]=[];
 for(const row of rows){const connection=await db.getConnection();try{await connection.beginTransaction();
  const [[hot]]:any=await connection.query(`SELECT id,player_id,healing,tick_interval,next_tick_at,expires_at,source,display_name FROM player_hots WHERE id=? AND next_tick_at<=NOW(3) AND expires_at>=NOW(3) FOR UPDATE`,[row.id]);
  if(!hot){await connection.rollback();continue;}
  const [[player]]:any=await connection.query(`SELECT hpoints,maxhp FROM players WHERE id=? FOR UPDATE`,[hot.player_id]);
  if(!player){await connection.query(`DELETE FROM player_hots WHERE id=?`,[hot.id]);await connection.commit();continue;}
  const [effects]:any=await connection.query(`SELECT id,effect_key,value,charges FROM player_status_effects WHERE player_id=? AND source=? AND expires_at>NOW(3)`,[hot.player_id,`hot:${hot.source}`]);
  const currentHP=Math.max(0,Number(player.hpoints)||0),maxHP=Math.max(1,Number(player.maxhp)||1);
  let healing=Math.max(1,Number(hot.healing)||1),gaugeGain=0,partyEchoPercent=0,casterEchoPlayerId:number|null=null,casterEchoPercent=0,refresh:any=null;
  for(const e of effects){if(e.effect_key==='hot_low_health_bonus'){const packed=Math.max(0,Number(e.value)||0),threshold=Math.floor(packed/1000),bonus=packed%1000;if(currentHP/maxHP<threshold/100)healing=Math.max(1,Math.floor(healing*(1+bonus/100)));}else if(e.effect_key==='hot_gauge_per_tick')gaugeGain+=Math.max(0,Number(e.value)||0);else if(e.effect_key==='sentinel_hot_party_echo_pct')partyEchoPercent=Math.max(partyEchoPercent,Math.max(0,Number(e.value)||0));else if(e.effect_key==='sage_hot_caster_echo'){casterEchoPlayerId=Number(e.value);casterEchoPercent=Math.max(casterEchoPercent,Math.max(0,Number(e.charges)||0));}else if(e.effect_key==='hot_refresh'&&Number(e.charges)>0)refresh=e;}
  const newHP=Math.min(maxHP,currentHP+healing),actual=Math.max(0,newHP-currentHP),interval=Math.max(.1,Number(hot.tick_interval)||1);
  await connection.query(`UPDATE players SET hpoints=? WHERE id=?`,[newHP,hot.player_id]);
  const nextMs=new Date(hot.next_tick_at).getTime()+interval*1000,expiresMs=new Date(hot.expires_at).getTime();let refreshed=false;
  if(refresh&&nextMs>expiresMs){const packed=Math.max(0,Number(refresh.value)||0),pct=Math.floor(packed/1000),duration=Math.max(1,packed%1000);await connection.query(`UPDATE player_hots SET healing=GREATEST(1,FLOOR(healing*?/100)),next_tick_at=DATE_ADD(NOW(3),INTERVAL ? MICROSECOND),expires_at=DATE_ADD(NOW(3),INTERVAL ? SECOND) WHERE id=?`,[pct,Math.round(interval*1000000),duration,hot.id]);if(Number(refresh.charges)<=1)await connection.query(`DELETE FROM player_status_effects WHERE id=?`,[refresh.id]);else await connection.query(`UPDATE player_status_effects SET charges=charges-1 WHERE id=?`,[refresh.id]);refreshed=true;}else await connection.query(`UPDATE player_hots SET next_tick_at=DATE_ADD(next_tick_at,INTERVAL ? MICROSECOND) WHERE id=?`,[Math.round(interval*1000000),hot.id]);
  const partyEchoHealing=Math.max(0,Math.floor(healing*partyEchoPercent/100));
  let casterEchoHealing=0;
  if(casterEchoPlayerId&&casterEchoPercent>0){const [[caster]]:any=await connection.query(`SELECT hpoints,maxhp FROM players WHERE id=? FOR UPDATE`,[casterEchoPlayerId]);if(caster){const casterHP=casterEchoPlayerId===Number(hot.player_id)?newHP:Math.max(0,Number(caster.hpoints)||0),casterMax=Math.max(1,Number(caster.maxhp)||1),echoPotential=Math.max(0,Math.floor(actual*casterEchoPercent/100)),casterNewHP=Math.min(casterMax,casterHP+echoPotential);casterEchoHealing=Math.max(0,casterNewHP-casterHP);if(casterEchoHealing>0)await connection.query(`UPDATE players SET hpoints=? WHERE id=?`,[casterNewHP,casterEchoPlayerId]);}}
  await connection.commit();results.push({playerId:Number(hot.player_id),healing:actual,newHP,maxHP,gaugeGain,partyEchoHealing,casterEchoPlayerId,casterEchoHealing,displayName:String(hot.display_name||'Healing over Time'),refreshed});
 }catch(error){await connection.rollback();console.error('Failed to process player HOT',{hotId:row.id,error});}finally{connection.release();}}
 await db.query(`DELETE FROM player_hots WHERE expires_at<NOW(3)${filter}`,ids);
 return results;
}
