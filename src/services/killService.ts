import { db } from "../db";
import { checkAndApplyLevelUp } from "./experienceService";

async function getGuildRewardMultipliers(playerId: number) {
  const [rows]: any = await db.query(`
    SELECT pd.effect_type, pd.effect_value, gp.level
    FROM guild_members gm
    JOIN guild_perks gp ON gp.guild_id = gm.guild_id
    JOIN perk_definitions pd ON pd.id = gp.perk_id
    WHERE gm.player_id = ?
  `, [playerId]);

  let goldPct = 0;
  let expPct = 0;

  for (const r of rows || []) {
    const perLevel = Number(r.effect_value) || 0; // ex: 1
    const lvl = Number(r.level) || 0;            // ex: 3
    const totalPct = perLevel * lvl;             // ex: 3%

    switch (r.effect_type) {
      case "gold_pct": goldPct += totalPct; break;
      case "exp_pct":  expPct += totalPct; break;
    }
  }

  return {
    goldMult: 1 + goldPct / 100,
    expMult:  1 + expPct / 100
  };
}

export async function handleCreatureKill(
  playerId: number,
  playerCreatureId: number
) {
  // Load creature data BEFORE deletion
  const [[row]]: any = await db.query(`
    SELECT c.exper, c.level, c.rarity
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.id = ?
  `, [playerCreatureId]);

  if (!row) return null;

  const baseExp = Number(row.exper) || 0;
  const level = Number(row.level) || 1;
  const rarity = row.rarity || "common";

  // 💰 GOLD CALCULATION (base)
  const baseGold = level * 5;

  const rarityBonus =
    rarity === "rare" ? 10 :
    rarity === "elite" ? 30 :
    rarity === "boss" ? 100 :
    rarity === "legendary" ? 300 :
    0;

  const variance = Math.floor(baseGold * 0.2);
  const rolledGold =
    baseGold +
    rarityBonus +
    Math.floor(Math.random() * (variance * 2 + 1)) - variance;

  // ✅ Apply guild EXP/GOLD multipliers (economy/utility perks)
  const mults = await getGuildRewardMultipliers(playerId);

  const expGained = Math.max(0, Math.floor(baseExp * (mults.expMult || 1)));
  const goldGained = Math.max(0, Math.floor(rolledGold * (mults.goldMult || 1)));

  // Add EXP + GOLD
  await db.query(
    `UPDATE players
     SET exper = exper + ?, gold = gold + ?
     WHERE id = ?`,
    [expGained, goldGained, playerId]
  );

  // Remove creature
  await db.query(
    `DELETE FROM player_creatures WHERE id = ?`,
    [playerCreatureId]
  );

  // Apply level-ups
  const levelUp = await checkAndApplyLevelUp(playerId);

  return {
    expGained,
    goldGained,
    levelUp
  };
}

