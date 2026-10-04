#!/usr/bin/env python3
"""Manage the local workspace without an HTTP server."""
from contextlib import closing
import argparse
import base64
import json
import mimetypes
from pathlib import Path
import sqlite3
import sys

import snapshot
import workspace as ws


RESOURCES = {
    "issues": "issues", "projects": "projects", "teams": "teams", "members": "members",
    "statuses": "issue_statuses", "labels": "labels", "cycles": "cycles", "views": "views",
    "inbox": "notifications", "automations": "automations", "recurring": "recurring_rules",
    "settings": "app_settings", "preferences": "app_settings", "workspace": "workspace",
}
# Each entry names the existing HTTP method and path.
ACTIONS = {
    "issues": {"create": ("POST", "/api/issues"), "update": ("PATCH", "/api/issues/{id}"),
               "archive": ("DELETE", "/api/issues/{id}"), "restore": ("POST", "/api/issues/{id}/restore"),
               "comment": ("POST", "/api/issues/{id}/comments"), "attach": ("POST", "/api/issues/{id}/attachments"),
               "relate": ("POST", "/api/issues/{id}/relations"), "import": ("POST", "/api/import")},
    "projects": {"create": ("POST", "/api/projects"), "update": ("PATCH", "/api/projects/{id}"),
                 "archive": ("DELETE", "/api/projects/{id}"), "restore": ("POST", "/api/projects/{id}/restore"),
                 "milestone": ("POST", "/api/projects/{id}/milestones"), "post-update": ("POST", "/api/projects/{id}/updates"),
                 "depend": ("POST", "/api/projects/{id}/dependencies")},
    "teams": {"create": ("POST", "/api/teams"), "update": ("PATCH", "/api/teams/{id}"),
              "add-resource": ("POST", "/api/teams/{id}/resources"),
              "remove-resource": ("DELETE", "/api/teams/{id}/resources/{resource_id}")},
    "statuses": {"create": ("POST", "/api/statuses")},
    "labels": {"create": ("POST", "/api/labels")},
    "cycles": {"create": ("POST", "/api/cycles")},
    "views": {"create": ("POST", "/api/views"), "update": ("PATCH", "/api/views/{id}"), "delete": ("DELETE", "/api/views/{id}")},
    "inbox": {"read": ("POST", "/api/notifications/{id}/read"), "unread": ("POST", "/api/notifications/{id}/unread"),
              "archive": ("POST", "/api/notifications/{id}/archive"), "read-all": ("POST", "/api/notifications/read-all"),
              "read-selected": ("POST", "/api/notifications/read-selected"), "archive-selected": ("POST", "/api/notifications/archive-selected")},
    "preferences": {"update": ("PATCH", "/api/preferences")},
    "settings": {"update": ("PATCH", "/api/settings")},
    "workspace": {"update": ("PATCH", "/api/settings")},
    "automations": {"create": ("POST", "/api/automations")},
    "recurring": {"create": ("POST", "/api/recurring")},
}
TEXT_FIELDS = ("title", "name", "description", "summary", "status", "body", "health", "key", "icon", "color",
               "category", "timezone", "estimateType", "dueDate", "startDate", "targetDate", "startsAt", "endsAt",
               "cadence", "nextRun", "externalUrl", "scope", "entity", "section", "url", "type", "relatedIssueId")
INT_FIELDS = ("teamId", "projectId", "cycleId", "milestoneId", "assigneeId", "leadId", "parentId", "dependsOnId")
JSON_FIELDS = ("labelIds", "teamIds", "memberIds", "subscriberIds", "ids", "filters", "display", "trigger", "condition",
               "action", "value", "dependencies", "milestones", "recurringRule", "isFavorite")


def kebab(text):
    import re
    return re.sub(r"([A-Z])", lambda m: "-" + m[1].lower(), text)


def globals_parser():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--db", default=argparse.SUPPRESS, help="SQLite path")
    parser.add_argument("--sync-dir", default=argparse.SUPPRESS, help="Snapshot directory")
    parser.add_argument("--actor", type=int, default=argparse.SUPPRESS, help="Member ID (default: 1)")
    parser.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="Write JSON output")
    return parser


def parser():
    common = globals_parser()
    root = argparse.ArgumentParser(description=__doc__, parents=[common])
    commands = root.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", parents=[common], help="Create a database and export it")
    init.add_argument("--demo", action="store_true", help="Load demo data")
    commands.add_parser("serve", parents=[common], help="Run the web server")
    search = commands.add_parser("search", parents=[common])
    search.add_argument("query")
    search.add_argument("--scope", choices=["All", "Issues", "Projects"], default="All")
    commands.add_parser("export", parents=[common], help="Write the existing UI JSON export")
    sync = commands.add_parser("sync", parents=[common])
    operations = sync.add_subparsers(dest="verb", required=True)
    for name in ("status", "validate", "export", "import"):
        op = operations.add_parser(name, parents=[common])
        if name in ("export", "import"):
            op.add_argument("--dry-run", action="store_true")
            op.add_argument("--force", action="store_true", help="Back up and replace conflicting data")
    attachments = commands.add_parser("attachments", parents=[common])
    att = attachments.add_subparsers(dest="verb", required=True).add_parser("get", parents=[common])
    att.add_argument("id", type=int)
    att.add_argument("--output", required=True)
    for resource in RESOURCES:
        group = commands.add_parser(resource, parents=[common])
        actions = group.add_subparsers(dest="verb", required=True)
        for name in ("list", "show"):
            op = actions.add_parser(name, parents=[common])
            if name == "show" and resource not in ("preferences", "workspace"):
                op.add_argument("id")
            if name == "list":
                op.add_argument("--all", action="store_true", help="Include archived and inactive records")
                op.add_argument("--team-id", type=int)
                op.add_argument("--project-id", type=int)
                op.add_argument("--status")
        for name, (_, route) in ACTIONS.get(resource, {}).items():
            op = actions.add_parser(name, parents=[common])
            if "{id}" in route:
                op.add_argument("id")
            if "{resource_id}" in route:
                op.add_argument("resource_id", type=int)
            op.add_argument("--data", help="JSON object, @file.json, or - for stdin")
            for field in TEXT_FIELDS:
                op.add_argument("--" + kebab(field), dest=field)
            for field in INT_FIELDS:
                op.add_argument("--" + kebab(field), dest=field, type=int)
            for field in JSON_FIELDS:
                op.add_argument("--" + kebab(field), dest=field, type=json.loads)
            for field in ("estimate", "capacity"):
                op.add_argument("--" + field, type=float)
            op.add_argument("--priority", help="Priority name or number from 0 to 4")
            if name == "attach":
                op.add_argument("--file", action="append", default=[])
            if resource == "issues" and name == "import":
                op.add_argument("--dry-run", action="store_true")
        if resource == "recurring":
            actions.add_parser("run", parents=[common])
    return root


def payload(args):
    raw = getattr(args, "data", None)
    if raw == "-":
        value = json.load(sys.stdin)
    elif raw and raw.startswith("@"):
        value = json.loads(Path(raw[1:]).read_text("utf-8"))
    elif raw:
        value = json.loads(raw)
    else:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("--data must contain a JSON object")
    for field in TEXT_FIELDS + INT_FIELDS + JSON_FIELDS + ("estimate", "capacity", "priority"):
        data = getattr(args, field, None)
        if data is not None:
            value[field] = data
    value["actorId"] = getattr(args, "actor", 1)
    return value


def read_resource(args):
    resource = args.command
    table = RESOURCES[resource]
    with snapshot.locked(), closing(ws.db()) as con:
        snapshot.recover(con)
        con.execute("BEGIN")
        entries = [dict(r) for r in con.execute(f'SELECT * FROM "{table}"')]
        if args.verb == "list":
            if not args.all:
                entries = [r for r in entries if not r.get("archived", 0) and r.get("active", 1)]
                if resource == "inbox":
                    entries = [r for r in entries if r["recipient_id"] == getattr(args, "actor", 1)]
            for field in ("team_id", "project_id"):
                wanted = getattr(args, field, None)
                if wanted is not None:
                    if resource == "projects" and field == "team_id":
                        ids = {r[0] for r in con.execute("SELECT project_id FROM project_teams WHERE team_id=?", (wanted,))}
                        entries = [r for r in entries if r["id"] in ids]
                    else:
                        entries = [r for r in entries if r.get(field) == wanted]
            if args.status:
                if resource == "issues":
                    ids = {r[0] for r in con.execute("SELECT id FROM issue_statuses WHERE name=?", (args.status,))}
                    entries = [r for r in entries if r["status_id"] in ids]
                else:
                    entries = [r for r in entries if r.get("status") == args.status]
            return entries
        ident = getattr(args, "id", "preferences" if resource == "preferences" else "1")
        key = "identifier" if resource == "issues" else ("key" if table == "app_settings" else "id")
        item = next((r for r in entries if str(r[key]) == ident), None)
        if not item:
            raise ValueError("Record not found")
        if resource == "issues":
            return ws.issue_row(con, item["id"])
        if resource == "projects" and not item["archived"]:
            return next(p for p in ws.bootstrap(con)["projects"] if p["id"] == item["id"])
        if table == "app_settings":
            return json.loads(item["value_json"])
        if resource == "teams":
            return next(t for t in ws.bootstrap(con)["teams"] if t["id"] == item["id"])
        return item


def execute(args):
    ws.configure(getattr(args, "db", None), getattr(args, "sync_dir", None))
    command = args.command
    if command == "init":
        return snapshot.initialize(args.demo)
    if command == "serve":
        import server
        server.main()
        return {"ok": True}
    if command == "sync":
        if args.verb == "status":
            return snapshot.status()
        if args.verb == "validate":
            return snapshot.validate()
        method = snapshot.export if args.verb == "export" else snapshot.import_snapshot
        return method(force=args.force, dry_run=args.dry_run)
    if command == "recurring" and args.verb == "run":
        return snapshot.run_recurring()
    if command in ("search", "export"):
        with snapshot.locked(), closing(ws.db()) as con:
            snapshot.recover(con)
            con.execute("BEGIN")
            if command == "search":
                return ws.search(con, args.query, args.scope)
            result = ws.bootstrap(con)
            result["exportedAt"] = ws.now()
            return result
    if command == "attachments":
        with snapshot.locked(), closing(ws.db()) as con:
            snapshot.recover(con)
            row = con.execute("SELECT * FROM issue_attachments WHERE id=?", (args.id,)).fetchone()
            if not row:
                raise ValueError("Attachment not found")
            content = snapshot.attachment_bytes({"issue_attachments": [dict(row)]}, ws.DATA_DIR / "attachments")[row["storage_name"]]
            output = Path(args.output).resolve()
            if output == ws.DB_PATH or output.is_relative_to(ws.SNAPSHOT_DIR) or output.is_relative_to(ws.DATA_DIR / "attachments"):
                raise ValueError("Output must not replace workspace storage")
            output.write_bytes(content)
            return {"output": str(output), "size": len(content)}
    if args.verb in ("list", "show"):
        return read_resource(args)
    data = payload(args)
    method, route = ACTIONS[command][args.verb]
    route = route.format(id=getattr(args, "id", ""), resource_id=getattr(args, "resource_id", ""))
    if command == "workspace":
        data = {"key": "workspace", "value": {k: v for k, v in data.items() if k != "actorId"}, "actorId": data["actorId"]}
    if command == "issues" and args.verb == "attach":
        files = data.setdefault("files", [])
        for path in args.file:
            source = Path(path)
            files.append({"name": source.name, "type": mimetypes.guess_type(source.name)[0],
                          "data": base64.b64encode(source.read_bytes()).decode("ascii")})
    if command == "issues" and args.verb == "import" and args.dry_run:
        with snapshot.locked(), closing(ws.db()) as con:
            snapshot.check_files(con)
            con.execute("BEGIN IMMEDIATE")
            try:
                return ws.dispatch_mutation(con, method, route, data)
            finally:
                con.rollback()
    result = snapshot.mutate(method, route, data)
    result.pop("_status", None)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        result = execute(args)
        if getattr(args, "json", False) or isinstance(result, (dict, list)):
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(result)
        return 0
    except snapshot.SyncConflict as error:
        print(str(error), file=sys.stderr)
        return 3
    except snapshot.PendingExport as error:
        print(str(error), file=sys.stderr)
        return 4
    except (ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    except sqlite3.IntegrityError as error:
        print("Conflict or invalid relationship: " + str(error), file=sys.stderr)
        return 3
    except (OSError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
