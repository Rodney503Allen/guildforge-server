import { GUILD_PERMISSIONS } from "./guildPermissions";

export function hasPermission(
  rolePermissions: number,
  permission: number
): boolean {
  return (rolePermissions & permission) === permission;
}

export function canActOnRole(
  actorRank: number,
  targetRank: number
): boolean {
  return actorRank > targetRank;
}
