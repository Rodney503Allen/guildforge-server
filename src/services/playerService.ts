//src/services/playerService.ts
import { db } from "../db";
import { computePlayerStats, type ItemMods, type DerivedStats } from "./statEngine";
import { getActiveBuffs } from "./buffService";
import type { Archetype } from "./archetypeScaling";

/**
 * FINAL, AUTHORITATIVE PLAYER SHAPE
 * This is what UI + combat + church should use
 */
export type PlayerComputed = DerivedStats & {
  exper: number;
  gold: number;
  stat_points: number;
  location?: string;

  class_name: string;
  archetype: Archetype;

  guild_name?: string | null;
  guild_rank?: string | null;

  portrait_url?: string | null;
  guild_banner?: string | null;
};

const ARCHETYPES = ["Arcanist", "Divine", "Brute", "Skirmisher"] as const;

function asArchetype(v: any): Archetype {
  return ARCHETYPES.includes(v) ? v : "Arcanist";
}

function parseRollJson(v: any) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return [];
  }
}

function rollsToItemMods(rolls: any[]): ItemMods {
  const mods: ItemMods = {};

  for (const r of rolls || []) {
    const stat = String(r?.stat || "").toLowerCase().trim();
    const value = Number(r?.value) || 0;
    const isPercent = !!r?.isPercent;

    if (!stat || value === 0) continue;

    switch (stat) {
      case "attack":
        mods.attack = (mods.attack || 0) + value;
        break;

      case "attack_power":
        mods.attack_power = (mods.attack_power || 0) + value;
        break;

      case "defense":
        mods.defense = (mods.defense || 0) + value;
        break;

      case "agility":
        mods.agility = (mods.agility || 0) + value;
        break;

      case "dexterity":
        mods.dexterity = (mods.dexterity || 0) + value;
        break;

      case "vitality":
        mods.vitality = (mods.vitality || 0) + value;
        break;

      case "intellect":
        mods.intellect = (mods.intellect || 0) + value;
        break;

      case "intelligence":
        mods.intelligence = (mods.intelligence || 0) + value;
        break;

      case "strength":
        mods.strength = (mods.strength || 0) + value;
        break;

      case "crit":
        mods.crit = (mods.crit || 0) + value;
        break;

      case "crit_chance":
        if (isPercent) {
          mods.crit_chance = (mods.crit_chance || 0) + value;
        } else {
          mods.crit = (mods.crit || 0) + value;
        }
        break;

      case "crit_damage":
        if (isPercent) {
          mods.crit_damage = (mods.crit_damage || 0) + value;
        }
        break;

      case "health":
      case "hp":
        mods.hp = (mods.hp || 0) + value;
        break;

      case "mana":
      case "sp":
        mods.sp = (mods.sp || 0) + value;
        break;

      case "dodge":
        if (isPercent) {
          mods.dodge = (mods.dodge || 0) + value;
        } else {
          mods.agility = (mods.agility || 0) + value;
        }
        break;

      case "damage_reduction":
        if (isPercent) {
          mods.damage_reduction = (mods.damage_reduction || 0) + value;
        }
        break;

      case "lifesteal":
        if (isPercent) {
          mods.lifesteal = (mods.lifesteal || 0) + value;
        }
        break;

      default:
        break;
    }
    
  }

  return mods;
}

async function getGuildPerkMultipliers(playerId: number) {
  const [rows]: any = await db.query(`
    SELECT
      pd.effect_type,
      pd.effect_value,
      gp.level
    FROM guild_members gm
    LEFT JOIN guild_perks gp ON gp.guild_id = gm.guild_id
    LEFT JOIN perk_definitions pd ON pd.id = gp.perk_id
    WHERE gm.player_id = ?
      AND gp.level IS NOT NULL
      AND pd.effect_type IS NOT NULL
  `, [playerId]);

  let damagePct = 0;
  let hpPct = 0;
  let critPct = 0;

  for (const r of rows || []) {
    const perLevel = Number(r.effect_value) || 0;
    const lvl = Number(r.level) || 0;
    const totalPct = perLevel * lvl;

    switch (r.effect_type) {
      case "damage_pct":
        damagePct += totalPct;
        break;
      case "hp_pct":
        hpPct += totalPct;
        break;
      case "crit_pct":
        critPct += totalPct;
        break;
    }
  }

  return {
    damageMult: 1 + damagePct / 100,
    hpMult: 1 + hpPct / 100,
    critMult: 1 + critPct / 100
  };
}

/**
 * RAW PLAYER ONLY (NO DERIVED STATS)
 */
export async function getBasePlayer(playerId: number) {
  const [[base]]: any = await db.query(
    `
    SELECT
      p.*,
      c.name AS class_name,
      c.archetype
    FROM players p
    JOIN classes c ON c.name = p.pclass
    WHERE p.id = ?
    `,
    [playerId]
  );

  return base ?? null;
}

/**
 * FINAL PLAYER STATS (BASE + GEAR + BUFFS + DERIVED)
 */
export async function getFinalPlayerStats(
  playerId: number
): Promise<PlayerComputed | null> {
  const base = await getBasePlayer(playerId);
  if (!base) return null;

  // ======================
  // EQUIPPED GEAR (static + rolled)
  // ======================
  const [gear]: any = await db.query(
    `
    SELECT
      inv.inventory_id,
      inv.item_id,
      inv.player_item_id,

      -- static item path
      i.attack AS static_attack,
      i.defense AS static_defense,
      i.agility AS static_agility,
      i.vitality AS static_vitality,
      i.intellect AS static_intellect,
      i.crit AS static_crit,

      -- rolled item path
      pi.roll_json AS rolled_roll_json,

      ib.base_attack,
      ib.base_defense

    FROM inventory inv
    LEFT JOIN items i
      ON i.id = inv.item_id
    LEFT JOIN player_items pi
      ON pi.id = inv.player_item_id
    LEFT JOIN item_bases ib
      ON ib.id = pi.item_base_id
    WHERE inv.player_id = ?
      AND inv.equipped = 1
    `,
    [playerId]
  );

  const gearMods: ItemMods[] = (gear || []).map((g: any) => {
    const isRolled = !!g.player_item_id;

    if (!isRolled) {
      return {
        attack: Number(g.static_attack || 0),
        defense: Number(g.static_defense || 0),
        agility: Number(g.static_agility || 0),
        vitality: Number(g.static_vitality || 0),
        intellect: Number(g.static_intellect || 0),
        crit: Number(g.static_crit || 0)
      };
    }

    const rolls = parseRollJson(g.rolled_roll_json);
    const rollMods = rollsToItemMods(rolls);

    return {
      base_attack: Number(g.base_attack || 0),
      base_defense: Number(g.base_defense || 0),
      ...rollMods
    };
  });

  // ======================
  // ACTIVE BUFFS
  // ======================
  const buffs = await getActiveBuffs(playerId);
  const buffMods: ItemMods[] = buffs.map((b) => ({
    [b.stat]: b.value
  }));

  // ======================
  // GUILD PERK MULTS
  // ======================
  const perkMults = await getGuildPerkMultipliers(playerId);

  // ======================
  // FINAL COMPUTE
  // ======================
  const computed = computePlayerStats(base, gearMods, buffMods, perkMults);

  // ======================
  // GUILD INFO
  // ======================
  const [[guildRow]]: any = await db.query(
    `
    SELECT
      g.name AS guild_name,
      gr.name AS guild_rank
    FROM guild_members gm
    LEFT JOIN guild_roles gr ON gr.id = gm.role_id
    LEFT JOIN guilds g ON g.id = gm.guild_id
    WHERE gm.player_id=?
    LIMIT 1
    `,
    [playerId]
  );
console.log("[PLAYER STATS]", {
  playerId,
  dodgeChance: computed.dodgeChance,
  critDamageMult: computed.critDamageMult,
  damageReduction: computed.damageReduction,
  lifesteal: computed.lifesteal,
  maxhp: computed.maxhp,
  maxspoints: computed.maxspoints
});
  return {
    ...(computed as any),

    exper: Number(base.exper || 0),
    gold: Number(base.gold || 0),
    stat_points: Number(base.stat_points || 0),
    location: base.location,

    class_name: base.class_name,
    archetype: asArchetype(base.archetype),

    guild_name: guildRow?.guild_name ?? null,
    guild_rank: guildRow?.guild_rank ?? null,

    portrait_url: base.portrait_url ?? null,
    guild_banner: base.guild_banner ?? null
  };
}