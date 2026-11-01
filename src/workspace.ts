import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  lastInsertId,
  one,
  rows,
  run,
  scalar,
  sql,
  type Database,
} from "./database.js";
import { InvalidInputError, RelationshipConflictError } from "./errors.js";
import { issueStatuses, priorities } from "./schema.js";
import type {
  JsonObject,
  JsonValue,
  MutationResult,
  Row,
  StoragePaths,
} from "./types.js";
import { mutationPayload } from "./validation.js";
import { actorRecord, actorRecords, requireActor } from "./actors.js";
import { now } from "./time.js";
import { mutateTeam } from "./teams.js";
import { mutateProject } from "./projects.js";
import { mutateIssue } from "./issues.js";
import {
  array,
  event,
  fail,
  isObject,
  parseJson,
  priorityNumber,
  replaceLinks,
  text,
  updateColumns,
  updateFields,
  updateSetting,
  withoutActor,
} from "./workspace-helpers.js";
import { issueRow } from "./workspace-reads.js";

export { actorRecord, actorRecords, requireActor } from "./actors.js";
export {
  createMemberActors,
  initializeSchema,
  seedDemo,
  seedEmpty,
} from "./seed.js";
export { now } from "./time.js";
export { bootstrap, issueRow, search } from "./workspace-reads.js";

export function dispatchMutation(
  database: Database,
  method: string,
  route: string,
  raw: unknown,
  paths: StoragePaths,
): MutationResult {
  const data = mutationPayload(raw, route);
  const actor = requireActor(database, data.actorId ?? 1);
  validateActorFields(database, data, method, route);
  const stamp = now();
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

function mutateAgent(
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

export function runDueRecurring(
  database: Database,
  paths: StoragePaths,
): number {
  const today = new Date().toISOString().slice(0, 10);
  let created = 0;
  for (const rule of rows(
    database,
    "SELECT * FROM recurring_rules WHERE enabled=1 ORDER BY id",
  )) {
    let due = String(rule.next_run).slice(0, 10);
    if (due > today) continue;
    dispatchMutation(
      database,
      "POST",
      "/api/issues",
      {
        actorId: 1,
        teamId: Number(rule.team_id),
        title: String(rule.title),
        description: String(rule.description),
        recurringRule: {
          ruleId: Number(rule.id),
          cadence: String(rule.cadence),
        },
      },
      paths,
    );
    do due = recurringNext(due, String(rule.cadence));
    while (due <= today);
    run(
      database,
      "UPDATE recurring_rules SET next_run=? WHERE id=?",
      due,
      sql(rule.id),
    );
    created += 1;
  }
  return created;
}

function applyAutomations(
  database: Database,
  teamId: number,
  issueId: number,
  eventName: string,
  actor: number,
): void {
  const issue = one(
    database,
    "SELECT i.*,s.name AS status FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.id=?",
    issueId,
  );
  if (!issue) return;
  const labels = new Set(
    rows(
      database,
      "SELECT l.name FROM labels l JOIN issue_labels il ON il.label_id=l.id WHERE il.issue_id=?",
      issueId,
    ).map((row) => String(row.name)),
  );
  for (const rule of rows(
    database,
    "SELECT * FROM automations WHERE team_id=? AND enabled=1 ORDER BY id",
    teamId,
  )) {
    const trigger = parseJson(rule.trigger_json, {}) as JsonObject;
    const condition = parseJson(rule.condition_json, {}) as JsonObject;
    const action = parseJson(rule.action_json, {}) as JsonObject;
    if (trigger.event !== eventName) continue;
    if (
      ![null, "", "Any", undefined].includes(condition.priority as never) &&
      priorities[Number(issue.priority)] !== condition.priority
    )
      continue;
    if (
      ![null, "", "Any", undefined].includes(condition.label as never) &&
      !labels.has(String(condition.label))
    )
      continue;
    const name = String(action.name ?? "");
    const changes: JsonObject[] = [];
    if (action.assignTo !== undefined) {
      const id = requireActor(database, action.assignTo);
      run(
        database,
        "UPDATE issues SET assignee_id=?,updated_at=? WHERE id=?",
        id,
        now(),
        issueId,
      );
      changes.push({ field: "assignee_id", value: id });
    } else if (name === "Assign to me") {
      run(
        database,
        "UPDATE issues SET assignee_id=?,updated_at=? WHERE id=?",
        actor,
        now(),
        issueId,
      );
      changes.push({ field: "assignee_id", value: actor });
    } else if (name.startsWith("Add ") && name.endsWith(" label")) {
      const labelName = name.slice(4, -6).trim();
      const label = one(
        database,
        "SELECT id FROM labels WHERE name=? AND (team_id=? OR team_id IS NULL) ORDER BY team_id DESC LIMIT 1",
        labelName,
        teamId,
      );
      if (label && !labels.has(labelName)) {
        run(
          database,
          "INSERT OR IGNORE INTO issue_labels(issue_id,label_id) VALUES(?,?)",
          issueId,
          sql(label.id),
        );
        labels.add(labelName);
        changes.push({ field: "label", value: labelName });
      }
    } else if (name.startsWith("Set status: ")) {
      const status = one(
        database,
        "SELECT id FROM issue_statuses WHERE team_id=? AND name=?",
        teamId,
        name.split(":", 2)[1]!.trim(),
      );
      if (status) {
        run(
          database,
          "UPDATE issues SET status_id=?,updated_at=? WHERE id=?",
          sql(status.id),
          now(),
          issueId,
        );
        changes.push({ field: "status_id", value: Number(status.id) });
      }
    }
    if (changes.length)
      event(database, "issue", issueId, actor, "automation_applied", {
        automation: String(rule.name),
        changes,
      });
  }
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
function recurringNext(value: string, cadence: string): string {
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (cadence === "Daily") date.setUTCDate(date.getUTCDate() + 1);
  else if (cadence === "Every 2 weeks") date.setUTCDate(date.getUTCDate() + 14);
  else if (cadence === "Monthly") {
    const targetMonth = month === 12 ? 1 : month + 1;
    const targetYear = month === 12 ? year + 1 : year;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    date.setTime(Date.UTC(targetYear, targetMonth - 1, Math.min(day, lastDay)));
  } else date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}
