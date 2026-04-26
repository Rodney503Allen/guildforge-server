//services/killService.ts
import { db } from "../db";
import { grantExperience } from "./experienceService";
import { rollCreatureLoot } from "./lootService";
import { createChestFromDrops } from "./chestService";
import { applyKillProgress } from "./questService";
import { generateLootForCreature } from "./lootGenerator";

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
    const perLevel = Number(r.effect_value) || 0;
    const lvl = Number(r.level) || 0;
    const totalPct = perLevel * lvl;

    switch (r.effect_type) {
      case "gold_pct":
        goldPct += totalPct;
        break;
      case "exp_pct":
        expPct += totalPct;
        break;
    }
  }

  return {
    goldMult: 1 + goldPct / 100,
    expMult: 1 + expPct / 100
  };
}

async function hydrateCompletedQuests(playerId: number, playerQuestIds: number[]) {
  const ids = (playerQuestIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return [];

  const [rows]: any = await db.query(
    `
    SELECT
      pq.id AS playerQuestId,
      pq.quest_id AS questId,
      q.title
    FROM player_quests pq
    JOIN quests q ON q.id = pq.quest_id
    WHERE pq.player_id = ?
      AND pq.id IN (${ids.map(() => "?").join(",")})
    `,
    [playerId, ...ids]
  );

  return (rows || []).map((r: any) => ({
    playerQuestId: Number(r.playerQuestId),
    questId: Number(r.questId),
    title: String(r.title || "Quest")
  }));
}

export async function handleCreatureKill(
  playerId: number,
  playerCreatureId: number
) {
// Load creature data + current mapped region BEFORE deletion
const [[row]]: any = await db.query(`
  SELECT
    pc.creature_id,
    c.name,
    c.exper,
    c.level,
    c.rarity,
    COALESCE(wm.region_name, r.name) AS region_name
  FROM player_creatures pc
  JOIN creatures c
    ON c.id = pc.creature_id
  JOIN players p
    ON p.id = pc.player_id
  LEFT JOIN world_map wm
    ON wm.x = p.map_x
   AND wm.y = p.map_y
  LEFT JOIN regions r
    ON r.id = wm.region_id
  WHERE pc.id = ?
    AND pc.player_id = ?
  LIMIT 1
`, [playerCreatureId, playerId]);

if (!row) return null;

const creatureId = Number(row.creature_id);
const creatureName = String(row.name || "Creature");
const creatureLevel = Number(row.level) || 1;
const creatureRarity = String(row.rarity || "common");
const baseExp = Number(row.exper) || 0;
const regionName = row.region_name ? String(row.region_name).trim() : null;
  // BASE RANGE
  const base = 2 + (creatureLevel * 3);
  const min = Math.floor(base * 0.85);
  const max = Math.floor(base * 1.15);

  let rolledGold = Math.floor(
    Math.random() * (max - min + 1)
  ) + min;

  // RARITY MULTIPLIER
  const rarityMult =
    creatureRarity === "uncommon" ? 1.15 :
    creatureRarity === "rare" ? 1.35 :
    creatureRarity === "elite" ? 1.75 :
    creatureRarity === "boss" ? 2.5 :
    1;

  rolledGold = Math.floor(rolledGold * rarityMult);

  // Apply guild EXP/GOLD multipliers
  const mults = await getGuildRewardMultipliers(playerId);

  const expGained = Math.max(0, Math.floor(baseExp * (mults.expMult || 1)));
  const goldGained = Math.max(0, Math.floor(rolledGold * (mults.goldMult || 1)));

  const { levelUp } = await grantExperience(playerId, expGained);

  if (goldGained > 0) {
    await db.query(
      `UPDATE players
      SET gold = gold + ?
      WHERE id = ?`,
      [goldGained, playerId]
    );
  }

  const drops = await rollCreatureLoot(playerId, creatureId);

  const rolledGear = await generateLootForCreature(
    {
      id: creatureId,
      name: creatureName,
      level: creatureLevel,
      rarity: creatureRarity
    },
    {
      id: playerId
    }
  );

  const killProg = await applyKillProgress(playerId, creatureId, regionName);
  const completedQuests = await hydrateCompletedQuests(
    playerId,
    killProg?.completedPlayerQuestIds ?? []
  );

  const chestDrops = [
    ...(drops ?? []).map((d: any) => ({
      item_id: d.itemId,
      qty: d.qty
    })),
    ...(rolledGear ?? []).map((g: any) => ({
      player_item_id: g.playerItemId,
      qty: 1,
      roll_json: g.affixes
    }))
  ];

  let chest = null;
  if (chestDrops.length > 0) {
    chest = await createChestFromDrops({
      playerId,
      sourceType: "combat",
      sourceId: creatureId,
      drops: chestDrops
    });
  }

await db.query(
  `DELETE FROM player_creatures WHERE id = ? AND player_id = ?`,
  [playerCreatureId, playerId]
);

  return {
    expGained,
    goldGained,
    levelUp,
    enemyDead: true,
    chest: chest ? { id: chest.chestId } : null,
    quest: {
      ...(killProg ?? { updatedObjectives: [], completedPlayerQuestIds: [] }),
      completedQuests
    }
  };
}