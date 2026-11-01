import { actorRecord } from "./actors.js";
import {
  lastInsertId,
  one,
  rows,
  run,
  scalar,
  sql,
  type Database,
} from "./database.js";
import { priorities } from "./schema.js";
import type { JsonObject, MutationResult, Row } from "./types.js";
import {
  array,
  event,
  fail,
  priorityNumber,
  replaceLinks,
  text,
  updateFields,
} from "./workspace-helpers.js";

export function mutateProject(
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

export function projectRecord(
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
