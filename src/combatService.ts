import { db } from "./db";

type ResolveDamageArgs = {
  pid: number;
  battleId: number;
  damage: number;
  crit?: number;
  spendSP?: number;
};

export async function resolveDamage({
  pid,
  battleId,
  damage,
  crit = 0,
  spendSP = 0,
}: ResolveDamageArgs): Promise<any> {

  // Load enemy
  const [[enemy]]: any = await db.query(`
    SELECT 
      pc.id,
      pc.hp,
      pc.creature_id,
      c.exper
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    WHERE pc.id = ?
  `, [battleId]);

  if (!enemy) {
    console.log("resolveDamage: no enemy found", battleId);
    return { dead: true, noEnemy: true };
  }

  // Spend SP for spell
  if (spendSP > 0) {
    await db.query(
      "UPDATE players SET spoints = GREATEST(0, spoints - ?) WHERE id=?",
      [spendSP, pid]
    );
  }

  // ======================
  // CRIT CHECK
  // ======================
  let isCrit = false;

  if (Math.random() < crit) {
    damage = Math.floor(damage * 1.5);
    isCrit = true;
  }

  const newEnemyHP = enemy.hp - damage;

  console.log("DAMAGE DEBUG", {
    battleId,
    oldHP: enemy.hp,
    damage,
    newEnemyHP,
    pCrit: isCrit
  });

  // ======================
  // ENEMY DEAD
  // ======================
  if (newEnemyHP <= 0) {

    const exp = enemy.exper || 25;
    const gold = Math.floor(Math.random() * 20) + 10;

    await db.query(
      "UPDATE players SET exper = exper + ?, gold = gold + ? WHERE id=?",
      [exp, gold, pid]
    );

    await dropRandomItemForPlayer(pid, enemy.creature_id);

    const [[player]]: any = await db.query(
      "SELECT level, exper FROM players WHERE id=?",
      [pid]
    );

    const threshold = player.level * 50 + player.level * player.level * 50;
    let leveled = false;

    if (player.exper >= threshold) {
      await db.query(`
        UPDATE players
        SET level = level + 1,
            exper = exper - ?,
            stat_points = stat_points + 5,
            hpoints = maxhp,
            spoints = maxspoints
        WHERE id=?
      `, [threshold, pid]);

      leveled = true;
    }

    await db.query("DELETE FROM player_creatures WHERE id=?", [battleId]);

    return {
      dead: true,
      pHit: damage,
      pCrit: isCrit,
      enemyHP: 0,
      exp,
      gold,
      leveled
    };
  }

  // ======================
  // ENEMY LIVES
  // ======================
  await db.query(
    "UPDATE player_creatures SET hp=? WHERE id=?",
    [newEnemyHP, battleId]
  );

  return {
    dead: false,
    pHit: damage,
    pCrit: isCrit,
    enemyHP: newEnemyHP
  };
}


// ==============================
// LOOT DROPS
// ==============================
export async function dropRandomItemForPlayer(pid: number, creatureId?: number) {

  console.log("DROP FUNCTION CALLED", pid);

  const roll = Math.random();
  console.log("LOOT ROLL:", roll);

  let allowedTypes = ["junk", "potion"];
  const tierRoll = Math.random();

  if (tierRoll > 0.9) allowedTypes.push("treasure", "weapon", "armor");
  else if (tierRoll > 0.6) allowedTypes.push("weapon", "armor");

  const placeholders = allowedTypes.map(() => "?").join(",");

  const [lootRows]: any = await db.query(`
    SELECT id
    FROM items
    WHERE type IN (${placeholders})
    ORDER BY RAND()
    LIMIT 1
  `, [...allowedTypes]);

  if (!lootRows.length) {
    console.log("No loot found");
    return;
  }

  const lootId = lootRows[0].id;

  const [[existing]]: any = await db.query(`
    SELECT inventory_id
    FROM inventory
    WHERE player_id = ? AND item_id = ?
  `, [pid, lootId]);

  if (existing) {
    await db.query(
      "UPDATE inventory SET quantity = quantity + 1 WHERE inventory_id=?",
      [existing.inventory_id]
    );
  } else {
    await db.query(
      "INSERT INTO inventory (player_id,item_id,quantity,equipped) VALUES (?, ?, 1, 0)",
      [pid, lootId]
    );
  }
}
