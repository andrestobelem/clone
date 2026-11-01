import { actorRecord, actorRecords } from "./actors.js";
import { one, rows, sql, type Database } from "./database.js";
import { issueRow } from "./issues.js";
import { projectRecord } from "./projects.js";
import { cycleRecord } from "./teams.js";
import type { Row } from "./types.js";
import { parseJson } from "./workspace-helpers.js";

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
