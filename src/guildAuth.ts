import { PERMS } from "./guild.routes";

export function hasPerm(mask: number, perm: number): boolean {
  return (mask & perm) === perm;
}

export function higherRank(a: number, b: number): boolean {
  return a > b;
}
