"""Check CLI parity, complete snapshots, and recovery."""
from contextlib import closing, redirect_stdout, redirect_stderr
import io
import json
import multiprocessing
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

import cli
import server
import snapshot as sync
import workspace as ws


def concurrent_issue(database, folder, title):
    ws.configure(database, folder)
    sync.mutate("POST", "/api/issues", {"title": title})


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.old = (ws.DB_PATH, ws.SNAPSHOT_DIR)
        ws.configure(self.root / "one" / "workspace.sqlite3")
        sync.initialize(demo=True)
        self.base = ws.SNAPSHOT_DIR

    def tearDown(self):
        ws.configure(*self.old)
        self.temp.cleanup()

    def clone(self, name):
        folder = self.root / name
        shutil.copytree(self.base, folder / "snapshot")
        ws.configure(folder / "workspace.sqlite3")
        sync.import_snapshot()
        server.DATA_DIR, server.DB_PATH = ws.DATA_DIR, ws.DB_PATH

    def image(self):
        with closing(ws.db()) as con:
            return sync.database_files(con)

    def test_full_round_trip_and_stable_export(self):
        sync.mutate("POST", "/api/issues/PRO-248/attachments", {"files": [{"name": "test.txt", "data": "aGVsbG8="}]})
        sync.mutate("DELETE", "/api/issues/PRO-248", {})
        with closing(ws.db()) as con:
            con.execute("UPDATE members SET active=0 WHERE id=5")
            con.execute("UPDATE actors SET active=0 WHERE id=5")
            con.commit()
        sync.export()
        original = self.image()
        sync.export()
        self.assertEqual(original, sync.disk_files(self.base))
        self.clone("restored")
        self.assertEqual(original, self.image())
        self.assertEqual(sync.export(dry_run=True), {"added": [], "changed": [], "deleted": []})
        self.assertTrue(sync.validate()["valid"])

    def test_remove_unused_tables_and_document_reference(self):
        with closing(ws.db()) as con:
            con.execute("CREATE TABLE documents(id INTEGER PRIMARY KEY, body TEXT)")
            con.execute("CREATE TABLE reviews(id INTEGER PRIMARY KEY)")
            con.execute("CREATE TABLE agent_threads(id INTEGER PRIMARY KEY)")
            con.execute("CREATE TABLE agent_messages(id INTEGER PRIMARY KEY,thread_id INTEGER REFERENCES agent_threads(id))")
            con.execute("INSERT INTO documents VALUES(1,'Removed')")
            con.execute("INSERT INTO reviews VALUES(1)")
            con.execute("INSERT INTO agent_threads VALUES(1)")
            con.execute("INSERT INTO agent_messages VALUES(1,1)")
            con.execute("ALTER TABLE team_resources ADD COLUMN document_id INTEGER REFERENCES documents(id)")
            con.commit()
        sync.export(dry_run=True)
        with closing(ws.db()) as con:
            self.assertTrue(con.execute("SELECT 1 FROM sqlite_master WHERE name='documents'").fetchone())
        sync.export()
        with closing(ws.db()) as con:
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertFalse(tables & ws.REMOVED_TABLES)
            self.assertNotIn("document_id", {r[1] for r in con.execute("PRAGMA table_info(team_resources)")})
            self.assertEqual(con.execute("SELECT COUNT(*) FROM team_resources").fetchone()[0], 1)
            self.assertFalse(con.execute("PRAGMA foreign_key_check").fetchall())
        self.assertFalse(set(json.loads((self.base / "manifest.json").read_text())["tables"]) & ws.REMOVED_TABLES)

    def test_import_interrupt_after_commit_recovers(self):
        sync.mutate("POST", "/api/issues/PRO-248/attachments", {"files": [{"name": "test", "data": "aGVsbG8="}]})
        attachment = next((self.base / "attachments").iterdir())
        attachment.write_bytes(b"world")
        real = sync.recover
        calls = 0
        def interrupted(con):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise KeyboardInterrupt()
            return real(con)
        with patch.object(sync, "recover", side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                sync.import_snapshot()
        self.assertTrue(sync.local_path("journal.json").exists())
        sync.prepare()
        self.assertFalse(sync.local_path("journal.json").exists())
        self.assertEqual(self.image(), sync.disk_files(self.base))

    def test_import_interrupt_before_commit_restores(self):
        sync.mutate("POST", "/api/issues/PRO-248/attachments", {"files": [{"name": "test", "data": "aGVsbG8="}]})
        original = self.image()
        attachment = next((self.base / "attachments").iterdir())
        attachment.write_bytes(b"world")
        real = Path.replace
        def interrupted(path, target):
            result = real(path, target)
            if path.name.startswith(".sync-import-") and not path.name.endswith("-old"):
                raise KeyboardInterrupt()
            return result
        with patch.object(Path, "replace", interrupted):
            with self.assertRaises(KeyboardInterrupt):
                sync.import_snapshot()
        self.assertTrue(sync.local_path("journal.json").exists())
        with closing(ws.db()) as con:
            sync.recover(con)
        self.assertEqual(original, self.image())
        self.assertFalse(sync.local_path("journal.json").exists())

    def test_external_changes_and_import_without_events(self):
        path = self.base / "issues" / "row-1.json"
        row = json.loads(path.read_text())
        row["title"] = "Edited in Git"
        path.write_text(json.dumps(row))
        with self.assertRaises(sync.SyncConflict):
            sync.mutate("POST", "/api/issues", {"title": "blocked"})
        with self.assertRaises(sync.SyncConflict):
            sync.export()
        before = self.image()
        self.assertTrue(sync.status()["files_changed"])
        preview = sync.import_snapshot(dry_run=True)
        self.assertIn("issues/row-1.json", preview["changed"])
        self.assertEqual(before, self.image())
        sync.import_snapshot()
        self.assertFalse(sync.status()["database_changed"])
        self.assertFalse(sync.status()["files_changed"])
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT title FROM issues WHERE id=1").fetchone()[0], "Edited in Git")
            self.assertEqual(len(sync.rows(con)["activity_events"]), 5)
        sync.mutate("POST", "/api/issues", {"title": "allowed"})
        self.assertFalse(sync.status()["files_changed"])

    def test_database_drift_and_force_backup(self):
        with closing(ws.db()) as con:
            con.execute("UPDATE issues SET title='Outside writer' WHERE id=1")
            con.commit()
        with self.assertRaises(sync.SyncConflict):
            sync.import_snapshot()
        with self.assertRaises(sync.SyncConflict):
            sync.mutate("POST", "/api/issues", {"title": "blocked"})
        result = sync.import_snapshot(force=True)
        with closing(sqlite3.connect(Path(result["backup"]) / "workspace.sqlite3")) as con:
            self.assertEqual(con.execute("SELECT title FROM issues WHERE id=1").fetchone()[0], "Outside writer")

    def test_invalid_snapshots_leave_database_unchanged(self):
        original = self.image()
        cases = [
            ("manifest.json", lambda row: row.update(format_version=9)),
            ("issues/row-1.json", lambda row: row.update(assignee_id=99999)),
            ("issues/row-1.json", lambda row: row.update(status_id=8)),
            ("issues/row-1.json", lambda row: row.update(priority="1")),
            ("issues/row-1.json", lambda row: row.update(extra=True)),
        ]
        for name, change in cases:
            with self.subTest(name=name, change=change):
                path = self.base / name
                saved = path.read_bytes()
                row = json.loads(saved)
                change(row)
                path.write_bytes(sync.encode(row))
                with self.assertRaises(ValueError):
                    sync.import_snapshot(force=True)
                self.assertEqual(original, self.image())
                path.write_bytes(saved)
        path = self.base / "issues/row-1.json"
        saved = path.read_bytes()
        path.write_text("<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch")
        with self.assertRaises(ValueError):
            sync.validate()
        path.write_bytes(saved)
        (self.base / "unsafe").symlink_to(self.root)
        with self.assertRaises(ValueError):
            sync.validate()

    def test_missing_and_unsafe_attachments(self):
        sync.mutate("POST", "/api/issues/PRO-248/attachments", {"files": [{"name": "test", "data": "aGVsbG8="}]})
        path = self.base / "issue_attachments/row-1.json"
        row = json.loads(path.read_bytes())
        attachment = self.base / "attachments" / row["storage_name"]
        content = attachment.read_bytes()
        attachment.unlink()
        with self.assertRaises(ValueError):
            sync.validate()
        attachment.write_bytes(content)
        row["storage_name"] = "../outside"
        path.write_bytes(sync.encode(row))
        with self.assertRaises(ValueError):
            sync.validate()

    def test_empty_snapshot_and_deletions(self):
        for path in self.base.rglob("row-*.json"):
            path.unlink()
        sync.import_snapshot()
        with closing(ws.db()) as con:
            self.assertTrue(all(not entries for entries in sync.rows(con).values()))
            self.assertEqual(ws.bootstrap(con)["workspace"], {})
        self.assertEqual(sync.validate()["records"], 0)
        sync.export()
        self.assertEqual(set(sync.disk_files(self.base)), {"manifest.json"})

    def test_export_recovery_after_commit(self):
        real = sync.recover
        calls = 0
        def fail_finish(con):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("Disk unavailable")
            return real(con)
        with patch.object(sync, "recover", side_effect=fail_finish):
            with self.assertRaises(sync.PendingExport):
                sync.mutate("POST", "/api/issues", {"title": "Committed"})
        self.assertTrue(sync.local_path("journal.json").exists())
        sync.prepare()
        self.assertFalse(sync.local_path("journal.json").exists())
        self.assertEqual(self.image(), sync.disk_files(self.base))
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM issues WHERE title='Committed'").fetchone()[0], 1)

    def test_export_recovery_after_directory_swap(self):
        real = sync.save_state
        with patch.object(sync, "save_state", side_effect=OSError("State unavailable")):
            with self.assertRaises(sync.PendingExport):
                sync.mutate("POST", "/api/issues", {"title": "Published"})
        sync.prepare()
        self.assertEqual(self.image(), sync.disk_files(self.base))

    def test_export_failure_before_commit(self):
        original = self.image()
        with patch.object(sync, "stage_files", side_effect=OSError("Disk full")):
            with self.assertRaises(OSError):
                sync.mutate("POST", "/api/issues", {"title": "Rolled back"})
        self.assertEqual(original, self.image())
        self.assertEqual(original, sync.disk_files(self.base))

    def test_import_failure_restores_attachments(self):
        sync.mutate("POST", "/api/issues/PRO-248/attachments", {"files": [{"name": "test", "data": "aGVsbG8="}]})
        original = self.image()
        attachment = next((self.base / "attachments").iterdir())
        attachment.write_bytes(b"world")
        real = Path.replace
        def fail_stage(path, target):
            if path.name.startswith(".sync-import-") and not path.name.endswith("-old"):
                raise OSError("Cannot publish attachments")
            return real(path, target)
        with patch.object(Path, "replace", fail_stage):
            with self.assertRaises(OSError):
                sync.import_snapshot()
        self.assertEqual(original, self.image())
        self.assertFalse(sync.local_path("journal.json").exists())

    def test_concurrent_writes(self):
        ctx = multiprocessing.get_context("spawn")
        workers = [ctx.Process(target=concurrent_issue, args=(str(ws.DB_PATH), str(ws.SNAPSHOT_DIR), f"Concurrent {n}")) for n in range(3)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(20)
            self.assertEqual(worker.exitcode, 0)
        self.assertEqual(self.image(), sync.disk_files(self.base))
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM issues WHERE title LIKE 'Concurrent %'").fetchone()[0], 3)

    def test_recurring_exports_and_runs_once(self):
        sync.mutate("POST", "/api/recurring", {"title": "Scheduled", "nextRun": "2000-01-01", "cadence": "Monthly"})
        self.assertGreater(sync.run_recurring()["created"], 0)
        self.assertEqual(sync.run_recurring()["created"], 0)
        self.assertEqual(self.image(), sync.disk_files(self.base))

    def test_cli_read_does_not_create_database_and_exit_codes(self):
        target = self.root / "absent" / "workspace.sqlite3"
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["--db", str(target), "issues", "list"]), 2)
        self.assertFalse(target.exists())
        path = self.base / "issues/row-1.json"
        path.write_text(path.read_text().replace("Improve", "Change"))
        # A valid edit must block the CLI write.
        row = json.loads(path.read_text()); row["title"] = "External"; path.write_bytes(sync.encode(row))
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["--db", str(self.root / "one/workspace.sqlite3"), "issues", "create", "--title", "blocked"]), 3)

    def test_cli_flags_payload_and_reads(self):
        self.clone("cli")
        db = str(ws.DB_PATH)
        args = cli.parser().parse_args(["issues", "create", "--db", db, "--title", "Flags", "--team-id", "1", "--priority", "High", "--label-ids", "[1]"])
        result = cli.execute(args)
        self.assertEqual(result["issue"]["priority"], 1)
        self.assertEqual(result["issue"]["labels"][0]["id"], 1)
        for resource in cli.RESOURCES:
            args = cli.parser().parse_args(["--db", db, resource, "list"])
            self.assertIsInstance(cli.execute(args), list)
        args = cli.parser().parse_args(["--db", db, "issues", "show", result["issue"]["identifier"]])
        self.assertEqual(cli.execute(args)["title"], "Flags")
        self.assertTrue(cli.execute(cli.parser().parse_args(["--db", db, "search", "Flags"]))["results"])

    def test_http_errors_and_cli_exit_codes(self):
        server.DATA_DIR, server.DB_PATH = ws.DATA_DIR, ws.DB_PATH
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            for resource, action, ident, data, status, exit_code in [
                ("issues", "create", None, {}, 400, 2),
                ("issues", "create", None, {"title": "Invalid", "teamId": 999}, 400, 2),
                ("issues", "update", "PRO-248", {"assigneeId": 999}, 409, 3),
                ("projects", "update", "1", {"teamIds": []}, 400, 2),
                ("issues", "attach", "PRO-248", {"files": [{"name": "valid", "data": "aGVsbG8="}, {"name": "invalid", "data": "!!!"}]}, 400, 2),
            ]:
                with self.subTest(resource=resource, action=action, data=data):
                    before = self.image()
                    method, route = cli.ACTIONS[resource][action]
                    request = Request(f"http://127.0.0.1:{httpd.server_port}" + route.format(id=ident), data=json.dumps(data).encode(), method=method)
                    with self.assertRaises(HTTPError) as error:
                        urlopen(request)
                    self.assertEqual(error.exception.code, status)
                    error.exception.close()
                    argv = ["--db", str(ws.DB_PATH), resource, action]
                    if ident:
                        argv.append(ident)
                    argv += ["--data", json.dumps(data)]
                    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                        self.assertEqual(cli.main(argv), exit_code)
                    self.assertEqual(before, self.image())
                    self.assertFalse(list((ws.DATA_DIR / "attachments").glob("*")))
            request = Request(f"http://127.0.0.1:{httpd.server_port}/api/unknown", data=b"{}", method="POST")
            with self.assertRaises(HTTPError) as error:
                urlopen(request)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_cli_http_action_parity(self):
        cases = [
            ("issues", "create", None, {"title": "New", "parentId": 1}),
            ("issues", "update", "PRO-248", {"title": "Edited", "subscriberIds": [1, 2], "labelIds": [1]}),
            ("issues", "update", "PRO-248", {"status": "Done"}),
            ("issues", "archive", "PRO-248", {}), ("issues", "restore", "PRO-248", {}),
            ("issues", "comment", "PRO-248", {"body": "Note"}),
            ("issues", "attach", "PRO-248", {"files": [{"name": "test", "data": "aGVsbG8="}]}),
            ("issues", "relate", "PRO-248", {"relatedIssueId": "PRO-246"}),
            ("issues", "import", None, {"issues": [{"title": "Imported"}]}),
            ("projects", "create", None, {"name": "New", "teamIds": [1, 2], "milestones": [{"name": "First"}]}),
            ("projects", "update", "1", {"summary": "Edited", "memberIds": [1], "teamIds": [1, 2]}),
            ("projects", "archive", "1", {}), ("projects", "restore", "1", {}),
            ("projects", "milestone", "1", {"name": "Next"}),
            ("projects", "post-update", "1", {"body": "Progress", "health": "On track"}),
            ("projects", "depend", "1", {"dependsOnId": 2}),
            ("teams", "create", None, {"name": "Support", "key": "SUP"}),
            ("teams", "update", "1", {"description": "Changed"}),
            ("teams", "add-resource", "1", {"title": "Docs", "url": "https://example.com"}),
            ("teams", "remove-resource", "1", {}),
            ("statuses", "create", None, {"name": "Waiting"}),
            ("labels", "create", None, {"name": "New"}),
            ("cycles", "create", None, {"name": "Next", "startsAt": "2026-11-01", "endsAt": "2026-11-15"}),
            ("views", "create", None, {"name": "New", "filters": {"priority": [1]}}),
            ("views", "update", "1", {"name": "Edited"}), ("views", "delete", "1", {}),
            ("inbox", "read", "1", {}), ("inbox", "unread", "1", {}), ("inbox", "archive", "1", {}),
            ("inbox", "read-all", None, {}), ("inbox", "read-selected", None, {"ids": [1, 2]}),
            ("inbox", "archive-selected", None, {"ids": [1, 2]}),
            ("preferences", "update", None, {"defaultHome": "Home"}),
            ("settings", "update", None, {"key": "test", "value": {"enabled": True}}),
            ("workspace", "update", None, {"name": "Changed"}),
            ("automations", "create", None, {"name": "New", "trigger": {"event": "issue.created"}, "action": {}}),
            ("recurring", "create", None, {"title": "Future", "nextRun": "2099-01-01"}),
        ]
        self.assertEqual({(r, a) for r, actions in cli.ACTIONS.items() if r != "agents" for a in actions}, {(r, a) for r, a, _, _ in cases})
        with patch.object(ws, "now", return_value="2026-10-04T00:00:00+00:00"), patch.object(ws, "uuid", SimpleNamespace(uuid4=lambda: SimpleNamespace(hex="attachment-test"))):
            for n, (resource, action, ident, data) in enumerate(cases):
                with self.subTest(resource=resource, action=action, data=data):
                    self.clone(f"cli-{n}")
                    argv = ["--db", str(ws.DB_PATH), resource, action]
                    if ident:
                        argv.append(ident)
                    if action == "remove-resource":
                        argv.append("1")
                    argv += ["--data", json.dumps(data)]
                    result = cli.execute(cli.parser().parse_args(argv))
                    expected = self.image()
                    self.clone(f"http-{n}")
                    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
                    thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
                    try:
                        method, route = cli.ACTIONS[resource][action]
                        route = route.format(id=ident, resource_id=1)
                        body = dict(data, actorId=1)
                        if resource == "workspace":
                            body = {"key": "workspace", "value": data, "actorId": 1}
                        request = Request(f"http://127.0.0.1:{httpd.server_port}{route}", data=json.dumps(body).encode(), method=method, headers={"Content-Type": "application/json"})
                        with urlopen(request) as response:
                            actual_result = json.load(response)
                        self.assertEqual(result, actual_result)
                        self.assertEqual(expected, self.image())
                        self.assertEqual(self.image(), sync.disk_files(ws.SNAPSHOT_DIR))
                    finally:
                        httpd.shutdown(); httpd.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
