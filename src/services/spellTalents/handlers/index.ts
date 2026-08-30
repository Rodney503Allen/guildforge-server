import type { SpellTalentHandler } from "../types";
import {
  changeTargetTypeTalent,
  increaseBuffDurationTalent,
  increaseBuffValuePercentTalent,
  increaseDamagePercentTalent,
  increaseDebuffDurationTalent,
  increaseDebuffValuePercentTalent,
  increaseDotDamagePercentTalent,
  increaseDotDurationTalent,
  increaseHealingPercentTalent,
  reduceCooldownSecondsTalent,
  reduceManaCostPercentTalent
} from "./genericTalentHandlers";

import {
  blindingRadianceTalentHandler,
  overwhelmingPresenceTalentHandler,
  righteousChallengeTalentHandler,
  steadfastJudgmentTalentHandler,
  rallyingStrikeTalentHandler,
  guardianBondTalentHandler,
  radiantBarrierTalentHandler,
  sharedSanctuaryTalentHandler,
  defendersCallingTalentHandler,
  inspiringConsecrationTalentHandler,
  sacredChallengeTalentHandler,
  crusadersZealTalentHandler,
  invigoratingLightTalentHandler,
  savingGraceTalentHandler,
  overflowingGraceTalentHandler,
  sharedGraceTalentHandler,
  rallyBeneathShieldTalentHandler,
  layeredBulwarkTalentHandler,
  lastBastionTalentHandler,
  marchingBulwarkTalentHandler,
  undyingFaithTalentHandler,
  divineAscendanceTalentHandler,
  unbrokenSpiritTalentHandler,
  avengingFaithTalentHandler
} from "./paladinTalentHandlers";
import * as templar from "./templarTalentHandlers";
import * as priest from "./priestTalentHandlers";
import { voidwalkerTalentHandlers } from "./voidwalkerTalentHandlers";
import { elementalistTalentHandlers } from "./elementalistTalentHandlers";
import { bloodweaverTalentHandlers } from "./bloodweaverTalentHandlers";
import { sentinelTalentHandlers } from "./sentinelTalentHandlers";
import { rangerTalentHandlers } from "./rangerTalentHandlers";
import { sageTalentHandlers } from "./sageTalentHandlers";
import { knightTalentHandlers } from "./knightTalentHandlers";
import { berserkerTalentHandlers } from "./berserkerTalentHandlers";
import { warlordTalentHandlers } from "./warlordTalentHandlers";

export const genericTalentHandlers: Record<
  string,
  SpellTalentHandler
> = {
  generic_increase_damage_percent: increaseDamagePercentTalent,
  generic_increase_healing_percent: increaseHealingPercentTalent,
  generic_reduce_mana_cost_percent: reduceManaCostPercentTalent,
  generic_reduce_cooldown_seconds: reduceCooldownSecondsTalent,
  generic_increase_dot_damage_percent: increaseDotDamagePercentTalent,
  generic_increase_dot_duration: increaseDotDurationTalent,
  generic_increase_buff_value_percent: increaseBuffValuePercentTalent,
  generic_increase_buff_duration: increaseBuffDurationTalent,
  generic_increase_debuff_value_percent: increaseDebuffValuePercentTalent,
  generic_increase_debuff_duration: increaseDebuffDurationTalent,
  generic_change_target_type: changeTargetTypeTalent
};

export const customTalentHandlers: Record<
  string,
  SpellTalentHandler
> = {
  paladin_righteous_challenge:
    righteousChallengeTalentHandler,
  paladin_steadfast_judgment:
    steadfastJudgmentTalentHandler,
  paladin_overwhelming_presence:
    overwhelmingPresenceTalentHandler,
  paladin_rallying_strike:
    rallyingStrikeTalentHandler,
  paladin_blinding_radiance:
    blindingRadianceTalentHandler,
  paladin_guardians_bond: guardianBondTalentHandler,
  paladin_radiant_barrier: radiantBarrierTalentHandler,
  paladin_shared_sanctuary: sharedSanctuaryTalentHandler,
  paladin_defenders_calling: defendersCallingTalentHandler,
  paladin_inspiring_consecration: inspiringConsecrationTalentHandler,
  paladin_sacred_challenge: sacredChallengeTalentHandler,
  paladin_crusaders_zeal: crusadersZealTalentHandler,
  paladin_invigorating_light: invigoratingLightTalentHandler,
  paladin_saving_grace: savingGraceTalentHandler,
  paladin_overflowing_grace: overflowingGraceTalentHandler,
  paladin_shared_grace: sharedGraceTalentHandler,
  paladin_rally_beneath_shield: rallyBeneathShieldTalentHandler,
  paladin_layered_bulwark: layeredBulwarkTalentHandler,
  paladin_last_bastion: lastBastionTalentHandler,
  paladin_marching_bulwark: marchingBulwarkTalentHandler,
  paladin_undying_faith: undyingFaithTalentHandler,
  paladin_divine_ascendance: divineAscendanceTalentHandler,
  paladin_unbroken_spirit: unbrokenSpiritTalentHandler,
  paladin_avenging_faith: avengingFaithTalentHandler
  ,templar_echoing_smite: templar.echoingSmite
  ,templar_righteous_momentum: templar.righteousMomentum
  ,templar_purging_light: templar.purgingLight
  ,templar_radiant_impact: templar.radiantImpact
  ,templar_sentence_of_vulnerability: templar.sentenceOfVulnerability
  ,templar_collective_condemnation: templar.collectiveCondemnation
  ,templar_unrelenting_verdict: templar.unrelentingVerdict
  ,templar_harsh_sentence: templar.harshSentence
  ,templar_exposing_judgment: templar.exposingJudgment
  ,templar_rallying_verdict: templar.rallyingVerdict
  ,templar_brand_of_censure: templar.brandOfCensure
  ,templar_accelerant: templar.accelerant
  ,templar_searing_exposure: templar.searingExposure
  ,templar_cleansing_flame: templar.cleansingFlame
  ,templar_wrathful_sentence: templar.wrathfulSentence
  ,templar_shattering_verdict: templar.shatteringVerdict
  ,templar_sentence_renewed: templar.sentenceRenewed
  ,templar_zealous_recovery: templar.zealousRecovery
  ,templar_crushing_wrath: templar.crushingWrath
  ,templar_absolute_decree: templar.absoluteDecree
  ,templar_reckonings_echo: templar.reckoningsEcho
  ,templar_divine_ruin: templar.divineRuin
  ,templar_condemn_unworthy: templar.condemnUnworthy
  ,templar_unending_judgment: templar.unendingJudgment
  ,templar_sentence_of_annihilation: templar.sentenceOfAnnihilation
  ,templar_divine_deliverance: templar.divineDeliverance
  ,templar_no_appeal: templar.noAppeal
  ,templar_eradication: templar.eradication
  ,templar_rally_to_verdict: templar.rallyToVerdict
  ,templar_final_decree: templar.finalDecree
  ,priest_restorative_overflow: priest.restorativeOverflow
  ,priest_healing_hands: priest.healingHands
  ,priest_invigorating_mend: priest.invigoratingMend
  ,priest_conserved_light: priest.conservedLight
  ,priest_immediate_relief: priest.immediateRelief
  ,priest_graceful_renew: priest.gracefulRenew
  ,priest_perpetual_light: priest.perpetualLight
  ,priest_restoring_rhythm: priest.restoringRhythm
  ,priest_empowering_fortitude: priest.empoweringFortitude
  ,priest_fortified_spirit: priest.fortifiedSpirit
  ,priest_spiritual_vigor: priest.spiritualVigor
  ,priest_shared_blessing: priest.sharedBlessing
  ,priest_cleansing_grace: priest.cleansingGrace
  ,priest_purifying_wave: priest.purifyingWave
  ,priest_lingering_purity: priest.lingeringPurity
  ,priest_reclaimed_strength: priest.reclaimedStrength
  ,priest_mass_restoration: priest.massRestoration
  ,priest_sacred_immunity: priest.sacredImmunity
  ,priest_miracle_worker: priest.miracleWorker
  ,priest_salvation: priest.salvation
  ,priest_echo_of_grace: priest.echoOfGrace
  ,priest_shared_restoration: priest.sharedRestoration
  ,priest_hand_of_salvation: priest.handOfSalvation
  ,priest_defy_death: priest.defyDeath
  ,priest_divine_resonance: priest.divineResonance
  ,priest_rally_from_brink: priest.rallyFromBrink
  ,priest_immortal_soul: priest.immortalSoul
  ,priest_vengeful_resurrection: priest.vengefulResurrection
  ,...voidwalkerTalentHandlers
  ,...elementalistTalentHandlers
  ,...bloodweaverTalentHandlers
  ,...sentinelTalentHandlers
  ,...rangerTalentHandlers
  ,...sageTalentHandlers
  ,...knightTalentHandlers
  ,...berserkerTalentHandlers
  ,...warlordTalentHandlers
};

export * from "./genericTalentHandlers";
export * from "./paladinTalentHandlers";
export * from "./templarTalentHandlers";
export * from "./priestTalentHandlers";
export * from "./voidwalkerTalentHandlers";
export * from "./elementalistTalentHandlers";
export * from "./bloodweaverTalentHandlers";
export * from "./sentinelTalentHandlers";
export * from "./rangerTalentHandlers";
export * from "./sageTalentHandlers";
export * from "./knightTalentHandlers";
export * from "./berserkerTalentHandlers";
export * from "./warlordTalentHandlers";
