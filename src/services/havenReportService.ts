import { db } from "../db";

export type HavenReportType =
  | "WORLD_EVENT"
  | "WORLD_BOSS"
  | "BOSS_DEFEATED"
  | "LEVEL_MILESTONE"
  | "RARE_DROP"
  | "WORLD_FIRST"
  | "SYSTEM";

export interface CreateHavenReportInput {
  type: HavenReportType;
  title: string;
  message: string;

  playerId?: number | null;
  regionId?: number | null;
  locationId?: number | null;

  entityType?: string | null;
  entityId?: number | null;

  importance?: number;
  expiresAt?: Date | string | null;
}

export interface HavenReport {
  id: number;
  report_type: HavenReportType;
  title: string;
  message: string;

  player_id: number | null;
  region_id: number | null;
  location_id: number | null;

  entity_type: string | null;
  entity_id: number | null;

  importance: number;
  created_at: Date;
  expires_at: Date | null;
}

/**
 * Creates a new Haven Report.
 *
 * Other game systems should use this instead of inserting
 * directly into haven_reports.
 */
export async function createHavenReport(
  input: CreateHavenReportInput
): Promise<number> {
  const title = String(input.title || "").trim();
  const message = String(input.message || "").trim();

  if (!title) {
    throw new Error("Haven report title is required.");
  }

  if (!message) {
    throw new Error("Haven report message is required.");
  }

  const importance = Math.max(
    1,
    Math.min(3, Number(input.importance || 1))
  );

  const [result]: any = await db.query(
    `
      INSERT INTO haven_reports (
        report_type,
        title,
        message,
        player_id,
        region_id,
        location_id,
        entity_type,
        entity_id,
        importance,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.type,
      title,
      message,

      input.playerId ?? null,
      input.regionId ?? null,
      input.locationId ?? null,

      input.entityType ?? null,
      input.entityId ?? null,

      importance,
      input.expiresAt ?? null
    ]
  );

  return Number(result.insertId);
}

/**
 * Returns the newest currently-visible Haven Reports.
 *
 * Haven Reports are live world activity, so only reports created
 * within the last hour are returned to players.
 */
export async function getActiveHavenReports(
  limit = 20
): Promise<HavenReport[]> {
  const safeLimit = Math.max(1, Math.min(50, Number(limit || 20)));

  const [rows]: any = await db.query(
    `
      SELECT
        id,
        report_type,
        title,
        message,
        player_id,
        region_id,
        location_id,
        entity_type,
        entity_id,
        importance,
        created_at,
        expires_at
      FROM haven_reports
      WHERE
        created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
      ORDER BY 
        created_at DESC
      LIMIT ?
    `,
    [safeLimit]
  );

  return rows || [];
}

/**
 * Deletes Haven Reports once they are at least one hour old.
 *
 * Visibility is independently limited to the last hour by
 * getActiveHavenReports(), so delayed cleanup can never make
 * stale reports visible to players.
 */
export async function deleteExpiredHavenReports(): Promise<number> {
  const [result]: any = await db.query(
    `
      DELETE FROM haven_reports
      WHERE created_at <= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `
  );

  return Number(result.affectedRows || 0);
}
