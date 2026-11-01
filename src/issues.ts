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
import type {
  JsonObject,
  JsonValue,
  MutationResult,
  Row,
  StoragePaths,
} from "./types.js";
import { issueRow } from "./workspace-reads.js";
import {
  array,
  event,
  fail,
  priorityNumber,
  replaceLinks,
  text,
  updateColumns,
} from "./workspace-helpers.js";

export type AutomationRunner = (
  database: Database,
  teamId: number,
  issueId: number,
  eventName: string,
  actor: number,
) => void;

export function mutateIssue(
  database: Database,
  method: string,
  route: string,
  data: JsonObject,
  stamp: string,
  actor: number,
  paths: StoragePaths,
  runAutomations: AutomationRunner,
): MutationResult | null {
  if (route === "/api/issues" && method === "POST") {
    const title = text(data.title, "Issue title is required");
    const teamId = Number(data.teamId ?? 1);
    const team = one(database, "SELECT key FROM teams WHERE id=?", teamId);
    if (!team) fail("Team not found");
    validateIssueLinks(database, data);
    const number = nextIssueNumber(database, teamId, String(team.key));
    const status = issueStatus(
      database,
      teamId,
      data.status as string | undefined,
    );
    run(
      database,
      "INSERT INTO issues(identifier,number,team_id,title,description,status_id,priority,assignee_id,creator_id,project_id,cycle_id,milestone_id,due_date,estimate,parent_id,recurring_rule,external_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      `${team.key}-${number}`,
      number,
      teamId,
      title,
      sql(data.description ?? ""),
      sql(status.id),
      priorityNumber(data.priority ?? 4),
      sql(data.assigneeId),
      actor,
      sql(data.projectId),
      sql(data.cycleId),
      sql(data.milestoneId),
      sql(data.dueDate),
      sql(data.estimate),
      sql(data.parentId),
      sql(data.recurringRule),
      sql(data.externalUrl),
      stamp,
      stamp,
    );
    const issueId = lastInsertId(database);
    for (const label of array(data.labelIds))
      run(
        database,
        "INSERT OR IGNORE INTO issue_labels(issue_id,label_id) VALUES(?,?)",
        issueId,
        sql(label),
      );
    run(
      database,
      "INSERT OR IGNORE INTO issue_subscribers(issue_id,member_id) VALUES(?,?)",
      issueId,
      actor,
    );
    for (const subscriber of array(data.subscriberIds))
      run(
        database,
        "INSERT OR IGNORE INTO issue_subscribers VALUES(?,?)",
        issueId,
        sql(subscriber),
      );
    event(database, "issue", issueId, actor, "created", {
      title,
      status: String(status.name),
    });
    runAutomations(database, teamId, issueId, "issue.created", actor);
    return { issue: issueRow(database, issueId) as JsonValue, _status: 201 };
  }
  const base = route.match(/^\/api\/issues\/([^/]+)$/);
  if (base && ["PUT", "PATCH"].includes(method)) {
    const current = one(
      database,
      "SELECT * FROM issues WHERE identifier=?",
      base[1]!,
    );
    if (!current) fail("Issue not found");
    const issueId = Number(current.id);
    const targetTeam = Number(data.teamId ?? current.team_id);
    validateIssueLinks(database, data, current);
    const oldCategory = String(
      scalar(
        database,
        "SELECT category FROM issue_statuses WHERE id=?",
        sql(current.status_id),
      ),
    );
    const changes: Record<string, unknown> = {};
    const map = {
      title: "title",
      description: "description",
      assigneeId: "assignee_id",
      projectId: "project_id",
      cycleId: "cycle_id",
      milestoneId: "milestone_id",
      dueDate: "due_date",
      estimate: "estimate",
      parentId: "parent_id",
      recurringRule: "recurring_rule",
      externalUrl: "external_url",
    };
    for (const [key, column] of Object.entries(map))
      if (key in data) changes[column] = data[key];
    if ("priority" in data) changes.priority = priorityNumber(data.priority);
    if ("status" in data)
      changes.status_id = issueStatus(
        database,
        targetTeam,
        String(data.status),
      ).id;
    if ("teamId" in data) {
      if (!one(database, "SELECT id FROM teams WHERE id=?", targetTeam))
        fail("Team not found");
      changes.team_id = targetTeam;
      if (!("status" in data)) {
        const name = scalar(
          database,
          "SELECT name FROM issue_statuses WHERE id=?",
          sql(current.status_id),
        );
        changes.status_id = (
          one(
            database,
            "SELECT id FROM issue_statuses WHERE team_id=? AND name=?",
            targetTeam,
            sql(name),
          ) ?? issueStatus(database, targetTeam)
        ).id;
      }
    }
    updateColumns(database, "issues", "id", issueId, {
      ...changes,
      updated_at: stamp,
    });
    if ("labelIds" in data)
      replaceLinks(
        database,
        "issue_labels",
        "issue_id",
        issueId,
        "label_id",
        array(data.labelIds),
      );
    if ("subscriberIds" in data)
      replaceLinks(
        database,
        "issue_subscribers",
        "issue_id",
        issueId,
        "member_id",
        array(data.subscriberIds),
      );
    const changed = Object.fromEntries(
      Object.keys(data)
        .filter(
          (key) =>
            key in map ||
            [
              "priority",
              "status",
              "teamId",
              "labelIds",
              "subscriberIds",
            ].includes(key),
        )
        .map((key) => [key, data[key]!]),
    ) as JsonObject;
    event(database, "issue", issueId, actor, "updated", changed);
    runAutomations(database, targetTeam, issueId, "issue.updated", actor);
    const newCategory = String(
      scalar(
        database,
        "SELECT s.category FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.id=?",
        issueId,
      ),
    );
    if (oldCategory !== "Completed" && newCategory === "Completed")
      runAutomations(database, targetTeam, issueId, "issue.completed", actor);
    return { issue: issueRow(database, issueId) as JsonValue };
  }
  if (base && method === "DELETE") {
    const row = one(
      database,
      "SELECT id FROM issues WHERE identifier=?",
      base[1]!,
    );
    if (!row) fail("Issue not found");
    run(
      database,
      "UPDATE issues SET archived=1,updated_at=? WHERE id=?",
      stamp,
      sql(row.id),
    );
    event(database, "issue", Number(row.id), actor, "archived", {});
    return { ok: true };
  }
  const action = route.match(
    /^\/api\/issues\/([^/]+)\/(restore|comments|attachments|relations)$/,
  );
  if (!action) return null;
  const issue = one(
    database,
    "SELECT id FROM issues WHERE identifier=?",
    action[1]!,
  );
  if (!issue) fail("Issue not found");
  const issueId = Number(issue.id);
  if (action[2] === "restore" && method === "POST") {
    run(
      database,
      "UPDATE issues SET archived=0,updated_at=? WHERE id=?",
      stamp,
      issueId,
    );
    event(database, "issue", issueId, actor, "restored", {});
    return { ok: true };
  }
  if (action[2] === "comments" && method === "POST") {
    const body = text(data.body, "Comment is required");
    run(
      database,
      "INSERT INTO comments(issue_id,author_id,body,created_at) VALUES(?,?,?,?)",
      issueId,
      actor,
      body,
      stamp,
    );
    event(database, "issue", issueId, actor, "commented", {
      body: body.slice(0, 120),
    });
    return { issue: issueRow(database, issueId) as JsonValue, _status: 201 };
  }
  if (action[2] === "relations" && method === "POST") {
    const relatedIdentifier = data.relatedIssueId;
    const url = data.url;
    if (!relatedIdentifier && !url) fail("Choose an issue or provide a URL");
    let related: null | number = null;
    if (relatedIdentifier) {
      const found = one(
        database,
        "SELECT id FROM issues WHERE identifier=?",
        sql(relatedIdentifier),
      );
      if (!found) fail("Related issue not found");
      related = Number(found.id);
    }
    run(
      database,
      "INSERT INTO issue_relations(issue_id,related_issue_id,relation_type,url) VALUES(?,?,?,?)",
      issueId,
      related,
      sql(data.type ?? "relates to"),
      sql(url),
    );
    event(database, "issue", issueId, actor, "linked", {
      relation: (relatedIdentifier ?? url) as JsonValue,
    });
    return { issue: issueRow(database, issueId) as JsonValue, _status: 201 };
  }
  if (action[2] === "attachments" && method === "POST")
    return attachFiles(database, issueId, data, stamp, actor, paths);
  return null;
}

function attachFiles(
  database: Database,
  issueId: number,
  data: JsonObject,
  stamp: string,
  actor: number,
  paths: StoragePaths,
): MutationResult {
  const files = array(data.files);
  if (!files.length) fail("Choose at least one attachment");
  fs.mkdirSync(paths.attachmentsDirectory, { recursive: true });
  let total = 0;
  const created: JsonObject[] = [];
  for (const raw of files) {
    const item = raw as JsonObject;
    const name =
      path
        .basename(String(item.name ?? "attachment"))
        .trim()
        .slice(0, 180) || "attachment";
    let content: Buffer;
    try {
      content = Buffer.from(
        String(item.data ?? "")
          .split(",")
          .at(-1) ?? "",
        "base64",
      );
    } catch {
      fail("Attachment data is invalid");
    }
    total += content.length;
    if (!content.length) fail("Empty files cannot be attached");
    if (content.length > 3_000_000 || total > 3_000_000)
      fail("Attachments must total 3 MB or less");
    const storageName = randomUUID().replaceAll("-", "");
    fs.writeFileSync(
      path.join(paths.attachmentsDirectory, storageName),
      content,
    );
    const contentType = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(
      String(item.type ?? ""),
    )
      ? String(item.type)
      : "application/octet-stream";
    run(
      database,
      "INSERT INTO issue_attachments(issue_id,name,content_type,size,storage_name,created_at) VALUES(?,?,?,?,?,?)",
      issueId,
      name,
      contentType,
      content.length,
      storageName,
      stamp,
    );
    created.push({ id: lastInsertId(database), name });
  }
  event(database, "issue", issueId, actor, "attachments_added", {
    count: created.length,
  });
  return { attachments: created, _status: 201 };
}

function validateIssueLinks(
  database: Database,
  data: JsonObject,
  current: Row = {},
) {
  const teamId = Number(data.teamId ?? current.team_id ?? 1);
  const projectId = data.projectId ?? current.project_id;
  if (
    projectId != null &&
    !one(
      database,
      "SELECT 1 FROM project_teams WHERE project_id=? AND team_id=?",
      sql(projectId),
      teamId,
    )
  )
    fail("Add this team to the project before linking its issues");
  const cycle = data.cycleId ?? current.cycle_id;
  if (cycle != null) {
    const row = one(
      database,
      "SELECT team_id FROM cycles WHERE id=?",
      sql(cycle),
    );
    if (!row || Number(row.team_id) !== teamId)
      fail("Issue cycle must belong to its team");
  }
  const milestone = data.milestoneId ?? current.milestone_id;
  if (milestone != null) {
    const row = one(
      database,
      "SELECT project_id FROM milestones WHERE id=?",
      sql(milestone),
    );
    if (!row || row.project_id !== projectId)
      fail("Issue milestone must belong to its project");
  }
  let parent = data.parentId ?? current.parent_id;
  const seen = new Set<number>(current.id ? [Number(current.id)] : []);
  while (parent != null) {
    if (seen.has(Number(parent)))
      fail("Issue parent links must not form a cycle");
    seen.add(Number(parent));
    const row = one(
      database,
      "SELECT parent_id FROM issues WHERE id=?",
      sql(parent),
    );
    if (!row) fail("Parent issue not found");
    parent = row.parent_id;
  }
}
function nextIssueNumber(
  database: Database,
  teamId: number,
  key: string,
): number {
  return Number(
    scalar(
      database,
      "SELECT COALESCE(MAX(number),0)+1 FROM issues WHERE team_id=? OR substr(identifier,1,?)=?",
      teamId,
      key.length + 1,
      `${key}-`,
    ),
  );
}
function issueStatus(database: Database, teamId: number, name?: string): Row {
  const row =
    name === undefined
      ? one(
          database,
          "SELECT id,name FROM issue_statuses WHERE team_id=? AND is_default=1 ORDER BY position,id LIMIT 1",
          teamId,
        )
      : one(
          database,
          "SELECT id,name FROM issue_statuses WHERE team_id=? AND name=? ORDER BY position,id LIMIT 1",
          teamId,
          name,
        );
  if (!row)
    fail(
      name === undefined
        ? "Team has no default workflow status"
        : "Unknown workflow status",
    );
  return row;
}
