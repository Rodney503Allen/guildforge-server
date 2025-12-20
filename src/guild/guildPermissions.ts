export const GUILD_PERMISSIONS = {
  INVITE:        1 << 0, // 1
  KICK:          1 << 1, // 2
  PROMOTE:       1 << 2, // 4
  DEMOTE:        1 << 3, // 8
  EDIT_MOTD:     1 << 4, // 16
  EDIT_DESC:     1 << 5, // 32
  MANAGE_ROLES:  1 << 6, // 64
  BANK_DEPOSIT:  1 << 7, // 128
  BANK_WITHDRAW: 1 << 8  // 256
} as const;

export const ALL_GUILD_PERMISSIONS =
  Object.values(GUILD_PERMISSIONS).reduce((a, b) => a | b, 0);
