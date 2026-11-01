import { one, rows, type Database } from "./database.js";
import { InvalidInputError, RelationshipConflictError } from "./errors.js";
import type { Row } from "./types.js";

export function actorRecord(database: Database, actorId: number): Row | null {
  return (
    one(
      database,
      `SELECT a.*,m.email,m.role FROM actors a
    LEFT JOIN members m ON m.id=a.member_id WHERE a.id=?`,
      actorId,
    ) ?? null
  );
}

export function actorRecords(
  database: Database,
  kind: string | null = null,
  includeInactive = false,
): Row[] {
  return rows(
    database,
    "SELECT id FROM actors WHERE (? IS NULL OR kind=?) AND (? OR active=1) ORDER BY id",
    kind,
    kind,
    includeInactive ? 1 : 0,
  )
    .map((row) => actorRecord(database, Number(row.id)))
    .filter((row): row is Row => row !== null);
}

export function requireActor(database: Database, actorId: unknown): number {
  if (!Number.isInteger(actorId))
    throw new InvalidInputError("Actor ID must be an integer");
  const record = actorRecord(database, Number(actorId));
  if (!record || !record.active)
    throw new RelationshipConflictError("Actor not found or inactive");
  return Number(actorId);
}
