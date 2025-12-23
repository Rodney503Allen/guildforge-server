import { db } from "../db";

const TICK_RATE_MS = 1000;







async function processCreatureDOTs() {
  const [rows]: any = await db.query(`
    SELECT
      d.player_creature_id,
      d.value,
      pc.hp
    FROM player_creature_debuffs d
    JOIN player_creatures pc ON pc.id = d.player_creature_id
    WHERE d.stat = 'dot'
      AND d.expires_at > NOW()
      AND pc.hp > 0
  `);

  for (const r of rows) {
    const newHP = Math.max(0, Number(r.hp) - Number(r.value));

    await db.query(
      "UPDATE player_creatures SET hp = ? WHERE id = ?",
      [newHP, r.player_creature_id]
    );
  }
}





async function processCreatureHOTs() {
  const [rows]: any = await db.query(`
    SELECT
      d.player_creature_id,
      d.value,
      pc.hp,
      c.maxhp
    FROM player_creature_debuffs d
    JOIN player_creatures pc ON pc.id = d.player_creature_id
    JOIN creatures c ON c.id = pc.creature_id
    WHERE d.stat = 'hot'
      AND d.expires_at > NOW()
      AND pc.hp < c.maxhp
  `);

  for (const r of rows) {
    const healed = Math.min(
      Number(r.hp) + Number(r.value),
      Number(r.maxhp)
    );

    await db.query(
      "UPDATE player_creatures SET hp = ? WHERE id = ?",
      [healed, r.player_creature_id]
    );
  }
}





async function handleCreatureDeathFromDOT(playerCreatureId: number) {
  const [[row]]: any = await db.query(`
    SELECT player_id
    FROM player_creatures
    WHERE id = ?
  `, [playerCreatureId]);

  if (!row) return; // already dead / cleaned up

  const { handleCreatureKill } = await import("./killService");
  await handleCreatureKill(row.player_id, playerCreatureId);
}







async function processPlayerHOTs() {
  const [rows]: any = await db.query(`
    SELECT
      b.player_id,
      b.value,
      p.hpoints,
      p.maxhp
    FROM player_buffs b
    JOIN players p ON p.id = b.player_id
    WHERE b.stat = 'hot'
      AND b.expires_at > NOW()
      AND p.hpoints < p.maxhp
  `);

  for (const r of rows) {
    const healed = Math.min(
      Number(r.hpoints) + Number(r.value),
      Number(r.maxhp)
    );

    await db.query(
      "UPDATE players SET hpoints = ? WHERE id = ?",
      [healed, r.player_id]
    );
  }
}


async function processPlayerDOTs() {
  const [rows]: any = await db.query(`
    SELECT
      b.player_id,
      b.value,
      p.hpoints
    FROM player_buffs b
    JOIN players p ON p.id = b.player_id
    WHERE b.stat = 'dot'
      AND b.expires_at > NOW()
      AND p.hpoints > 0
  `);

  for (const r of rows) {
    const newHP = Math.max(0, Number(r.hpoints) - Number(r.value));

    await db.query(
      "UPDATE players SET hpoints = ? WHERE id = ?",
      [newHP, r.player_id]
    );

    // Optional: handle player death here later
  }
}





export function startStatusHeartbeat() {
  setInterval(async () => {
    try {
      await processCreatureDOTs();
      await processCreatureHOTs();
      await processPlayerDOTs();
      await processPlayerHOTs();
    } catch (err) {
      console.error("🔥 Status Heartbeat Error:", err);
    }
  }, TICK_RATE_MS);
}