import { InvalidInputError } from "./errors.js";
import type { JsonObject, JsonValue } from "./types.js";

const cadences = new Set(["Daily", "Weekly", "Every 2 weeks", "Monthly"]);
const statusCategories = new Set([
  "Backlog",
  "Unstarted",
  "Started",
  "Completed",
  "Canceled",
  "Duplicate",
]);

export function mutationPayload(value: unknown, route: string): JsonObject {
  if (!isObject(value)) {
    throw new InvalidInputError("Request body must be an object");
  }
  assertJson(value);
  const result = structuredClone(value) as JsonObject;

  const textFields = [
    "title",
    "name",
    "body",
    "description",
    "summary",
    "status",
    "health",
    "key",
    "icon",
    "color",
    "category",
    "timezone",
    "estimateType",
    "cadence",
    "scope",
    "entity",
    "section",
    "url",
    "type",
    "externalUrl",
    "relatedIssueId",
  ];
  for (const field of textFields) {
    if (!(field in result)) continue;
    if ((field === "externalUrl" || field === "url") && result[field] === null)
      continue;
    if (typeof result[field] !== "string") fail(`${field} must be text`);
  }
  for (const field of ["title", "name", "body", "key"]) {
    if (!(field in result)) continue;
    const text = (result[field] as string).trim();
    if (!text) fail(`${field} must not be empty`);
    result[field] = text;
  }

  for (const field of [
    "teamId",
    "projectId",
    "cycleId",
    "milestoneId",
    "parentId",
    "dependsOnId",
  ]) {
    if (!(field in result)) continue;
    const candidate = result[field];
    const nullable =
      ["projectId", "cycleId", "milestoneId", "parentId"].includes(field) ||
      (field === "teamId" && /^\/api\/(labels|views)(\/\d+)?$/.test(route));
    if (candidate === null && nullable) continue;
    if (!Number.isInteger(candidate) || Number(candidate) < 1)
      fail(`${field} must be a positive integer`);
  }

  for (const field of ["labelIds", "teamIds", "dependencies", "ids"]) {
    if (!(field in result)) continue;
    const values = result[field];
    if (
      !Array.isArray(values) ||
      values.some((item) => !Number.isInteger(item) || Number(item) < 1)
    ) {
      fail(`${field} must be an array of positive integers`);
    }
    result[field] = [...new Set(values)] as JsonValue[];
  }
  for (const field of [
    "filters",
    "display",
    "trigger",
    "condition",
    "action",
  ]) {
    if (field in result && !isObject(result[field]))
      fail(`${field} must be an object`);
  }
  for (const field of ["issues", "files", "milestones"]) {
    if (!(field in result)) continue;
    const values = result[field];
    if (!Array.isArray(values) || values.some((item) => !isObject(item))) {
      fail(`${field} must be an array of objects`);
    }
  }
  for (const field of ["estimate", "capacity"]) {
    if (!(field in result)) continue;
    const candidate = result[field];
    if (field === "estimate" && candidate === null) continue;
    if (
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      candidate < 0
    ) {
      fail(`${field} must be a finite number of zero or more`);
    }
  }
  for (const field of ["dueDate", "startDate", "targetDate"]) {
    if (field in result) result[field] = dateValue(result[field], field, true);
  }
  validateRouteFields(result, route);
  return result;
}

function validateRouteFields(result: JsonObject, route: string): void {
  if (route === "/api/cycles") {
    const start = timestampValue(result.startsAt, "startsAt");
    const end = timestampValue(result.endsAt, "endsAt");
    if (end < start) fail("Cycle end must not be before its start");
  }
  if (route === "/api/recurring") {
    if (!cadences.has(String(result.cadence ?? "Weekly")))
      fail("Unknown recurring cadence");
    if ("nextRun" in result)
      result.nextRun = dateValue(result.nextRun, "nextRun", false);
  }
  if (
    route === "/api/statuses" &&
    !statusCategories.has(String(result.category ?? "Unstarted"))
  ) {
    fail("Unknown workflow status category");
  }
  if (
    /^\/api\/projects(?:\/\d+)?$/.test(route) &&
    "status" in result &&
    !["Backlog", "Planned", "In Progress", "Completed", "Canceled"].includes(
      String(result.status),
    )
  ) {
    fail("Unknown project status");
  }
  if (/^\/api\/views(?:\/\d+)?$/.test(route)) {
    if (
      "entity" in result &&
      !["issues", "projects"].includes(String(result.entity))
    )
      fail("Unknown view entity");
    if (
      "scope" in result &&
      !["Personal", "Workspace", "Team"].includes(String(result.scope))
    )
      fail("Unknown view scope");
    if (
      "isFavorite" in result &&
      typeof result.isFavorite !== "boolean" &&
      result.isFavorite !== 0 &&
      result.isFavorite !== 1
    ) {
      fail("isFavorite must be a boolean or 0 or 1");
    }
  }
  if (route === "/api/automations") {
    const trigger = (result.trigger ?? {}) as JsonObject;
    const condition = (result.condition ?? {}) as JsonObject;
    const action = (result.action ?? {}) as JsonObject;
    if (
      "event" in trigger &&
      !["issue.created", "issue.updated", "issue.completed"].includes(
        String(trigger.event),
      )
    )
      fail("Unknown automation event");
    if (
      "priority" in condition &&
      ![
        null,
        "",
        "Any",
        "Urgent",
        "High",
        "Medium",
        "Low",
        "No priority",
      ].includes(condition.priority as never)
    )
      fail("Unknown automation priority condition");
    if (
      "label" in condition &&
      condition.label !== null &&
      typeof condition.label !== "string"
    )
      fail("Automation label condition must be text");
    if ("name" in action && typeof action.name !== "string")
      fail("Automation action name must be text");
  }
  if (route === "/api/preferences") {
    if (
      "sidebar" in result &&
      (!isObject(result.sidebar) ||
        Object.values(result.sidebar).some(
          (value) => typeof value !== "boolean",
        ))
    )
      fail("sidebar must be an object of booleans");
    for (const field of ["autoAssignToSelf", "spelling"])
      if (field in result && typeof result[field] !== "boolean")
        fail(`${field} must be a boolean`);
  }
  if (route === "/api/settings") {
    const key = result.key;
    const value = result.value ?? {};
    if (key === "preferences" || key === "workspace") {
      if (!isObject(value)) fail(`${key} must be an object`);
      if (key === "preferences") mutationPayload(value, "/api/preferences");
      if (
        key === "workspace" &&
        "name" in value &&
        (typeof value.name !== "string" || !value.name.trim())
      )
        fail("Workspace name must not be empty");
    }
    if (
      key === "integrations" &&
      (!Array.isArray(value) || value.some((item) => !isObject(item)))
    )
      fail("integrations must be an array of objects");
  }
  if ("milestones" in result) {
    result.milestones = (result.milestones as JsonObject[]).map((item) =>
      mutationPayload(item, "/api/milestones"),
    );
  }
  if ("recurringRule" in result && result.recurringRule !== null) {
    if (isObject(result.recurringRule))
      result.recurringRule = JSON.stringify(result.recurringRule);
    else if (typeof result.recurringRule !== "string")
      fail("recurringRule must be an object, text, or null");
  }
}

function dateValue(
  value: JsonValue | undefined,
  field: string,
  optional: boolean,
): string | null {
  if (optional && (value === null || value === "")) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    fail(`${field} must use YYYY-MM-DD with a valid date`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    fail(`${field} must use YYYY-MM-DD with a valid date`);
  return value;
}

function timestampValue(value: JsonValue | undefined, field: string): number {
  if (typeof value !== "string") fail(`${field} must be a date or timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    fail(`${field} must be a valid ISO date or timestamp`);
  return parsed;
}

function assertJson(value: unknown): asserts value is JsonValue {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || /(?:NaN|Infinity)/.test(encoded))
      throw new Error();
  } catch {
    fail("Request body must contain JSON values with finite numbers");
  }
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new InvalidInputError(message);
}
