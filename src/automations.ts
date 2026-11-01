import { requireActor } from "./actors.js";
import { one, rows, run, sql, type Database } from "./database.js";
import { priorities } from "./schema.js";
import { now } from "./time.js";
import type { JsonObject } from "./types.js";
import { event, parseJson } from "./workspace-helpers.js";

export function applyAutomations(
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
