// src/services/statusHeartbeat.ts
import { db } from "../db";

const TICK_RATE_MS = 1000;
let heartbeatRunning = false;

export function startStatusHeartbeat() {
  setInterval(async () => {
    if (heartbeatRunning) return;

    heartbeatRunning = true;

    try {
      await processCreatureDOTs();
      await processCreatureHOTs();
      await processPlayerDOTs();
      await processPlayerHOTs();
    } catch (err) {
      console.error("🔥 Status Heartbeat Error:", err);
    } finally {
      heartbeatRunning = false;
    }
  }, TICK_RATE_MS);
}

async function processCreatureDOTs() {
  const [rows]: any = await db.query(`
    SELECT d.player_creature_id, d.value, pc.hp
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
    SELECT d.player_creature_id, d.value, pc.hp, c.maxhp
    FROM player_creatures pc
    JOIN creatures c ON c.id = pc.creature_id
    JOIN player_creature_debuffs d ON d.player_creature_id = pc.id
    WHERE d.stat = 'hot'
      AND d.expires_at > NOW()
      AND pc.hp < c.maxhp
  `);

  for (const r of rows) {
    const healed = Math.min(Number(r.hp) + Number(r.value), Number(r.maxhp));

    await db.query(
      "UPDATE player_creatures SET hp = ? WHERE id = ?",
      [healed, r.player_creature_id]
    );
  }
}

async function processPlayerHOTs() {
  const [rows]: any = await db.query(`
    SELECT b.player_id, b.value, p.hpoints, p.maxhp
    FROM player_buffs b
    JOIN players p ON p.id = b.player_id
    WHERE b.stat = 'hot'
      AND b.expires_at > NOW()
      AND p.hpoints < p.maxhp
  `);

  for (const r of rows) {
    const healed = Math.min(Number(r.hpoints) + Number(r.value), Number(r.maxhp));

    await db.query(
      "UPDATE players SET hpoints = ? WHERE id = ?",
      [healed, r.player_id]
    );
  }
}

async function processPlayerDOTs() {
  const [rows]: any = await db.query(`
    SELECT b.player_id, b.value, p.hpoints
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
  }
}