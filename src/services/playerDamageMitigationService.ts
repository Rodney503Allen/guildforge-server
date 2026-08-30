// src/services/playerDamageMitigationService.ts

import { db } from "../db";
import { applyBuff } from "./buffService";

export type PlayerDamageMitigationResult = {
  incomingDamage: number;
  finalDamage: number;

  absorbedDamage: number;
  shieldBroken: boolean;
  linkedShieldBuffRemoved: boolean;

  interceptTriggered: boolean;
  interceptReductionPercent: number;
  knightInterceptTriggered: boolean;
  unbreakableOverflowReductionPercent: number;

  aegisTriggered: boolean;
  aegisPreventedDeath: boolean;
  aegisReductionPercent: number;
  aegisHealing: number;
  aegisFollowupReductionPercent: number;
  priestDeathProtectionTriggered: boolean;
  priestReviveHealing: number;
  priestTriggerGaugeGain: number;
  priestTriggerDamagePercent: number;
  redirectedDamage: number;
  redirectPlayerId: number | null;
  spatialGaugeGain: number;
  emergencyTranslationTriggered: boolean;
  voidFeedbackDamage: number;
  voidFeedbackSplashPercent: number;
  bloodweaverDeathProtectionTriggered: boolean;
  bloodweaverReviveHealing: number;
  thornsDamage: number;
  shieldBreakHealing: number;
  sentinelInterceptTriggered: boolean;
  sentinelDeathProtectionTriggered: boolean;
  sentinelReviveHealing: number;
  thornsSplashPercent: number;
  thornsHealing: number;
  shieldReformed: boolean;
  shieldBreakPartyHealPercent: number;
  shieldBreakHotApplied: boolean;
  shieldBreakReductionApplied: boolean;
  sageDeathProtectionTriggered: boolean;
  sageReviveHealing: number;
  sageTriggerGaugeGain: number;
  knightThornsTriggered: boolean;
  knightShieldReformed: boolean;
  knightSecondWindTriggered: boolean;
  berserkerRefuseToFallTriggered: boolean;
};


// =====================================================
// SHIELDS
// =====================================================

async function absorbDamageWithPlayerShields(
  playerId: number,
  incomingDamage: number,
  maxHP: number
) {
  let remainingDamage =
    Math.max(
      0,
      Math.floor(
        Number(incomingDamage) || 0
      )
    );

  let absorbedDamage = 0;
  let shieldBroken = false;
  let linkedShieldBuffRemoved = false;
  let voidFeedbackDamage = 0;
  let voidFeedbackSplashPercent = 0;
  let shieldBreakHealPercent = 0;
  let shieldReformed = false;
  let shieldBreakPartyHealPercent = 0;
  let shieldBreakHotApplied = false;
  let shieldBreakReductionApplied = false;
  let knightShieldReformed = false;

  if (remainingDamage <= 0) {
    return {
      absorbedDamage: 0,
      remainingDamage: 0,
      shieldBroken: false
      ,linkedShieldBuffRemoved: false
      ,voidFeedbackDamage: 0
      ,voidFeedbackSplashPercent: 0
      ,shieldBreakHealPercent: 0
      ,shieldReformed: false
      ,shieldBreakPartyHealPercent: 0
      ,shieldBreakHotApplied: false
      ,shieldBreakReductionApplied: false
      ,knightShieldReformed: false
    };
  }

  await db.query(
    `
      DELETE FROM player_shields

      WHERE player_id = ?
        AND (
          expires_at <= NOW(3)
          OR remaining_absorb <= 0
        )
    `,
    [playerId]
  );

  const [shields]: any =
    await db.query(
      `
        SELECT
          id,
          max_absorb,
          remaining_absorb,
          expires_at,
          source

        FROM player_shields

        WHERE player_id = ?
          AND expires_at > NOW(3)
          AND remaining_absorb > 0

        ORDER BY
          expires_at ASC,
          id ASC
      `,
      [playerId]
    );

  for (
    const shield of
    shields
  ) {
    if (
      remainingDamage <= 0
    ) {
      break;
    }

    const availableAbsorb =
      Math.max(
        0,
        Number(
          shield.remaining_absorb
        ) || 0
      );

    if (
      availableAbsorb <= 0
    ) {
      continue;
    }

    const absorbedFromShield =
      Math.min(
        remainingDamage,
        availableAbsorb
      );

    const newRemainingAbsorb =
      availableAbsorb -
      absorbedFromShield;

    remainingDamage -=
      absorbedFromShield;

    absorbedDamage +=
      absorbedFromShield;

    const feedbackSource = `shield:${shield.source}`;
    const [[feedback]]: any = await db.query(
      `SELECT value FROM player_status_effects WHERE player_id=? AND effect_key='void_feedback_percent' AND source=? AND expires_at>NOW(3) LIMIT 1`,
      [playerId,feedbackSource]
    );
    if (feedback) {
      const [[stored]]: any = await db.query(
        `SELECT id,value FROM player_status_effects WHERE player_id=? AND effect_key='void_feedback_stored' AND source=? AND expires_at>NOW(3) LIMIT 1`,
        [playerId,feedbackSource]
      );
      const newStored=(Math.max(0,Number(stored?.value)||0)+absorbedFromShield);
      if(stored) await db.query(`UPDATE player_status_effects SET value=? WHERE id=?`,[newStored,stored.id]);
      if(newRemainingAbsorb<=0){
        voidFeedbackDamage+=Math.floor(newStored*Math.max(0,Number(feedback.value)||0)/100);
        const [[splash]]:any=await db.query(`SELECT value FROM player_status_effects WHERE player_id=? AND effect_key='void_feedback_splash_pct' AND source=? AND expires_at>NOW(3) LIMIT 1`,[playerId,feedbackSource]);
        voidFeedbackSplashPercent=Math.max(voidFeedbackSplashPercent,Number(splash?.value)||0);
        await db.query(`DELETE FROM player_status_effects WHERE player_id=? AND source=? AND effect_key LIKE 'void_feedback_%'`,[playerId,feedbackSource]);
      }
    }

    if (
      newRemainingAbsorb <= 0
    ) {
      const [[breakHeal]]: any = await db.query(
        `SELECT value FROM player_status_effects
         WHERE player_id = ?
           AND effect_key = 'natures_aegis_break_heal_pct'
           AND source = ?
           AND expires_at > NOW(3)
         LIMIT 1`,
        [playerId, `shield:${shield.source}`]
      );

      shieldBreakHealPercent = Math.max(
        shieldBreakHealPercent,
        Math.max(0, Number(breakHeal?.value) || 0)
      );

      if (breakHeal) {
        await db.query(
          `DELETE FROM player_status_effects
           WHERE player_id = ?
             AND effect_key = 'natures_aegis_break_heal_pct'
             AND source = ?`,
          [playerId, `shield:${shield.source}`]
        );
      }

      const breakSource = `shield:${shield.source}`;
      const [sentinelBreakEffects]: any = await db.query(
        `SELECT id,effect_key,value,charges
         FROM player_status_effects
         WHERE player_id=? AND source=? AND expires_at>NOW(3)
           AND effect_key IN (
             'natures_aegis_reform_pct',
             'natures_aegis_break_reduction',
             'natures_aegis_party_heal_pct',
             'natures_aegis_break_hot',
             'knight_bulwark_reform_pct'
           )`,
        [playerId, breakSource]
      );

      for (const effect of sentinelBreakEffects) {
        if ((effect.effect_key === 'natures_aegis_reform_pct' || effect.effect_key === 'knight_bulwark_reform_pct') && Number(effect.charges) > 0) {
          const amount = Math.max(1, Math.floor(Math.max(1, Number(shield.max_absorb) || 1) * Math.max(0, Number(effect.value) || 0) / 100));
          await db.query(
            `INSERT INTO player_shields(player_id,max_absorb,remaining_absorb,expires_at,source)
             VALUES(?,?,?,?,?)
             ON DUPLICATE KEY UPDATE max_absorb=VALUES(max_absorb),remaining_absorb=VALUES(remaining_absorb),expires_at=VALUES(expires_at)`,
            [playerId, amount, amount, shield.expires_at, `reformed:${shield.source}`]
          );
          shieldReformed = true;
          knightShieldReformed = effect.effect_key === 'knight_bulwark_reform_pct';
        } else if (effect.effect_key === 'natures_aegis_break_reduction') {
          const packed = Math.max(0, Number(effect.value) || 0);
          const reduction = Math.floor(packed / 1000);
          const duration = Math.max(1, packed % 1000);
          if (reduction > 0) {
            await applyBuff(playerId, 'damage_reduction', reduction, duration, `aegis-break:${shield.id}`);
            shieldBreakReductionApplied = true;
          }
        } else if (effect.effect_key === 'natures_aegis_party_heal_pct') {
          shieldBreakPartyHealPercent = Math.max(shieldBreakPartyHealPercent, Math.max(0, Number(effect.value) || 0));
        } else if (effect.effect_key === 'natures_aegis_break_hot') {
          const packed = Math.max(0, Number(effect.value) || 0);
          const hotPercent = Math.floor(packed / 1000000);
          const remainder = packed % 1000000;
          const duration = Math.max(1, Math.floor(remainder / 1000));
          const tickRate = Math.max(1, remainder % 1000);
          const ticks = Math.max(1, Math.floor(duration / tickRate));
          const totalHealing = Math.max(1, Math.floor(Math.max(1, maxHP) * hotPercent / 100));
          const healingPerTick = Math.max(1, Math.floor(totalHealing / ticks));
          await db.query(`DELETE FROM player_hots WHERE player_id=? AND source=?`, [playerId, `aegis-break:${shield.source}`]);
          await db.query(
            `INSERT INTO player_hots(player_id,healing,tick_interval,next_tick_at,expires_at,source,display_name)
             VALUES(?,?,?,DATE_ADD(NOW(3),INTERVAL ? SECOND),DATE_ADD(NOW(3),INTERVAL ? SECOND),?,?)`,
            [playerId, healingPerTick, tickRate, tickRate, duration, `aegis-break:${shield.source}`, 'Seeds of Renewal']
          );
          shieldBreakHotApplied = true;
        }

        await db.query(`DELETE FROM player_status_effects WHERE id=?`, [effect.id]);
      }

      await db.query(
        `
          DELETE FROM player_shields

          WHERE id = ?
        `,
        [shield.id]
      );

      shieldBroken = true;

      const [cleanup]: any = await db.query(
        `DELETE FROM player_buffs WHERE player_id = ? AND source = ?`,
        [playerId, `shield:${shield.source}`]
      );
      linkedShieldBuffRemoved = linkedShieldBuffRemoved || Number(cleanup?.affectedRows) > 0;

    } else {

      await db.query(
        `
          UPDATE player_shields

          SET remaining_absorb = ?

          WHERE id = ?
        `,
        [
          newRemainingAbsorb,
          shield.id
        ]
      );
    }
  }

  return {
    absorbedDamage,
    remainingDamage,
    shieldBroken
    ,linkedShieldBuffRemoved
    ,voidFeedbackDamage
    ,voidFeedbackSplashPercent
    ,shieldBreakHealPercent
    ,shieldReformed
    ,shieldBreakPartyHealPercent
    ,shieldBreakHotApplied
    ,shieldBreakReductionApplied
    ,knightShieldReformed
  };
}

async function applySentinelInterception(playerId: number, incomingDamage: number) {
  const damage = Math.max(0, Math.floor(Number(incomingDamage) || 0));
  const [[effect]]: any = await db.query(
    `SELECT value, source FROM player_status_effects
     WHERE player_id = ?
       AND effect_key = 'sentinel_ancient_intercept'
       AND expires_at > NOW(3)
     ORDER BY expires_at ASC, id ASC
     LIMIT 1`,
    [playerId]
  );

  if (!effect || damage <= 0) {
    return { damage, redirectedDamage: 0, redirectPlayerId: null as number | null, triggered: false };
  }

  const redirectPlayerId = Number(String(effect.source || "").split(":")[1]);
  if (!Number.isFinite(redirectPlayerId) || redirectPlayerId === playerId) {
    return { damage, redirectedDamage: 0, redirectPlayerId: null as number | null, triggered: false };
  }

  const [[protector]]: any = await db.query(
    `SELECT hpoints FROM players WHERE id = ? LIMIT 1`,
    [redirectPlayerId]
  );

  if (!protector || Number(protector.hpoints) <= 0) {
    return { damage, redirectedDamage: 0, redirectPlayerId: null as number | null, triggered: false };
  }

  const percent = Math.max(0, Math.min(90, Number(effect.value) || 0));
  const interceptedDamage = Math.floor(damage * percent / 100);
  const [[reduction]]: any = await db.query(
    `SELECT value FROM player_status_effects
     WHERE player_id=? AND effect_key='sentinel_intercept_damage_reduction_pct'
       AND source=? AND expires_at>NOW(3) LIMIT 1`,
    [playerId, effect.source]
  );
  const redirectedDamage = Math.floor(
    interceptedDamage *
    (1 - Math.max(0, Math.min(90, Number(reduction?.value) || 0)) / 100)
  );

  return {
    damage: Math.max(0, damage - interceptedDamage),
    redirectedDamage,
    redirectPlayerId,
    triggered: redirectedDamage > 0
  };
}

async function applySentinelDeathProtection(
  playerId: number,
  currentHP: number,
  maxHP: number,
  incomingDamage: number
) {
  const damage = Math.max(0, Math.floor(Number(incomingDamage) || 0));
  if (damage < currentHP) return { damage, triggered: false, healing: 0 };

  const [[effect]]: any = await db.query(
    `SELECT id, value, charges FROM player_status_effects
     WHERE player_id = ?
       AND effect_key = 'sentinel_death_prevention'
       AND expires_at > NOW(3)
       AND charges > 0
     ORDER BY expires_at ASC, id ASC
     LIMIT 1`,
    [playerId]
  );

  if (!effect) return { damage, triggered: false, healing: 0 };

  const healing = Math.max(1, Math.floor(Math.max(1, maxHP) * Math.max(1, Number(effect.value) || 10) / 100));
  if (Number(effect.charges) <= 1) {
    await db.query(`DELETE FROM player_status_effects WHERE id = ?`, [effect.id]);
  } else {
    await db.query(`UPDATE player_status_effects SET charges = charges - 1 WHERE id = ?`, [effect.id]);
  }

  return {
    damage: Math.max(0, currentHP - healing),
    triggered: true,
    healing
  };
}

async function applySpatialExchange(playerId:number,currentHP:number,incomingDamage:number){
 const damage=Math.max(0,Math.floor(incomingDamage));
 const [[link]]:any=await db.query(`SELECT value,source FROM player_status_effects WHERE player_id=? AND effect_key='spatial_exchange' AND expires_at>NOW(3) LIMIT 1`,[playerId]);
 if(!link)return{damage,redirectedDamage:0,redirectPlayerId:null as number|null,gaugeGain:0,emergency:false};
 const redirectPlayerId=Number(String(link.source||'').split(':')[1]);
 if(!Number.isFinite(redirectPlayerId)||redirectPlayerId===playerId)return{damage,redirectedDamage:0,redirectPlayerId:null as number|null,gaugeGain:0,emergency:false};
 let redirectedDamage=Math.floor(damage*Math.max(0,Math.min(90,Number(link.value)||0))/100),emergency=false;
 const [[rescue]]:any=await db.query(`SELECT id,charges,value FROM player_status_effects WHERE player_id=? AND effect_key='spatial_emergency_translation' AND expires_at>NOW(3) AND charges>0 LIMIT 1`,[playerId]);
 if(damage-redirectedDamage>=currentHP&&rescue&&Number(rescue.value)===redirectPlayerId){redirectedDamage=Math.max(redirectedDamage,damage-Math.max(0,currentHP-1));emergency=true;if(Number(rescue.charges)<=1)await db.query(`DELETE FROM player_status_effects WHERE id=?`,[rescue.id]);else await db.query(`UPDATE player_status_effects SET charges=charges-1 WHERE id=?`,[rescue.id]);}
 const [[gauge]]:any=await db.query(`SELECT value FROM player_status_effects WHERE player_id=? AND effect_key='spatial_gauge_gain' AND expires_at>NOW(3) LIMIT 1`,[playerId]);
 return{damage:Math.max(0,damage-redirectedDamage),redirectedDamage,redirectPlayerId,gaugeGain:redirectedDamage>0?Math.max(0,Number(gauge?.value)||0):0,emergency};
}

async function applyBloodweaverDeathProtection(playerId:number,currentHP:number,maxHP:number,incomingDamage:number){
 const damage=Math.max(0,Math.floor(incomingDamage));if(damage<currentHP)return{damage,triggered:false,healing:0};
 const [[effect]]:any=await db.query(`SELECT id,value,charges FROM player_status_effects WHERE player_id=? AND effect_key='bloodweaver_death_protection' AND expires_at>NOW(3) AND charges>0 LIMIT 1`,[playerId]);
 if(!effect)return{damage,triggered:false,healing:0};
 const healing=Math.max(1,Math.floor(Math.max(1,maxHP)*Math.max(1,Number(effect.value)||40)/100));
 if(Number(effect.charges)<=1)await db.query(`DELETE FROM player_status_effects WHERE id=?`,[effect.id]);else await db.query(`UPDATE player_status_effects SET charges=charges-1 WHERE id=?`,[effect.id]);
 return{damage:Math.max(0,currentHP-healing),triggered:true,healing};
}

async function applyPriestDeathProtection(playerId:number,currentHP:number,maxHP:number,incomingDamage:number) {
  const damage=Math.max(0,Math.floor(incomingDamage));
  if (damage < currentHP) return {damage,triggered:false,healing:0,gaugeGain:0,damagePercent:0};
  const [[effect]]:any=await db.query(`SELECT id,charges,value FROM player_status_effects WHERE player_id=? AND effect_key='priest_death_protection' AND expires_at>NOW(3) AND charges>0 ORDER BY expires_at,id LIMIT 1`,[playerId]);
  if(!effect) return {damage,triggered:false,healing:0,gaugeGain:0,damagePercent:0};
  const revivedHP=Math.max(1,Math.floor(Math.max(1,maxHP)*Math.max(1,Number(effect.value)||35)/100));
  let damagePercent=0,gaugeGain=0;
  const [[vengeance]]:any=await db.query(`SELECT id,charges,value FROM player_status_effects WHERE player_id=? AND effect_key='priest_vengeful_resurrection' AND expires_at>NOW(3) AND charges>0 LIMIT 1`,[playerId]);
  if(vengeance){ damagePercent=Math.max(0,Number(vengeance.value)||0); gaugeGain=100; await applyBuff(playerId,'damage_dealt_pct',damagePercent,10,`priest-resurrection:${vengeance.id}`); if(Number(vengeance.charges)<=1)await db.query(`DELETE FROM player_status_effects WHERE id=?`,[vengeance.id]);else await db.query(`UPDATE player_status_effects SET charges=charges-1 WHERE id=?`,[vengeance.id]); }
  if(Number(effect.charges)<=1) await db.query(`DELETE FROM player_status_effects WHERE id=?`,[effect.id]); else await db.query(`UPDATE player_status_effects SET charges=charges-1 WHERE id=?`,[effect.id]);
  return {damage:Math.max(0,currentHP-revivedHP),triggered:true,healing:revivedHP,gaugeGain,damagePercent};
}


// =====================================================
// INTERCEPT
// =====================================================

async function applyUnbreakableOverflow(
  playerId: number,
  incomingDamage: number
) {
  const damage = Math.max(0, Math.floor(Number(incomingDamage) || 0));
  const [[effect]]: any = await db.query(
    `SELECT value
     FROM player_status_effects
     WHERE player_id = ?
       AND effect_key = 'knight_unbreakable_reduction_pct'
       AND expires_at > NOW(3)
     ORDER BY value DESC
     LIMIT 1`,
    [playerId]
  );

  const fullReduction = Math.max(0, Math.min(90, Number(effect?.value) || 0));
  if (damage <= 0 || fullReduction <= 50) {
    return { damage, overflowReductionPercent: 0 };
  }

  // The stat engine has already applied its normal 50% mitigation cap.
  // Compensate the post-cap damage so the final result matches the full
  // Unbreakable percentage instead of multiplying another raw percentage.
  const compensatedDamage = Math.max(
    0,
    Math.ceil(damage * ((1 - fullReduction / 100) / 0.5))
  );

  return {
    damage: compensatedDamage,
    overflowReductionPercent: fullReduction - 50
  };
}

async function applyIntercept(
  playerId: number,
  incomingDamage: number,
  currentHP: number
) {
  const damage =
    Math.max(
      0,
      Math.floor(
        Number(incomingDamage) || 0
      )
    );

  if (
    damage <= 0
  ) {
    return {
      damage: 0,
      triggered: false,
      reductionPercent: 0,
      redirectedDamage: 0,
      redirectPlayerId: null as number | null,
      knightTriggered: false
    };
  }

  await db.query(
    `
      DELETE FROM player_status_effects

      WHERE player_id = ?
        AND effect_key = 'intercept'
        AND (
          expires_at <= NOW(3)
          OR charges <= 0
        )
    `,
    [playerId]
  );

  const [[effect]]: any =
    await db.query(
      `
        SELECT
          id,
          charges,
          value,
          source

        FROM player_status_effects

        WHERE player_id = ?
          AND effect_key = 'intercept'
          AND expires_at > NOW(3)
          AND charges > 0

        ORDER BY
          expires_at ASC,
          id ASC

        LIMIT 1
      `,
      [playerId]
    );

  if (!effect) {
    return {
      damage,
      triggered: false,
      reductionPercent: 0,
      redirectedDamage: 0,
      redirectPlayerId: null as number | null,
      knightTriggered: false
    };
  }

  const reductionPercent =
    Math.max(
      0,
      Math.min(
        90,
        Number(
          effect.value
        ) || 0
      )
    );

  const source = String(effect.source || "");
  const sourceParts = source.split(":");
  const knightPlayerId = sourceParts[0] === "knight"
    ? Number(sourceParts[1])
    : NaN;

  if (
    Number.isFinite(knightPlayerId) &&
    knightPlayerId > 0 &&
    knightPlayerId !== playerId
  ) {
    const [[knight]]: any = await db.query(
      `SELECT hpoints FROM players WHERE id = ? LIMIT 1`,
      [knightPlayerId]
    );

    if (knight && Number(knight.hpoints) > 0) {
      let interceptedDamage = Math.max(
        0,
        Math.floor(damage * reductionPercent / 100)
      );
      const [[lethalRescue]]: any = await db.query(
        `SELECT id FROM player_status_effects
         WHERE player_id=? AND effect_key='knight_intercept_prevent_lethal'
           AND source=? AND expires_at>NOW(3) AND charges>0 LIMIT 1`,
        [playerId, source]
      );
      if (lethalRescue && damage - interceptedDamage >= Math.max(1, currentHP)) {
        interceptedDamage = Math.min(damage, Math.max(interceptedDamage, damage - Math.max(0, currentHP - 1)));
        await db.query(`DELETE FROM player_status_effects WHERE id=?`, [lethalRescue.id]);
      }
      const [[companion]]: any = await db.query(
        `SELECT id, value
         FROM player_status_effects
         WHERE player_id = ?
           AND effect_key = 'knight_intercept_redirect_reduction'
           AND source = ?
           AND expires_at > NOW(3)
         LIMIT 1`,
        [playerId, source]
      );
      const redirectedReduction = Math.max(
        0,
        Math.min(90, Number(companion?.value) || 0)
      );
      const redirectedDamage = Math.max(
        0,
        Math.ceil(interceptedDamage * (1 - redirectedReduction / 100))
      );

      await db.query(`DELETE FROM player_status_effects WHERE id = ?`, [effect.id]);
      if (companion?.id) {
        await db.query(`DELETE FROM player_status_effects WHERE id = ?`, [companion.id]);
      }

      const [[answer]]: any = await db.query(
        `SELECT id,value FROM player_status_effects
         WHERE player_id=? AND effect_key='knight_intercept_next_spell_damage_pct'
           AND source=? AND expires_at>NOW(3) AND charges>0 LIMIT 1`,
        [playerId, source]
      );
      if (answer) {
        await applyBuff(
          knightPlayerId,
          'damage_dealt_pct',
          Math.max(0, Number(answer.value) || 0),
          30,
          `knight-answer:${effect.id}`
        );
        await db.query(`DELETE FROM player_status_effects WHERE id=?`, [answer.id]);
      }

      return {
        damage: Math.max(0, damage - interceptedDamage),
        triggered: interceptedDamage > 0,
        reductionPercent,
        redirectedDamage,
        redirectPlayerId: knightPlayerId,
        knightTriggered: interceptedDamage > 0
      };
    }

    // A defeated or missing Knight cannot intercept the attack. Remove the
    // stale one-charge effect instead of turning it into legacy mitigation.
    await db.query(`DELETE FROM player_status_effects WHERE id = ?`, [effect.id]);
    await db.query(
      `DELETE FROM player_status_effects
       WHERE player_id = ?
         AND effect_key = 'knight_intercept_redirect_reduction'
         AND source = ?`,
      [playerId, source]
    );
    return {
      damage,
      triggered: false,
      reductionPercent: 0,
      redirectedDamage: 0,
      redirectPlayerId: null as number | null,
      knightTriggered: false
    };
  }

  const reducedDamage =
    Math.max(
      1,
      Math.ceil(
        damage *
        (
          1 -
          reductionPercent /
            100
        )
      )
    );

  const remainingCharges =
    Math.max(
      0,
      Number(
        effect.charges
      ) - 1
    );

  if (
    remainingCharges <= 0
  ) {
    await db.query(
      `
        DELETE FROM player_status_effects

        WHERE id = ?
      `,
      [effect.id]
    );

  } else {

    await db.query(
      `
        UPDATE player_status_effects

        SET charges = ?

        WHERE id = ?
      `,
      [
        remainingCharges,
        effect.id
      ]
    );
  }

  return {
    damage:
      reducedDamage,

    triggered:
      true,
    reductionPercent,
    redirectedDamage: 0,
    redirectPlayerId: null as number | null,
    knightTriggered: false
  };
}


// =====================================================
// AEGIS OF FAITH
// =====================================================

async function applyAegisOfFaith(
  playerId: number,
  currentHP: number,
  maxHP: number,
  incomingDamage: number
) {
  const damage =
    Math.max(
      0,
      Math.floor(
        Number(incomingDamage) || 0
      )
    );

  if (
    damage <= 0
  ) {
    return {
      damage: 0,
      triggered: false,
      preventedDeath: false,
      reductionPercent: 0
      ,healing: 0, followupReductionPercent: 0, sageGaugeGain: 0, source: null as string | null
    };
  }

  await db.query(
    `
      DELETE FROM player_status_effects

      WHERE player_id = ?
        AND effect_key = 'death_prevention'
        AND (
          expires_at <= NOW(3)
          OR charges <= 0
        )
    `,
    [playerId]
  );

  const [[effect]]: any =
    await db.query(
      `
        SELECT
          id,
          charges,
          value,
          source

        FROM player_status_effects

        WHERE player_id = ?
          AND effect_key = 'death_prevention'
          AND expires_at > NOW(3)
          AND charges > 0

        ORDER BY
          expires_at ASC,
          id ASC

        LIMIT 1
      `,
      [playerId]
    );

  if (!effect) {
    return {
      damage,
      triggered: false,
      preventedDeath: false,
      reductionPercent: 0
      ,healing: 0, followupReductionPercent: 0, sageGaugeGain: 0, source: null as string | null
    };
  }

  // Aegis's ongoing mitigation is already applied by its player buff.
  // The status row is reserved for lethal-hit prevention so charges are
  // not wasted by ordinary attacks.
  const reductionPercent = 0;
  let reducedDamage = damage;

  let preventedDeath =
    false;
  let healing = 0;
  let followupReductionPercent = 0;
  let sageGaugeGain = 0;

  if (reducedDamage < currentHP) {
    return {
      damage,
      triggered: false,
      preventedDeath: false,
      reductionPercent: 0,
      healing: 0,
      followupReductionPercent: 0,
      sageGaugeGain: 0,
      source: String(effect.source || "")
    };
  }

  if (reducedDamage >= currentHP) {
    reducedDamage =
      Math.max(
        0,
        currentHP - 1
      );

    preventedDeath =
      true;

    const [companions]: any = await db.query(`
      SELECT id, effect_key, value, charges
      FROM player_status_effects
      WHERE player_id = ?
        AND effect_key IN (
          'aegis_trigger_heal_pct','aegis_trigger_reduction',
          'sage_death_trigger_heal_pct','sage_death_trigger_gauge',
          'knight_unbreakable_trigger_heal_pct',
          'warlord_death_trigger_heal_pct'
        )
        AND source = ?
        AND expires_at > NOW(3) AND charges > 0
    `, [playerId, effect.source]);

    for (const companion of companions) {
      if (companion.effect_key === 'aegis_trigger_heal_pct' || companion.effect_key === 'sage_death_trigger_heal_pct' || companion.effect_key === 'knight_unbreakable_trigger_heal_pct' || companion.effect_key === 'warlord_death_trigger_heal_pct') {
        healing = Math.max(healing, Math.floor(Math.max(1, maxHP) * Number(companion.value) / 100));
      } else if (companion.effect_key === 'sage_death_trigger_gauge') {
        sageGaugeGain = Math.max(sageGaugeGain, Math.max(0, Number(companion.value) || 0));
      } else {
        const packed = Math.max(0, Number(companion.value) || 0);
        followupReductionPercent = Math.floor(packed / 1000);
        const duration = Math.max(1, Math.floor(packed % 1000));
        if (followupReductionPercent > 0) {
          await applyBuff(playerId, 'damage_reduction', followupReductionPercent, duration, `aegis-trigger:${companion.id}`);
        }
      }
      if (Number(companion.charges) <= 1) {
        await db.query(`DELETE FROM player_status_effects WHERE id = ?`, [companion.id]);
      } else {
        await db.query(`UPDATE player_status_effects SET charges = charges - 1 WHERE id = ?`, [companion.id]);
      }
    }

    if (String(effect.source || '').startsWith('berserker:blood_rage:')) {
      await db.query(
        `DELETE FROM player_buffs WHERE player_id=? AND source LIKE 'spell:9:%'`,
        [playerId]
      );
      await db.query(
        `DELETE FROM player_status_effects WHERE player_id=? AND source=? AND effect_key<>'death_prevention'`,
        [playerId, effect.source]
      );
    }
  }

  const remainingCharges =
    Math.max(
      0,
      Number(
        effect.charges
      ) - 1
    );

  if (
    remainingCharges <= 0
  ) {
    await db.query(
      `
        DELETE FROM player_status_effects

        WHERE id = ?
      `,
      [effect.id]
    );

  } else {

    await db.query(
      `
        UPDATE player_status_effects

        SET charges = ?

        WHERE id = ?
      `,
      [
        remainingCharges,
        effect.id
      ]
    );
  }

  return {
    damage:
      reducedDamage,

    triggered:
      true,

    preventedDeath,

    reductionPercent
    ,healing
    ,followupReductionPercent
    ,sageGaugeGain
    ,source: String(effect.source || "")
  };
}


// =====================================================
// UNIVERSAL PLAYER DAMAGE MITIGATION
// =====================================================

export async function mitigateIncomingPlayerDamage(
  playerId: number,
  currentHP: number,
  incomingDamage: number,
  maxHP: number = currentHP
): Promise<PlayerDamageMitigationResult> {

  const incoming =
    Math.max(
      0,
      Math.floor(
        Number(
          incomingDamage
        ) || 0
      )
    );

  let finalDamage =
    incoming;

  const unbreakableResult = await applyUnbreakableOverflow(
    playerId,
    finalDamage
  );
  finalDamage = unbreakableResult.damage;


  // -------------------------
  // ABSORB SHIELDS
  // -------------------------

  const shieldResult =
    await absorbDamageWithPlayerShields(
      playerId,
      finalDamage,
      maxHP
    );

  finalDamage =
    shieldResult.remainingDamage;


  // -------------------------
  // INTERCEPT
  // -------------------------

  const interceptResult =
    await applyIntercept(
      playerId,
      finalDamage,
      currentHP
    );

  finalDamage =
    interceptResult.damage;

  const spatialResult = interceptResult.redirectedDamage > 0
    ? { damage: finalDamage, redirectedDamage: 0, redirectPlayerId: null as number | null, gaugeGain: 0, emergency: false }
    : await applySpatialExchange(playerId,currentHP,finalDamage);
  finalDamage = spatialResult.damage;

  const sentinelInterceptResult = interceptResult.redirectedDamage > 0 || spatialResult.redirectedDamage > 0
    ? { damage: finalDamage, redirectedDamage: 0, redirectPlayerId: null as number | null, triggered: false }
    : await applySentinelInterception(playerId, finalDamage);
  finalDamage = sentinelInterceptResult.damage;


  // -------------------------
  // AEGIS OF FAITH
  // -------------------------

  const aegisResult =
    await applyAegisOfFaith(
      playerId,
      currentHP,
      maxHP,
      finalDamage
    );

  finalDamage =
    aegisResult.damage;

  const priestResult = await applyPriestDeathProtection(playerId,currentHP,maxHP,finalDamage);
  finalDamage = priestResult.damage;

  const bloodResult = await applyBloodweaverDeathProtection(playerId,currentHP,maxHP,finalDamage);
  finalDamage = bloodResult.damage;

  const sentinelDeathResult = await applySentinelDeathProtection(playerId,currentHP,maxHP,finalDamage);
  finalDamage = sentinelDeathResult.damage;

  const [[thorns]]: any = await db.query(
    `SELECT effect_key,value,source FROM player_status_effects
     WHERE player_id = ?
       AND effect_key IN ('sentinel_thorns_pct','knight_thorns_pct','warlord_thorns_pct')
       AND expires_at > NOW(3)
     ORDER BY value DESC
     LIMIT 1`,
    [playerId]
  );
  const [[useIncoming]]: any = await db.query(
    `SELECT value FROM player_status_effects WHERE player_id=? AND effect_key IN ('sentinel_thorns_use_incoming','knight_thorns_use_incoming') AND expires_at>NOW(3) LIMIT 1`,
    [playerId]
  );
  const thornsBaseDamage = useIncoming ? incoming : finalDamage;
  const thornsDamage = Math.max(0, Math.floor(thornsBaseDamage * Math.max(0, Number(thorns?.value) || 0) / 100));
  const [[splash]]: any = await db.query(
    `SELECT value FROM player_status_effects WHERE player_id=? AND effect_key='sentinel_thorns_splash_pct' AND expires_at>NOW(3) ORDER BY value DESC LIMIT 1`,
    [playerId]
  );
  const thornsSplashPercent = Math.max(0, Number(splash?.value) || 0);

  let thornsHealing = 0;
  if (thornsDamage > 0) {
    const [[healEffect]]: any = await db.query(
      `SELECT value,source FROM player_status_effects WHERE player_id=? AND effect_key='sentinel_thorns_heal_pct' AND expires_at>NOW(3) ORDER BY value DESC LIMIT 1`,
      [playerId]
    );
    if (healEffect) {
      const [[lock]]: any = await db.query(
        `SELECT id FROM player_status_effects WHERE player_id=? AND effect_key='sentinel_thorns_heal_lock' AND source=? AND expires_at>NOW(3) LIMIT 1`,
        [playerId, healEffect.source]
      );
      if (!lock) {
        const [[icd]]: any = await db.query(
          `SELECT value FROM player_status_effects WHERE player_id=? AND effect_key='sentinel_thorns_heal_icd_seconds' AND source=? AND expires_at>NOW(3) LIMIT 1`,
          [playerId, healEffect.source]
        );
        const seconds = Math.max(1, Number(icd?.value) || 2);
        thornsHealing = Math.max(1, Math.floor(Math.max(1, maxHP) * Math.max(0, Number(healEffect.value) || 0) / 100));
        await db.query(
          `INSERT INTO player_status_effects(player_id,effect_key,value,charges,expires_at,source)
           VALUES(?,'sentinel_thorns_heal_lock',1,1,DATE_ADD(NOW(3),INTERVAL ? SECOND),?)
           ON DUPLICATE KEY UPDATE expires_at=VALUES(expires_at)`,
          [playerId, seconds, healEffect.source]
        );
      }
    }
  }
  const shieldBreakHealing = shieldResult.shieldBroken
    ? Math.max(0, Math.floor(Math.max(1, maxHP) * Math.max(0, Number(shieldResult.shieldBreakHealPercent) || 0) / 100))
    : 0;


  return {
    incomingDamage:
      incoming,

    finalDamage,

    absorbedDamage:
      shieldResult.absorbedDamage,

    shieldBroken:
      shieldResult.shieldBroken,

    linkedShieldBuffRemoved:
      shieldResult.linkedShieldBuffRemoved,

    interceptTriggered:
      interceptResult.triggered,

    interceptReductionPercent:
      interceptResult.reductionPercent,

    knightInterceptTriggered:
      interceptResult.knightTriggered,

    unbreakableOverflowReductionPercent:
      unbreakableResult.overflowReductionPercent,

    aegisTriggered:
      aegisResult.triggered,

    aegisPreventedDeath:
      aegisResult.preventedDeath,

    aegisReductionPercent:
      aegisResult.reductionPercent,

    aegisHealing:
      aegisResult.healing,

    aegisFollowupReductionPercent:
      aegisResult.followupReductionPercent,
    priestDeathProtectionTriggered: priestResult.triggered,
    priestReviveHealing: priestResult.healing,
    priestTriggerGaugeGain: priestResult.gaugeGain,
    priestTriggerDamagePercent: priestResult.damagePercent,
    redirectedDamage: interceptResult.redirectedDamage + spatialResult.redirectedDamage + sentinelInterceptResult.redirectedDamage,
    redirectPlayerId: interceptResult.redirectPlayerId ?? spatialResult.redirectPlayerId ?? sentinelInterceptResult.redirectPlayerId,
    spatialGaugeGain: spatialResult.gaugeGain,
    emergencyTranslationTriggered: spatialResult.emergency,
    voidFeedbackDamage: shieldResult.voidFeedbackDamage,
    voidFeedbackSplashPercent: shieldResult.voidFeedbackSplashPercent,
    bloodweaverDeathProtectionTriggered: bloodResult.triggered,
    bloodweaverReviveHealing: bloodResult.healing,
    thornsDamage,
    shieldBreakHealing,
    sentinelInterceptTriggered: sentinelInterceptResult.triggered,
    sentinelDeathProtectionTriggered: sentinelDeathResult.triggered,
    sentinelReviveHealing: sentinelDeathResult.healing,
    thornsSplashPercent,
    thornsHealing,
    shieldReformed: shieldResult.shieldReformed,
    shieldBreakPartyHealPercent: shieldResult.shieldBreakPartyHealPercent,
    shieldBreakHotApplied: shieldResult.shieldBreakHotApplied,
    shieldBreakReductionApplied: shieldResult.shieldBreakReductionApplied
    ,sageDeathProtectionTriggered: aegisResult.preventedDeath && aegisResult.sageGaugeGain > 0
    ,sageReviveHealing: aegisResult.preventedDeath ? aegisResult.healing : 0
    ,sageTriggerGaugeGain: aegisResult.sageGaugeGain
    ,knightThornsTriggered: String(thorns?.effect_key || '') === 'knight_thorns_pct'
    ,knightShieldReformed: shieldResult.knightShieldReformed
    ,knightSecondWindTriggered: aegisResult.preventedDeath && String(aegisResult.source || '').startsWith('spell:6') && aegisResult.healing > 0
    ,berserkerRefuseToFallTriggered: aegisResult.preventedDeath && String(aegisResult.source || '').startsWith('berserker:blood_rage:')
  };
}
