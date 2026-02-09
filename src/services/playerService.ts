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
  archetype: Archetype; // ✅ change from string → Archetype

  guild_name?: string | null;
  guild_rank?: string | null;

  portrait_url?: string | null;
  guild_banner?: string | null;
};

const ARCHETYPES = ["Arcanist", "Divine", "Brute", "Skirmisher"] as const;

function asArchetype(v: any): Archetype {
  return ARCHETYPES.includes(v) ? v : "Arcanist"; // safe default
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
    const perLevel = Number(r.effect_value) || 0;     // ex: 1
    const lvl = Number(r.level) || 0;                // ex: 3
    const totalPct = perLevel * lvl;                 // ex: 3%

    switch (r.effect_type) {
      case "damage_pct": damagePct += totalPct; break;
      case "hp_pct":     hpPct += totalPct; break;
      case "crit_pct":   critPct += totalPct; break;
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
 * Use this ONLY when you explicitly want raw DB values
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
 * ⚠️ THIS IS THE ONLY PLACE computePlayerStats IS CALLED
 */
export async function getFinalPlayerStats(
  playerId: number
): Promise<PlayerComputed | null> {
  const base = await getBasePlayer(playerId);
  if (!base) return null;

  // ======================
  // EQUIPPED GEAR
  // ======================
  const [gear]: any = await db.query(
    `
    SELECT i.*
    FROM inventory inv
    JOIN items i ON i.id = inv.item_id
    WHERE inv.player_id=? AND inv.equipped=1
    `,
    [playerId]
  );

  const gearMods: ItemMods[] = gear.map((g: any) => ({
    attack: g.attack || 0,
    defense: g.defense || 0,
    agility: g.agility || 0,
    vitality: g.vitality || 0,
    intellect: g.intellect || 0,
    crit: g.crit || 0
  }));

  // ======================
  // ACTIVE BUFFS
  // ======================
  const buffs = await getActiveBuffs(playerId);
  const buffMods: ItemMods[] = buffs.map(b => ({
    [b.stat]: b.value
  }));


  // ======================
  // GUILD PERK MULTS (percent)
  // ======================
  const perkMults = await getGuildPerkMultipliers(playerId);

  // ======================
  // FINAL COMPUTE (ONCE)
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

return {
  ...(computed as any),

  exper: Number(base.exper || 0),
  gold: Number(base.gold || 0),
  stat_points: Number(base.stat_points || 0),
  location: base.location,

  class_name: base.class_name,
  archetype: asArchetype(base.archetype), // ✅ typed + safe

  guild_name: guildRow?.guild_name ?? null,
  guild_rank: guildRow?.guild_rank ?? null,

  portrait_url: base.portrait_url ?? null,
  guild_banner: base.guild_banner ?? null
};


}
