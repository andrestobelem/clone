"""Check actor identities, agent access, and storage upgrades."""
from contextlib import closing, redirect_stdout, redirect_stderr
from http.server import ThreadingHTTPServer
import io
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import cli
import server
import snapshot as sync
import workspace as ws


class ActorTests(unittest.TestCase):
    def setUp(self):
        self.saved_paths = ws.DB_PATH, ws.SNAPSHOT_DIR
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        ws.configure(self.root / "workspace.sqlite3")
        sync.initialize(demo=True)

    def tearDown(self):
        ws.configure(*self.saved_paths)
        self.temp.cleanup()

    def command(self, *argv, stdin=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), patch("sys.stdin", io.StringIO(stdin or "")):
            code = cli.main(["--db", str(ws.DB_PATH), *argv])
        return code, out.getvalue(), err.getvalue()

    def agent(self, key="codex", name="Codex"):
        code, out, err = self.command("agents", "create", "--key", key, "--name", name)
        self.assertEqual((code, err), (0, ""))
        return json.loads(out)["agent"]

    def legacy_storage(self):
        with closing(ws.db()) as con:
            records = sync.rows(con)
            records.pop("actors")
            files = sync.files_for(records, sync.attachment_bytes(records, ws.DATA_DIR / "attachments"))
            con.execute("PRAGMA foreign_keys=OFF")
            con.execute("BEGIN IMMEDIATE")
            for table in sync.schema():
                con.execute(f'DROP TABLE "{table}"')
            for statement in ws.LEGACY_SCHEMA.split(";"):
                if statement.strip():
                    con.execute(statement)
            sync.insert_records(con, records)
            sync.begin_export(con, files)
            con.commit()
            sync.finish_export(con)
        return records, files

    def test_agent_workflow_and_distinct_authors(self):
        one, two = self.agent(), self.agent("reviewer", "Reviewer")
        self.assertGreater(one["id"], 5)
        self.assertNotEqual(one["id"], two["id"])
        payload = json.dumps({"title": "Agent issue", "teamId": 1, "assigneeId": two["id"]})
        code, out, err = self.command("--actor", str(one["id"]), "issues", "create", "--data", "-", stdin=payload)
        self.assertEqual((code, err), (0, ""))
        issue = json.loads(out)["issue"]
        self.assertEqual(issue["creator_id"], one["id"])
        self.assertEqual(issue["assignee_id"], two["id"])
        self.assertEqual(issue["creator"], "Codex (Agent)")
        self.assertEqual(issue["subscribers"][0]["id"], one["id"])
        ident = issue["identifier"]
        self.command("issues", "update", ident, "--status", "In Progress", "--actor", str(two["id"]))
        self.command("issues", "comment", ident, "--body", "Reviewed", "--actor", str(two["id"]))
        with closing(ws.db()) as con:
            result = ws.issue_row(con, issue["id"])
            self.assertEqual(result["comments"][0]["author"], "Reviewer (Agent)")
            self.assertEqual(result["comments"][0]["author_id"], two["id"])
            self.assertEqual({a["actor_id"] for a in result["activity"]}, {one["id"], two["id"]})
            self.assertEqual(len(ws.bootstrap(con)["members"]), 5)
        self.assertTrue(sync.validate()["valid"])

    def test_agent_relationships_and_defaults(self):
        agent = self.agent()["id"]
        result = sync.mutate("POST", "/api/projects", {"name": "Agent project", "actorId": agent})
        project = result["projectId"]
        team = sync.mutate("POST", "/api/teams", {"name": "Agent team", "key": "AGT", "actorId": agent})["teamId"]
        sync.mutate("PATCH", f"/api/teams/{team}", {"memberIds": [agent, 1]})
        view = sync.mutate("POST", "/api/views", {"name": "Agent view", "actorId": agent})["viewId"]
        sync.mutate("POST", f"/api/projects/{project}/updates", {"body": "Ready", "actorId": agent})
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT lead_id FROM projects WHERE id=?", (project,)).fetchone()[0], agent)
            self.assertEqual(con.execute("SELECT member_id FROM project_members WHERE project_id=?", (project,)).fetchone()[0], agent)
            self.assertEqual(con.execute("SELECT role FROM team_members WHERE team_id=? AND member_id=?", (team, agent)).fetchone()[0], "Lead")
            self.assertEqual(con.execute("SELECT owner_id FROM views WHERE id=?", (view,)).fetchone()[0], agent)
            self.assertEqual(con.execute("SELECT author_id FROM project_updates WHERE project_id=?", (project,)).fetchone()[0], agent)
            con.execute("INSERT INTO notifications(recipient_id,kind,title,created_at) VALUES(?,'comment','For agent',?)", (agent, ws.now()))
            con.commit()
        sync.export()
        code, out, _ = self.command("inbox", "list", "--actor", str(agent))
        self.assertEqual(code, 0)
        notification = json.loads(out)[0]
        sync.mutate("POST", f"/api/notifications/{notification['id']}/read", {"actorId": agent})
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT is_read FROM notifications WHERE id=?", (notification["id"],)).fetchone()[0], 1)

    def test_deactivation_preserves_history_and_existing_relations(self):
        agent = self.agent()["id"]
        issue = sync.mutate("POST", "/api/issues", {"title": "Keep history", "actorId": agent, "assigneeId": agent})["issue"]
        sync.mutate("POST", f"/api/agents/{agent}/deactivate", {})
        for data in ({"title": "Blocked", "actorId": agent}, {"title": "Blocked", "assigneeId": agent}, {"title": "Blocked", "subscriberIds": [agent]}):
            with self.assertRaises(sqlite3.IntegrityError):
                sync.mutate("POST", "/api/issues", data)
        sync.mutate("PATCH", f"/api/issues/{issue['identifier']}", {"title": "Still editable", "assigneeId": agent, "subscriberIds": [agent]})
        with closing(ws.db()) as con:
            self.assertEqual(ws.issue_row(con, issue["id"])["creator"], "Codex (Agent)")
        self.assertEqual(json.loads(self.command("agents", "list")[1]), [])
        self.assertEqual(json.loads(self.command("agents", "list", "--all")[1])[0]["id"], agent)
        sync.mutate("POST", f"/api/agents/{agent}/restore", {})
        sync.mutate("POST", "/api/issues", {"title": "Restored", "actorId": agent})
        self.assertTrue(sync.validate()["valid"])

    def test_agent_registration_and_validation(self):
        agent = self.agent()["id"]
        with self.assertRaises(sqlite3.IntegrityError):
            sync.mutate("POST", "/api/agents", {"key": "codex", "name": "Another"})
        for data in ({"key": "", "name": "Empty"}, {"key": "x", "name": ""}):
            with self.assertRaises(ValueError):
                sync.mutate("POST", "/api/agents", data)
        with self.assertRaises(ValueError):
            sync.mutate("PATCH", f"/api/agents/{agent}", {"key": "new", "name": "New"})
        sync.mutate("PATCH", f"/api/agents/{agent}", {"name": "Builder"})
        self.assertEqual(json.loads(self.command("agents", "show", str(agent))[1])["name"], "Builder")
        self.assertEqual(self.command("agents", "show", "1")[0], 2)
        self.assertEqual(self.command("agents", "delete", str(agent))[0], 2)
        with self.assertRaises(sqlite3.IntegrityError):
            sync.mutate("POST", "/api/issues", {"title": "Unknown", "actorId": 999})
        with self.assertRaises(ValueError):
            sync.mutate("POST", "/api/issues", {"title": "Invalid", "actorId": True})

    def test_import_and_automation_keep_agent_actor(self):
        agent = self.agent()["id"]
        sync.mutate("POST", "/api/automations", {"name": "Self assign", "trigger": {"event": "issue.created"}, "action": {"name": "Assign to me"}})
        result = sync.mutate("POST", "/api/import", {"actorId": agent, "issues": [{"title": "Imported", "actorId": 1}]})
        with closing(ws.db()) as con:
            issue = dict(con.execute("SELECT * FROM issues WHERE identifier=?", (result["created"][0],)).fetchone())
            self.assertEqual((issue["creator_id"], issue["assignee_id"]), (agent, agent))
        self.assertTrue(sync.validate()["valid"])

    def test_scheduler_keeps_member_actor_and_rejects_inactive_actor(self):
        sync.mutate("POST", "/api/recurring", {"title": "Recurring actor", "nextRun": "2000-01-01"})
        sync.run_recurring()
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT creator_id FROM issues WHERE title='Recurring actor'").fetchone()[0], 1)
            con.execute("UPDATE actors SET active=0 WHERE id=1")
            con.execute("UPDATE members SET active=0 WHERE id=1")
            con.execute("UPDATE recurring_rules SET next_run='2000-01-01'")
            con.commit()
        sync.export()
        with self.assertRaises(sqlite3.IntegrityError):
            sync.run_recurring()
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM issues WHERE title='Recurring actor'").fetchone()[0], 1)

    def test_agent_http_cli_parity(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        def request(method, path, data=None):
            req = Request(f"http://127.0.0.1:{httpd.server_port}{path}", method=method,
                          data=json.dumps(data).encode() if data is not None else None)
            with urlopen(req) as response:
                return json.load(response)
        try:
            agent = request("POST", "/api/agents", {"key": "http", "name": "HTTP"})["agent"]
            self.assertEqual(request("GET", f"/api/agents/{agent['id']}")["id"], agent["id"])
            self.assertEqual(request("GET", "/api/actors")[-1]["id"], agent["id"])
            for action, body in (("update", {"name": "Updated"}), ("deactivate", {}), ("restore", {})):
                method, route = cli.ACTIONS["agents"][action]
                response = request(method, route.format(id=agent["id"]), body)
                record = json.loads(self.command("agents", "show", str(agent["id"]))[1])
                self.assertEqual(response["agent"], record)
            with self.assertRaises(HTTPError) as error:
                request("DELETE", f"/api/agents/{agent['id']}", {})
            self.assertEqual(error.exception.code, 404)
            error.exception.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_describe_and_json_parse_errors_do_not_access_storage(self):
        target = self.root / "missing" / "db.sqlite3"
        with patch.object(ws, "configure", side_effect=AssertionError("Storage access")):
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(cli.main(["--db", str(target), "describe"]), 0)
        self.assertFalse(target.parent.exists())
        catalog = json.loads(out.getvalue())
        paths = {tuple(c["path"]) for c in catalog["commands"]}
        for resource, actions in cli.ACTIONS.items():
            for action in actions:
                self.assertIn((resource, action), paths)
        self.assertIn(("sync", "migrate"), paths)
        for argv in (["--json", "missing"], ["issues", "create", "--actor", "wrong", "--json"],
                     ["issues", "create", "--label-ids", "bad", "--json"],
                     ["issues", "show", "--json"]):
            code, out, err = self.command(*argv)
            self.assertEqual((code, out), (2, ""))
            self.assertEqual(json.loads(err)["code"], "invalid_input")

    def test_json_error_categories_and_pending_commit(self):
        agent = self.agent()["id"]
        code, out, err = self.command("issues", "create", "--title", "Bad", "--assignee-id", "999", "--json")
        self.assertEqual((code, out, json.loads(err)["code"]), (3, "", "relationship_conflict"))
        with patch.object(sync, "stage_files", side_effect=OSError("Disk full")):
            code, _, err = self.command("issues", "create", "--title", "Rollback", "--json")
            self.assertEqual((code, json.loads(err)["code"]), (4, "storage_error"))
        real = sync.recover
        calls = 0
        def fail_finish(con):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("Publish failed")
            return real(con)
        with patch.object(sync, "recover", side_effect=fail_finish):
            code, out, err = self.command("issues", "create", "--title", "Committed once", "--actor", str(agent), "--json")
        error = json.loads(err)
        self.assertEqual((code, out, error["code"]), (4, "", "pending_export"))
        self.assertTrue(error["committed"] and error["recoveryRequired"])
        sync.export()
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM issues WHERE title='Committed once'").fetchone()[0], 1)
        path = ws.SNAPSHOT_DIR / "issues/row-1.json"
        row = json.loads(path.read_text()); row["title"] = "Git edit"; path.write_bytes(sync.encode(row))
        code, _, err = self.command("issues", "create", "--title", "Conflict", "--json")
        self.assertEqual((code, json.loads(err)["code"]), (3, "sync_conflict"))

    def test_migrate_preserves_legacy_storage(self):
        sync.mutate("POST", "/api/issues/PRO-248/attachments", {"files": [{"name": "note", "data": "aGVsbG8="}]})
        old, files = self.legacy_storage()
        with self.assertRaisesRegex(ValueError, "sync migrate"):
            ws.db()
        self.assertTrue(sync.status()["migration_required"])
        result = sync.migrate()
        self.assertTrue(result["migrated"])
        with closing(sqlite3.connect(Path(result["backup"]) / "workspace.sqlite3")) as backup:
            self.assertFalse(backup.execute("SELECT 1 FROM sqlite_master WHERE name='actors'").fetchone())
        with closing(ws.db()) as con:
            current = sync.rows(con)
            self.assertEqual({k: v for k, v in current.items() if k != "actors"}, old)
            self.assertFalse(con.execute("PRAGMA foreign_key_check").fetchall())
        self.assertEqual(sync.disk_files(Path(result["backup"]) / "snapshot"), files)
        self.assertFalse(sync.migrate()["migrated"])
        self.assertTrue(sync.validate()["valid"])
        self.assertGreater(self.agent()["id"], max(m["id"] for m in old["members"]))

    def test_migrate_conflicts_and_rollback(self):
        old, files = self.legacy_storage()
        path = ws.SNAPSHOT_DIR / "issues/row-1.json"
        saved = path.read_bytes()
        row = json.loads(saved); row["title"] = "External"; path.write_bytes(sync.encode(row))
        with self.assertRaises(sync.SyncConflict):
            sync.migrate()
        path.write_bytes(saved)
        with patch.object(sync, "stage_files", side_effect=OSError("Disk full")):
            with self.assertRaises(OSError):
                sync.migrate()
        with closing(ws.db(allow_legacy=True)) as con:
            self.assertEqual(sync.rows(con), old)
        self.assertEqual(sync.disk_files(ws.SNAPSHOT_DIR), files)
        with closing(ws.db(allow_legacy=True)) as con:
            con.execute("UPDATE issues SET title='Outside' WHERE id=1"); con.commit()
        with self.assertRaises(sync.SyncConflict):
            sync.migrate()

    def test_migrate_publication_interruption_recovers(self):
        self.legacy_storage()
        with patch.object(sync, "finish_export", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                sync.migrate()
        self.assertTrue(sync.local_path("journal.json").exists())
        sync.prepare()
        self.assertEqual(json.loads((ws.SNAPSHOT_DIR / "manifest.json").read_text())["format_version"], 2)
        self.assertTrue(sync.validate()["valid"])

    def test_import_v1_preview_and_publish_v2(self):
        _, old_files = self.legacy_storage()
        # Import into a new database from a v1 snapshot.
        source = ws.SNAPSHOT_DIR
        ws.configure(self.root / "restore" / "workspace.sqlite3")
        shutil.copytree(source, ws.SNAPSHOT_DIR)
        self.assertTrue(sync.validate()["valid"])
        preview = sync.import_snapshot(dry_run=True)
        self.assertIn("actors/row-1.json", preview["added"])
        self.assertFalse(ws.DB_PATH.exists())
        self.assertEqual(sync.disk_files(ws.SNAPSHOT_DIR), old_files)
        sync.import_snapshot()
        self.assertEqual(json.loads((ws.SNAPSHOT_DIR / "manifest.json").read_text())["format_version"], 2)
        self.assertFalse(sync.status()["files_changed"])
        self.assertFalse(sync.status()["database_changed"])
        self.agent()
        sync.export()
        self.assertTrue(sync.validate()["valid"])

    def test_old_database_conflicts_can_be_reconciled(self):
        self.legacy_storage()
        with closing(ws.db(allow_legacy=True)) as con:
            con.execute("UPDATE issues SET title='Outside edit' WHERE id=1"); con.commit()
        sync.export()
        self.assertTrue(sync.migrate()["migrated"])
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT title FROM issues WHERE id=1").fetchone()[0], "Outside edit")

    def test_import_into_old_database_upgrades_references(self):
        self.legacy_storage()
        path = ws.SNAPSHOT_DIR / "issues/row-1.json"
        row = json.loads(path.read_text()); row["title"] = "Git edit"; path.write_bytes(sync.encode(row))
        with self.assertRaises(sync.SyncConflict):
            sync.migrate()
        sync.import_snapshot(dry_run=True)
        with self.assertRaisesRegex(ValueError, "sync migrate"):
            ws.db()
        sync.import_snapshot()
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT title FROM issues WHERE id=1").fetchone()[0], "Git edit")
            self.assertFalse(con.execute("PRAGMA foreign_key_check").fetchall())
        self.assertEqual(json.loads((ws.SNAPSHOT_DIR / "manifest.json").read_text())["format_version"], 2)

    def test_v1_import_snapshot_swap_recovers(self):
        self.legacy_storage()
        source = ws.SNAPSHOT_DIR
        ws.configure(self.root / "interrupted" / "workspace.sqlite3")
        shutil.copytree(source, ws.SNAPSHOT_DIR)
        replace = Path.replace
        def interrupt_after_swap(path, destination):
            result = replace(path, destination)
            if path == ws.SNAPSHOT_DIR:
                raise KeyboardInterrupt()
            return result
        with patch.object(Path, "replace", interrupt_after_swap):
            with self.assertRaises(KeyboardInterrupt):
                sync.import_snapshot()
        self.assertFalse(ws.SNAPSHOT_DIR.exists())
        sync.prepare()
        self.assertTrue(sync.validate()["valid"])
        self.assertFalse(sync.local_path("journal.json").exists())
        self.assertFalse(sync.status()["database_changed"])

    def test_v1_import_rollback_keeps_old_files(self):
        _, old_files = self.legacy_storage()
        source = ws.SNAPSHOT_DIR
        ws.configure(self.root / "rollback" / "workspace.sqlite3")
        shutil.copytree(source, ws.SNAPSHOT_DIR)
        replace = Path.replace
        def interrupt_before_commit(path, destination):
            result = replace(path, destination)
            if path.name.startswith(".sync-import-") and not path.name.endswith("-old"):
                raise KeyboardInterrupt()
            return result
        with patch.object(Path, "replace", interrupt_before_commit):
            with self.assertRaises(KeyboardInterrupt):
                sync.import_snapshot()
        with closing(ws.db()) as con:
            sync.recover(con)
        self.assertEqual(sync.disk_files(ws.SNAPSHOT_DIR), old_files)
        sync.import_snapshot()
        self.assertTrue(sync.validate()["valid"])

    def test_migrate_recovers_old_pending_publication(self):
        self.legacy_storage()
        with closing(ws.db(allow_legacy=True)) as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute("UPDATE issues SET title='Committed before upgrade' WHERE id=1")
            sync.begin_export(con, sync.database_files(con))
            con.commit()
        self.assertTrue(sync.local_path("journal.json").exists())
        sync.migrate()
        with closing(ws.db()) as con:
            self.assertEqual(con.execute("SELECT title FROM issues WHERE id=1").fetchone()[0], "Committed before upgrade")
        self.assertTrue(sync.validate()["valid"])

    def test_v2_agent_round_trip_and_invalid_actor_records(self):
        agent = self.agent()["id"]
        sync.mutate("POST", "/api/issues", {"title": "Agent snapshot", "actorId": agent, "assigneeId": agent})
        original = sync.disk_files(ws.SNAPSHOT_DIR)
        source = ws.SNAPSHOT_DIR
        ws.configure(self.root / "roundtrip" / "workspace.sqlite3")
        shutil.copytree(source, ws.SNAPSHOT_DIR)
        sync.import_snapshot()
        with closing(ws.db()) as con:
            self.assertEqual(sync.database_files(con), original)
        row_path = ws.SNAPSHOT_DIR / "actors/row-1.json"
        row = json.loads(row_path.read_text()); row["member_id"] = None
        row_path.write_bytes(sync.encode(row))
        with self.assertRaises(ValueError):
            sync.validate()


if __name__ == "__main__":
    unittest.main()
