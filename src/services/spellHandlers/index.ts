import {
  SpellHandlerDefinition,
  SpellRecord
} from "./types";

import {
  buffHandler,
  damageDotHandler,
  damageHandler,
  debuffHandler,
  dotHandler,
  healHandler
} from "./genericHandlers";

import {
  divineInterventionHandler,
  purifyHandler,
  renewHandler
} from "./priestHandlers";

import {
  aegisOfFaithHandler,
  guardiansGraceHandler,
  sacredShieldHandler
} from "./paladinHandlers";

import {
  crusadersWrathHandler,
  divineReckoningHandler,
  finalJudgmentHandler,
  judgmentHandler
} from "./templarHandlers";

import {
  cataclysmHandler,
  chainLightningHandler,
  frostLanceHandler,
  infernoHandler
} from "./elementalistHandlers";

import {
  abyssalWardHandler,
  nullBarrierHandler,
  spatialExchangeHandler
} from "./voidwalkerHandlers";

import {
  bloodTransfusionHandler,
  lifeSiphonHandler,
  scarletRenewalHandler
} from "./bloodweaverHandlers";

import {
  guardHandler,
  interceptHandler,
  shieldBashHandler,
  shieldWallHandler
} from "./knightHandlers";

import {
  battleFrenzyHandler,
  bloodRageHandler,
  decapitateHandler,
  savageBlowHandler
} from "./berserkerHandlers";

import {
  callToVictoryHandler,
  commandingStrikeHandler,
  warBannerHandler
} from "./warlordHandlers";

import {
  deadeyeHandler,
  piercingArrowHandler,
  volleyHandler
} from "./rangerHandlers";

import {
  ancientProtectorHandler,
  brambleStrikeHandler,
  naturesAegisHandler
} from "./sentinelHandlers";

import {
  flourishHandler,
  harmonyOfTheWildHandler,
  herbalRemedyHandler
} from "./sageHandlers";

const genericSpellHandlers: Record<
  string,
  SpellHandlerDefinition
> = {
  damage: damageHandler,
  heal: healHandler,
  dot: dotHandler,
  damage_dot: damageDotHandler,
  buff: buffHandler,
  debuff: debuffHandler
};

const customSpellHandlers: Record<
  string,
  SpellHandlerDefinition
> = {
    // Priest Handlers
    priest_renew:
        renewHandler,
    priest_purify:
        purifyHandler,
    priest_divine_intervention:
        divineInterventionHandler,
    // Paladin Handlers
    paladin_guardians_grace:
        guardiansGraceHandler,
    paladin_sacred_shield:
        sacredShieldHandler,
    paladin_aegis_of_faith:
        aegisOfFaithHandler,
    // Templar Handlers
    templar_judgment:
        judgmentHandler,
    templar_crusaders_wrath:
        crusadersWrathHandler,
    templar_divine_reckoning:
        divineReckoningHandler,
    templar_final_judgment:
        finalJudgmentHandler,
    // Elementalist Handlers
    elementalist_frost_lance:
        frostLanceHandler,
    elementalist_chain_lightning:
        chainLightningHandler,
    elementalist_inferno:
        infernoHandler,
    elementalist_cataclysm:
        cataclysmHandler,
    // Voidwalker Handlers
    voidwalker_null_barrier:
        nullBarrierHandler,
    voidwalker_spatial_exchange:
        spatialExchangeHandler,
    voidwalker_abyssal_ward:
        abyssalWardHandler,
    //BloodWeaver Handlers
    bloodweaver_vital_thread:
        renewHandler,
    bloodweaver_life_siphon:
        lifeSiphonHandler,
    bloodweaver_scarlet_renewal:
        scarletRenewalHandler,
    bloodweaver_blood_transfusion:
        bloodTransfusionHandler,
    // Knight Handlers
    knight_shield_bash:
        shieldBashHandler,
    knight_guard:
        guardHandler,
    knight_intercept:
        interceptHandler,
    knight_shield_wall:
        shieldWallHandler,
    berserker_savage_blow:
        savageBlowHandler,
    berserker_battle_frenzy:
        battleFrenzyHandler,
    berserker_decapitate:
        decapitateHandler,
    berserker_blood_rage:
        bloodRageHandler,
    warlord_commanding_strike:
        commandingStrikeHandler,
    warlord_war_banner:
        warBannerHandler,
    warlord_call_to_victory:
        callToVictoryHandler,
    // Ranger Handlers
    ranger_volley:
        volleyHandler,
    ranger_piercing_arrow:
        piercingArrowHandler,
    ranger_deadeye:
        deadeyeHandler,
    // Sentinel Handlers
    sentinel_bramble_strike:
        brambleStrikeHandler,
    sentinel_natures_aegis:
        naturesAegisHandler,
    sentinel_ancient_protector:
        ancientProtectorHandler,
    // Sage Handlers
    sage_rejuvenation:
        renewHandler,
    sage_herbal_remedy:
        herbalRemedyHandler,
    sage_flourish:
        flourishHandler,
    sage_harmony_of_the_wild:
        harmonyOfTheWildHandler
};

export function getSpellHandler(
  spell: SpellRecord
): SpellHandlerDefinition | null {
  const handlerKey = String(
    spell.handler_key || ""
  )
    .trim()
    .toLowerCase();

  if (handlerKey) {
    const customHandler =
      customSpellHandlers[handlerKey];

    if (!customHandler) {
      console.error(
        `Unknown custom spell handler "${handlerKey}"`,
        {
          spellId: spell.id,
          spellName: spell.name
        }
      );

      return null;
    }

    return customHandler;
  }

  const spellType = String(
    spell.type || ""
  )
    .trim()
    .toLowerCase();

  return genericSpellHandlers[spellType] ?? null;
}