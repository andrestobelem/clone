import { randomUUID } from "node:crypto";

import { run, scalar, sql, type Database } from "./database.js";
import { issueStatuses, schema } from "./schema.js";
import type { JsonValue } from "./types.js";
import { now } from "./time.js";

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
    "INSERT INTO workspace(id,workspace_id,name,icon,created_at) VALUES(1,?,?,?,?)",
    randomUUID(),
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
    "INSERT INTO workspace(id,workspace_id,name,icon,created_at) VALUES(1,?,?,?,?)",
    randomUUID(),
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

function updateSetting(
  database: Database,
  key: string,
  value: JsonValue,
): void {
  run(
    database,
    "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    key,
    JSON.stringify(value),
    now(),
  );
}
