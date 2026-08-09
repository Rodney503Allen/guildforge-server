//hunt.types.ts
export type HuntStatus =
  | "tracking"
  | "revealed"
  | "engaged"
  | "completed"
  | "failed"
  | "abandoned";

export interface HuntDefinition {
  id: number;
  name: string;
  slug: string;

  description: string | null;
  flavorText: string | null;

  targetCreatureId: number | null;
  regionId: number | null;

  recommendedLevel: number;
  recommendedPartySize: number;

  difficulty: number;

  rewardXp: number;
  rewardGold: number;
  rewardHuntMarks: number;

  trackingRequired: number;

  isActive: boolean;
}

export interface HuntObjectiveProgress {
  id: number;

  objectiveType: string;

  targetCreatureId: number | null;
  targetRegionId: number | null;
  targetObjectId: number | null;

  requiredCount: number;
  progressCount: number;

  trackingValue: number;

  description: string;

  sortOrder: number;

  isRequired: boolean;
  isComplete: boolean;

  completedAt: Date | string | null;
}

export interface ActivePartyHunt {
  partyHuntId: number;

  partyId: number;
  huntId: number;

  acceptedByPlayerId: number;

  status: HuntStatus;

  trackingProgress: number;
  trackingRequired: number;

  targetRevealed: boolean;

  targetMapX: number | null;
  targetMapY: number | null;

  acceptedAt: Date | string;

  revealedAt: Date | string | null;
  completedAt: Date | string | null;
  failedAt: Date | string | null;

  hunt: HuntDefinition;

  objectives: HuntObjectiveProgress[];
}

export type HuntProgressEventType =
  | "ENTER_REGION"
  | "KILL"
  | "TRACK"
  | "INTERACT"
  | "BOSS";

export interface HuntProgressEvent {
  type: HuntProgressEventType;

  regionId?: number;
  creatureId?: number;
  objectId?: number;

  amount?: number;
}