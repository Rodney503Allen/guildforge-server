import express from "express";
import { db } from "../db";
import { getMemberWithRole } from "./guildMemberService";
import { hasPermission, canActOnRole } from "./guildPermissionService";
import { GUILD_PERMISSIONS } from "./guildPermissions";

const router = express.Router();

/**
 * GET roles for a guild
 */
router.get("/guild/:guildId/roles", async (req, res) => {
  const guildId = Number(req.params.guildId);

  const [roles]: any = await db.query(
    "SELECT id, name, permissions, rank_order FROM guild_roles WHERE guild_id = ? ORDER BY rank_order DESC",
    [guildId]
  );

  res.json(roles);
});

/**
 * CREATE role
 */
router.post("/guild/:guildId/roles", async (req, res) => {
  const playerId = (req.session as any).playerId;
  const guildId = Number(req.params.guildId);
  const { name, permissions, rank_order } = req.body;

  const actor = await getMemberWithRole(playerId);

  if (!actor || actor.guild_id !== guildId)
    return res.status(403).json({ error: "Not in guild" });

  if (!hasPermission(actor.permissions, GUILD_PERMISSIONS.MANAGE_ROLES))
    return res.status(403).json({ error: "No permission" });

  if (!canActOnRole(actor.rank_order, rank_order))
    return res.status(403).json({ error: "Rank too high" });

  await db.query(
    "INSERT INTO guild_roles (guild_id, name, permissions, rank_order) VALUES (?, ?, ?, ?)",
    [guildId, name, permissions, rank_order]
  );

  res.json({ success: true });
});

/**
 * UPDATE role
 */
router.put("/guild/roles/:roleId", async (req, res) => {
  const playerId = (req.session as any).playerId;
  const roleId = Number(req.params.roleId);
  const { name, permissions, rank_order } = req.body;

  const actor = await getMemberWithRole(playerId);

  const [[role]]: any = await db.query(
    "SELECT guild_id, rank_order FROM guild_roles WHERE id = ?",
    [roleId]
  );

  if (!role) return res.status(404).json({ error: "Role not found" });

  if (
    !actor ||
    actor.guild_id !== role.guild_id ||
    !hasPermission(actor.permissions, GUILD_PERMISSIONS.MANAGE_ROLES) ||
    !canActOnRole(actor.rank_order, role.rank_order)
  ) {
    return res.status(403).json({ error: "Forbidden" });
  }

  await db.query(
    "UPDATE guild_roles SET name = ?, permissions = ?, rank_order = ? WHERE id = ?",
    [name, permissions, rank_order, roleId]
  );

  res.json({ success: true });
});

/**
 * DELETE role
 */
router.delete("/guild/roles/:roleId", async (req, res) => {
  const playerId = (req.session as any).playerId;
  const roleId = Number(req.params.roleId);

  const actor = await getMemberWithRole(playerId);

  const [[role]]: any = await db.query(
    "SELECT guild_id, rank_order FROM guild_roles WHERE id = ?",
    [roleId]
  );

  if (!role) return res.status(404).json({ error: "Role not found" });

  if (
    !actor ||
    actor.guild_id !== role.guild_id ||
    !hasPermission(actor.permissions, GUILD_PERMISSIONS.MANAGE_ROLES) ||
    !canActOnRole(actor.rank_order, role.rank_order)
  ) {
    return res.status(403).json({ error: "Forbidden" });
  }

  await db.query("DELETE FROM guild_roles WHERE id = ?", [roleId]);
  res.json({ success: true });
});

export default router;
