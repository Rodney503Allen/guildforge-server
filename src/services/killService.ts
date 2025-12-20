import { db } from "../db";
import { checkAndApplyLevelUp } from "./experienceService";

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

  const expGained = Number(row.exper) || 0;
  const level = Number(row.level) || 1;
  const rarity = row.rarity || "common";

  // 💰 GOLD CALCULATION
  const baseGold = level * 5;

  const rarityBonus =
    rarity === "rare" ? 10 :
    rarity === "elite" ? 30 :
    rarity === "boss" ? 100 :
    rarity === "legendary" ? 300 :
    0;

  const variance = Math.floor(baseGold * 0.2);
  const goldGained =
    baseGold +
    rarityBonus +
    Math.floor(Math.random() * (variance * 2 + 1)) - variance;

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
