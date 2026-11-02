import { mutateAgent, requireActor } from "./actors.js";
import { applyAutomations } from "./automations.js";
import {
  lastInsertId,
  one,
  rows,
  run,
  sql,
  type Database,
} from "./database.js";
import { mutateIssue } from "./issues.js";
import { mutateProject } from "./projects.js";
import { mutateTeam } from "./teams.js";
import { now } from "./time.js";
import { InvalidInputError, RecordConflictError } from "./errors.js";
import type { JsonObject, MutationResult, StoragePaths } from "./types.js";
import { mutationPayload } from "./validation.js";
import {
  array,
  fail,
  isObject,
  text,
  updateFields,
  updateSetting,
  withoutActor,
} from "./workspace-helpers.js";

export function dispatchMutation(
  database: Database,
  method: string,
  route: string,
  raw: unknown,
  paths: StoragePaths,
): MutationResult {
  const data = mutationPayload(raw, route, method);
  const actor = requireActor(database, data.actorId ?? 1);
  validateActorFields(database, data, method, route);
  const stamp = now();
  advanceRevision(database, method, route, data);
  return (
    mutateAgent(database, method, route, data, stamp) ??
    mutateTeam(database, method, route, data, stamp, actor) ??
    mutateProject(database, method, route, data, stamp, actor) ??
    mutateIssue(
      database,
      method,
      route,
      data,
      stamp,
      actor,
      paths,
      applyAutomations,
    ) ??
    mutateGeneral(database, method, route, data, stamp, actor)
  );
}

interface RevisionTarget {
  readonly table: string;
  readonly key: string;
  readonly value: string | number;
}

function advanceRevision(
  database: Database,
  method: string,
  route: string,
  data: JsonObject,
): void {
  const target = revisionTarget(method, route, data);
  if (!target) return;
  if (!Number.isInteger(data.ifRevision) || Number(data.ifRevision) < 1)
    throw new InvalidInputError("ifRevision must be a positive integer");
  const record = one(
    database,
    `SELECT revision FROM ${target.table} WHERE ${target.key}=?`,
    target.value,
  );
  if (!record) throw new InvalidInputError("Record not found");
  const currentRevision = Number(record.revision);
  const expectedRevision = Number(data.ifRevision);
  if (currentRevision !== expectedRevision)
    throw new RecordConflictError(expectedRevision, currentRevision);
  run(
    database,
    `UPDATE ${target.table} SET revision=revision+1 WHERE ${target.key}=?`,
    target.value,
  );
}

function revisionTarget(
  method: string,
  route: string,
  data: JsonObject,
): RevisionTarget | null {
  const agent = route.match(
    /^\/api\/agents\/(\d+)(?:\/(?:deactivate|restore))?$/,
  );
  if (agent && ["PATCH", "POST"].includes(method))
    return { table: "actors", key: "id", value: Number(agent[1]) };
  const issue = route.match(/^\/api\/issues\/([^/]+)(?:\/(restore))?$/);
  if (issue && ["PATCH", "DELETE", "POST"].includes(method))
    return { table: "issues", key: "identifier", value: issue[1]! };
  const project = route.match(/^\/api\/projects\/(\d+)(?:\/(restore))?$/);
  if (project && ["PATCH", "DELETE", "POST"].includes(method))
    return { table: "projects", key: "id", value: Number(project[1]) };
  const team = route.match(/^\/api\/teams\/(\d+)$/);
  if (team && method === "PATCH")
    return { table: "teams", key: "id", value: Number(team[1]) };
  const resource = route.match(/^\/api\/teams\/\d+\/resources\/(\d+)$/);
  if (resource && method === "DELETE")
    return { table: "team_resources", key: "id", value: Number(resource[1]) };
  const view = route.match(/^\/api\/views\/(\d+)$/);
  if (view && ["PATCH", "DELETE"].includes(method))
    return { table: "views", key: "id", value: Number(view[1]) };
  const notification = route.match(
    /^\/api\/notifications\/(\d+)\/(?:read|unread|archive)$/,
  );
  if (notification && method === "POST")
    return {
      table: "notifications",
      key: "id",
      value: Number(notification[1]),
    };
  if (route === "/api/preferences" && method === "PATCH")
    return { table: "app_settings", key: "key", value: "preferences" };
  if (route === "/api/settings" && method === "PATCH")
    return { table: "app_settings", key: "key", value: String(data.key) };
  return null;
}

function mutateGeneral(
  database: Database,
  method: string,
  route: string,
  data: JsonObject,
  stamp: string,
  actor: number,
): MutationResult {
  if (route === "/api/views" && method === "POST") {
    run(
      database,
      "INSERT INTO views(name,description,icon,entity,scope,owner_id,team_id,filters_json,display_json,is_favorite,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      text(data.name, "View name is required"),
      sql(data.description ?? ""),
      sql(data.icon ?? "◈"),
      sql(data.entity ?? "issues"),
      sql(data.scope ?? "Personal"),
      actor,
      sql(data.teamId),
      JSON.stringify(data.filters ?? {}),
      JSON.stringify(data.display ?? {}),
      data.isFavorite ? 1 : 0,
      stamp,
      stamp,
    );
    return { viewId: lastInsertId(database), _status: 201 };
  }
  const view = route.match(/^\/api\/views\/(\d+)$/);
  if (view && ["PUT", "PATCH"].includes(method)) {
    updateFields(database, "views", "id", Number(view[1]), data, {
      name: "name",
      description: "description",
      icon: "icon",
      entity: "entity",
      scope: "scope",
      teamId: "team_id",
      isFavorite: "is_favorite",
    });
    if ("filters" in data)
      run(
        database,
        "UPDATE views SET filters_json=?,updated_at=? WHERE id=?",
        JSON.stringify(data.filters),
        stamp,
        Number(view[1]),
      );
    if ("display" in data)
      run(
        database,
        "UPDATE views SET display_json=?,updated_at=? WHERE id=?",
        JSON.stringify(data.display),
        stamp,
        Number(view[1]),
      );
    return { ok: true };
  }
  if (view && method === "DELETE") {
    run(database, "DELETE FROM views WHERE id=?", Number(view[1]));
    return { ok: true };
  }
  if (route === "/api/cycles" && method === "POST") {
    run(
      database,
      "INSERT INTO cycles(team_id,name,starts_at,ends_at,status,capacity,created_at) VALUES(?,?,?,?,?,?,?)",
      sql(data.teamId ?? 1),
      text(data.name, "Cycle name is required"),
      sql(data.startsAt),
      sql(data.endsAt),
      sql(data.status ?? "Upcoming"),
      sql(data.capacity ?? 20),
      stamp,
    );
    return { cycleId: lastInsertId(database), _status: 201 };
  }
  if (route === "/api/preferences" && ["PUT", "PATCH"].includes(method)) {
    updateSetting(database, "preferences", withoutActor(data));
    return { ok: true };
  }
  const notification = route.match(
    /^\/api\/notifications\/(\d+)\/(read|unread|archive)$/,
  );
  if (notification && method === "POST") {
    const assignment =
      notification[2] === "archive"
        ? "archived=1"
        : notification[2] === "read"
          ? "is_read=1"
          : "is_read=0";
    run(
      database,
      `UPDATE notifications SET ${assignment} WHERE id=? AND recipient_id=?`,
      Number(notification[1]),
      actor,
    );
    return { ok: true };
  }
  if (route === "/api/notifications/read-all" && method === "POST") {
    run(
      database,
      "UPDATE notifications SET is_read=1 WHERE recipient_id=?",
      actor,
    );
    return { ok: true };
  }
  if (
    [
      "/api/notifications/archive-selected",
      "/api/notifications/read-selected",
    ].includes(route) &&
    method === "POST"
  ) {
    const ids = array(data.ids).map(Number);
    if (!ids.length) return { ok: true, count: 0 };
    const set = route.endsWith("archive-selected") ? "archived=1" : "is_read=1";
    const statement = database.prepare(
      `UPDATE notifications SET ${set} WHERE recipient_id=? AND id IN (${ids.map(() => "?").join(",")})`,
    );
    const result = statement.run(actor, ...ids);
    return { ok: true, count: Number(result.changes) };
  }
  if (route === "/api/import" && method === "POST") {
    const created: string[] = [];
    for (const raw of array(data.issues)) {
      const item = {
        ...(raw as JsonObject),
        actorId: actor,
        teamId: (raw as JsonObject).teamId ?? 1,
      };
      const result = dispatchMutation(database, "POST", "/api/issues", item, {
        database: "",
        dataDirectory: "",
        snapshotDirectory: "",
        attachmentsDirectory: "",
        backupsDirectory: "",
      });
      created.push(String((result.issue as JsonObject).identifier));
    }
    return { created, count: created.length };
  }
  if (route === "/api/automations" && method === "POST") {
    run(
      database,
      "INSERT INTO automations(team_id,name,trigger_json,condition_json,action_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
      sql(data.teamId ?? 1),
      text(data.name, "Automation name is required"),
      JSON.stringify(data.trigger ?? {}),
      JSON.stringify(data.condition ?? {}),
      JSON.stringify(data.action ?? {}),
      stamp,
      stamp,
    );
    return { automationId: lastInsertId(database), _status: 201 };
  }
  if (route === "/api/recurring" && method === "POST") {
    run(
      database,
      "INSERT INTO recurring_rules(team_id,title,description,cadence,next_run,enabled,created_at) VALUES(?,?,?,?,?,1,?)",
      sql(data.teamId ?? 1),
      sql(data.title),
      sql(data.description ?? ""),
      sql(data.cadence ?? "Weekly"),
      sql(data.nextRun ?? stamp.slice(0, 10)),
      stamp,
    );
    return { ok: true, _status: 201 };
  }
  if (route === "/api/settings" && ["PUT", "PATCH"].includes(method)) {
    const key = String(data.key ?? "");
    if (!key) fail("Setting key is required");
    updateSetting(database, key, data.value ?? {});
    if (key === "workspace" && isObject(data.value))
      updateFields(database, "workspace", "id", 1, data.value, {
        name: "name",
        icon: "icon",
      });
    return { ok: true };
  }
  return { error: "Not found", _status: 404 };
}

function validateActorFields(
  database: Database,
  data: JsonObject,
  method: string,
  route: string,
): void {
  const existing: Record<string, Set<number>> = {};
  if (["PATCH", "PUT"].includes(method)) {
    const issue = route.match(/^\/api\/issues\/([^/]+)$/);
    if (issue) {
      const row = one(
        database,
        "SELECT id,assignee_id FROM issues WHERE identifier=?",
        issue[1]!,
      );
      if (row) {
        existing.assigneeId = new Set(
          row.assignee_id == null ? [] : [Number(row.assignee_id)],
        );
        existing.subscriberIds = new Set(
          rows(
            database,
            "SELECT member_id FROM issue_subscribers WHERE issue_id=?",
            sql(row.id),
          ).map((item) => Number(item.member_id)),
        );
      }
    }
    const project = route.match(/^\/api\/projects\/(\d+)$/);
    if (project) {
      const row = one(
        database,
        "SELECT lead_id FROM projects WHERE id=?",
        Number(project[1]),
      );
      if (row) {
        existing.leadId = new Set(
          row.lead_id == null ? [] : [Number(row.lead_id)],
        );
        existing.memberIds = new Set(
          rows(
            database,
            "SELECT member_id FROM project_members WHERE project_id=?",
            Number(project[1]),
          ).map((item) => Number(item.member_id)),
        );
      }
    }
    const team = route.match(/^\/api\/teams\/(\d+)$/);
    if (team)
      existing.memberIds = new Set(
        rows(
          database,
          "SELECT member_id FROM team_members WHERE team_id=?",
          Number(team[1]),
        ).map((item) => Number(item.member_id)),
      );
  }
  for (const field of ["assigneeId", "leadId", "memberIds", "subscriberIds"]) {
    if (!(field in data)) continue;
    const values = ["memberIds", "subscriberIds"].includes(field)
      ? array(data[field])
      : [data[field]];
    for (const value of values) {
      if (value === null && ["assigneeId", "leadId"].includes(field)) continue;
      if (!existing[field]?.has(Number(value))) requireActor(database, value);
    }
  }
}
