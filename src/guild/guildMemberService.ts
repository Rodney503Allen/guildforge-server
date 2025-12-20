import { db } from "../db";

export async function getMemberWithRole(playerId: number) {
  const [[row]]: any = await db.query(`
    SELECT
      gm.guild_id,
      gm.role_id,
      gr.permissions,
      gr.rank_order
    FROM guild_members gm
    JOIN guild_roles gr ON gr.id = gm.role_id
    WHERE gm.player_id = ?
  `, [playerId]);

  return row;
}
