import { one, run, sql, type Database } from "./database.js";
import { InvalidInputError } from "./errors.js";
import { priorities } from "./schema.js";
import { now } from "./time.js";
import type { JsonObject, JsonValue } from "./types.js";

export function parseJson(value: unknown, fallback: JsonValue): JsonValue {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return fallback;
  }
}

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function event(
  database: Database,
  type: string,
  id: number,
  actor: number,
  action: string,
  payload: JsonObject,
): void {
  run(
    database,
    "INSERT INTO activity_events(entity_type,entity_id,actor_id,action,payload,created_at) VALUES(?,?,?,?,?,?)",
    type,
    id,
    actor,
    action,
    JSON.stringify(payload),
    now(),
  );
}

export function updateSetting(
  database: Database,
  key: string,
  value: JsonValue,
): void {
  const row = one(
    database,
    "SELECT value_json FROM app_settings WHERE key=?",
    key,
  );
  const existing = parseJson(row?.value_json, {}) as JsonValue;
  if (isObject(existing) && isObject(value)) value = { ...existing, ...value };
  run(
    database,
    "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    key,
    JSON.stringify(value),
    now(),
  );
}

export function priorityNumber(value: unknown): number {
  if (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 4)
    return Number(value);
  if (typeof value === "string" && /^\d$/.test(value) && Number(value) <= 4)
    return Number(value);
  const index = priorities.indexOf(value as never);
  if (index < 0) fail("Unknown priority");
  return index;
}

export function updateFields(
  database: Database,
  table: string,
  key: string,
  id: number | string,
  data: JsonObject,
  map: Record<string, string>,
  transforms: Record<string, (value: unknown) => unknown> = {},
): boolean {
  const changes: Record<string, unknown> = {};
  for (const [source, target] of Object.entries(map))
    if (source in data)
      changes[target] = (transforms[source] ?? ((v) => v))(data[source]);
  updateColumns(database, table, key, id, changes);
  return Object.keys(changes).length > 0;
}

export function updateColumns(
  database: Database,
  table: string,
  key: string,
  id: number | string,
  changes: Record<string, unknown>,
): void {
  const entries = Object.entries(changes);
  if (!entries.length) return;
  database
    .prepare(
      `UPDATE ${table} SET ${entries.map(([column]) => `${column}=?`).join(",")} WHERE ${key}=?`,
    )
    .run(...entries.map(([, value]) => sql(value)), id);
}

export function replaceLinks(
  database: Database,
  table: string,
  key: string,
  id: number,
  column: string,
  values: unknown[],
): void {
  run(database, `DELETE FROM ${table} WHERE ${key}=?`, id);
  for (const value of values)
    run(
      database,
      `INSERT OR IGNORE INTO ${table}(${key},${column}) VALUES(?,?)`,
      id,
      sql(value),
    );
}

export function text(value: unknown, message: string): string {
  const result = String(value ?? "").trim();
  if (!result) fail(message);
  return result;
}

export function array(value: unknown, fallback: unknown[] = []): unknown[] {
  return Array.isArray(value) ? value : fallback;
}

export function withoutActor(data: JsonObject): JsonObject {
  const { actorId: _, ...rest } = data;
  return rest;
}

export function fail(message: string): never {
  throw new InvalidInputError(message);
}
