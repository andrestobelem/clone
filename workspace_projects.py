"""Project, milestone, update, and dependency mutations."""

import re


def mutate_project(con, method, path, data, stamp, actor, priority_num, record_event):
    if path == "/api/projects" and method == "POST":
        name = str(data.get("name", "")).strip()
        if not name:
            raise ValueError("Project name is required")
        con.execute(
            "INSERT INTO projects(name,summary,description,status,priority,icon,lead_id,start_date,target_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                name,
                data.get("summary", ""),
                data.get("description", ""),
                data.get("status", "Backlog"),
                priority_num(data.get("priority", 4)),
                data.get("icon", "◈"),
                data.get("leadId", actor),
                data.get("startDate"),
                data.get("targetDate"),
                stamp,
                stamp,
            ),
        )
        project_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        for team_id in data.get("teamIds", [1]):
            con.execute(
                "INSERT OR IGNORE INTO project_teams(project_id,team_id) VALUES(?,?)",
                (project_id, int(team_id)),
            )
        for member_id in data.get("memberIds", [actor]):
            con.execute(
                "INSERT OR IGNORE INTO project_members(project_id,member_id) VALUES(?,?)",
                (project_id, int(member_id)),
            )
        for label_id in data.get("labelIds", []):
            con.execute(
                "INSERT OR IGNORE INTO project_labels(project_id,label_id) VALUES(?,?)",
                (project_id, int(label_id)),
            )
        for dependency in data.get("dependencies", []):
            if int(dependency) != project_id:
                con.execute(
                    "INSERT OR IGNORE INTO project_dependencies(project_id,depends_on_id,dependency_type) VALUES(?,?,?)",
                    (project_id, int(dependency), "blocks"),
                )
        for position, milestone in enumerate(data.get("milestones", [])):
            con.execute(
                "INSERT INTO milestones(project_id,name,due_date,status,position) VALUES(?,?,?,?,?)",
                (
                    project_id,
                    milestone["name"],
                    milestone.get("dueDate"),
                    milestone.get("status", "Todo"),
                    position,
                ),
            )
        record_event(con, "project", project_id, actor, "created", {"name": name})
        return {"projectId": project_id, "_status": 201}

    match = re.fullmatch(r"/api/projects/(\d+)", path)
    if match and method in ("PUT", "PATCH"):
        project_id = int(match[1])
        if not con.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
            raise ValueError("Project not found")
        if "teamIds" in data:
            next_team_ids = {int(team_id) for team_id in data["teamIds"]}
            issue_teams = {
                row[0]
                for row in con.execute(
                    "SELECT DISTINCT team_id FROM issues WHERE project_id=?", (project_id,)
                )
            }
            if not issue_teams.issubset(next_team_ids):
                raise ValueError("Move or unlink this project's issues before removing their team")
        fields = {
            "name": "name",
            "summary": "summary",
            "description": "description",
            "status": "status",
            "icon": "icon",
            "leadId": "lead_id",
            "startDate": "start_date",
            "targetDate": "target_date",
        }
        assignments = []
        values = []
        for key, column in fields.items():
            if key in data:
                assignments.append(f"{column}=?")
                values.append(data[key])
        if "priority" in data:
            assignments.append("priority=?")
            values.append(priority_num(data["priority"]))
        if assignments:
            assignments.append("updated_at=?")
            values.extend((stamp, project_id))
            con.execute(f"UPDATE projects SET {','.join(assignments)} WHERE id=?", values)
        for key, table, column in (
            ("teamIds", "project_teams", "team_id"),
            ("memberIds", "project_members", "member_id"),
            ("labelIds", "project_labels", "label_id"),
        ):
            if key in data:
                con.execute(f"DELETE FROM {table} WHERE project_id=?", (project_id,))
                for value in data[key]:
                    con.execute(
                        f"INSERT OR IGNORE INTO {table}(project_id,{column}) VALUES(?,?)",
                        (project_id, int(value)),
                    )
        record_event(con, "project", project_id, actor, "updated", data)
        return {"projectId": project_id}

    if match and method == "DELETE":
        project_id = int(match[1])
        if not con.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
            raise ValueError("Project not found")
        con.execute(
            "UPDATE projects SET archived=1,updated_at=? WHERE id=?",
            (stamp, project_id),
        )
        record_event(con, "project", project_id, actor, "archived", {})
        return {"ok": True}

    match = re.fullmatch(r"/api/projects/(\d+)/restore", path)
    if match and method == "POST":
        project_id = int(match[1])
        if not con.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
            raise ValueError("Project not found")
        con.execute(
            "UPDATE projects SET archived=0,updated_at=? WHERE id=?",
            (stamp, project_id),
        )
        record_event(con, "project", project_id, actor, "restored", {})
        return {"ok": True}

    match = re.fullmatch(r"/api/projects/(\d+)/milestones", path)
    if match and method == "POST":
        project_id = int(match[1])
        name = str(data.get("name", "")).strip()
        if not name:
            raise ValueError("Milestone name is required")
        position = con.execute(
            "SELECT COUNT(*) FROM milestones WHERE project_id=?", (project_id,)
        ).fetchone()[0]
        con.execute(
            "INSERT INTO milestones(project_id,name,due_date,status,position) VALUES(?,?,?,?,?)",
            (project_id, name, data.get("dueDate"), data.get("status", "Todo"), position),
        )
        record_event(con, "project", project_id, actor, "milestone_created", {"name": name})
        return {"ok": True, "_status": 201}

    match = re.fullmatch(r"/api/projects/(\d+)/updates", path)
    if match and method == "POST":
        project_id = int(match[1])
        body = str(data.get("body", "")).strip()
        health = str(data.get("health", "On track"))
        if not con.execute(
            "SELECT id FROM projects WHERE id=? AND archived=0", (project_id,)
        ).fetchone():
            raise ValueError("Project not found")
        if not body:
            raise ValueError("Write an update before saving")
        if health not in ("On track", "At risk", "Off track"):
            raise ValueError("Unknown project health")
        con.execute(
            "INSERT INTO project_updates(project_id,health,body,author_id,created_at) VALUES(?,?,?,?,?)",
            (project_id, health, body, actor, stamp),
        )
        record_event(con, "project", project_id, actor, "update_posted", {"health": health})
        return {"ok": True, "_status": 201}

    match = re.fullmatch(r"/api/projects/(\d+)/dependencies", path)
    if match and method == "POST":
        project_id = int(match[1])
        dependency = int(data["dependsOnId"])
        if project_id == dependency:
            raise ValueError("A project cannot depend on itself")
        con.execute(
            "INSERT OR IGNORE INTO project_dependencies(project_id,depends_on_id,dependency_type) VALUES(?,?,?)",
            (project_id, dependency, data.get("type", "blocks")),
        )
        record_event(
            con,
            "project",
            project_id,
            actor,
            "dependency_added",
            {"dependsOnId": dependency},
        )
        return {"ok": True, "_status": 201}

    return None
