export type Archetype =
  | "Arcanist"
  | "Divine"
  | "Brute"
  | "Skirmisher";

export type ScalingStat =
  | "intellect"
  | "attack"
  | "agility";

export const ARCHETYPE_SCALING: Record<Archetype, ScalingStat> = {
  Arcanist: "intellect",
  Divine: "intellect",
  Brute: "attack",
  Skirmisher: "agility"
};
