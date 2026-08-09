export type PartyRole =
  | "tank"
  | "healer"
  | "damage"
  | "support"
  | null;

export interface PartyMember {
  playerId: number;
  name: string;
  level: number;
  className: string;
  role: PartyRole;

  hpoints: number;
  maxhp: number;

  spoints: number;
  maxspoints: number;

  joinedAt: Date | string;

  isLeader: boolean;
}

export interface Party {
  id: number;
  leaderPlayerId: number;
  status: string;
  maxMembers: number;
  createdAt: Date | string;
  members: PartyMember[];
}