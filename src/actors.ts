import {
  lastInsertId,
  one,
  rows,
  run,
  sql,
  type Database,
} from "./database.js";
import { InvalidInputError, RelationshipConflictError } from "./errors.js";
import type { JsonObject, JsonValue, MutationResult, Row } from "./types.js";
import { fail, text } from "./workspace-helpers.js";

export function mutateAgent(
  database: Database,
  method: string,
  route: string,
  data: JsonObject,
  stamp: string,
): MutationResult | null {
  if (route === "/api/agents" && method === "POST") {
    const key = text(data.key, "Agent key is required");
    const name = text(data.name, "Agent name is required");
    run(
      database,
      "INSERT INTO actors(kind,name,key,created_at) VALUES('agent',?,?,?)",
      name,
      key,
      stamp,
    );
    const agentId = lastInsertId(database);
    if (data.teamId !== undefined)
      run(
        database,
        "INSERT INTO team_members(team_id,member_id,role) VALUES(?,?,'Member')",
        sql(data.teamId),
        agentId,
      );
    return { agent: actorRecord(database, agentId) as JsonValue, _status: 201 };
  }
  const match = route.match(
    /^\/api\/agents\/(\d+)(?:\/(deactivate|restore))?$/,
  );
  if (!match) return null;
  const agentId = Number(match[1]);
  const target = actorRecord(database, agentId);
  if (!target || target.kind !== "agent") fail("Agent not found");
  if (match[2] && method === "POST")
    run(
      database,
      "UPDATE actors SET active=? WHERE id=?",
      match[2] === "restore" ? 1 : 0,
      agentId,
    );
  else if (!match[2] && method === "PATCH") {
    if ("key" in data) fail("Agent key cannot change");
    run(
      database,
      "UPDATE actors SET name=? WHERE id=?",
      text(data.name, "Agent name is required"),
      agentId,
    );
  } else return { error: "Not found", _status: 404 };
  return { agent: actorRecord(database, agentId) as JsonValue };
}

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
