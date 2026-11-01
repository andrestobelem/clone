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
