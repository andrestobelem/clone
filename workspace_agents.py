"""Agent identity mutations for Clone."""

import re


def mutate_agent(con, method, path, data, stamp, actor_record):
    if path == "/api/agents" and method == "POST":
        key = data.get("key")
        name = data.get("name")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("Agent key is required")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Agent name is required")
        cursor = con.execute(
            "INSERT INTO actors(kind,name,key,created_at) VALUES('agent',?,?,?)",
            (name.strip(), key.strip(), stamp),
        )
        return {"agent": actor_record(con, cursor.lastrowid), "_status": 201}

    match = re.fullmatch(r"/api/agents/(\d+)(?:/(deactivate|restore))?", path)
    if not match:
        return None

    agent_id = int(match[1])
    target = actor_record(con, agent_id)
    if not target or target["kind"] != "agent":
        raise ValueError("Agent not found")
    if match[2] and method == "POST":
        con.execute("UPDATE actors SET active=? WHERE id=?", (int(match[2] == "restore"), agent_id))
    elif not match[2] and method == "PATCH":
        if "key" in data:
            raise ValueError("Agent key cannot change")
        name = data.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Agent name is required")
        con.execute("UPDATE actors SET name=? WHERE id=?", (name.strip(), agent_id))
    else:
        return {"error": "Not found", "_status": 404}
    return {"agent": actor_record(con, agent_id)}
