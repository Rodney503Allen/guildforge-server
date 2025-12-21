import { Router, Request, Response } from "express";
import { db } from "../db";
import { hasPermission, canActOnRole } from "./guildPermissionService";
import { GUILD_PERMISSIONS } from "./guildPermissions";
import { getMemberWithRole } from "./guildMemberService"; // make sure this file exists

const router = Router();

router.put("/guild/members/:memberId/role", async (req, res) => {
  const actorId = (req.session as any).playerId;
  const memberId = Number(req.params.memberId);
  const { newRoleId } = req.body;

  const actor = await getMemberWithRole(actorId);

  const [[target]]: any = await db.query(`
    SELECT gm.guild_id, gr.rank_order
    FROM guild_members gm
    JOIN guild_roles gr ON gr.id = gm.role_id
    WHERE gm.id = ?
  `, [memberId]);

  const [[newRole]]: any = await db.query(
    "SELECT rank_order FROM guild_roles WHERE id = ?",
    [newRoleId]
  );

  if (
    !actor ||
    actor.guild_id !== target.guild_id ||
    !hasPermission(actor.permissions, GUILD_PERMISSIONS.PROMOTE) ||
    !canActOnRole(actor.rank_order, target.rank_order) ||
    !canActOnRole(actor.rank_order, newRole.rank_order)
  ) {
    return res.status(403).json({ error: "Forbidden" });
  }

  await db.query(
    "UPDATE guild_members SET role_id = ? WHERE id = ?",
    [newRoleId, memberId]
  );

  res.json({ success: true });
});
