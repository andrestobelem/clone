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
import { issueStatuses, priorities, schema } from "./schema.js";
import type { JsonObject, JsonValue, Row, StoragePaths } from "./types.js";
import { mutationPayload } from "./validation.js";

export interface MutationResult extends JsonObject {
  _status?: number;
}

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function initializeSchema(database: Database): void {
  database.exec(schema);
}

export function createMemberActors(database: Database): void {
  database.exec(`INSERT INTO actors(id,kind,name,active,member_id,avatar_color,created_at)
    SELECT id,'member',name,active,id,avatar_color,created_at FROM members`);
}

export function seedEmpty(database: Database): void {
  initializeSchema(database);
  if (scalar(database, "SELECT COUNT(*) FROM workspace")) return;
  const stamp = now();
  run(
    database,
    "INSERT INTO workspace(id,name,icon,created_at) VALUES(1,?,?,?)",
    "My Workspace",
    "M",
    stamp,
  );
  run(
    database,
    "INSERT INTO members(id,name,email,role,avatar_color,created_at) VALUES(1,?,?,?,?,?)",
    "Local User",
    "local@clone.local",
    "Workspace admin",
    "#88a8ce",
    stamp,
  );
  createMemberActors(database);
  updateSetting(database, "preferences", {
    defaultHome: "Issues",
    theme: "Light",
    sidebar: {},
  });
  updateSetting(database, "workspace", {
    name: "My Workspace",
    timezone: "UTC",
    issueIdentifier: "ISS",
    inviteDomain: null,
  });
}

export function seedDemo(database: Database): void {
  initializeSchema(database);
  if (scalar(database, "SELECT COUNT(*) FROM workspace")) return;
  const stamp = now();
  run(
    database,
    "INSERT INTO workspace(id,name,icon,created_at) VALUES(1,?,?,?)",
    "Acme Studio",
    "A",
    stamp,
  );
  const people = [
    [1, "Alex Morgan", "alex@acme.local", "Workspace admin", "#cda58f"],
    [2, "Maya Chen", "maya@acme.local", "Member", "#ac95d4"],
    [3, "Sam Rivera", "sam@acme.local", "Member", "#79a99b"],
    [4, "Jordan Lee", "jordan@acme.local", "Member", "#d79da5"],
    [5, "Taylor Kim", "taylor@acme.local", "Member", "#88a8ce"],
  ] as const;
  for (const person of people) {
    run(
      database,
      "INSERT INTO members(id,name,email,role,avatar_color,created_at) VALUES(?,?,?,?,?,?)",
      ...person,
      stamp,
    );
  }
  createMemberActors(database);
  run(
    database,
    "INSERT INTO teams(id,name,key,description,icon,created_at) VALUES(1,'Product','PRO','Build a product people love.','✳',?)",
    stamp,
  );
  run(
    database,
    "INSERT INTO teams(id,name,key,description,icon,created_at) VALUES(2,'Design','DSN','Shape a clear, considered experience.','◇',?)",
    stamp,
  );
  for (const [teamId, memberId, role] of [
    [1, 1, "Lead"],
    [1, 2, "Member"],
    [1, 3, "Member"],
    [1, 4, "Member"],
    [2, 1, "Lead"],
    [2, 2, "Member"],
    [2, 4, "Member"],
    [2, 5, "Member"],
  ] as const) {
    run(
      database,
      "INSERT INTO team_members(team_id,member_id,role) VALUES(?,?,?)",
      teamId,
      memberId,
      role,
    );
  }
  const colors: Record<string, string> = {
    Backlog: "#a3a3ad",
    Todo: "#6e9dd5",
    "In Progress": "#8584dd",
    "In Review": "#b881d2",
    Done: "#54b58b",
    Canceled: "#8b8b93",
    Duplicate: "#8b8b93",
  };
  for (const teamId of [1, 2]) {
    issueStatuses.forEach(([name, category], position) =>
      run(
        database,
        "INSERT INTO issue_statuses(team_id,name,category,position,color,is_default) VALUES(?,?,?,?,?,?)",
        teamId,
        name,
        category,
        position,
        colors[name]!,
        name === "Backlog" ? 1 : 0,
      ),
    );
  }
  seedDemoContent(database, stamp);
}

function seedDemoContent(database: Database, stamp: string): void {
  const labels = [
    [1, "Feature", "#7c78d8", 1],
    [2, "Bug", "#d96c68", 1],
    [3, "Improvement", "#6394d4", 1],
    [4, "Design", "#c27ad2", 1],
    [5, "Urgent", "#e3a74f", 1],
    [6, "Accessibility", "#58a88d", 1],
    [7, "Frontend", "#7496d4", 1],
    [8, "Research", "#c58e58", 2],
  ] as const;
  for (const item of labels)
    run(
      database,
      "INSERT INTO labels(id,name,color,team_id) VALUES(?,?,?,?)",
      ...item,
    );
  const cycles = [
    [1, 1, "Cycle 24", "2026-10-24", "2026-11-07", "Active", 24],
    [2, 1, "Cycle 25", "2026-11-07", "2026-11-21", "Upcoming", 24],
    [3, 2, "Design cycle 12", "2026-10-28", "2026-11-11", "Active", 18],
  ] as const;
  for (const item of cycles)
    run(
      database,
      "INSERT INTO cycles(id,team_id,name,starts_at,ends_at,status,capacity,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ...item,
      stamp,
    );
  const projects = [
    [
      1,
      "Workspace foundations",
      "Make everyday project work feel fast and clear.",
      "Improve the core planning experience for teams.",
      "In Progress",
      2,
      "◈",
      1,
      "2026-09-15",
      "2026-10-18",
    ],
    [
      2,
      "Spring product launch",
      "Bring the next version of Acme to every team.",
      "Prepare the product launch across product and design.",
      "In Progress",
      1,
      "✳",
      1,
      "2026-09-20",
      "2026-11-02",
    ],
    [
      3,
      "Design system refresh",
      "A sharper, more consistent UI across the product.",
      "Refresh components, tokens, and documentation.",
      "Planned",
      3,
      "⬡",
      4,
      "2026-10-05",
      "2026-12-01",
    ],
  ] as const;
  for (const item of projects)
    run(
      database,
      "INSERT INTO projects(id,name,summary,description,status,priority,icon,lead_id,start_date,target_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ...item,
      stamp,
      stamp,
    );
  for (const item of [
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
    [3, 2],
  ] as const)
    run(
      database,
      "INSERT INTO project_teams(project_id,team_id) VALUES(?,?)",
      ...item,
    );
  for (const item of [
    [1, 1],
    [1, 2],
    [1, 3],
    [2, 1],
    [2, 2],
    [2, 4],
    [3, 4],
    [3, 5],
  ] as const)
    run(
      database,
      "INSERT INTO project_members(project_id,member_id) VALUES(?,?)",
      ...item,
    );
  run(
    database,
    "INSERT INTO project_dependencies(project_id,depends_on_id,dependency_type) VALUES(2,1,'blocks')",
  );
  const milestones = [
    [1, 1, "Prototype review", "2026-10-04", "Done", 0],
    [2, 1, "Team beta", "2026-10-12", "In Progress", 1],
    [3, 1, "General availability", "2026-10-18", "Todo", 2],
    [4, 2, "Launch readiness", "2026-10-22", "Todo", 0],
    [5, 3, "Token audit", "2026-10-20", "Todo", 0],
  ] as const;
  for (const item of milestones)
    run(
      database,
      "INSERT INTO milestones(id,project_id,name,due_date,status,position) VALUES(?,?,?,?,?,?)",
      ...item,
    );
  const issueData = [
    [
      248,
      1,
      "Add keyboard shortcuts to command menu",
      "Make command navigation available without leaving the keyboard.",
      "In Progress",
      0,
      1,
      2,
      1,
      1,
      "2026-10-05",
      3,
    ],
    [
      246,
      1,
      "Support custom issue labels",
      "Let teams add, color, and filter their own labels.",
      "In Progress",
      1,
      2,
      1,
      1,
      1,
      "2026-10-08",
      5,
    ],
    [
      241,
      1,
      "Fix layout shift on the project overview",
      "Prevent cards jumping while progress data loads.",
      "In Progress",
      2,
      4,
      1,
      1,
      1,
      "2026-10-09",
      2,
    ],
    [
      239,
      1,
      "Add a compact sidebar density option",
      "Offer a narrower navigation layout.",
      "Todo",
      1,
      3,
      1,
      1,
      2,
      "2026-10-12",
      null,
    ],
    [
      237,
      1,
      "Remember the last selected team view",
      "Restore the last active view on the next visit.",
      "Todo",
      2,
      1,
      1,
      1,
      2,
      null,
      2,
    ],
    [
      232,
      2,
      "Improve keyboard focus in issue details",
      "Keep focus visible when navigating issue properties.",
      "Backlog",
      3,
      2,
      1,
      3,
      3,
      null,
      null,
    ],
    [
      229,
      2,
      "Create project update templates",
      "Start project updates from reusable templates.",
      "Backlog",
      4,
      3,
      1,
      2,
      3,
      null,
      null,
    ],
    [
      226,
      2,
      "Polish empty states across the workspace",
      "Add helpful next steps to empty product views.",
      "Done",
      2,
      4,
      1,
      1,
      3,
      null,
      null,
    ],
    [
      218,
      2,
      "Document color token usage",
      "Record accessibility contrast constraints for the palette.",
      "In Review",
      3,
      5,
      2,
      3,
      3,
      "2026-10-14",
      null,
    ],
    [
      216,
      1,
      "Add keyboard shortcuts help panel",
      "Show discoverable shortcuts from the help menu.",
      "Backlog",
      4,
      1,
      1,
      null,
      2,
      null,
      null,
    ],
    [
      95,
      2,
      "Audit empty state illustrations",
      "Review illustration consistency across feature areas.",
      "Todo",
      3,
      4,
      2,
      3,
      3,
      "2026-10-16",
      null,
    ],
    [
      93,
      1,
      "Add issue dependency indicators",
      "Show blocked-by relationships in list and detail views.",
      "Backlog",
      2,
      2,
      1,
      1,
      2,
      null,
      3,
    ],
  ] as const;
  for (const item of issueData) {
    const [
      number,
      team,
      title,
      description,
      status,
      priority,
      assignee,
      creator,
      project,
      cycle,
      due,
      estimate,
    ] = item;
    const statusId = scalar(
      database,
      "SELECT id FROM issue_statuses WHERE team_id=? AND name=?",
      team,
      status,
    );
    run(
      database,
      "INSERT INTO issues(identifier,number,team_id,title,description,status_id,priority,assignee_id,creator_id,project_id,cycle_id,due_date,estimate,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      `${team === 1 ? "PRO" : "DSN"}-${number}`,
      number,
      team,
      title,
      description,
      sql(statusId),
      priority,
      assignee,
      creator,
      project,
      cycle,
      due,
      estimate,
      stamp,
      stamp,
    );
  }
  const issueId = (identifier: string) =>
    Number(
      scalar(database, "SELECT id FROM issues WHERE identifier=?", identifier),
    );
  const issueLabels: Record<string, number[]> = {
    "PRO-248": [1, 7],
    "PRO-246": [1],
    "PRO-241": [2, 7],
    "PRO-239": [3],
    "DSN-232": [6],
    "DSN-218": [4, 8],
    "DSN-95": [4],
  };
  for (const [identifier, labelIds] of Object.entries(issueLabels))
    for (const labelId of labelIds)
      run(
        database,
        "INSERT INTO issue_labels(issue_id,label_id) VALUES(?,?)",
        issueId(identifier),
        labelId,
      );
  for (const item of [
    ["PRO-248", 1],
    ["PRO-248", 2],
    ["PRO-246", 1],
    ["DSN-218", 1],
  ] as const)
    run(
      database,
      "INSERT INTO issue_subscribers(issue_id,member_id) VALUES(?,?)",
      issueId(item[0]),
      item[1],
    );
  run(
    database,
    "INSERT INTO issue_relations(issue_id,related_issue_id,relation_type) VALUES(?,?,?)",
    issueId("PRO-241"),
    issueId("PRO-93"),
    "blocked by",
  );
  run(
    database,
    "INSERT INTO issue_relations(issue_id,related_issue_id,relation_type) VALUES(?,?,?)",
    issueId("PRO-248"),
    issueId("PRO-216"),
    "relates to",
  );
  run(
    database,
    "INSERT INTO comments(issue_id,author_id,body,created_at) VALUES(?,?,?,?)",
    issueId("PRO-248"),
    2,
    "I drafted the shortcut map; we can review the final keys with the team.",
    stamp,
  );
  run(
    database,
    "INSERT INTO team_resources(team_id,section,title,url) VALUES(1,'Resources','Product principles','https://example.local/principles')",
  );
  const notifications = [
    [
      1,
      1,
      "comment",
      "Maya commented on PRO-248",
      "I drafted the shortcut map; we can review the final keys with the team.",
      "issue",
      issueId("PRO-248"),
      0,
    ],
    [
      2,
      1,
      "assignment",
      "PRO-237 was assigned to you",
      "Remember the last selected team view",
      "issue",
      issueId("PRO-237"),
      0,
    ],
    [
      3,
      1,
      "project_update",
      "Workspace foundations update",
      "Prototype review is complete. The team beta is next.",
      "project",
      1,
      1,
    ],
    [
      4,
      2,
      "mention",
      "Alex mentioned you in PRO-246",
      "Can you review the labels proposal?",
      "issue",
      issueId("PRO-246"),
      0,
    ],
  ] as const;
  for (const item of notifications)
    run(
      database,
      "INSERT INTO notifications(id,recipient_id,kind,title,body,entity_type,entity_id,is_read,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ...item,
      stamp,
    );
  const views = [
    [
      1,
      "All issues",
      "Everything in the Product team",
      "◈",
      "issues",
      "Team",
      null,
      1,
      { status: "all" },
      { layout: "List", groupBy: "Status", orderBy: "Priority" },
      1,
    ],
    [
      2,
      "My open issues",
      "Assigned to Alex and not completed",
      "◎",
      "issues",
      "Personal",
      1,
      1,
      { assignee: "Alex Morgan", completed: false },
      { layout: "List", groupBy: "Status", orderBy: "Updated" },
      1,
    ],
    [
      3,
      "Project tracking",
      "Active project delivery",
      "✳",
      "projects",
      "Workspace",
      null,
      null,
      { status: "In Progress" },
      { layout: "Board", groupBy: "Status", orderBy: "Target date" },
      0,
    ],
  ] as const;
  for (const item of views) {
    const [
      id,
      name,
      description,
      icon,
      entity,
      scope,
      owner,
      team,
      filters,
      display,
      favorite,
    ] = item;
    run(
      database,
      "INSERT INTO views(id,name,description,icon,entity,scope,owner_id,team_id,filters_json,display_json,is_favorite,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      name,
      description,
      icon,
      entity,
      scope,
      owner,
      team,
      JSON.stringify(filters),
      JSON.stringify(display),
      favorite,
      stamp,
      stamp,
    );
  }
  const settings = {
    preferences: {
      defaultHome: "Issues",
      displayNames: "Full name",
      firstDayOfWeek: "Monday",
      commentSubmit: "Enter",
      fontSize: "Default",
      theme: "Light",
      spelling: true,
      autoAssignToSelf: false,
      sidebar: { Inbox: true, "My issues": true, Projects: true, Views: true },
      orderCompletedByRecency: false,
    },
    workspace: {
      name: "Acme Studio",
      timezone: "America/Argentina/Buenos_Aires",
      issueIdentifier: "PRO",
      inviteDomain: null,
    },
    integrations: [
      { name: "GitHub", connected: false },
      { name: "Slack", connected: false },
    ],
    featureFlags: {
      cycles: true,
      triage: true,
      automations: true,
      customerRequests: false,
      releases: true,
      initiatives: true,
      pulse: false,
      asks: false,
    },
  };
  for (const [key, value] of Object.entries(settings))
    updateSetting(database, key, value);
  const nextRun = new Date(Date.now() + 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  run(
    database,
    "INSERT INTO recurring_rules(team_id,title,description,cadence,next_run,enabled,created_at) VALUES(1,?,?,?,?,1,?)",
    "Weekly planning reminder",
    "Review open issues before cycle planning.",
    "Weekly",
    nextRun,
    stamp,
  );
  run(
    database,
    "INSERT INTO automations(team_id,name,trigger_json,condition_json,action_json,enabled,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?)",
    "Assign urgent bugs",
    JSON.stringify({ event: "issue.created" }),
    JSON.stringify({ label: "Bug", priority: "Urgent" }),
    JSON.stringify({ assignTo: 1 }),
    stamp,
    stamp,
  );
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

export function issueRow(
  database: Database,
  issueId: number,
): Record<string, unknown> | null {
  const result = one(
    database,
    `SELECT i.*,t.name AS team_name,t.key AS team_key,s.name AS status,s.category AS status_category,s.color AS status_color,
    CASE WHEN a.kind='agent' THEN a.name||' (Agent)' ELSE a.name END AS assignee,(SELECT email FROM members WHERE id=a.member_id) AS assignee_email,a.avatar_color AS assignee_color,a.kind AS assignee_kind,c.kind AS creator_kind,CASE WHEN c.kind='agent' THEN c.name||' (Agent)' ELSE c.name END AS creator,
    p.name AS project,cy.name AS cycle,m.name AS milestone
    FROM issues i JOIN teams t ON t.id=i.team_id JOIN issue_statuses s ON s.id=i.status_id
    LEFT JOIN actors a ON a.id=i.assignee_id LEFT JOIN actors c ON c.id=i.creator_id
    LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN cycles cy ON cy.id=i.cycle_id LEFT JOIN milestones m ON m.id=i.milestone_id
    WHERE i.id=?`,
    issueId,
  );
  if (!result) return null;
  const output: Record<string, unknown> = {
    ...result,
    priority_name: priorities[Number(result.priority)],
  };
  output.labels = rows(
    database,
    "SELECT l.id,l.name,l.color FROM labels l JOIN issue_labels il ON il.label_id=l.id WHERE il.issue_id=?",
    issueId,
  );
  output.subscribers = rows(
    database,
    "SELECT member_id FROM issue_subscribers WHERE issue_id=?",
    issueId,
  ).map((row) => actorRecord(database, Number(row.member_id)));
  output.comments = rows(
    database,
    "SELECT c.id,c.body,c.created_at,m.id AS author_id,CASE WHEN m.kind='agent' THEN m.name||' (Agent)' ELSE m.name END AS author,m.avatar_color FROM comments c JOIN actors m ON m.id=c.author_id WHERE c.issue_id=? ORDER BY c.id",
    issueId,
  );
  output.attachments = rows(
    database,
    "SELECT id,name,content_type,size,created_at FROM issue_attachments WHERE issue_id=? ORDER BY id",
    issueId,
  );
  output.relations = rows(
    database,
    "SELECT r.id,r.relation_type,r.url,i.identifier AS related_identifier,i.title AS related_title FROM issue_relations r LEFT JOIN issues i ON i.id=r.related_issue_id WHERE r.issue_id=?",
    issueId,
  );
  output.subissues = rows(
    database,
    "SELECT id,identifier,title,status_id FROM issues WHERE parent_id=? AND archived=0",
    issueId,
  );
  output.status_changed_at = result.created_at;
  let statusFound = false;
  output.activity = rows(
    database,
    "SELECT e.*,CASE WHEN m.kind='agent' THEN m.name||' (Agent)' ELSE m.name END AS actor FROM activity_events e LEFT JOIN actors m ON m.id=e.actor_id WHERE e.entity_type='issue' AND e.entity_id=? ORDER BY e.created_at DESC,e.id DESC",
    issueId,
  ).map((entry) => {
    const payload = parseJson(entry.payload, {}) as Record<string, unknown>;
    if (
      !statusFound &&
      ("status" in payload ||
        (Array.isArray(payload.changes) &&
          payload.changes.some(
            (change) => isObject(change) && change.field === "status_id",
          )))
    ) {
      output.status_changed_at = entry.created_at;
      statusFound = true;
    }
    return { ...entry, payload };
  });
  return output;
}

export function bootstrap(
  database: Database,
  currentActor = 1,
): Record<string, unknown> {
  const workspace = one(database, "SELECT * FROM workspace LIMIT 1") ?? {};
  const teams = rows(database, "SELECT * FROM teams ORDER BY id").map(
    (team) => ({
      ...team,
      members: rows(
        database,
        "SELECT member_id FROM team_members WHERE team_id=?",
        sql(team.id),
      ).map((row) => actorRecord(database, Number(row.member_id))),
      statuses: rows(
        database,
        "SELECT * FROM issue_statuses WHERE team_id=? ORDER BY position",
        sql(team.id),
      ),
      resources: rows(
        database,
        "SELECT * FROM team_resources WHERE team_id=? ORDER BY section,id",
        sql(team.id),
      ),
    }),
  );
  const projects = rows(
    database,
    "SELECT * FROM projects WHERE archived=0 ORDER BY id DESC",
  ).map((project) => projectRecord(database, project));
  const issues = rows(
    database,
    "SELECT id FROM issues WHERE archived=0 ORDER BY number DESC",
  ).map((row) => issueRow(database, Number(row.id)));
  const views = rows(
    database,
    "SELECT * FROM views ORDER BY is_favorite DESC,updated_at DESC",
  ).map(({ filters_json, display_json, ...view }) => ({
    ...view,
    filters: parseJson(filters_json, {}),
    display: parseJson(display_json, {}),
  }));
  const cycles = rows(
    database,
    "SELECT c.*,t.name AS team_name,t.key FROM cycles c JOIN teams t ON t.id=c.team_id ORDER BY c.starts_at DESC",
  ).map((cycle) => cycleRecord(database, cycle));
  const settings = Object.fromEntries(
    rows(database, "SELECT * FROM app_settings").map((row) => [
      String(row.key),
      parseJson(row.value_json, {}),
    ]),
  );
  return {
    workspace,
    teams,
    members: rows(
      database,
      "SELECT * FROM members WHERE active=1 ORDER BY name",
    ),
    issues,
    projects,
    views,
    notifications: rows(
      database,
      "SELECT * FROM notifications WHERE archived=0 AND recipient_id=? ORDER BY created_at DESC",
      currentActor,
    ),
    cycles,
    statuses: rows(
      database,
      "SELECT * FROM issue_statuses ORDER BY team_id,position",
    ),
    labels: rows(database, "SELECT * FROM labels ORDER BY name"),
    recurring: rows(database, "SELECT * FROM recurring_rules ORDER BY id"),
    automations: rows(database, "SELECT * FROM automations ORDER BY id"),
    archives: {
      issues: rows(
        database,
        "SELECT id FROM issues WHERE archived=1 ORDER BY updated_at DESC",
      ).map((row) => issueRow(database, Number(row.id))),
      projects: rows(
        database,
        "SELECT id,name,summary,status,updated_at FROM projects WHERE archived=1 ORDER BY updated_at DESC",
      ),
    },
    settings,
    currentMemberId: 1,
    currentActorId: currentActor,
    actors: actorRecords(database, null, true),
  };
}

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
    mutateIssue(database, method, route, data, stamp, actor, paths) ??
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

function mutateTeam(
  database: Database,
  method: string,
  route: string,
  data: JsonObject,
  stamp: string,
  actor: number,
): MutationResult | null {
  if (route === "/api/teams" && method === "POST") {
    const name = text(data.name, "Team name is required");
    const key = String(data.key ?? name.slice(0, 3))
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 5);
    if (!key) fail("Team key must contain letters or digits");
    run(
      database,
      "INSERT INTO teams(name,key,description,icon,created_at) VALUES(?,?,?,?,?)",
      name,
      key,
      sql(data.description ?? ""),
      sql(data.icon ?? "✳"),
      stamp,
    );
    const teamId = lastInsertId(database);
    run(
      database,
      "INSERT INTO team_members(team_id,member_id,role) VALUES(?,?,'Lead')",
      teamId,
      actor,
    );
    for (const participant of array(data.memberIds))
      run(
        database,
        "INSERT OR IGNORE INTO team_members(team_id,member_id) VALUES(?,?)",
        teamId,
        sql(participant),
      );
    issueStatuses.forEach(([status, category], position) =>
      run(
        database,
        "INSERT INTO issue_statuses(team_id,name,category,position,color,is_default) VALUES(?,?,?,?,?,?)",
        teamId,
        status,
        category,
        position,
        "#8e8e98",
        status === "Backlog" ? 1 : 0,
      ),
    );
    return { teamId, _status: 201 };
  }
  if (route === "/api/statuses" && method === "POST") {
    const teamId = Number(data.teamId ?? 1);
    const name = text(data.name, "Status name is required");
    const position = Number(
      scalar(
        database,
        "SELECT COALESCE(MAX(position),-1)+1 FROM issue_statuses WHERE team_id=?",
        teamId,
      ),
    );
    run(
      database,
      "INSERT INTO issue_statuses(team_id,name,category,position,color) VALUES(?,?,?,?,?)",
      teamId,
      name,
      sql(data.category ?? "Unstarted"),
      position,
      sql(data.color ?? "#8989a1"),
    );
    return { statusId: lastInsertId(database), _status: 201 };
  }
  if (route === "/api/labels" && method === "POST") {
    run(
      database,
      "INSERT INTO labels(name,color,team_id) VALUES(?,?,?)",
      text(data.name, "Label name is required"),
      sql(data.color ?? "#8585cc"),
      sql(data.teamId ?? 1),
    );
    return { labelId: lastInsertId(database), _status: 201 };
  }
  const team = route.match(/^\/api\/teams\/(\d+)$/);
  if (team && ["PUT", "PATCH"].includes(method)) {
    const teamId = Number(team[1]);
    if (!one(database, "SELECT id FROM teams WHERE id=?", teamId))
      fail("Team not found");
    updateFields(database, "teams", "id", teamId, data, {
      name: "name",
      description: "description",
      icon: "icon",
      timezone: "timezone",
      estimateType: "estimate_type",
    });
    if ("memberIds" in data)
      replaceLinks(
        database,
        "team_members",
        "team_id",
        teamId,
        "member_id",
        array(data.memberIds),
      );
    return { ok: true };
  }
  const resources = route.match(/^\/api\/teams\/(\d+)\/resources(?:\/(\d+))?$/);
  if (resources && !resources[2] && method === "POST") {
    const url = String(data.url ?? "").trim();
    if (!/^https?:\/\//i.test(url))
      fail("Resource links must start with http:// or https://");
    run(
      database,
      "INSERT INTO team_resources(team_id,section,title,url) VALUES(?,?,?,?)",
      Number(resources[1]),
      String(data.section ?? "Resources").trim() || "Resources",
      text(data.title, "Resource title is required"),
      url,
    );
    return { resourceId: lastInsertId(database), _status: 201 };
  }
  if (resources?.[2] && method === "DELETE") {
    run(
      database,
      "DELETE FROM team_resources WHERE team_id=? AND id=?",
      Number(resources[1]),
      Number(resources[2]),
    );
    return { ok: true };
  }
  return null;
}

function mutateProject(
  database: Database,
  method: string,
  route: string,
  data: JsonObject,
  stamp: string,
  actor: number,
): MutationResult | null {
  if (route === "/api/projects" && method === "POST") {
    const name = text(data.name, "Project name is required");
    run(
      database,
      "INSERT INTO projects(name,summary,description,status,priority,icon,lead_id,start_date,target_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      name,
      sql(data.summary ?? ""),
      sql(data.description ?? ""),
      sql(data.status ?? "Backlog"),
      priorityNumber(data.priority ?? 4),
      sql(data.icon ?? "◈"),
      sql(data.leadId ?? actor),
      sql(data.startDate),
      sql(data.targetDate),
      stamp,
      stamp,
    );
    const projectId = lastInsertId(database);
    for (const teamId of array(data.teamIds, [1]))
      run(
        database,
        "INSERT OR IGNORE INTO project_teams(project_id,team_id) VALUES(?,?)",
        projectId,
        sql(teamId),
      );
    for (const memberId of array(data.memberIds, [actor]))
      run(
        database,
        "INSERT OR IGNORE INTO project_members(project_id,member_id) VALUES(?,?)",
        projectId,
        sql(memberId),
      );
    for (const labelId of array(data.labelIds))
      run(
        database,
        "INSERT OR IGNORE INTO project_labels(project_id,label_id) VALUES(?,?)",
        projectId,
        sql(labelId),
      );
    for (const dependency of array(data.dependencies))
      if (Number(dependency) !== projectId)
        run(
          database,
          "INSERT OR IGNORE INTO project_dependencies(project_id,depends_on_id,dependency_type) VALUES(?,?,'blocks')",
          projectId,
          sql(dependency),
        );
    array(data.milestones).forEach((raw, position) => {
      const item = raw as JsonObject;
      run(
        database,
        "INSERT INTO milestones(project_id,name,due_date,status,position) VALUES(?,?,?,?,?)",
        projectId,
        sql(item.name),
        sql(item.dueDate),
        sql(item.status ?? "Todo"),
        position,
      );
    });
    event(database, "project", projectId, actor, "created", { name });
    return { projectId, _status: 201 };
  }
  const match = route.match(
    /^\/api\/projects\/(\d+)(?:\/(restore|milestones|updates|dependencies))?$/,
  );
  if (!match) return null;
  const projectId = Number(match[1]);
  const action = match[2];
  if (!one(database, "SELECT id FROM projects WHERE id=?", projectId))
    fail("Project not found");
  if (!action && ["PUT", "PATCH"].includes(method)) {
    if ("teamIds" in data) {
      const next = new Set(array(data.teamIds).map(Number));
      if (
        rows(
          database,
          "SELECT DISTINCT team_id FROM issues WHERE project_id=?",
          projectId,
        ).some((row) => !next.has(Number(row.team_id)))
      )
        fail("Move or unlink this project's issues before removing their team");
    }
    const changed = updateFields(
      database,
      "projects",
      "id",
      projectId,
      data,
      {
        name: "name",
        summary: "summary",
        description: "description",
        status: "status",
        icon: "icon",
        leadId: "lead_id",
        startDate: "start_date",
        targetDate: "target_date",
      },
      { priority: priorityNumber },
    );
    if (changed)
      run(
        database,
        "UPDATE projects SET updated_at=? WHERE id=?",
        stamp,
        projectId,
      );
    for (const [key, table, column] of [
      ["teamIds", "project_teams", "team_id"],
      ["memberIds", "project_members", "member_id"],
      ["labelIds", "project_labels", "label_id"],
    ] as const)
      if (key in data)
        replaceLinks(
          database,
          table,
          "project_id",
          projectId,
          column,
          array(data[key]),
        );
    event(database, "project", projectId, actor, "updated", data);
    return { projectId };
  }
  if (!action && method === "DELETE") {
    run(
      database,
      "UPDATE projects SET archived=1,updated_at=? WHERE id=?",
      stamp,
      projectId,
    );
    event(database, "project", projectId, actor, "archived", {});
    return { ok: true };
  }
  if (action === "restore" && method === "POST") {
    run(
      database,
      "UPDATE projects SET archived=0,updated_at=? WHERE id=?",
      stamp,
      projectId,
    );
    event(database, "project", projectId, actor, "restored", {});
    return { ok: true };
  }
  if (action === "milestones" && method === "POST") {
    const name = text(data.name, "Milestone name is required");
    const position = Number(
      scalar(
        database,
        "SELECT COUNT(*) FROM milestones WHERE project_id=?",
        projectId,
      ),
    );
    run(
      database,
      "INSERT INTO milestones(project_id,name,due_date,status,position) VALUES(?,?,?,?,?)",
      projectId,
      name,
      sql(data.dueDate),
      sql(data.status ?? "Todo"),
      position,
    );
    event(database, "project", projectId, actor, "milestone_created", { name });
    return { ok: true, _status: 201 };
  }
  if (action === "updates" && method === "POST") {
    const body = text(data.body, "Write an update before saving");
    const health = String(data.health ?? "On track");
    if (!["On track", "At risk", "Off track"].includes(health))
      fail("Unknown project health");
    run(
      database,
      "INSERT INTO project_updates(project_id,health,body,author_id,created_at) VALUES(?,?,?,?,?)",
      projectId,
      health,
      body,
      actor,
      stamp,
    );
    event(database, "project", projectId, actor, "update_posted", { health });
    return { ok: true, _status: 201 };
  }
  if (action === "dependencies" && method === "POST") {
    const dependency = Number(data.dependsOnId);
    if (projectId === dependency) fail("A project cannot depend on itself");
    run(
      database,
      "INSERT OR IGNORE INTO project_dependencies(project_id,depends_on_id,dependency_type) VALUES(?,?,?)",
      projectId,
      dependency,
      sql(data.type ?? "blocks"),
    );
    event(database, "project", projectId, actor, "dependency_added", {
      dependsOnId: dependency,
    });
    return { ok: true, _status: 201 };
  }
  return null;
}

function mutateIssue(
  database: Database,
  method: string,
  route: string,
  data: JsonObject,
  stamp: string,
  actor: number,
  paths: StoragePaths,
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
    applyAutomations(database, teamId, issueId, "issue.created", actor);
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
    applyAutomations(database, targetTeam, issueId, "issue.updated", actor);
    const newCategory = String(
      scalar(
        database,
        "SELECT s.category FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.id=?",
        issueId,
      ),
    );
    if (oldCategory !== "Completed" && newCategory === "Completed")
      applyAutomations(database, targetTeam, issueId, "issue.completed", actor);
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

export function search(
  database: Database,
  query: string,
  scope = "All",
): { results: Row[] } {
  const trimmed = query.trim();
  if (!trimmed) return { results: [] };
  const like = `%${trimmed}%`;
  const result: Row[] = [];
  if (["All", "Issues"].includes(scope))
    result.push(
      ...rows(
        database,
        "SELECT i.id,i.identifier AS key,i.title,s.name AS status,'Issue' AS type FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.archived=0 AND (i.identifier LIKE ? OR i.title LIKE ? OR i.description LIKE ?) ORDER BY i.updated_at DESC LIMIT 40",
        like,
        like,
        like,
      ),
    );
  if (["All", "Projects"].includes(scope))
    result.push(
      ...rows(
        database,
        "SELECT id,id AS key,name AS title,status,'Project' AS type FROM projects WHERE archived=0 AND (name LIKE ? OR summary LIKE ? OR description LIKE ?) LIMIT 30",
        like,
        like,
        like,
      ),
    );
  return { results: result.slice(0, 80) };
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
function projectRecord(
  database: Database,
  project: Row,
): Record<string, unknown> {
  const id = Number(project.id);
  const statuses = rows(
    database,
    "SELECT status_id,COUNT(*) AS n FROM issues WHERE project_id=? AND archived=0 GROUP BY status_id",
    id,
  );
  const done = new Set(
    rows(
      database,
      "SELECT id FROM issue_statuses WHERE category='Completed'",
    ).map((r) => Number(r.id)),
  );
  const total = statuses.reduce((n, r) => n + Number(r.n), 0);
  const complete = statuses
    .filter((r) => done.has(Number(r.status_id)))
    .reduce((n, r) => n + Number(r.n), 0);
  const milestoneTotal = Number(
    scalar(database, "SELECT COUNT(*) FROM milestones WHERE project_id=?", id),
  );
  const milestoneDone = Number(
    scalar(
      database,
      "SELECT COUNT(*) FROM milestones WHERE project_id=? AND status='Done'",
      id,
    ),
  );
  const parts = [
    total ? complete / total : null,
    milestoneTotal ? milestoneDone / milestoneTotal : null,
  ].filter((v): v is number => v !== null);
  return {
    ...project,
    priority_name: priorities[Number(project.priority)],
    lead: project.lead_id
      ? actorRecord(database, Number(project.lead_id))
      : null,
    teams: rows(
      database,
      "SELECT t.id,t.name,t.key,t.icon FROM teams t JOIN project_teams pt ON pt.team_id=t.id WHERE pt.project_id=?",
      id,
    ),
    members: rows(
      database,
      "SELECT member_id FROM project_members WHERE project_id=?",
      id,
    ).map((r) => actorRecord(database, Number(r.member_id))),
    labels: rows(
      database,
      "SELECT l.id,l.name,l.color FROM labels l JOIN project_labels pl ON pl.label_id=l.id WHERE pl.project_id=?",
      id,
    ),
    milestones: rows(
      database,
      "SELECT * FROM milestones WHERE project_id=? ORDER BY position,id",
      id,
    ),
    updates: rows(
      database,
      "SELECT u.*,CASE WHEN m.kind='agent' THEN m.name||' (Agent)' ELSE m.name END AS author FROM project_updates u LEFT JOIN actors m ON m.id=u.author_id WHERE u.project_id=? ORDER BY u.created_at DESC,u.id DESC",
      id,
    ),
    dependencies: rows(
      database,
      "SELECT d.dependency_type,p.id,p.name FROM project_dependencies d JOIN projects p ON p.id=d.depends_on_id WHERE d.project_id=?",
      id,
    ),
    issue_count: total,
    completed_count: complete,
    milestone_count: milestoneTotal,
    completed_milestones: milestoneDone,
    progress: Math.round(
      (parts.reduce((a, b) => a + b, 0) / (parts.length || 1)) * 100,
    ),
    issues: rows(
      database,
      "SELECT i.id,i.identifier,i.title,s.name AS status,i.priority FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.project_id=? AND i.archived=0 ORDER BY i.updated_at DESC",
      id,
    ),
    activity: rows(
      database,
      "SELECT e.actor_id,e.action,e.payload,e.created_at,CASE WHEN m.kind='agent' THEN m.name||' (Agent)' ELSE m.name END AS actor FROM activity_events e LEFT JOIN actors m ON m.id=e.actor_id WHERE e.entity_type='project' AND e.entity_id=? ORDER BY e.created_at DESC",
      id,
    ),
  };
}
function cycleRecord(database: Database, cycle: Row): Record<string, unknown> {
  const stats = rows(
    database,
    "SELECT s.category,COUNT(*) AS total,COALESCE(SUM(COALESCE(i.estimate,0)),0) AS points FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.cycle_id=? AND i.archived=0 GROUP BY s.category",
    sql(cycle.id),
  );
  const count = stats.reduce((n, r) => n + Number(r.total), 0);
  const complete = stats
    .filter((r) => r.category === "Completed")
    .reduce((n, r) => n + Number(r.total), 0);
  return {
    ...cycle,
    issue_count: count,
    completed_count: complete,
    estimate_points: stats.reduce((n, r) => n + Number(r.points), 0),
    progress: count ? Math.round((complete * 100) / count) : 0,
    issues: rows(
      database,
      "SELECT identifier,title FROM issues WHERE cycle_id=? AND archived=0 ORDER BY number",
      sql(cycle.id),
    ),
  };
}
function event(
  database: Database,
  type: string,
  id: number,
  actor: number,
  action: string,
  payload: JsonObject,
) {
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
function updateSetting(database: Database, key: string, value: JsonValue) {
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
function priorityNumber(value: unknown): number {
  if (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 4)
    return Number(value);
  if (typeof value === "string" && /^\d$/.test(value) && Number(value) <= 4)
    return Number(value);
  const index = priorities.indexOf(value as never);
  if (index < 0) fail("Unknown priority");
  return index;
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
function updateFields(
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
function updateColumns(
  database: Database,
  table: string,
  key: string,
  id: number | string,
  changes: Record<string, unknown>,
) {
  const entries = Object.entries(changes);
  if (!entries.length) return;
  database
    .prepare(
      `UPDATE ${table} SET ${entries.map(([column]) => `${column}=?`).join(",")} WHERE ${key}=?`,
    )
    .run(...entries.map(([, value]) => sql(value)), id);
}
function replaceLinks(
  database: Database,
  table: string,
  key: string,
  id: number,
  column: string,
  values: unknown[],
) {
  run(database, `DELETE FROM ${table} WHERE ${key}=?`, id);
  for (const value of values)
    run(
      database,
      `INSERT OR IGNORE INTO ${table}(${key},${column}) VALUES(?,?)`,
      id,
      sql(value),
    );
}
function text(value: unknown, message: string): string {
  const result = String(value ?? "").trim();
  if (!result) fail(message);
  return result;
}
function array(value: unknown, fallback: unknown[] = []): unknown[] {
  return Array.isArray(value) ? value : fallback;
}
function parseJson(value: unknown, fallback: JsonValue): JsonValue {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return fallback;
  }
}
function withoutActor(data: JsonObject): JsonObject {
  const { actorId: _, ...rest } = data;
  return rest;
}
function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never {
  throw new InvalidInputError(message);
}
