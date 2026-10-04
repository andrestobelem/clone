"""Store complete workspace snapshots as stable files."""
from contextlib import contextmanager, closing
from functools import lru_cache
from pathlib import Path
import fcntl
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import uuid
from urllib.parse import quote

import workspace as ws


class SyncConflict(Exception):
    pass


class PendingExport(Exception):
    pass


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2,
                       allow_nan=False) + "\n").encode("utf-8")


def local_path(name):
    return ws.DB_PATH.parent / (".sync-" + ws.DB_PATH.name + "-" + name)


@contextmanager
def locked():
    ws.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with local_path("lock").open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with temp.open("wb") as handle:
        handle.write(encode(value))
        handle.flush()
        os.fsync(handle.fileno())
    temp.replace(path)


def read_json(path):
    try:
        return json.loads(path.read_text("utf-8"), parse_constant=lambda v: (_ for _ in ()).throw(ValueError("Invalid JSON number")))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid JSON: {path}") from error


@lru_cache(maxsize=1)
def schema():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript(ws.SCHEMA)
    result = {}
    for row in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        fields = [dict(r) for r in con.execute(f'PRAGMA table_info("{row[0]}")')]
        result[row[0]] = {"columns": [r["name"] for r in fields],
                          "primary_key": [r["name"] for r in sorted(fields, key=lambda r: r["pk"]) if r["pk"]]}
    con.close()
    return result


def record_name(row, spec):
    return "row-" + "--".join(quote(str(row[key]), safe="") for key in spec["primary_key"]) + ".json"


def rows(con):
    expected = schema()
    actual = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    if actual - set(expected) - ws.REMOVED_TABLES - {"__sync_meta"} or set(expected) - actual:
        raise ValueError("Database tables do not match the supported schema")
    result = {}
    for table, spec in expected.items():
        columns = [r[1] for r in con.execute(f'PRAGMA table_info("{table}")')]
        if columns != spec["columns"] and not (table == "team_resources" and columns == spec["columns"] + ["document_id"]):
            raise ValueError(f"Database columns do not match: {table}")
        order = ",".join('"' + key + '"' for key in spec["primary_key"])
        selected = ",".join('"' + key + '"' for key in spec["columns"])
        result[table] = [dict(r) for r in con.execute(f'SELECT {selected} FROM "{table}" ORDER BY {order}')]
    return result


def attachment_bytes(records, folder):
    if folder.is_symlink():
        raise ValueError("Attachment directory must not be a symbolic link")
    result = {}
    for row in records["issue_attachments"]:
        name = row["storage_name"]
        if not isinstance(name, str) or not name or Path(name).name != name or name in (".", "..") or "\\" in name:
            raise ValueError("Unsafe attachment path")
        path = folder / name
        if path.is_symlink() or not path.is_file() or path.resolve().parent != folder.resolve():
            raise ValueError(f"Attachment file not found or unsafe: {name}")
        content = path.read_bytes()
        if len(content) != row["size"]:
            raise ValueError(f"Attachment size does not match: {name}")
        result[name] = content
    return result


def files_for(records, attachments):
    specs = schema()
    files = {"manifest.json": encode({"format_version": 1, "tables": specs})}
    for table, entries in records.items():
        for row in entries:
            files[f"{table}/{record_name(row, specs[table])}"] = encode(row)
    for name, content in attachments.items():
        files["attachments/" + name] = content
    return files


def digest(files):
    h = hashlib.sha256()
    for name, content in sorted(files.items()):
        h.update(encode([name, hashlib.sha256(content).hexdigest()]))
    return h.hexdigest()


def disk_files(folder):
    if folder.is_symlink():
        raise ValueError("Snapshot directory must not be a symbolic link")
    if not folder.exists():
        return {}
    if not folder.is_dir():
        raise ValueError("Snapshot path must be a directory")
    files = {}
    for path in folder.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Symbolic links are not allowed: {path}")
        if path.is_file():
            files[path.relative_to(folder).as_posix()] = path.read_bytes()
    return files


def database_files(con):
    records = rows(con)
    return files_for(records, attachment_bytes(records, ws.DATA_DIR / "attachments"))


def differences(before, after):
    return {"added": sorted(set(after) - set(before)),
            "changed": sorted(k for k in set(before) & set(after) if before[k] != after[k]),
            "deleted": sorted(set(before) - set(after))}


def state():
    path = local_path("state.json")
    value = read_json(path) if path.exists() else None
    if value and value["snapshot_dir"] != str(ws.SNAPSHOT_DIR):
        raise SyncConflict("Snapshot path changed. Use sync export --force or sync import --force.")
    return value


def save_state(files, database=None):
    write_json(local_path("state.json"), {"snapshot_dir": str(ws.SNAPSHOT_DIR), "digest": digest(files), "database_digest": digest(database if database is not None else files)})


def token(con):
    found = con.execute("SELECT 1 FROM sqlite_master WHERE name='__sync_meta'").fetchone()
    return con.execute("SELECT token FROM __sync_meta WHERE id=1").fetchone()[0] if found else None


def set_token(con, value):
    con.execute("CREATE TABLE IF NOT EXISTS __sync_meta(id INTEGER PRIMARY KEY, token TEXT NOT NULL)")
    con.execute("INSERT INTO __sync_meta VALUES(1,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token", (value,))


def stage_files(files):
    ws.SNAPSHOT_DIR.parent.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix=".sync-stage-", dir=ws.SNAPSHOT_DIR.parent))
    for name, content in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    return folder


def cleanup(path):
    if path.exists():
        shutil.rmtree(path)


def recover(con):
    path = local_path("journal.json")
    if not path.exists():
        return
    journal = read_json(path)
    if journal["snapshot_dir"] != str(ws.SNAPSHOT_DIR):
        raise SyncConflict("Use the previous snapshot path to recover the pending operation")
    stage = Path(journal["stage"])
    backup = Path(journal["backup"])
    committed = token(con) == journal["token"]
    if journal["kind"] == "import":
        live = ws.DATA_DIR / "attachments"
        if not committed and backup.exists():
            cleanup(live)
            backup.replace(live)
        elif not committed and journal["no_old_attachments"] and not stage.exists():
            cleanup(live)
        cleanup(stage)
        cleanup(backup)
        if committed:
            write_json(local_path("state.json"), {"snapshot_dir": str(ws.SNAPSHOT_DIR),
                                                   "digest": journal["incoming_digest"],
                                                   "database_digest": digest(database_files(con))})
        path.unlink()
        return
    if not committed:
        cleanup(stage)
        path.unlink()
        return
    existing = disk_files(ws.SNAPSHOT_DIR)
    current = digest(existing)
    if current != journal["desired"]:
        if current != journal["previous"] and (ws.SNAPSHOT_DIR.exists() or not backup.exists()):
            raise SyncConflict("Snapshot changed during a pending export. Restore the files before recovery.")
        if not stage.exists():
            raise PendingExport("Committed data needs export, but the staged snapshot is missing")
        if ws.SNAPSHOT_DIR.exists():
            if backup.exists():
                cleanup(backup)
            ws.SNAPSHOT_DIR.replace(backup)
        stage.replace(ws.SNAPSHOT_DIR)
    save_state(disk_files(ws.SNAPSHOT_DIR))
    cleanup(stage)
    cleanup(backup)
    path.unlink()


def check_files(con):
    recover(con)
    saved = state()
    existing = disk_files(ws.SNAPSHOT_DIR)
    current = digest(database_files(con))
    if saved:
        if digest(existing) != saved["digest"]:
            raise SyncConflict("Snapshot files changed. Run sync import before writing.")
        if current != saved.get("database_digest", saved["digest"]):
            raise SyncConflict("Database has changes outside synchronization. Run sync export first.")
    elif existing and digest(existing) != current:
        raise SyncConflict("Snapshot and database differ. Run sync import or sync export --force.")


def begin_export(con, files, previous=None):
    actual = digest(disk_files(ws.SNAPSHOT_DIR))
    if previous is not None and actual != previous:
        raise SyncConflict("Snapshot files changed during the operation. Run sync import.")
    stage = stage_files(files)
    value = uuid.uuid4().hex
    journal = {"kind": "export", "token": value, "snapshot_dir": str(ws.SNAPSHOT_DIR),
               "stage": str(stage), "backup": str(stage.with_name(stage.name + "-old")),
               "previous": actual, "desired": digest(files)}
    write_json(local_path("journal.json"), journal)
    set_token(con, value)


def finish_export(con):
    try:
        recover(con)
    except Exception as error:
        raise PendingExport("Change committed. Snapshot export is pending: " + str(error)) from error


def mutate(method, path, data, con=None):
    with locked():
        own = con is None
        con = con or ws.db()
        folder = ws.DATA_DIR / "attachments"
        previous_attachments = {p.name for p in folder.iterdir()} if folder.is_dir() else set()
        try:
            check_files(con)
            previous = digest(disk_files(ws.SNAPSHOT_DIR))
            con.execute("BEGIN IMMEDIATE")
            ws.remove_unused_tables(con)
            result = ws.dispatch_mutation(con, method, path, data)
            if result.get("_status", 200) >= 400:
                con.rollback()
                return result
            begin_export(con, database_files(con), previous)
            con.commit()
            finish_export(con)
            return result
        except Exception:
            con.rollback()
            referenced = {r[0] for r in con.execute("SELECT storage_name FROM issue_attachments")}
            if folder.is_dir() and not folder.is_symlink():
                for path in folder.iterdir():
                    if path.name not in previous_attachments and path.name not in referenced and path.is_file():
                        path.unlink()
            raise
        finally:
            if own:
                con.close()


def prepare():
    with locked(), closing(ws.db()) as con:
        check_files(con)
        con.execute("BEGIN IMMEDIATE")
        changed = ws.remove_unused_tables(con)
        if changed or not state():
            begin_export(con, database_files(con))
            con.commit()
            finish_export(con)
        else:
            con.rollback()


def initialize(demo=False):
    with locked():
        if ws.DB_PATH.exists() or disk_files(ws.SNAPSHOT_DIR):
            raise SyncConflict("Database or snapshot already exists. Use sync import for a snapshot.")
        with closing(ws.db(create=True)) as con:
            con.executescript(ws.SCHEMA)
            con.execute("BEGIN IMMEDIATE")
            if demo:
                ws.seed(con)
            else:
                con.execute("INSERT INTO workspace VALUES(1,'Workspace','A',?)", (ws.now(),))
                con.execute("INSERT INTO members(id,name,email,created_at) VALUES(1,'Local member','local@localhost',?)", (ws.now(),))
            begin_export(con, database_files(con))
            con.commit()
            finish_export(con)
    return {"database": str(ws.DB_PATH), "snapshot": str(ws.SNAPSHOT_DIR)}


def run_recurring():
    with locked(), closing(ws.db()) as con:
        check_files(con)
        con.execute("BEGIN IMMEDIATE")
        previous = digest(disk_files(ws.SNAPSHOT_DIR))
        cleaned = ws.remove_unused_tables(con)
        count = ws.run_due_recurring(con)
        if count or cleaned:
            begin_export(con, database_files(con), previous)
        con.commit()
        if count or cleaned:
            finish_export(con)
        return {"created": count}


def backup_database(con):
    root = ws.DATA_DIR / "backups" / (ws.now().replace(":", "-") + "-" + uuid.uuid4().hex[:8])
    root.mkdir(parents=True)
    with closing(sqlite3.connect(root / "workspace.sqlite3")) as target:
        con.backup(target)
    if (ws.DATA_DIR / "attachments").exists():
        shutil.copytree(ws.DATA_DIR / "attachments", root / "attachments")
    return str(root)


def export(force=False, dry_run=False):
    with locked(), closing(ws.db()) as con:
        recover(con)
        con.execute("BEGIN IMMEDIATE")
        existing = disk_files(ws.SNAPSHOT_DIR)
        files = database_files(con)
        saved = None if force else state()
        if not force and existing and digest(existing) != (saved["digest"] if saved else digest(files)):
            raise SyncConflict("Snapshot files changed. Import them or use --force.")
        result = differences(existing, files)
        if dry_run:
            con.rollback()
            return result
        if force:
            con.rollback()
            result["backup"] = backup_database(con)
            if existing:
                shutil.copytree(ws.SNAPSHOT_DIR, Path(result["backup"]) / "snapshot")
            con.execute("BEGIN IMMEDIATE")
        ws.remove_unused_tables(con)
        begin_export(con, files, digest(existing))
        con.commit()
        finish_export(con)
        return result


def load_snapshot():
    files = disk_files(ws.SNAPSHOT_DIR)
    if "manifest.json" not in files:
        raise ValueError("Snapshot manifest not found")
    manifest = read_json(ws.SNAPSHOT_DIR / "manifest.json")
    specs = schema()
    if manifest != {"format_version": 1, "tables": specs}:
        raise ValueError("Unsupported snapshot version or schema")
    records = {name: [] for name in specs}
    known = {"manifest.json"}
    for table, spec in specs.items():
        for name in sorted(files):
            if not name.startswith(table + "/"):
                continue
            if len(Path(name).parts) != 2 or not name.endswith(".json"):
                raise ValueError(f"Invalid record path: {name}")
            row = read_json(ws.SNAPSHOT_DIR / name)
            if not isinstance(row, dict) or set(row) != set(spec["columns"]):
                raise ValueError(f"Invalid record fields: {name}")
            if any(row[k] is None or isinstance(row[k], (dict, list, bool)) for k in spec["primary_key"]):
                raise ValueError(f"Invalid record key: {name}")
            if name != table + "/" + record_name(row, spec):
                raise ValueError(f"Record filename does not match its key: {name}")
            if any(isinstance(v, (dict, list)) for v in row.values()):
                raise ValueError(f"Invalid field value: {name}")
            records[table].append(row)
            known.add(name)
    attachments = attachment_bytes(records, ws.SNAPSHOT_DIR / "attachments")
    known.update("attachments/" + name for name in attachments)
    if set(files) != known:
        raise ValueError("Snapshot contains unknown files")
    candidate = sqlite3.connect(":memory:")
    candidate.row_factory = sqlite3.Row
    candidate.executescript(ws.SCHEMA)
    candidate.execute("PRAGMA foreign_keys=ON")
    candidate.execute("BEGIN")
    candidate.execute("PRAGMA defer_foreign_keys=ON")
    try:
        insert_records(candidate, records)
        if candidate.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Snapshot contains invalid references")
        for r in candidate.execute("SELECT i.id FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.team_id!=s.team_id"):
            raise ValueError(f"Issue {r[0]} has a workflow status from another team")
        if candidate.execute("SELECT 1 FROM issues i WHERE i.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project_teams p WHERE p.project_id=i.project_id AND p.team_id=i.team_id)").fetchone():
            raise ValueError("Issue team is not linked to its project")
        for row in records["issues"] + records["projects"]:
            if type(row["priority"]) is not int or not 0 <= row["priority"] <= 4:
                raise ValueError("Invalid priority")
        for entries in records.values():
            for row in entries:
                for key, value in row.items():
                    if key.endswith("_json") or (key == "payload" and "action" in row):
                        if not isinstance(value, str):
                            raise ValueError("JSON fields must contain JSON text")
                        json.loads(value)
        candidate.commit()
        canonical = rows(candidate)
        if encode(canonical) != encode({t: sorted(entries, key=lambda r: tuple(r[k] for k in specs[t]["primary_key"])) for t, entries in records.items()}):
            raise ValueError("Snapshot field types do not match SQLite column types")
    except sqlite3.Error as error:
        raise ValueError("Invalid snapshot records: " + str(error)) from error
    finally:
        candidate.close()
    return records, attachments, files


def insert_records(con, records):
    for table, entries in records.items():
        columns = schema()[table]["columns"]
        names = ",".join('"' + c + '"' for c in columns)
        placeholders = ",".join("?" for _ in columns)
        con.executemany(f'INSERT INTO "{table}"({names}) VALUES({placeholders})',
                        [[r[c] for c in columns] for r in entries])


def validate():
    with locked():
        records, attachments, _ = load_snapshot()
        return {"valid": True, "records": sum(map(len, records.values())), "attachments": len(attachments)}


def status():
    with locked():
        existing = disk_files(ws.SNAPSHOT_DIR)
        if not ws.DB_PATH.exists():
            return {"database_exists": False, "snapshot_exists": bool(existing)}
        with closing(ws.db()) as con:
            recover(con)
            existing = disk_files(ws.SNAPSHOT_DIR)
            files = database_files(con)
            saved = state()
            return {"database_exists": True, "snapshot_exists": bool(existing),
                    "files_changed": bool(saved and digest(existing) != saved["digest"]),
                    "database_changed": bool(saved and digest(files) != saved.get("database_digest", saved["digest"])),
                    "differences": differences(files, existing)}


def import_snapshot(force=False, dry_run=False):
    with locked():
        existed = ws.DB_PATH.exists()
        con = ws.db() if existed else None
        committed = False
        try:
            if con:
                recover(con)
            records, attachments, incoming = load_snapshot()
            current = database_files(con) if con else {}
            saved = None if force else state()
            if existed and not force and digest(current) != (saved.get("database_digest", saved["digest"]) if saved else digest(files_for(records, attachments))):
                raise SyncConflict("Database has changes that import would discard. Export them or use --force.")
            result = differences(current, files_for(records, attachments))
            if dry_run:
                return result
            if con:
                result["backup"] = backup_database(con)
            else:
                con = ws.db(create=True)
                con.executescript(ws.SCHEMA)
            stage = Path(tempfile.mkdtemp(prefix=".sync-import-", dir=ws.DATA_DIR))
            for name, content in attachments.items():
                (stage / name).write_bytes(content)
            live = ws.DATA_DIR / "attachments"
            if live.is_symlink():
                cleanup(stage)
                raise ValueError("Attachment directory must not be a symbolic link")
            backup = stage.with_name(stage.name + "-old")
            value = uuid.uuid4().hex
            journal = {"kind": "import", "token": value, "snapshot_dir": str(ws.SNAPSHOT_DIR),
                       "stage": str(stage), "backup": str(backup), "no_old_attachments": not live.exists(),
                       "incoming_digest": digest(incoming)}
            con.execute("BEGIN IMMEDIATE")
            con.execute("PRAGMA defer_foreign_keys=ON")
            ws.remove_unused_tables(con)
            for statement in ws.SCHEMA.split(";"):
                if statement.strip():
                    con.execute(statement)
            for table in schema():
                con.execute(f'DELETE FROM "{table}"')
            insert_records(con, records)
            set_token(con, value)
            write_json(local_path("journal.json"), journal)
            if live.exists():
                live.replace(backup)
            stage.replace(live)
            con.commit()
            committed = True
            try:
                recover(con)
            except Exception as error:
                raise PendingExport("Import committed. Synchronization recovery is pending: " + str(error)) from error
            return result
        except Exception:
            if con and not committed:
                con.rollback()
                recover(con)
            raise
        finally:
            if con:
                con.close()
