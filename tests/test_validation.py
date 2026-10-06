"""Check invalid input, team changes, and HTTP storage boundaries."""
from contextlib import closing, redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import io
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from pathlib import Path

import cli
import server
import snapshot as sync
import workspace as ws


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old = (ws.DB_PATH, ws.SNAPSHOT_DIR)
        ws.configure(self.root / "storage" / "workspace.sqlite3")
        sync.initialize(demo=True)

    def tearDown(self):
        ws.configure(*self.old)
        self.temp.cleanup()

    def test_move_and_status_use_destination_team_and_automations(self):
        sync.mutate("POST", "/api/statuses", {"teamId": 2, "name": "Released", "category": "Completed"})
        sync.mutate("POST", "/api/automations", {
            "teamId": 2, "name": "Destination rule", "trigger": {"event": "issue.completed"},
            "action": {"assignTo": 2},
        })
        issue = sync.mutate("PATCH", "/api/issues/PRO-248", {
            "teamId": 2, "projectId": None, "cycleId": None, "status": "Released",
        })["issue"]
        self.assertEqual((issue["team_id"], issue["status"], issue["assignee_id"]), (2, "Released", 2))
        self.assertEqual(issue["identifier"], "PRO-248")
        self.assertTrue(sync.validate()["valid"])
        with closing(ws.db()) as con:
            self.assertEqual(ws.issue_row(con, issue["id"])["activity"][1]["payload"]["teamId"], 2)

    def test_move_with_shared_status_uses_destination_status_id(self):
        issue = sync.mutate("PATCH", "/api/issues/PRO-248", {
            "teamId": 2, "projectId": None, "cycleId": None, "status": "Todo",
        })["issue"]
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT team_id FROM issue_statuses WHERE id=?", (issue["status_id"],)).fetchone()[0], 2)
        self.assertTrue(sync.validate()["valid"])

    def test_move_reserves_identifiers_for_manual_and_recurring_creation(self):
        sync.mutate("PATCH", "/api/issues/PRO-248", {"teamId": 2, "projectId": None, "cycleId": None})
        issue = sync.mutate("POST", "/api/issues", {"title": "Next source issue"})["issue"]
        self.assertEqual(issue["identifier"], "PRO-249")
        sync.mutate("POST", "/api/recurring", {"title": "Next recurring issue", "nextRun": "2000-01-01"})
        # Keep the demo rule out of this identifier check on every test date.
        with patch.object(ws, "datetime", wraps=datetime) as clock:
            clock.now.return_value = datetime(2026, 10, 4, tzinfo=timezone.utc)
            sync.run_recurring()
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT identifier FROM issues WHERE title='Next recurring issue'").fetchone()[0], "PRO-250")
        self.assertTrue(sync.validate()["valid"])

    def test_invalid_fields_leave_storage_unchanged(self):
        cases = [
            ("POST", "/api/issues", {"title": None}),
            ("PATCH", "/api/issues/PRO-248", {"title": "  "}),
            ("POST", "/api/issues", {"title": "Invalid", "priority": 10}),
            ("POST", "/api/issues", {"title": "Invalid", "priority": True}),
            ("POST", "/api/issues", {"title": "Invalid", "labelIds": "1"}),
            ("POST", "/api/issues", {"title": "Invalid", "estimate": float("nan")}),
            ("POST", "/api/issues", {"title": "Invalid", "dueDate": "2026-02-30"}),
            ("POST", "/api/views", {"name": "Invalid", "filters": []}),
            ("POST", "/api/automations", {"name": "Invalid", "action": []}),
            ("POST", "/api/automations", {"name":"Invalid", "condition":{"label":{}}}),
            ("POST", "/api/automations", {"name":"Invalid", "action":{"name":[]}}),
            ("POST", "/api/recurring", {"title": "Invalid", "cadence": "Never"}),
            ("POST", "/api/recurring", {"title": "Invalid", "nextRun": "bad"}),
            ("POST", "/api/cycles", {"name": "Invalid", "startsAt": "2026-11-15", "endsAt": "2026-11-01"}),
            ("POST", "/api/cycles", {"name": "Invalid", "startsAt": "2026-11-01", "endsAt": "2026-11-15", "capacity": -1}),
            ("POST", "/api/teams", {"name": "Invalid", "key": "!!!"}),
            ("PATCH", "/api/settings", {"key":"preferences", "value": []}),
            ("POST", "/api/projects", {"name":"Invalid", "status":"unknown"}),
            ("POST", "/api/import", {"issues": [None]}),
            ("POST", "/api/issues/PRO-248/attachments", {"files": [None]}),
        ]
        for method, path, data in cases:
            with self.subTest(path=path, data=data):
                with closing(ws.db()) as con:
                    before = sync.database_files(con)
                with self.assertRaises(ValueError):
                    sync.mutate(method, path, data)
                with closing(ws.db()) as con:
                    self.assertEqual(before, sync.database_files(con))
                self.assertEqual(before, sync.disk_files(ws.SNAPSHOT_DIR))

    def test_issue_cycle_milestone_and_parent_relationships(self):
        issue = sync.mutate("POST", "/api/issues", {"title": "Child"})["issue"]
        cases = [{"cycleId": 3}, {"milestoneId": 4, "projectId": 1}, {"parentId": issue["id"]}]
        parent = sync.mutate("POST", "/api/issues", {"title": "Parent", "parentId": issue["id"]})["issue"]
        cases.append({"parentId": parent["id"]})
        for data in cases:
            with self.subTest(data=data), self.assertRaises(ValueError):
                sync.mutate("PATCH", f"/api/issues/{issue['identifier']}", data)
        self.assertTrue(sync.validate()["valid"])

    def test_issue_creation_keeps_milestone_and_recurring_rule(self):
        issue = sync.mutate("POST", "/api/issues", {
            "title": "Milestone", "projectId": 1, "milestoneId": 1,
            "recurringRule": {"cadence": "Weekly"},
        })["issue"]
        self.assertEqual(issue["milestone_id"], 1)
        self.assertEqual(json.loads(issue["recurring_rule"]), {"cadence": "Weekly"})

    def test_label_only_update_records_activity_and_runs_automation(self):
        sync.mutate("POST", "/api/automations", {
            "name": "Assign labeled issue", "trigger": {"event": "issue.updated"},
            "condition": {"label": "Bug"}, "action": {"assignTo": 2},
        })
        with closing(ws.db()) as con:
            label_id = con.execute("SELECT id FROM labels WHERE name='Bug' LIMIT 1").fetchone()[0]
        issue = sync.mutate("PATCH", "/api/issues/PRO-248", {"labelIds": [label_id]})["issue"]
        self.assertEqual(issue["assignee_id"], 2)
        updates = [entry for entry in issue["activity"] if entry["action"] == "updated"]
        self.assertEqual(updates[0]["payload"], {"labelIds": [label_id]})
        self.assertTrue(sync.validate()["valid"])

    def test_selected_inbox_count_excludes_other_actors_and_missing_ids(self):
        with closing(ws.db()) as con:
            own = con.execute("SELECT id FROM notifications WHERE recipient_id=1 LIMIT 1").fetchone()[0]
            other = con.execute("SELECT id FROM notifications WHERE recipient_id<>1 LIMIT 1").fetchone()[0]
            other_before = dict(con.execute("SELECT * FROM notifications WHERE id=?", (other,)).fetchone())
        result = sync.mutate("POST", "/api/notifications/read-selected", {"ids": [own, own, other, 999]})
        self.assertEqual(result["count"], 1)
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT is_read FROM notifications WHERE id=?", (own,)).fetchone()[0], 1)
            self.assertEqual(dict(con.execute("SELECT * FROM notifications WHERE id=?", (other,)).fetchone()), other_before)

    def test_missing_records_do_not_create_activity(self):
        for method, path in (("DELETE", "/api/projects/999"), ("PATCH", "/api/views/999"),
                             ("DELETE", "/api/views/999"), ("PATCH", "/api/teams/999")):
            with self.subTest(path=path), self.assertRaises(ValueError):
                sync.mutate(method, path, {"name": "Missing"})

    def test_failed_staging_rolls_back_and_removes_partial_files(self):
        before = sync.disk_files(ws.SNAPSHOT_DIR)
        with patch.object(sync.os, "fsync", side_effect=OSError("Disk failure")):
            with self.assertRaises(OSError):
                sync.mutate("POST", "/api/issues", {"title": "Must roll back"})
        self.assertEqual(list(ws.SNAPSHOT_DIR.parent.glob(".sync-stage-*")), [])
        with closing(ws.db()) as con:
            self.assertEqual(before, sync.database_files(con))
        self.assertEqual(before, sync.disk_files(ws.SNAPSHOT_DIR))

    def test_snapshot_rejects_nonfinite_numbers_inside_json_text(self):
        path = ws.SNAPSHOT_DIR / "views" / "row-1.json"
        row = json.loads(path.read_text())
        row["filters_json"] = '{"priority":NaN}'
        path.write_bytes(sync.encode(row))
        with self.assertRaises(ValueError):
            sync.validate()

    def test_global_labels_and_unscoped_views_keep_nullable_team(self):
        sync.mutate("POST", "/api/labels", {"name":"Global", "teamId": None})
        sync.mutate("POST", "/api/views", {"name":"Workspace view", "teamId": None, "scope":"Workspace"})
        self.assertTrue(sync.validate()["valid"])

    def test_download_cannot_replace_recovery_or_backup_files(self):
        att = sync.mutate("POST", "/api/issues/PRO-248/attachments", {
            "files": [{"name": "hello.txt", "data": "aGVsbG8="}],
        })["attachments"][0]
        for output in (sync.local_path("state.json"), ws.DB_PATH.with_suffix(".sqlite3-wal"), ws.DATA_DIR / "backups" / "file"):
            with self.subTest(output=output), self.assertRaises(ValueError):
                cli.execute(cli.parser().parse_args(["--db", str(ws.DB_PATH), "attachments", "get", str(att["id"]), "--output", str(output)]))
        output = self.root / "download.txt"
        cli.execute(cli.parser().parse_args(["--db", str(ws.DB_PATH), "attachments", "get", str(att["id"]), "--output", str(output)]))
        self.assertEqual(output.read_bytes(), b"hello")

    def test_http_input_routes_and_attachment_paths(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_port}"
        def error(path, expected, body=None, headers=None):
            request = Request(base + path, data=body, method="POST" if body is not None else "GET", headers=headers or {})
            with self.assertRaises(HTTPError) as caught:
                urlopen(request, timeout=5)
            self.assertEqual(caught.exception.code, expected)
            result = json.load(caught.exception) if path.startswith("/api/") else None
            caught.exception.close()
            return result
        try:
            for path in ("/workspace.py", "/data/workspace.sqlite3", "/data/snapshot/manifest.json"):
                error(path, 404)
            error("/api/issues/PRO-248/comments", 404)
            error("/api/projects/1/updates", 404)
            error("/api/issues", 400, b'{"title":"Invalid","estimate":NaN}')
            error("/api/issues", 400, b'{"title":null}')
            error("/api/issues", 400, b"{}", {"Content-Length":"-1"})
            error("/api/issues", 400, b"{}", {"Content-Length":"5000001"})
            att = sync.mutate("POST", "/api/issues/PRO-248/attachments", {
                "files": [{"name": "hello.txt", "data": "aGVsbG8="}],
            })["attachments"][0]
            with urlopen(base + f"/api/attachments/{att['id']}", timeout=5) as response:
                self.assertEqual(response.read(), b"hello")
            with closing(ws.db()) as con:
                name = con.execute("SELECT storage_name FROM issue_attachments WHERE id=?", (att["id"],)).fetchone()[0]
            target = ws.DATA_DIR / "attachments" / name
            target.unlink()
            target.symlink_to(ws.DB_PATH)
            error(f"/api/attachments/{att['id']}", 400)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_http_and_cli_reject_invalid_payloads_with_same_category(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            for data in ({"name": "Invalid", "action": []}, {"name": None}):
                request = Request(f"http://127.0.0.1:{httpd.server_port}/api/automations", data=json.dumps(data).encode(), method="POST")
                with self.assertRaises(HTTPError) as caught:
                    urlopen(request, timeout=5)
                self.assertEqual(caught.exception.code, 400)
                caught.exception.close()
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    code = cli.main(["--db", str(ws.DB_PATH), "automations", "create", "--data", json.dumps(data), "--json"])
                self.assertEqual(code, 2)
                self.assertEqual(out.getvalue(), "")
                self.assertEqual(json.loads(err.getvalue())["code"], "invalid_input")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
