import {
  lastInsertId,
  one,
  rows,
  run,
  scalar,
  sql,
  type Database,
} from "./database.js";
import { issueStatuses } from "./schema.js";
import type { JsonObject, MutationResult, Row } from "./types.js";
import {
  array,
  fail,
  replaceLinks,
  text,
  updateFields,
} from "./workspace-helpers.js";

export function mutateTeam(
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

export function cycleRecord(
  database: Database,
  cycle: Row,
): Record<string, unknown> {
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
