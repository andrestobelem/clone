import { actorRecord, actorRecords } from "./actors.js";
import { one, rows, scalar, sql, type Database } from "./database.js";
import { priorities } from "./schema.js";
import type { Row } from "./types.js";
import { isObject, parseJson } from "./workspace-helpers.js";

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
