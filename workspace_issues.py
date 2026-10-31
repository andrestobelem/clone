"""Issue, comment, attachment, and relation mutations."""

import base64
import mimetypes
import re
import uuid
from pathlib import Path


def mutate_issue(
    con,
    method,
    path,
    data,
    stamp,
    actor,
    *,
    data_dir,
    validate_links,
    next_number,
    find_status,
    priority_number,
    record_event,
    run_automations,
    read_issue,
):
    if path == "/api/issues" and method == "POST":
        title = str(data.get("title", "")).strip()
        if not title:
            raise ValueError("Issue title is required")
        team_id = int(data.get("teamId", 1))
        team = con.execute("SELECT key FROM teams WHERE id=?", (team_id,)).fetchone()
        if not team:
            raise ValueError("Team not found")
        validate_links(con, data)
        number = next_number(con, team_id, team["key"])
        status = find_status(con, team_id, data.get("status"))
        con.execute(
            "INSERT INTO issues(identifier,number,team_id,title,description,status_id,priority,assignee_id,creator_id,project_id,cycle_id,milestone_id,due_date,estimate,parent_id,recurring_rule,external_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                f"{team['key']}-{number}",
                number,
                team_id,
                title,
                str(data.get("description", "")),
                status[0],
                priority_number(data.get("priority", 4)),
                data.get("assigneeId"),
                actor,
                data.get("projectId") or None,
                data.get("cycleId"),
                data.get("milestoneId"),
                data.get("dueDate"),
                data.get("estimate"),
                data.get("parentId"),
                data.get("recurringRule"),
                data.get("externalUrl"),
                stamp,
                stamp,
            ),
        )
        issue_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        for label_id in data.get("labelIds", []):
            con.execute(
                "INSERT OR IGNORE INTO issue_labels(issue_id,label_id) VALUES(?,?)",
                (issue_id, int(label_id)),
            )
        con.execute(
            "INSERT OR IGNORE INTO issue_subscribers(issue_id,member_id) VALUES(?,?)",
            (issue_id, actor),
        )
        for subscriber in data.get("subscriberIds", []):
            con.execute(
                "INSERT OR IGNORE INTO issue_subscribers VALUES(?,?)",
                (issue_id, subscriber),
            )
        record_event(con, "issue", issue_id, actor, "created", {"title": title, "status": status["name"]})
        run_automations(con, team_id, issue_id, "issue.created", actor)
        return {"issue": read_issue(con, issue_id), "_status": 201}

    match = re.fullmatch(r"/api/issues/([^/]+)", path)
    if match and method in ("PUT", "PATCH"):
        row = con.execute("SELECT * FROM issues WHERE identifier=?", (match[1],)).fetchone()
        if not row:
            raise ValueError("Issue not found")
        target_team_id = int(data.get("teamId", row["team_id"]))
        validate_links(con, data, row)
        old_category = con.execute(
            "SELECT category FROM issue_statuses WHERE id=?", (row["status_id"],)
        ).fetchone()[0]
        fields = {
            "title": "title", "description": "description", "priority": "priority",
            "assigneeId": "assignee_id", "projectId": "project_id", "cycleId": "cycle_id",
            "milestoneId": "milestone_id", "dueDate": "due_date", "estimate": "estimate",
            "parentId": "parent_id", "recurringRule": "recurring_rule", "externalUrl": "external_url",
        }
        assignments = []
        values = []
        for key, column in fields.items():
            if key in data:
                assignments.append(f"{column}=?")
                values.append(priority_number(data[key]) if key == "priority" else data[key])
        if "status" in data:
            status = find_status(con, target_team_id, data["status"])
            assignments.append("status_id=?")
            values.append(status[0])
        if "teamId" in data:
            next_team = int(data["teamId"])
            if not con.execute("SELECT id FROM teams WHERE id=?", (next_team,)).fetchone():
                raise ValueError("Team not found")
            assignments.append("team_id=?")
            values.append(next_team)
            if "status" not in data:
                current_name = con.execute(
                    "SELECT name FROM issue_statuses WHERE id=?", (row["status_id"],)
                ).fetchone()[0]
                status = con.execute(
                    "SELECT id FROM issue_statuses WHERE team_id=? AND name=?",
                    (next_team, current_name),
                ).fetchone() or find_status(con, next_team)
                assignments.append("status_id=?")
                values.append(status[0])
        changed_lists = "labelIds" in data or "subscriberIds" in data
        if assignments or changed_lists:
            assignments.append("updated_at=?")
            values.extend((stamp, row["id"]))
            con.execute(f"UPDATE issues SET {','.join(assignments)} WHERE id=?", values)
        if "labelIds" in data:
            con.execute("DELETE FROM issue_labels WHERE issue_id=?", (row["id"],))
            for label_id in data["labelIds"]:
                con.execute(
                    "INSERT INTO issue_labels(issue_id,label_id) VALUES(?,?)",
                    (row["id"], int(label_id)),
                )
        if "subscriberIds" in data:
            con.execute("DELETE FROM issue_subscribers WHERE issue_id=?", (row["id"],))
            for subscriber_id in data["subscriberIds"]:
                con.execute(
                    "INSERT INTO issue_subscribers(issue_id,member_id) VALUES(?,?)",
                    (row["id"], int(subscriber_id)),
                )
        if assignments or changed_lists:
            changed = {
                key: data[key]
                for key in data
                if key in fields or key in ("status", "teamId", "labelIds", "subscriberIds")
            }
            if "teamId" in data:
                changed["status"] = read_issue(con, row["id"])["status"]
            record_event(con, "issue", row["id"], actor, "updated", changed)
            run_automations(con, target_team_id, row["id"], "issue.updated", actor)
            new_category = con.execute(
                "SELECT s.category FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.id=?",
                (row["id"],),
            ).fetchone()[0]
            if old_category != "Completed" and new_category == "Completed":
                run_automations(con, target_team_id, row["id"], "issue.completed", actor)
        return {"issue": read_issue(con, row["id"])}

    if match and method == "DELETE":
        row = con.execute("SELECT id FROM issues WHERE identifier=?", (match[1],)).fetchone()
        if not row:
            raise ValueError("Issue not found")
        con.execute("UPDATE issues SET archived=1,updated_at=? WHERE id=?", (stamp, row[0]))
        record_event(con, "issue", row[0], actor, "archived", {})
        return {"ok": True}

    match = re.fullmatch(r"/api/issues/([^/]+)/comments", path)
    if match and method == "POST":
        row = con.execute("SELECT id FROM issues WHERE identifier=?", (match[1],)).fetchone()
        if not row:
            raise ValueError("Issue not found")
        body = str(data.get("body", "")).strip()
        if not body:
            raise ValueError("Comment is required")
        con.execute(
            "INSERT INTO comments(issue_id,author_id,body,created_at) VALUES(?,?,?,?)",
            (row[0], actor, body, stamp),
        )
        record_event(con, "issue", row[0], actor, "commented", {"body": body[:120]})
        return {"issue": read_issue(con, row[0]), "_status": 201}

    match = re.fullmatch(r"/api/issues/([^/]+)/restore", path)
    if match and method == "POST":
        row = con.execute("SELECT id FROM issues WHERE identifier=?", (match[1],)).fetchone()
        if not row:
            raise ValueError("Issue not found")
        con.execute("UPDATE issues SET archived=0,updated_at=? WHERE id=?", (stamp, row[0]))
        record_event(con, "issue", row[0], actor, "restored", {})
        return {"ok": True}

    match = re.fullmatch(r"/api/issues/([^/]+)/attachments", path)
    if match and method == "POST":
        issue = con.execute(
            "SELECT id FROM issues WHERE identifier=? AND archived=0", (match[1],)
        ).fetchone()
        if not issue:
            raise ValueError("Issue not found")
        files = data.get("files", [])
        if not isinstance(files, list) or not files:
            raise ValueError("Choose at least one attachment")
        total = 0
        created = []
        folder = data_dir / "attachments"
        if folder.is_symlink():
            raise ValueError("Attachment directory must not be a symbolic link")
        folder.mkdir(parents=True, exist_ok=True)
        for item in files:
            name = Path(str(item.get("name", "attachment"))).name.strip()[:180] or "attachment"
            encoded = str(item.get("data", "")).split(",")[-1]
            try:
                content = base64.b64decode(encoded, validate=True)
            except (ValueError, base64.binascii.Error) as error:
                raise ValueError("Attachment data is invalid") from error
            total += len(content)
            if not content:
                raise ValueError("Empty files cannot be attached")
            if len(content) > 3_000_000 or total > 3_000_000:
                raise ValueError("Attachments must total 3 MB or less")
            storage_name = uuid.uuid4().hex
            (folder / storage_name).write_bytes(content)
            candidate = str(item.get("type") or mimetypes.guess_type(name)[0] or "application/octet-stream")[:120]
            content_type = candidate if re.fullmatch(r"[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+", candidate) else "application/octet-stream"
            cursor = con.execute(
                "INSERT INTO issue_attachments(issue_id,name,content_type,size,storage_name,created_at) VALUES(?,?,?,?,?,?)",
                (issue[0], name, content_type, len(content), storage_name, stamp),
            )
            created.append({"id": cursor.lastrowid, "name": name})
        record_event(con, "issue", issue[0], actor, "attachments_added", {"count": len(created)})
        return {"attachments": created, "_status": 201}

    match = re.fullmatch(r"/api/issues/([^/]+)/relations", path)
    if match and method == "POST":
        row = con.execute("SELECT id FROM issues WHERE identifier=?", (match[1],)).fetchone()
        if not row:
            raise ValueError("Issue not found")
        relation_id = data.get("relatedIssueId")
        relation_url = data.get("url")
        if not relation_id and not relation_url:
            raise ValueError("Choose an issue or provide a URL")
        related = None
        if relation_id:
            related_row = con.execute(
                "SELECT id FROM issues WHERE identifier=?", (relation_id,)
            ).fetchone()
            if not related_row:
                raise ValueError("Related issue not found")
            related = related_row[0]
        con.execute(
            "INSERT INTO issue_relations(issue_id,related_issue_id,relation_type,url) VALUES(?,?,?,?)",
            (row[0], related, data.get("type", "relates to"), relation_url),
        )
        record_event(con, "issue", row[0], actor, "linked", {"relation": relation_id or relation_url})
        return {"issue": read_issue(con, row[0]), "_status": 201}

    return None
