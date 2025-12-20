export type PlayerIdentity = {
  id: number;
  name: string;
  pclass: string;
  level: number;
  exper: number;
  gold: number;
  stat_points: number;
};

export type PlayerStats = {
  attack: number;
  defense: number;
  agility: number;
  vitality: number;
  intellect: number;
  crit: number;

  hpoints: number;
  spoints: number;
  maxhp: number;
  maxspoints: number;
};

export type FullPlayer = PlayerIdentity & PlayerStats;
