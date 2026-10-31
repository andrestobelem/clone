"""Team, workflow status, label, and resource mutations."""

import re


def mutate_team(con, method, path, data, stamp, actor, issue_statuses):
    if path == "/api/teams" and method == "POST":
        name = str(data.get("name", "")).strip()
        key = re.sub(r"[^A-Za-z0-9]", "", data.get("key") or name[:3]).upper()[:5]
        if not name:
            raise ValueError("Team name is required")
        if not key:
            raise ValueError("Team key must contain letters or digits")
        con.execute(
            "INSERT INTO teams(name,key,description,icon,created_at) VALUES(?,?,?,?,?)",
            (name, key, data.get("description", ""), data.get("icon", "✳"), stamp),
        )
        team_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.execute(
            "INSERT INTO team_members(team_id,member_id,role) VALUES(?,?,?)",
            (team_id, actor, "Lead"),
        )
        for participant in data.get("memberIds", []):
            con.execute(
                "INSERT OR IGNORE INTO team_members(team_id,member_id) VALUES(?,?)",
                (team_id, participant),
            )
        for position, (status, category) in enumerate(issue_statuses):
            con.execute(
                "INSERT INTO issue_statuses(team_id,name,category,position,color,is_default) VALUES(?,?,?,?,?,?)",
                (team_id, status, category, position, "#8e8e98", int(status == "Backlog")),
            )
        return {"teamId": team_id, "_status": 201}

    if path == "/api/statuses" and method == "POST":
        team_id = int(data.get("teamId", 1))
        name = str(data.get("name", "")).strip()
        category = data.get("category", "Unstarted")
        if not name:
            raise ValueError("Status name is required")
        position = con.execute(
            "SELECT COALESCE(MAX(position),-1)+1 FROM issue_statuses WHERE team_id=?",
            (team_id,),
        ).fetchone()[0]
        con.execute(
            "INSERT INTO issue_statuses(team_id,name,category,position,color) VALUES(?,?,?,?,?)",
            (team_id, name, category, position, data.get("color", "#8989a1")),
        )
        return {"statusId": con.execute("SELECT last_insert_rowid()").fetchone()[0], "_status": 201}

    if path == "/api/labels" and method == "POST":
        name = str(data.get("name", "")).strip()
        if not name:
            raise ValueError("Label name is required")
        con.execute(
            "INSERT INTO labels(name,color,team_id) VALUES(?,?,?)",
            (name, data.get("color", "#8585cc"), data.get("teamId", 1)),
        )
        return {"labelId": con.execute("SELECT last_insert_rowid()").fetchone()[0], "_status": 201}

    match = re.fullmatch(r"/api/teams/(\d+)", path)
    if match and method in ("PUT", "PATCH"):
        team_id = int(match[1])
        if not con.execute("SELECT id FROM teams WHERE id=?", (team_id,)).fetchone():
            raise ValueError("Team not found")
        fields = {
            "name": "name",
            "description": "description",
            "icon": "icon",
            "timezone": "timezone",
            "estimateType": "estimate_type",
        }
        assignments = []
        values = []
        for key, column in fields.items():
            if key in data:
                assignments.append(f"{column}=?")
                values.append(data[key])
        if "memberIds" in data:
            roles = {
                row["member_id"]: row["role"]
                for row in con.execute("SELECT * FROM team_members WHERE team_id=?", (team_id,))
            }
            con.execute("DELETE FROM team_members WHERE team_id=?", (team_id,))
            for participant in data["memberIds"]:
                con.execute(
                    "INSERT INTO team_members VALUES(?,?,?)",
                    (team_id, participant, roles.get(participant, "Member")),
                )
        if assignments:
            values.append(team_id)
            con.execute(f"UPDATE teams SET {','.join(assignments)} WHERE id=?", values)
        return {"ok": True}

    match = re.fullmatch(r"/api/teams/(\d+)/resources", path)
    if match and method == "POST":
        team_id = int(match[1])
        title = str(data.get("title", "")).strip()
        section = str(data.get("section", "Resources")).strip() or "Resources"
        url = str(data.get("url", "")).strip()
        if not title:
            raise ValueError("Resource title is required")
        if not re.match(r"^https?://", url, re.I):
            raise ValueError("Resource links must start with http:// or https://")
        con.execute(
            "INSERT INTO team_resources(team_id,section,title,url) VALUES(?,?,?,?)",
            (team_id, section, title, url),
        )
        return {"resourceId": con.execute("SELECT last_insert_rowid()").fetchone()[0], "_status": 201}

    match = re.fullmatch(r"/api/teams/(\d+)/resources/(\d+)", path)
    if match and method == "DELETE":
        con.execute(
            "DELETE FROM team_resources WHERE team_id=? AND id=?",
            (int(match[1]), int(match[2])),
        )
        return {"ok": True}

    return None
