#!/usr/bin/env python3
"""Local, single-user Linear-style workspace backed by SQLite."""

from __future__ import annotations

import json
import mimetypes
import re
import sqlite3
import base64
import calendar
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

from validation import mutation_payload

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "workspace.sqlite3"
PRIORITIES = ["Urgent", "High", "Medium", "Low", "No priority"]
ISSUE_STATUSES = [
    ("Backlog", "Backlog"), ("Todo", "Unstarted"), ("In Progress", "Started"),
    ("In Review", "Started"), ("Done", "Completed"), ("Canceled", "Canceled"),
    ("Duplicate", "Duplicate"),
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ago(days: int = 0, hours: int = 0, minutes: int = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days, hours=hours, minutes=minutes)).isoformat(timespec="seconds")


def configure(database=None, snapshot=None):
    global DB_PATH, DATA_DIR, SNAPSHOT_DIR
    if database is not None:
        DB_PATH = Path(database).resolve()
        DATA_DIR = DB_PATH.parent
    SNAPSHOT_DIR = Path(snapshot).resolve() if snapshot else DATA_DIR / "snapshot"
    if DATA_DIR.is_relative_to(SNAPSHOT_DIR) or SNAPSHOT_DIR.is_relative_to(DATA_DIR / "attachments") or SNAPSHOT_DIR.is_relative_to(DATA_DIR / "backups"):
        raise ValueError("Snapshot directory must be separate from database storage, attachments, and backups")


SNAPSHOT_DIR = DATA_DIR / "snapshot"
REMOVED_TABLES = {"documents", "reviews", "agent_threads", "agent_messages"}


def db(create=False, allow_legacy=False) -> sqlite3.Connection:
    if create:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(DB_PATH, timeout=15)
    else:
        if not DB_PATH.is_file():
            raise ValueError("Database not found. Run init or sync import first.")
        con = sqlite3.connect(DB_PATH.as_uri() + "?mode=rw", uri=True, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    if not create and not allow_legacy and not con.execute("SELECT 1 FROM sqlite_master WHERE name='actors'").fetchone():
        con.close()
        raise ValueError("Database needs migration. Run uv run python cli.py sync migrate.")
    con.execute("PRAGMA journal_mode = WAL")
    return con


LEGACY_SCHEMA = """
CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'A', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'Member',
  avatar_color TEXT NOT NULL DEFAULT '#d8b5a4', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '✳', timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  estimate_type TEXT NOT NULL DEFAULT 'Points', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id), member_id INTEGER NOT NULL REFERENCES members(id),
  role TEXT NOT NULL DEFAULT 'Member', PRIMARY KEY(team_id, member_id)
);
CREATE TABLE IF NOT EXISTS issue_statuses (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), name TEXT NOT NULL,
  category TEXT NOT NULL, position INTEGER NOT NULL, color TEXT NOT NULL DEFAULT '#8e8e98', is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#8585cc', team_id INTEGER REFERENCES teams(id),
  UNIQUE(name, team_id)
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Backlog', priority INTEGER NOT NULL DEFAULT 4, icon TEXT NOT NULL DEFAULT '◈',
  lead_id INTEGER REFERENCES members(id), start_date TEXT, target_date TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_teams (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, team_id INTEGER NOT NULL REFERENCES teams(id),
  PRIMARY KEY(project_id, team_id)
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id),
  PRIMARY KEY(project_id, member_id)
);
CREATE TABLE IF NOT EXISTS project_labels (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY(project_id, label_id)
);
CREATE TABLE IF NOT EXISTS project_dependencies (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES projects(id), dependency_type TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY(project_id, depends_on_id)
);
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), name TEXT NOT NULL,
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Upcoming', capacity REAL NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'Todo', position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_updates (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  health TEXT NOT NULL DEFAULT 'On track', body TEXT NOT NULL, author_id INTEGER REFERENCES members(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY, identifier TEXT NOT NULL UNIQUE, number INTEGER NOT NULL, team_id INTEGER NOT NULL REFERENCES teams(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status_id INTEGER NOT NULL REFERENCES issue_statuses(id),
  priority INTEGER NOT NULL DEFAULT 4, assignee_id INTEGER REFERENCES members(id), creator_id INTEGER REFERENCES members(id),
  project_id INTEGER REFERENCES projects(id), cycle_id INTEGER REFERENCES cycles(id), milestone_id INTEGER REFERENCES milestones(id),
  due_date TEXT, estimate REAL, parent_id INTEGER REFERENCES issues(id), recurring_rule TEXT, external_url TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY(issue_id, label_id)
);
CREATE TABLE IF NOT EXISTS issue_subscribers (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id),
  PRIMARY KEY(issue_id, member_id)
);
CREATE TABLE IF NOT EXISTS issue_relations (
  id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  related_issue_id INTEGER REFERENCES issues(id), relation_type TEXT NOT NULL DEFAULT 'relates to', url TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES members(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_attachments (
  id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  name TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL,
  storage_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
  actor_id INTEGER REFERENCES members(id), action TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '◈',
  entity TEXT NOT NULL DEFAULT 'issues', scope TEXT NOT NULL DEFAULT 'Personal', owner_id INTEGER REFERENCES members(id),
  team_id INTEGER REFERENCES teams(id), filters_json TEXT NOT NULL DEFAULT '{}', display_json TEXT NOT NULL DEFAULT '{}',
  is_favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_resources (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  section TEXT NOT NULL DEFAULT 'Resources', title TEXT NOT NULL, url TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, recipient_id INTEGER NOT NULL REFERENCES members(id), kind TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', entity_type TEXT, entity_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recurring_rules (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL, next_run TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), name TEXT NOT NULL, trigger_json TEXT NOT NULL,
  condition_json TEXT NOT NULL DEFAULT '{}', action_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

"""


SCHEMA = """
CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'A', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'Member',
  avatar_color TEXT NOT NULL DEFAULT '#d8b5a4', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('member','agent')),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  member_id INTEGER UNIQUE REFERENCES members(id), key TEXT UNIQUE, avatar_color TEXT NOT NULL DEFAULT '#8585cc',
  created_at TEXT NOT NULL,
  CHECK((kind='member' AND member_id IS NOT NULL AND member_id=id AND key IS NULL) OR
        (kind='agent' AND member_id IS NULL AND key IS NOT NULL AND length(trim(key)) > 0))
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '✳', timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  estimate_type TEXT NOT NULL DEFAULT 'Points', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id), member_id INTEGER NOT NULL REFERENCES actors(id),
  role TEXT NOT NULL DEFAULT 'Member', PRIMARY KEY(team_id, member_id)
);
CREATE TABLE IF NOT EXISTS issue_statuses (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), name TEXT NOT NULL,
  category TEXT NOT NULL, position INTEGER NOT NULL, color TEXT NOT NULL DEFAULT '#8e8e98', is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#8585cc', team_id INTEGER REFERENCES teams(id),
  UNIQUE(name, team_id)
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Backlog', priority INTEGER NOT NULL DEFAULT 4, icon TEXT NOT NULL DEFAULT '◈',
  lead_id INTEGER REFERENCES actors(id), start_date TEXT, target_date TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_teams (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, team_id INTEGER NOT NULL REFERENCES teams(id),
  PRIMARY KEY(project_id, team_id)
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES actors(id),
  PRIMARY KEY(project_id, member_id)
);
CREATE TABLE IF NOT EXISTS project_labels (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY(project_id, label_id)
);
CREATE TABLE IF NOT EXISTS project_dependencies (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES projects(id), dependency_type TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY(project_id, depends_on_id)
);
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), name TEXT NOT NULL,
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Upcoming', capacity REAL NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'Todo', position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_updates (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  health TEXT NOT NULL DEFAULT 'On track', body TEXT NOT NULL, author_id INTEGER REFERENCES actors(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY, identifier TEXT NOT NULL UNIQUE, number INTEGER NOT NULL, team_id INTEGER NOT NULL REFERENCES teams(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status_id INTEGER NOT NULL REFERENCES issue_statuses(id),
  priority INTEGER NOT NULL DEFAULT 4, assignee_id INTEGER REFERENCES actors(id), creator_id INTEGER REFERENCES actors(id),
  project_id INTEGER REFERENCES projects(id), cycle_id INTEGER REFERENCES cycles(id), milestone_id INTEGER REFERENCES milestones(id),
  due_date TEXT, estimate REAL, parent_id INTEGER REFERENCES issues(id), recurring_rule TEXT, external_url TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY(issue_id, label_id)
);
CREATE TABLE IF NOT EXISTS issue_subscribers (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES actors(id),
  PRIMARY KEY(issue_id, member_id)
);
CREATE TABLE IF NOT EXISTS issue_relations (
  id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  related_issue_id INTEGER REFERENCES issues(id), relation_type TEXT NOT NULL DEFAULT 'relates to', url TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES actors(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_attachments (
  id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  name TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL,
  storage_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
  actor_id INTEGER REFERENCES actors(id), action TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '◈',
  entity TEXT NOT NULL DEFAULT 'issues', scope TEXT NOT NULL DEFAULT 'Personal', owner_id INTEGER REFERENCES actors(id),
  team_id INTEGER REFERENCES teams(id), filters_json TEXT NOT NULL DEFAULT '{}', display_json TEXT NOT NULL DEFAULT '{}',
  is_favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_resources (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  section TEXT NOT NULL DEFAULT 'Resources', title TEXT NOT NULL, url TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, recipient_id INTEGER NOT NULL REFERENCES actors(id), kind TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', entity_type TEXT, entity_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recurring_rules (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL, next_run TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), name TEXT NOT NULL, trigger_json TEXT NOT NULL,
  condition_json TEXT NOT NULL DEFAULT '{}', action_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

"""





def seed(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)
    if con.execute("SELECT COUNT(*) FROM workspace").fetchone()[0]:
        return
    stamp = now()
    con.execute("INSERT INTO workspace(id,name,icon,created_at) VALUES(1,?,?,?)", ("Acme Studio", "A", stamp))
    people = [
        (1, "Alex Morgan", "alex@acme.local", "Workspace admin", "#cda58f"),
        (2, "Maya Chen", "maya@acme.local", "Member", "#ac95d4"),
        (3, "Sam Rivera", "sam@acme.local", "Member", "#79a99b"),
        (4, "Jordan Lee", "jordan@acme.local", "Member", "#d79da5"),
        (5, "Taylor Kim", "taylor@acme.local", "Member", "#88a8ce"),
    ]
    con.executemany("INSERT INTO members(id,name,email,role,avatar_color,created_at) VALUES(?,?,?,?,?,?)", [p + (stamp,) for p in people])
    create_member_actors(con)
    con.executemany("INSERT INTO teams(id,name,key,description,icon,created_at) VALUES(?,?,?,?,?,?)", [
        (1, "Product", "PRO", "Build a product people love.", "✳", stamp),
        (2, "Design", "DSN", "Shape a clear, considered experience.", "◇", stamp),
    ])
    team_members = [(1, 1, "Lead"), (1, 2, "Member"), (1, 3, "Member"), (1, 4, "Member"), (2, 1, "Lead"), (2, 2, "Member"), (2, 4, "Member"), (2, 5, "Member")]
    con.executemany("INSERT INTO team_members(team_id,member_id,role) VALUES(?,?,?)", team_members)
    colors = {"Backlog":"#a3a3ad", "Todo":"#6e9dd5", "In Progress":"#8584dd", "In Review":"#b881d2", "Done":"#54b58b", "Canceled":"#8b8b93", "Duplicate":"#8b8b93"}
    for team_id in (1, 2):
        for pos, (name, category) in enumerate(ISSUE_STATUSES):
            con.execute("INSERT INTO issue_statuses(team_id,name,category,position,color,is_default) VALUES(?,?,?,?,?,?)", (team_id, name, category, pos, colors[name], int(name == "Backlog")))
    labels = [(1,"Feature","#7c78d8",1),(2,"Bug","#d96c68",1),(3,"Improvement","#6394d4",1),(4,"Design","#c27ad2",1),(5,"Urgent","#e3a74f",1),(6,"Accessibility","#58a88d",1),(7,"Frontend","#7496d4",1),(8,"Research","#c58e58",2)]
    con.executemany("INSERT INTO labels(id,name,color,team_id) VALUES(?,?,?,?)", labels)
    cycles = [(1,1,"Cycle 24",ago(days=7),ago(days=-7),"Active",24,stamp),(2,1,"Cycle 25",ago(days=-7),ago(days=-21),"Upcoming",24,stamp),(3,2,"Design sprint 12",ago(days=4),ago(days=-10),"Active",18,stamp)]
    con.executemany("INSERT INTO cycles(id,team_id,name,starts_at,ends_at,status,capacity,created_at) VALUES(?,?,?,?,?,?,?,?)", cycles)
    projects = [
        (1,"Workspace foundations","Make everyday project work feel fast and clear.","Improve the core planning experience for teams.","In Progress",2,"◈",1,"2026-09-15","2026-10-18",ago(days=27),stamp),
        (2,"Spring product launch","Bring the next version of Acme to every team.","Prepare the product launch across product and design.","In Progress",1,"✳",1,"2026-09-20","2026-11-02",ago(days=22),stamp),
        (3,"Design system refresh","A sharper, more consistent UI across the product.","Refresh components, tokens, and documentation.","Planned",3,"⬡",4,"2026-10-05","2026-12-01",stamp,stamp),
    ]
    con.executemany("INSERT INTO projects(id,name,summary,description,status,priority,icon,lead_id,start_date,target_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", projects)
    con.executemany("INSERT INTO project_teams(project_id,team_id) VALUES(?,?)", [(1,1),(1,2),(2,1),(2,2),(3,2)])
    con.executemany("INSERT INTO project_members(project_id,member_id) VALUES(?,?)", [(1,1),(1,2),(1,3),(2,1),(2,2),(2,4),(3,4),(3,5)])
    con.executemany("INSERT INTO project_dependencies(project_id,depends_on_id,dependency_type) VALUES(?,?,?)", [(2,1,"blocks")])
    milestones = [(1,1,"Prototype review","2026-10-04","Done",0),(2,1,"Team beta","2026-10-12","In Progress",1),(3,1,"General availability","2026-10-18","Todo",2),(4,2,"Launch readiness","2026-10-22","Todo",0),(5,3,"Token audit","2026-10-20","Todo",0)]
    con.executemany("INSERT INTO milestones(id,project_id,name,due_date,status,position) VALUES(?,?,?,?,?,?)", milestones)
    status_id = {(r["team_id"],r["name"]):r["id"] for r in con.execute("SELECT id,team_id,name FROM issue_statuses")}
    issue_data = [
        (248,1,"Add keyboard shortcuts to command menu","Make command navigation available without leaving the keyboard.","In Progress",0,1,2,1,1,"2026-10-05",3,ago(hours=3)),
        (246,1,"Support custom issue labels","Let teams add, color, and filter their own labels.","In Progress",1,2,1,1,1,"2026-10-08",5,ago(hours=5)),
        (241,1,"Fix layout shift on the project overview","Prevent cards jumping while progress data loads.","In Progress",2,4,1,1,1,"2026-10-09",2,ago(hours=8)),
        (239,1,"Add a compact sidebar density option","Offer a narrower navigation layout.","Todo",1,3,1,1,2,"2026-10-12",None,ago(days=1)),
        (237,1,"Remember the last selected team view","Restore the last active view on the next visit.","Todo",2,1,1,1,2,None,2,ago(days=1)),
        (232,2,"Improve keyboard focus in issue details","Keep focus visible when navigating issue properties.","Backlog",3,2,1,3,3,None,None,ago(days=3)),
        (229,2,"Create project update templates","Start project updates from reusable templates.","Backlog",4,3,1,2,3,None,None,ago(days=4)),
        (226,2,"Polish empty states across the workspace","Add helpful next steps to empty product views.","Done",2,4,1,1,3,None,None,ago(days=7)),
        (218,2,"Document color token usage","Record accessibility contrast constraints for the palette.","In Review",3,5,2,3,3,"2026-10-14",None,ago(hours=18)),
        (216,1,"Add keyboard shortcuts help panel","Show discoverable shortcuts from the help menu.","Backlog",4,1,1,None,2,None,None,ago(days=2)),
        (95,2,"Audit empty state illustrations","Review illustration consistency across feature areas.","Todo",3,4,2,3,3,"2026-10-16",None,ago(days=2)),
        (93,1,"Add issue dependency indicators","Show blocked-by relationships in list and detail views.","Backlog",2,2,1,1,2,None,3,ago(days=3)),
    ]
    for number,team,title,description,status,priority,assignee,creator,project,cycle,due,estimate,updated in issue_data:
        con.execute("INSERT INTO issues(identifier,number,team_id,title,description,status_id,priority,assignee_id,creator_id,project_id,cycle_id,due_date,estimate,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (f"{('PRO' if team==1 else 'DSN')}-{number}",number,team,title,description,status_id[(team,status)],priority,assignee,creator,project,cycle,due,estimate,ago(days=5),updated))
    issue_ids = {r["identifier"]:r["id"] for r in con.execute("SELECT id,identifier FROM issues")}
    for ident,label_ids in {"PRO-248":[1,7],"PRO-246":[1],"PRO-241":[2,7],"PRO-239":[3],"DSN-232":[6],"DSN-218":[4,8],"DSN-95":[4]}.items():
        for label_id in label_ids:
            con.execute("INSERT INTO issue_labels(issue_id,label_id) VALUES(?,?)",(issue_ids[ident],label_id))
    con.executemany("INSERT INTO issue_subscribers(issue_id,member_id) VALUES(?,?)",[(issue_ids["PRO-248"],1),(issue_ids["PRO-248"],2),(issue_ids["PRO-246"],1),(issue_ids["DSN-218"],1)])
    con.executemany("INSERT INTO issue_relations(issue_id,related_issue_id,relation_type) VALUES(?,?,?)",[(issue_ids["PRO-241"],issue_ids["PRO-93"],"blocked by"),(issue_ids["PRO-248"],issue_ids["PRO-216"],"relates to")])
    con.execute("INSERT INTO comments(issue_id,author_id,body,created_at) VALUES(?,?,?,?)",(issue_ids["PRO-248"],2,"I drafted the shortcut map; we can review the final keys with the team.",ago(hours=2)))
    for ident in ("PRO-248","PRO-246","PRO-241","PRO-239","DSN-218"):
        con.execute("INSERT INTO activity_events(entity_type,entity_id,actor_id,action,payload,created_at) VALUES('issue',?,?,?,?,?)",(issue_ids[ident],1,"created",json.dumps({"identifier":ident}),ago(days=5)))
    con.executemany("INSERT INTO team_resources(team_id,section,title,url) VALUES(?,?,?,?)",[(1,"Resources","Product principles","https://example.local/principles")])
    view_rows = [
        (1,"All issues","Everything in the Product team","◈","issues","Team",None,1,{"status":"all"},{"layout":"List","groupBy":"Status","orderBy":"Priority"},1,stamp,stamp),
        (2,"My open issues","Assigned to Alex and not completed","◎","issues","Personal",1,1,{"assignee":"Alex Morgan","completed":False},{"layout":"List","groupBy":"Status","orderBy":"Updated"},1,stamp,stamp),
        (3,"Project tracking","Active project delivery","✳","projects","Workspace",None,None,{"status":"In Progress"},{"layout":"Board","groupBy":"Status","orderBy":"Target date"},0,stamp,stamp),
    ]
    for row in view_rows:
        con.execute("INSERT INTO views(id,name,description,icon,entity,scope,owner_id,team_id,filters_json,display_json,is_favorite,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (*row[:8],json.dumps(row[8]),json.dumps(row[9]),*row[10:]))
    notifications = [
        (1,1,"comment","Maya commented on PRO-248","I drafted the shortcut map; we can review the final keys with the team.","issue",issue_ids["PRO-248"],0,ago(minutes=18)),
        (2,1,"assignment","PRO-237 was assigned to you","Remember the last selected team view","issue",issue_ids["PRO-237"],0,ago(hours=3)),
        (3,1,"project_update","Workspace foundations update","Prototype review is complete. The team beta is next.","project",1,1,ago(days=1)),
        (4,2,"mention","Alex mentioned you in PRO-246","Can you review the labels proposal?","issue",issue_ids["PRO-246"],0,ago(hours=7)),
    ]
    con.executemany("INSERT INTO notifications(id,recipient_id,kind,title,body,entity_type,entity_id,is_read,created_at) VALUES(?,?,?,?,?,?,?,?,?)",notifications)
    settings={
        "preferences":{"defaultHome":"Issues","displayNames":"Full name","firstDayOfWeek":"Monday","commentSubmit":"Enter","fontSize":"Default","theme":"Light","spelling":True,"autoAssignToSelf":False,"sidebar":{"Inbox":True,"My issues":True,"Projects":True,"Views":True},"orderCompletedByRecency":False},
        "workspace":{"name":"Acme Studio","timezone":"America/Argentina/Buenos_Aires","issueIdentifier":"PRO","inviteDomain":None},
        "integrations":[{"name":"GitHub","connected":False},{"name":"Slack","connected":False}],
        "featureFlags":{"cycles":True,"triage":True,"automations":True,"customerRequests":False,"releases":True,"initiatives":True,"pulse":False,"asks":False},
    }
    con.executemany("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)",[(key,json.dumps(value),stamp) for key,value in settings.items()])
    con.execute("INSERT INTO recurring_rules(team_id,title,description,cadence,next_run,enabled,created_at) VALUES(?,?,?,?,?,?,?)",(1,"Weekly planning reminder","Review open issues before cycle planning.","Weekly","2026-10-05",1,stamp))
    con.execute("INSERT INTO automations(team_id,name,trigger_json,condition_json,action_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(1,"Assign urgent bugs",json.dumps({"event":"issue.created"}),json.dumps({"label":"Bug","priority":"Urgent"}),json.dumps({"assignTo":1}),1,stamp,stamp))



def parse_json(value: str | None, fallback=None):
    try:
        return json.loads(value) if value else (fallback if fallback is not None else {})
    except (TypeError,json.JSONDecodeError):
        return fallback if fallback is not None else {}



def create_member_actors(con):
    con.execute("""INSERT INTO actors(id,kind,name,active,member_id,avatar_color,created_at)
        SELECT id,'member',name,active,id,avatar_color,created_at FROM members""")


def actor_record(con, actor_id):
    row = con.execute("""SELECT a.*,m.email,m.role FROM actors a
        LEFT JOIN members m ON m.id=a.member_id WHERE a.id=?""", (actor_id,)).fetchone()
    return dict(row) if row else None


def require_actor(con, actor_id):
    if isinstance(actor_id, bool) or not isinstance(actor_id, int):
        raise ValueError("Actor ID must be an integer")
    row = actor_record(con, actor_id)
    if not row or not row["active"]:
        raise sqlite3.IntegrityError("Actor not found or inactive")
    return actor_id


def validate_actor_fields(con, data, method, path):
    existing = {}
    issue_match = re.fullmatch(r"/api/issues/([^/]+)", path)
    project_match = re.fullmatch(r"/api/projects/(\d+)", path)
    team_match = re.fullmatch(r"/api/teams/(\d+)", path)
    if method in ("PATCH", "PUT"):
        if issue_match:
            row = con.execute("SELECT id,assignee_id FROM issues WHERE identifier=?", (issue_match[1],)).fetchone()
            if row:
                existing["assigneeId"] = {row["assignee_id"]}
                existing["subscriberIds"] = {r[0] for r in con.execute("SELECT member_id FROM issue_subscribers WHERE issue_id=?", (row["id"],))}
        if project_match:
            row = con.execute("SELECT lead_id FROM projects WHERE id=?", (project_match[1],)).fetchone()
            if row:
                existing["leadId"] = {row[0]}
                existing["memberIds"] = {r[0] for r in con.execute("SELECT member_id FROM project_members WHERE project_id=?", (project_match[1],))}
        if team_match:
            existing["memberIds"] = {r[0] for r in con.execute("SELECT member_id FROM team_members WHERE team_id=?", (team_match[1],))}
    for field in ("assigneeId", "leadId", "memberIds", "subscriberIds"):
        if field not in data:
            continue
        values = data[field] if field in ("memberIds", "subscriberIds") else [data[field]]
        if not isinstance(values, list):
            raise ValueError(field + " must be an array")
        for value in values:
            if value is None and field in ("assigneeId", "leadId"):
                continue
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError("Actor ID must be an integer")
            if value not in existing.get(field, set()):
                require_actor(con, value)


def actor_records(con, kind=None, include_inactive=False):
    return [actor_record(con, r[0]) for r in con.execute(
        "SELECT id FROM actors WHERE (? IS NULL OR kind=?) AND (? OR active=1) ORDER BY id",
        (kind, kind, include_inactive))]


def member(con, member_id):
    return dict(con.execute("SELECT id,name,email,role,avatar_color,active FROM members WHERE id=?",(member_id,)).fetchone()) if member_id else None


def validate_project_team(con, project_id, team_id):
    if project_id in (None, ""):
        return
    linked = con.execute("SELECT 1 FROM project_teams WHERE project_id=? AND team_id=?",(int(project_id),int(team_id))).fetchone()
    if not linked:
        raise ValueError("Add this team to the project before linking its issues")



def validate_issue_links(con, data, existing=None):
    current = dict(existing) if existing is not None else {}
    team_id = data.get("teamId", current.get("team_id", 1))
    project_id = data.get("projectId", current.get("project_id"))
    validate_project_team(con, project_id, team_id)
    cycle_id = data.get("cycleId", current.get("cycle_id"))
    if cycle_id is not None and (existing is None or "cycleId" in data or "teamId" in data):
        cycle = con.execute("SELECT team_id FROM cycles WHERE id=?", (cycle_id,)).fetchone()
        if not cycle or cycle[0] != team_id:
            raise ValueError("Issue cycle must belong to its team")
    milestone_id = data.get("milestoneId", current.get("milestone_id"))
    if milestone_id is not None and (existing is None or "milestoneId" in data or "projectId" in data):
        milestone = con.execute("SELECT project_id FROM milestones WHERE id=?", (milestone_id,)).fetchone()
        if not milestone or milestone[0] != project_id:
            raise ValueError("Issue milestone must belong to its project")
    parent_id = data.get("parentId", current.get("parent_id"))
    seen = {current["id"]} if "id" in current else set()
    while parent_id is not None:
        if parent_id in seen:
            raise ValueError("Issue parent links must not form a cycle")
        seen.add(parent_id)
        parent = con.execute("SELECT parent_id FROM issues WHERE id=?", (parent_id,)).fetchone()
        if not parent:
            raise ValueError("Parent issue not found")
        parent_id = parent[0]



def next_issue_number(con, team_id, team_key):
    # Keep identifiers reserved after an issue moves to another team.
    prefix = team_key + "-"
    return con.execute("SELECT COALESCE(MAX(number),0)+1 FROM issues WHERE team_id=? OR substr(identifier,1,?)=?",
                       (team_id, len(prefix), prefix)).fetchone()[0]


def issue_status(con, team_id, name=None):
    if name is None:
        status = con.execute("SELECT id,name FROM issue_statuses WHERE team_id=? AND is_default=1 ORDER BY position,id LIMIT 1", (team_id,)).fetchone()
    else:
        status = con.execute("SELECT id,name FROM issue_statuses WHERE team_id=? AND name=? ORDER BY position,id LIMIT 1", (team_id, name)).fetchone()
    if not status:
        raise ValueError("Unknown workflow status" if name is not None else "Team has no default workflow status")
    return status


def issue_row(con, issue_id):
    row=con.execute("""SELECT i.*,t.name AS team_name,t.key AS team_key,s.name AS status,s.category AS status_category,s.color AS status_color,
        CASE WHEN a.kind='agent' THEN a.name||' (Agent)' ELSE a.name END AS assignee,(SELECT email FROM members WHERE id=a.member_id) AS assignee_email,a.avatar_color AS assignee_color,a.kind AS assignee_kind,c.kind AS creator_kind,CASE WHEN c.kind='agent' THEN c.name||' (Agent)' ELSE c.name END AS creator,
        p.name AS project,cy.name AS cycle,m.name AS milestone
        FROM issues i JOIN teams t ON t.id=i.team_id JOIN issue_statuses s ON s.id=i.status_id
        LEFT JOIN actors a ON a.id=i.assignee_id LEFT JOIN actors c ON c.id=i.creator_id
        LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN cycles cy ON cy.id=i.cycle_id LEFT JOIN milestones m ON m.id=i.milestone_id
        WHERE i.id=?""",(issue_id,)).fetchone()
    if not row:return None
    result=dict(row);result["priority_name"]=PRIORITIES[result["priority"]]
    result["labels"]=[dict(r) for r in con.execute("SELECT l.id,l.name,l.color FROM labels l JOIN issue_labels il ON il.label_id=l.id WHERE il.issue_id=?",(issue_id,))]
    result["subscribers"]=[actor_record(con,r[0]) for r in con.execute("SELECT member_id FROM issue_subscribers WHERE issue_id=?",(issue_id,))]
    result["comments"]=[dict(r) for r in con.execute("SELECT c.id,c.body,c.created_at,m.id AS author_id,CASE WHEN m.kind='agent' THEN m.name||' (Agent)' ELSE m.name END AS author,m.avatar_color FROM comments c JOIN actors m ON m.id=c.author_id WHERE c.issue_id=? ORDER BY c.id",(issue_id,))]
    result["attachments"]=[dict(r) for r in con.execute("SELECT id,name,content_type,size,created_at FROM issue_attachments WHERE issue_id=? ORDER BY id",(issue_id,))]
    result["relations"]=[dict(r) for r in con.execute("SELECT r.id,r.relation_type,r.url,i.identifier AS related_identifier,i.title AS related_title FROM issue_relations r LEFT JOIN issues i ON i.id=r.related_issue_id WHERE r.issue_id=?",(issue_id,))]
    result["subissues"]=[dict(r) for r in con.execute("SELECT id,identifier,title,status_id FROM issues WHERE parent_id=? AND archived=0",(issue_id,))]
    result["status_changed_at"]=result["created_at"]
    has_status_event=False
    result["activity"]=[]
    for event_row in con.execute("SELECT e.*,CASE WHEN m.kind='agent' THEN m.name||' (Agent)' ELSE m.name END AS actor FROM activity_events e LEFT JOIN actors m ON m.id=e.actor_id WHERE e.entity_type='issue' AND e.entity_id=? ORDER BY e.created_at DESC,e.id DESC",(issue_id,)):
        entry=dict(event_row);entry["payload"]=parse_json(entry["payload"])
        status_change = "status" in entry["payload"] or any(c.get("field")=="status_id" for c in entry["payload"].get("changes",[]) if isinstance(c,dict))
        if not has_status_event and status_change:result["status_changed_at"]=entry["created_at"];has_status_event=True
        result["activity"].append(entry)
    return result


def bootstrap(con, current_actor=1):
    workspace_row=con.execute("SELECT * FROM workspace LIMIT 1").fetchone()
    workspace=dict(workspace_row) if workspace_row else {}
    teams=[]
    for row in con.execute("SELECT * FROM teams ORDER BY id"):
        item=dict(row);item["members"]=[actor_record(con,r[0]) for r in con.execute("SELECT member_id FROM team_members WHERE team_id=?",(item["id"],))]
        item["statuses"]=[dict(s) for s in con.execute("SELECT * FROM issue_statuses WHERE team_id=? ORDER BY position",(item["id"],))]
        item["resources"]=[dict(r) for r in con.execute("SELECT * FROM team_resources WHERE team_id=? ORDER BY section,id",(item["id"],))]
        teams.append(item)
    projects=[]
    for r in con.execute("SELECT * FROM projects WHERE archived=0 ORDER BY id DESC"):
        p=dict(r);p["priority_name"]=PRIORITIES[p["priority"]];p["lead"]=actor_record(con,p["lead_id"])
        p["teams"]=[dict(x) for x in con.execute("SELECT t.id,t.name,t.key,t.icon FROM teams t JOIN project_teams pt ON pt.team_id=t.id WHERE pt.project_id=?",(p["id"],))]
        p["members"]=[actor_record(con,x[0]) for x in con.execute("SELECT member_id FROM project_members WHERE project_id=?",(p["id"],))]
        p["labels"]=[dict(x) for x in con.execute("SELECT l.id,l.name,l.color FROM labels l JOIN project_labels pl ON pl.label_id=l.id WHERE pl.project_id=?",(p["id"],))]
        p["milestones"]=[dict(x) for x in con.execute("SELECT * FROM milestones WHERE project_id=? ORDER BY position,id",(p["id"],))]
        p["updates"]=[dict(x) for x in con.execute("SELECT u.*,CASE WHEN m.kind='agent' THEN m.name||' (Agent)' ELSE m.name END AS author FROM project_updates u LEFT JOIN actors m ON m.id=u.author_id WHERE u.project_id=? ORDER BY u.created_at DESC,u.id DESC",(p["id"],))]
        p["dependencies"]=[dict(x) for x in con.execute("SELECT d.dependency_type,p.id,p.name FROM project_dependencies d JOIN projects p ON p.id=d.depends_on_id WHERE d.project_id=?",(p["id"],))]
        rows=con.execute("SELECT status_id,COUNT(*) AS n FROM issues WHERE project_id=? AND archived=0 GROUP BY status_id",(p["id"],)).fetchall()
        total=sum(x["n"] for x in rows);done_ids=[x[0] for x in con.execute("SELECT id FROM issue_statuses WHERE category='Completed'")]
        complete=sum(x["n"] for x in rows if x["status_id"] in done_ids)
        milestone_total=con.execute("SELECT COUNT(*) FROM milestones WHERE project_id=?",(p["id"],)).fetchone()[0]
        milestone_done=con.execute("SELECT COUNT(*) FROM milestones WHERE project_id=? AND status='Done'",(p["id"],)).fetchone()[0]
        issue_progress=complete/total if total else None;milestone_progress=milestone_done/milestone_total if milestone_total else None
        progress=round(((issue_progress+milestone_progress)/2 if issue_progress is not None and milestone_progress is not None else (issue_progress if issue_progress is not None else milestone_progress or 0))*100)
        p["issue_count"]=total;p["completed_count"]=complete;p["milestone_count"]=milestone_total;p["completed_milestones"]=milestone_done;p["progress"]=progress
        p["issues"]=[dict(x) for x in con.execute("SELECT i.id,i.identifier,i.title,s.name AS status,i.priority FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.project_id=? AND i.archived=0 ORDER BY i.updated_at DESC",(p["id"],))]
        p["activity"]=[dict(x) for x in con.execute("SELECT e.actor_id,e.action,e.payload,e.created_at,CASE WHEN m.kind='agent' THEN m.name||' (Agent)' ELSE m.name END AS actor FROM activity_events e LEFT JOIN actors m ON m.id=e.actor_id WHERE e.entity_type='project' AND e.entity_id=? ORDER BY e.created_at DESC",(p["id"],))]
        projects.append(p)
    issues=[issue_row(con,r[0]) for r in con.execute("SELECT id FROM issues WHERE archived=0 ORDER BY number DESC")]
    views=[]
    for r in con.execute("SELECT * FROM views ORDER BY is_favorite DESC,updated_at DESC"):
        v=dict(r);v["filters"]=parse_json(v.pop("filters_json"));v["display"]=parse_json(v.pop("display_json"));views.append(v)
    notifications=[dict(r) for r in con.execute("SELECT * FROM notifications WHERE archived=0 AND recipient_id=? ORDER BY created_at DESC",(current_actor,))]
    cycles=[]
    for row in con.execute("SELECT c.*,t.name AS team_name,t.key FROM cycles c JOIN teams t ON t.id=c.team_id ORDER BY c.starts_at DESC"):
        item=dict(row)
        rows=con.execute("SELECT s.category,COUNT(*) AS total,COALESCE(SUM(COALESCE(i.estimate,0)),0) AS points FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.cycle_id=? AND i.archived=0 GROUP BY s.category",(item["id"],)).fetchall()
        item["issue_count"]=sum(r["total"] for r in rows);item["completed_count"]=sum(r["total"] for r in rows if r["category"]=="Completed")
        item["estimate_points"]=sum(r["points"] for r in rows);item["progress"]=round(item["completed_count"]*100/item["issue_count"]) if item["issue_count"] else 0
        item["issues"]=[dict(i) for i in con.execute("SELECT identifier,title FROM issues WHERE cycle_id=? AND archived=0 ORDER BY number",(item["id"],))]
        cycles.append(item)
    settings={r["key"]:parse_json(r["value_json"]) for r in con.execute("SELECT * FROM app_settings")}
    archives={"issues":[issue_row(con,r[0]) for r in con.execute("SELECT id FROM issues WHERE archived=1 ORDER BY updated_at DESC")],
              "projects":[dict(r) for r in con.execute("SELECT id,name,summary,status,updated_at FROM projects WHERE archived=1 ORDER BY updated_at DESC")]}
    return {"workspace":workspace,"teams":teams,"members":[dict(r) for r in con.execute("SELECT * FROM members WHERE active=1 ORDER BY name")],
            "issues":issues,"projects":projects,"views":views,"notifications":notifications,
            "cycles":cycles,
            "statuses":[dict(r) for r in con.execute("SELECT * FROM issue_statuses ORDER BY team_id,position")],
            "labels":[dict(r) for r in con.execute("SELECT * FROM labels ORDER BY name")],
            "recurring":[dict(r) for r in con.execute("SELECT * FROM recurring_rules ORDER BY id")],
            "automations":[dict(r) for r in con.execute("SELECT * FROM automations ORDER BY id")],
            "archives":archives,"settings":settings,"currentMemberId":1,"currentActorId":current_actor,"actors":actor_records(con, include_inactive=True)}


def dispatch_mutation(con,method,path,data):
    data = mutation_payload(data, path)
    actor=require_actor(con,data.get("actorId",1));stamp=now()
    validate_actor_fields(con, data, method, path)
    if path=="/api/agents" and method=="POST":
        key=data.get("key");name=data.get("name")
        if not isinstance(key,str) or not key.strip():raise ValueError("Agent key is required")
        if not isinstance(name,str) or not name.strip():raise ValueError("Agent name is required")
        cur=con.execute("INSERT INTO actors(kind,name,key,created_at) VALUES('agent',?,?,?)",
                        (name.strip(),key.strip(),stamp))
        return {"agent":actor_record(con,cur.lastrowid),"_status":201}
    agent_match=re.fullmatch(r"/api/agents/(\d+)(?:/(deactivate|restore))?",path)
    if agent_match:
        agent_id=int(agent_match[1])
        target=actor_record(con,agent_id)
        if not target or target["kind"]!="agent":raise ValueError("Agent not found")
        if agent_match[2] and method=="POST":
            con.execute("UPDATE actors SET active=? WHERE id=?",(int(agent_match[2]=="restore"),agent_id))
        elif not agent_match[2] and method=="PATCH":
            if "key" in data:raise ValueError("Agent key cannot change")
            name=data.get("name")
            if not isinstance(name,str) or not name.strip():raise ValueError("Agent name is required")
            con.execute("UPDATE actors SET name=? WHERE id=?",(name.strip(),agent_id))
        else:return {"error":"Not found","_status":404}
        return {"agent":actor_record(con,agent_id)}
    if path=="/api/issues" and method=="POST":
        title=str(data.get("title","")).strip()
        if not title:raise ValueError("Issue title is required")
        team_id=int(data.get("teamId",1));team=con.execute("SELECT key FROM teams WHERE id=?",(team_id,)).fetchone()
        if not team:raise ValueError("Team not found")
        project_id=data.get("projectId") or None
        validate_issue_links(con, data)
        number=next_issue_number(con, team_id, team["key"])
        status=issue_status(con, team_id, data.get("status"))
        con.execute("INSERT INTO issues(identifier,number,team_id,title,description,status_id,priority,assignee_id,creator_id,project_id,cycle_id,milestone_id,due_date,estimate,parent_id,recurring_rule,external_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"{team['key']}-{number}",number,team_id,title,str(data.get("description","")),status[0],priority_num(data.get("priority",4)),data.get("assigneeId"),actor,project_id,data.get("cycleId"),data.get("milestoneId"),data.get("dueDate"),data.get("estimate"),data.get("parentId"),data.get("recurringRule"),data.get("externalUrl"),stamp,stamp))
        iid=con.execute("SELECT last_insert_rowid()").fetchone()[0]
        for label_id in data.get("labelIds",[]):con.execute("INSERT OR IGNORE INTO issue_labels(issue_id,label_id) VALUES(?,?)",(iid,int(label_id)))
        con.execute("INSERT OR IGNORE INTO issue_subscribers(issue_id,member_id) VALUES(?,?)",(iid,actor))
        for participant in data.get("subscriberIds",[]):
            con.execute("INSERT OR IGNORE INTO issue_subscribers VALUES(?,?)",(iid,participant))
        event(con,"issue",iid,actor,"created",{"title":title,"status":status["name"]})
        apply_automations(con,team_id,iid,"issue.created",actor)
        return {"issue":issue_row(con,iid),"_status":201}
    m=re.fullmatch(r"/api/issues/([^/]+)",path)
    if m and method in ("PUT","PATCH"):
        row=con.execute("SELECT * FROM issues WHERE identifier=?",(m.group(1),)).fetchone()
        if not row:raise ValueError("Issue not found")
        target_team_id=int(data.get("teamId",row["team_id"]))
        validate_issue_links(con, data, row)
        old_category=con.execute("SELECT category FROM issue_statuses WHERE id=?",(row["status_id"],)).fetchone()[0]
        fields={"title":"title","description":"description","priority":"priority","assigneeId":"assignee_id","projectId":"project_id","cycleId":"cycle_id","milestoneId":"milestone_id","dueDate":"due_date","estimate":"estimate","parentId":"parent_id","recurringRule":"recurring_rule","externalUrl":"external_url"}
        changes=[];values=[]
        for key,col in fields.items():
            if key in data:
                value=priority_num(data[key]) if key=="priority" else data[key]
                changes.append(f"{col}=?");values.append(value)
        if "status" in data:
            status=issue_status(con, target_team_id, data["status"])
            changes.append("status_id=?");values.append(status[0])
        if "teamId" in data:
            next_team=int(data["teamId"]);team=con.execute("SELECT id FROM teams WHERE id=?",(next_team,)).fetchone()
            if not team:raise ValueError("Team not found")
            changes.append("team_id=?");values.append(next_team)
            if "status" not in data:
                current_name=con.execute("SELECT name FROM issue_statuses WHERE id=?",(row["status_id"],)).fetchone()[0]
                status=con.execute("SELECT id FROM issue_statuses WHERE team_id=? AND name=?",(next_team,current_name)).fetchone()
                if not status:status=issue_status(con, next_team)
                changes.append("status_id=?");values.append(status[0])
        if changes or "labelIds" in data or "subscriberIds" in data:changes.append("updated_at=?");values.append(stamp);values.append(row["id"]);con.execute(f"UPDATE issues SET {','.join(changes)} WHERE id=?",values)
        if "labelIds" in data:
            con.execute("DELETE FROM issue_labels WHERE issue_id=?",(row["id"],))
            for label_id in data["labelIds"]:con.execute("INSERT INTO issue_labels(issue_id,label_id) VALUES(?,?)",(row["id"],int(label_id)))
        if "subscriberIds" in data:
            con.execute("DELETE FROM issue_subscribers WHERE issue_id=?",(row["id"],))
            for member_id in data["subscriberIds"]:con.execute("INSERT INTO issue_subscribers(issue_id,member_id) VALUES(?,?)",(row["id"],int(member_id)))
        if changes or "labelIds" in data or "subscriberIds" in data:
            changed = {k:data[k] for k in data if k in fields or k in ("status", "teamId", "labelIds", "subscriberIds")}
            if "teamId" in data:
                changed["status"] = issue_row(con, row["id"])["status"]
            event(con,"issue",row["id"],actor,"updated",changed)
            apply_automations(con,target_team_id,row["id"],"issue.updated",actor)
            new_category=con.execute("SELECT s.category FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.id=?",(row["id"],)).fetchone()[0]
            if old_category!="Completed" and new_category=="Completed":apply_automations(con,target_team_id,row["id"],"issue.completed",actor)
        return {"issue":issue_row(con,row["id"])}
    if m and method=="DELETE":
        row=con.execute("SELECT id FROM issues WHERE identifier=?",(m.group(1),)).fetchone()
        if not row:raise ValueError("Issue not found")
        con.execute("UPDATE issues SET archived=1,updated_at=? WHERE id=?",(stamp,row[0]));event(con,"issue",row[0],actor,"archived",{})
        return {"ok":True}
    m=re.fullmatch(r"/api/issues/([^/]+)/comments",path)
    if m and method=="POST":
        row=con.execute("SELECT id FROM issues WHERE identifier=?",(m.group(1),)).fetchone()
        if not row:raise ValueError("Issue not found")
        body=str(data.get("body","")).strip()
        if not body:raise ValueError("Comment is required")
        con.execute("INSERT INTO comments(issue_id,author_id,body,created_at) VALUES(?,?,?,?)",(row[0],actor,body,stamp));event(con,"issue",row[0],actor,"commented",{"body":body[:120]})
        return {"issue":issue_row(con,row[0]),"_status":201}
    m=re.fullmatch(r"/api/issues/([^/]+)/restore",path)
    if m and method=="POST":
        row=con.execute("SELECT id FROM issues WHERE identifier=?",(m.group(1),)).fetchone()
        if not row:raise ValueError("Issue not found")
        con.execute("UPDATE issues SET archived=0,updated_at=? WHERE id=?",(stamp,row[0]));event(con,"issue",row[0],actor,"restored",{})
        return {"ok":True}
    m=re.fullmatch(r"/api/issues/([^/]+)/attachments",path)
    if m and method=="POST":
        issue=con.execute("SELECT id FROM issues WHERE identifier=? AND archived=0",(m.group(1),)).fetchone()
        if not issue:raise ValueError("Issue not found")
        files=data.get("files",[])
        if not isinstance(files,list) or not files:raise ValueError("Choose at least one attachment")
        total=0;created=[];folder=DATA_DIR/"attachments"
        if folder.is_symlink():raise ValueError("Attachment directory must not be a symbolic link")
        folder.mkdir(parents=True,exist_ok=True)
        for item in files:
            name=Path(str(item.get("name","attachment"))).name.strip()[:180] or "attachment"
            encoded=str(item.get("data","")).split(",")[-1]
            try:content=base64.b64decode(encoded,validate=True)
            except (ValueError,base64.binascii.Error):raise ValueError("Attachment data is invalid")
            total+=len(content)
            if not content:raise ValueError("Empty files cannot be attached")
            if len(content)>3_000_000 or total>3_000_000:raise ValueError("Attachments must total 3 MB or less")
            storage_name=uuid.uuid4().hex;target=folder/storage_name
            target.write_bytes(content)
            candidate=str(item.get("type") or mimetypes.guess_type(name)[0] or "application/octet-stream")[:120]
            mime=candidate if re.fullmatch(r"[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+",candidate) else "application/octet-stream"
            cur=con.execute("INSERT INTO issue_attachments(issue_id,name,content_type,size,storage_name,created_at) VALUES(?,?,?,?,?,?)",(issue[0],name,mime,len(content),storage_name,stamp))
            created.append({"id":cur.lastrowid,"name":name})
        event(con,"issue",issue[0],actor,"attachments_added",{"count":len(created)})
        return {"attachments":created,"_status":201}
    m=re.fullmatch(r"/api/issues/([^/]+)/relations",path)
    if m and method=="POST":
        row=con.execute("SELECT id FROM issues WHERE identifier=?",(m.group(1),)).fetchone()
        if not row:raise ValueError("Issue not found")
        relation_id=data.get("relatedIssueId");relation_url=data.get("url")
        if not relation_id and not relation_url:raise ValueError("Choose an issue or provide a URL")
        related=None
        if relation_id:
            rr=con.execute("SELECT id FROM issues WHERE identifier=?",(relation_id,)).fetchone()
            if not rr:raise ValueError("Related issue not found")
            related=rr[0]
        con.execute("INSERT INTO issue_relations(issue_id,related_issue_id,relation_type,url) VALUES(?,?,?,?)",(row[0],related,data.get("type","relates to"),relation_url))
        event(con,"issue",row[0],actor,"linked",{"relation":relation_id or relation_url})
        return {"issue":issue_row(con,row[0]),"_status":201}
    if path=="/api/projects" and method=="POST":
        name=str(data.get("name","")).strip()
        if not name:raise ValueError("Project name is required")
        con.execute("INSERT INTO projects(name,summary,description,status,priority,icon,lead_id,start_date,target_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (name,data.get("summary",""),data.get("description",""),data.get("status","Backlog"),priority_num(data.get("priority",4)),data.get("icon","◈"),data.get("leadId",actor),data.get("startDate"),data.get("targetDate"),stamp,stamp))
        pid=con.execute("SELECT last_insert_rowid()").fetchone()[0]
        for team_id in data.get("teamIds",[1]):con.execute("INSERT OR IGNORE INTO project_teams(project_id,team_id) VALUES(?,?)",(pid,int(team_id)))
        for member_id in data.get("memberIds",[actor]):con.execute("INSERT OR IGNORE INTO project_members(project_id,member_id) VALUES(?,?)",(pid,int(member_id)))
        for label_id in data.get("labelIds",[]):con.execute("INSERT OR IGNORE INTO project_labels(project_id,label_id) VALUES(?,?)",(pid,int(label_id)))
        for dependency in data.get("dependencies",[]):
            if int(dependency)!=pid:con.execute("INSERT OR IGNORE INTO project_dependencies(project_id,depends_on_id,dependency_type) VALUES(?,?,?)",(pid,int(dependency),"blocks"))
        for pos,milestone in enumerate(data.get("milestones",[])):
            con.execute("INSERT INTO milestones(project_id,name,due_date,status,position) VALUES(?,?,?,?,?)",(pid,milestone["name"],milestone.get("dueDate"),milestone.get("status","Todo"),pos))
        event(con,"project",pid,actor,"created",{"name":name})
        return {"projectId":pid,"_status":201}
    m=re.fullmatch(r"/api/projects/(\d+)",path)
    if m and method in ("PUT","PATCH"):
        pid=int(m.group(1));old=con.execute("SELECT id FROM projects WHERE id=?",(pid,)).fetchone()
        if not old:raise ValueError("Project not found")
        if "teamIds" in data:
            next_team_ids={int(team_id) for team_id in data["teamIds"]}
            issue_teams={r[0] for r in con.execute("SELECT DISTINCT team_id FROM issues WHERE project_id=?",(pid,))}
            if not issue_teams.issubset(next_team_ids):
                raise ValueError("Move or unlink this project's issues before removing their team")
        fields={"name":"name","summary":"summary","description":"description","status":"status","icon":"icon","leadId":"lead_id","startDate":"start_date","targetDate":"target_date"}
        sets=[];vals=[]
        for key,col in fields.items():
            if key in data:sets.append(f"{col}=?");vals.append(data[key])
        if "priority" in data:sets.append("priority=?");vals.append(priority_num(data["priority"]))
        if sets:sets.append("updated_at=?");vals.append(stamp);vals.append(pid);con.execute(f"UPDATE projects SET {','.join(sets)} WHERE id=?",vals)
        for key,table,column in (("teamIds","project_teams","team_id"),("memberIds","project_members","member_id"),("labelIds","project_labels","label_id")):
            if key in data:
                con.execute(f"DELETE FROM {table} WHERE project_id=?",(pid,))
                for value in data[key]:con.execute(f"INSERT OR IGNORE INTO {table}(project_id,{column}) VALUES(?,?)",(pid,int(value)))
        event(con,"project",pid,actor,"updated",data);return {"projectId":pid}
    if re.fullmatch(r"/api/projects/(\d+)",path) and method=="DELETE":
        pid=int(path.rsplit("/",1)[1])
        if not con.execute("SELECT id FROM projects WHERE id=?", (pid,)).fetchone():raise ValueError("Project not found")
        con.execute("UPDATE projects SET archived=1,updated_at=? WHERE id=?",(stamp,pid));event(con,"project",pid,actor,"archived",{});return {"ok":True}
    m=re.fullmatch(r"/api/projects/(\d+)/restore",path)
    if m and method=="POST":
        pid=int(m.group(1));row=con.execute("SELECT id FROM projects WHERE id=?",(pid,)).fetchone()
        if not row:raise ValueError("Project not found")
        con.execute("UPDATE projects SET archived=0,updated_at=? WHERE id=?",(stamp,pid));event(con,"project",pid,actor,"restored",{})
        return {"ok":True}
    m=re.fullmatch(r"/api/projects/(\d+)/milestones",path)
    if m and method=="POST":
        pid=int(m.group(1));name=str(data.get("name","")).strip()
        if not name:raise ValueError("Milestone name is required")
        pos=con.execute("SELECT COUNT(*) FROM milestones WHERE project_id=?",(pid,)).fetchone()[0]
        con.execute("INSERT INTO milestones(project_id,name,due_date,status,position) VALUES(?,?,?,?,?)",(pid,name,data.get("dueDate"),data.get("status","Todo"),pos))
        event(con,"project",pid,actor,"milestone_created",{"name":name});return {"ok":True,"_status":201}
    m=re.fullmatch(r"/api/projects/(\d+)/updates",path)
    if m and method=="POST":
        pid=int(m.group(1));body=str(data.get("body","")).strip();health=str(data.get("health","On track"))
        if not con.execute("SELECT id FROM projects WHERE id=? AND archived=0",(pid,)).fetchone():raise ValueError("Project not found")
        if not body:raise ValueError("Write an update before saving")
        if health not in ("On track","At risk","Off track"):raise ValueError("Unknown project health")
        con.execute("INSERT INTO project_updates(project_id,health,body,author_id,created_at) VALUES(?,?,?,?,?)",(pid,health,body,actor,stamp))
        event(con,"project",pid,actor,"update_posted",{"health":health})
        return {"ok":True,"_status":201}
    m=re.fullmatch(r"/api/projects/(\d+)/dependencies",path)
    if m and method=="POST":
        pid=int(m.group(1));dependency=int(data["dependsOnId"])
        if pid==dependency:raise ValueError("A project cannot depend on itself")
        con.execute("INSERT OR IGNORE INTO project_dependencies(project_id,depends_on_id,dependency_type) VALUES(?,?,?)",(pid,dependency,data.get("type","blocks")))
        event(con,"project",pid,actor,"dependency_added",{"dependsOnId":dependency});return {"ok":True,"_status":201}
    if path=="/api/views" and method=="POST":
        name=str(data.get("name","")).strip()
        if not name:raise ValueError("View name is required")
        con.execute("INSERT INTO views(name,description,icon,entity,scope,owner_id,team_id,filters_json,display_json,is_favorite,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (name,data.get("description",""),data.get("icon","◈"),data.get("entity","issues"),data.get("scope","Personal"),actor,data.get("teamId"),json.dumps(data.get("filters",{})),json.dumps(data.get("display",{})),int(bool(data.get("isFavorite"))),stamp,stamp))
        return {"viewId":con.execute("SELECT last_insert_rowid()").fetchone()[0],"_status":201}
    m=re.fullmatch(r"/api/views/(\d+)",path)
    if m and method in ("PUT","PATCH"):
        view_id=int(m.group(1))
        if not con.execute("SELECT id FROM views WHERE id=?", (view_id,)).fetchone():raise ValueError("View not found")
        fields={"name":"name","description":"description","icon":"icon","entity":"entity","scope":"scope","teamId":"team_id","isFavorite":"is_favorite"};sets=[];vals=[]
        for key,column in fields.items():
            if key in data:sets.append(f"{column}=?");vals.append(int(data[key]) if key=="isFavorite" else data[key])
        for key,column in (("filters","filters_json"),("display","display_json")):
            if key in data:sets.append(f"{column}=?");vals.append(json.dumps(data[key]))
        if sets:sets.append("updated_at=?");vals.append(stamp);vals.append(view_id);con.execute(f"UPDATE views SET {','.join(sets)} WHERE id=?",vals)
        return {"ok":True}
    if m and method=="DELETE":
        if not con.execute("SELECT id FROM views WHERE id=?", (int(m.group(1)),)).fetchone():raise ValueError("View not found")
        con.execute("DELETE FROM views WHERE id=?",(int(m.group(1)),));return {"ok":True}
    if path=="/api/cycles" and method=="POST":
        name=str(data.get("name","")).strip()
        if not name:raise ValueError("Cycle name is required")
        con.execute("INSERT INTO cycles(team_id,name,starts_at,ends_at,status,capacity,created_at) VALUES(?,?,?,?,?,?,?)",(data.get("teamId",1),name,data["startsAt"],data["endsAt"],data.get("status","Upcoming"),float(data.get("capacity",20)),stamp))
        return {"cycleId":con.execute("SELECT last_insert_rowid()").fetchone()[0],"_status":201}
    if path=="/api/preferences" and method in ("PUT","PATCH"):update_setting(con,"preferences",{k:v for k,v in data.items() if k!="actorId"});return {"ok":True}
    if path=="/api/teams" and method=="POST":
        name=str(data.get("name","")).strip();key=re.sub(r"[^A-Za-z0-9]","",data.get("key") or name[:3]).upper()[:5]
        if not name:raise ValueError("Team name is required")
        if not key:raise ValueError("Team key must contain letters or digits")
        con.execute("INSERT INTO teams(name,key,description,icon,created_at) VALUES(?,?,?,?,?)",(name,key,data.get("description",""),data.get("icon","✳"),stamp))
        team_id=con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.execute("INSERT INTO team_members(team_id,member_id,role) VALUES(?,?,?)",(team_id,actor,"Lead"))
        for participant in data.get("memberIds",[]):
            con.execute("INSERT OR IGNORE INTO team_members(team_id,member_id) VALUES(?,?)",(team_id,participant))
        for pos,(status,category) in enumerate(ISSUE_STATUSES):con.execute("INSERT INTO issue_statuses(team_id,name,category,position,color,is_default) VALUES(?,?,?,?,?,?)",(team_id,status,category,pos,"#8e8e98",int(status=="Backlog")))
        return {"teamId":team_id,"_status":201}
    if path=="/api/statuses" and method=="POST":
        team_id=int(data.get("teamId",1));name=str(data.get("name","")).strip();category=data.get("category","Unstarted")
        if not name:raise ValueError("Status name is required")
        pos=con.execute("SELECT COALESCE(MAX(position),-1)+1 FROM issue_statuses WHERE team_id=?",(team_id,)).fetchone()[0]
        con.execute("INSERT INTO issue_statuses(team_id,name,category,position,color) VALUES(?,?,?,?,?)",(team_id,name,category,pos,data.get("color","#8989a1")))
        return {"statusId":con.execute("SELECT last_insert_rowid()").fetchone()[0],"_status":201}
    if path=="/api/labels" and method=="POST":
        name=str(data.get("name","")).strip()
        if not name:raise ValueError("Label name is required")
        con.execute("INSERT INTO labels(name,color,team_id) VALUES(?,?,?)",(name,data.get("color","#8585cc"),data.get("teamId",1)))
        return {"labelId":con.execute("SELECT last_insert_rowid()").fetchone()[0],"_status":201}
    m=re.fullmatch(r"/api/teams/(\d+)",path)
    if m and method in ("PUT","PATCH"):
        team_id=int(m.group(1))
        if not con.execute("SELECT id FROM teams WHERE id=?", (team_id,)).fetchone():raise ValueError("Team not found")
        fields={"name":"name","description":"description","icon":"icon","timezone":"timezone","estimateType":"estimate_type"};sets=[];vals=[]
        for key,column in fields.items():
            if key in data:sets.append(f"{column}=?");vals.append(data[key])
        if "memberIds" in data:
            roles={r["member_id"]:r["role"] for r in con.execute("SELECT * FROM team_members WHERE team_id=?",(team_id,))}
            con.execute("DELETE FROM team_members WHERE team_id=?",(team_id,))
            for participant in data["memberIds"]:
                con.execute("INSERT INTO team_members VALUES(?,?,?)",(team_id,participant,roles.get(participant,"Member")))
        if sets:vals.append(team_id);con.execute(f"UPDATE teams SET {','.join(sets)} WHERE id=?",vals)
        return {"ok":True}
    m=re.fullmatch(r"/api/teams/(\d+)/resources",path)
    if m and method=="POST":
        team_id=int(m.group(1));title=str(data.get("title","")).strip();section=str(data.get("section","Resources")).strip() or "Resources";url=str(data.get("url","")).strip()
        if not title:raise ValueError("Resource title is required")
        if not re.match(r"^https?://",url,re.I):raise ValueError("Resource links must start with http:// or https://")
        con.execute("INSERT INTO team_resources(team_id,section,title,url) VALUES(?,?,?,?)",(team_id,section,title,url))
        return {"resourceId":con.execute("SELECT last_insert_rowid()").fetchone()[0],"_status":201}
    m=re.fullmatch(r"/api/teams/(\d+)/resources/(\d+)",path)
    if m and method=="DELETE":
        con.execute("DELETE FROM team_resources WHERE team_id=? AND id=?",(int(m.group(1)),int(m.group(2))));return {"ok":True}
    m=re.fullmatch(r"/api/notifications/(\d+)/(read|unread|archive)",path)
    if m and method=="POST":
        statement="archived=1" if m.group(2)=="archive" else ("is_read=1" if m.group(2)=="read" else "is_read=0")
        con.execute(f"UPDATE notifications SET {statement} WHERE id=? AND recipient_id=?",(int(m.group(1)),actor));return {"ok":True}
    if path=="/api/notifications/read-all" and method=="POST":con.execute("UPDATE notifications SET is_read=1 WHERE recipient_id=?",(actor,));return {"ok":True}
    if path in ("/api/notifications/archive-selected","/api/notifications/read-selected") and method=="POST":
        ids=sorted({int(value) for value in data.get("ids",[])})
        count=0
        if ids:
            placeholders=','.join('?' for _ in ids)
            update="archived=1" if path.endswith("archive-selected") else "is_read=1"
            count=con.execute(f"UPDATE notifications SET {update} WHERE recipient_id=? AND id IN ({placeholders})",[actor,*ids]).rowcount
        return {"ok":True,"count":count}
    if path=="/api/import" and method=="POST":
        created=[]
        for issue in data.get("issues",[]):
            item=dict(issue);item["actorId"]=actor;item.setdefault("teamId",1)
            created.append(dispatch_mutation(con,"POST","/api/issues",item)["issue"]["identifier"])
        return {"created":created,"count":len(created)}
    if path=="/api/automations" and method=="POST":
        name=str(data.get("name","")).strip()
        if not name:raise ValueError("Automation name is required")
        action_spec=data.get("action",{})
        if "assignTo" in action_spec:require_actor(con,action_spec["assignTo"])
        con.execute("INSERT INTO automations(team_id,name,trigger_json,condition_json,action_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(data.get("teamId",1),name,json.dumps(data.get("trigger",{})),json.dumps(data.get("condition",{})),json.dumps(data.get("action",{})),1,stamp,stamp))
        return {"automationId":con.execute("SELECT last_insert_rowid()").fetchone()[0],"_status":201}
    if path=="/api/recurring" and method=="POST":
        con.execute("INSERT INTO recurring_rules(team_id,title,description,cadence,next_run,enabled,created_at) VALUES(?,?,?,?,?,?,?)",(data.get("teamId",1),data["title"],data.get("description",""),data.get("cadence","Weekly"),data.get("nextRun",stamp[:10]),1,stamp))
        return {"ok":True,"_status":201}
    if path=="/api/settings" and method in ("PUT","PATCH"):
        key=data.get("key")
        if not key:raise ValueError("Setting key is required")
        value=data.get("value",{});update_setting(con,key,value)
        if key=="workspace" and isinstance(value,dict):
            fields={"name":"name","icon":"icon"};sets=[];vals=[]
            for field,column in fields.items():
                if field in value:sets.append(f"{column}=?");vals.append(value[field])
            if sets:con.execute(f"UPDATE workspace SET {','.join(sets)} WHERE id=1",vals)
        return {"ok":True}
    return {"error":"Not found","_status":404}



def apply_automations(con,team_id,issue_id,event_name,actor):
    issue=con.execute("SELECT i.*,s.name AS status FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.id=?",(issue_id,)).fetchone()
    if not issue:return
    label_names={r[0] for r in con.execute("SELECT l.name FROM labels l JOIN issue_labels il ON il.label_id=l.id WHERE il.issue_id=?",(issue_id,))}
    for row in con.execute("SELECT * FROM automations WHERE team_id=? AND enabled=1 ORDER BY id",(team_id,)):
        trigger=parse_json(row["trigger_json"]);condition=parse_json(row["condition_json"]);action_spec=parse_json(row["action_json"])
        if trigger.get("event")!=event_name:continue
        expected_priority=condition.get("priority","Any")
        if expected_priority not in (None,"","Any") and PRIORITIES[issue["priority"]]!=expected_priority:continue
        expected_label=condition.get("label","Any")
        if expected_label not in (None,"","Any") and expected_label not in label_names:continue
        name=str(action_spec.get("name",""));changes=[]
        assignee=action_spec.get("assignTo")
        if assignee is not None:changes.append(("assignee_id",require_actor(con,assignee)))
        elif name=="Assign to me":changes.append(("assignee_id",actor))
        elif name.startswith("Add ") and name.endswith(" label"):
            label_name=name[4:-6].strip()
            label=con.execute("SELECT id FROM labels WHERE name=? AND (team_id=? OR team_id IS NULL) ORDER BY team_id DESC LIMIT 1",(label_name,team_id)).fetchone()
            if label and label_name not in label_names:
                con.execute("INSERT OR IGNORE INTO issue_labels(issue_id,label_id) VALUES(?,?)",(issue_id,label[0]));label_names.add(label_name);changes.append(("label",label_name))
        elif name.startswith("Set status: "):
            status_name=name.split(":",1)[1].strip()
            status=con.execute("SELECT id FROM issue_statuses WHERE team_id=? AND name=?",(team_id,status_name)).fetchone()
            if status:changes.append(("status_id",status[0]))
        if changes:
            sql_changes=[];values=[]
            for field,value in changes:
                if field=="label":continue
                sql_changes.append(f"{field}=?");values.append(value)
            if sql_changes:values.extend([now(),issue_id]);con.execute(f"UPDATE issues SET {','.join(sql_changes)},updated_at=? WHERE id=?",values)
            event(con,"issue",issue_id,actor,"automation_applied",{"automation":row["name"],"changes":[{"field":field,"value":value} for field,value in changes]})


def recurring_next(value,cadence):
    current=datetime.fromisoformat(str(value)[:10]).date()
    if cadence=="Daily":return current+timedelta(days=1)
    if cadence=="Every 2 weeks":return current+timedelta(days=14)
    if cadence=="Monthly":
        year=current.year+(current.month==12);month=1 if current.month==12 else current.month+1
        return current.replace(year=year,month=month,day=min(current.day,calendar.monthrange(year,month)[1]))
    return current+timedelta(days=7)


def run_due_recurring(con):
    today=datetime.now(timezone.utc).date();created=0
    for rule in con.execute("SELECT * FROM recurring_rules WHERE enabled=1 ORDER BY id").fetchall():
        due=datetime.fromisoformat(str(rule["next_run"])[:10]).date()
        if due>today:continue
        team=con.execute("SELECT key FROM teams WHERE id=?",(rule["team_id"],)).fetchone()
        status=con.execute("SELECT id,name FROM issue_statuses WHERE team_id=? AND is_default=1 ORDER BY id LIMIT 1",(rule["team_id"],)).fetchone()
        if not team or not status:continue
        require_actor(con,1)
        stamp=now();number=next_issue_number(con, rule["team_id"], team["key"])
        identifier=f"{team['key']}-{number}"
        con.execute("INSERT INTO issues(identifier,number,team_id,title,description,status_id,priority,creator_id,recurring_rule,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (identifier,number,rule["team_id"],rule["title"],rule["description"],status["id"],4,1,json.dumps({"ruleId":rule["id"],"cadence":rule["cadence"]}),stamp,stamp))
        issue_id=con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.execute("INSERT OR IGNORE INTO issue_subscribers(issue_id,member_id) VALUES(?,1)",(issue_id,))
        event(con,"issue",issue_id,1,"created",{"title":rule["title"],"status":status["name"],"recurringRuleId":rule["id"]})
        apply_automations(con,rule["team_id"],issue_id,"issue.created",1)
        while due<=today:due=recurring_next(due,rule["cadence"])
        con.execute("UPDATE recurring_rules SET next_run=? WHERE id=?",(due.isoformat(),rule["id"]));created+=1
    return created


def priority_num(value):
    if type(value) is int and 0 <= value <= 4:return value
    if isinstance(value,str) and value.isdigit() and 0 <= int(value) <= 4:return int(value)
    if value not in PRIORITIES:raise ValueError("Unknown priority")
    return PRIORITIES.index(value)


def event(con,entity_type,entity_id,actor,action,payload):
    con.execute("INSERT INTO activity_events(entity_type,entity_id,actor_id,action,payload,created_at) VALUES(?,?,?,?,?,?)",(entity_type,entity_id,actor,action,json.dumps(payload),now()))


def update_setting(con,key,value):
    row=con.execute("SELECT value_json FROM app_settings WHERE key=?",(key,)).fetchone()
    existing=parse_json(row[0]) if row else {}
    if isinstance(existing,dict) and isinstance(value,dict):existing.update(value);value=existing
    con.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",(key,json.dumps(value),now()))




def search(con, query, scope="All"):
    query = query.strip()
    if not query:
        return {"results": []}
    like = f"%{query}%"
    result = []
    if scope in ("All", "Issues"):
        result.extend(dict(r) for r in con.execute("SELECT i.id,i.identifier AS key,i.title,s.name AS status,'Issue' AS type FROM issues i JOIN issue_statuses s ON s.id=i.status_id WHERE i.archived=0 AND (i.identifier LIKE ? OR i.title LIKE ? OR i.description LIKE ?) ORDER BY i.updated_at DESC LIMIT 40", (like, like, like)))
    if scope in ("All", "Projects"):
        result.extend(dict(r) for r in con.execute("SELECT id,id AS key,name AS title,status,'Project' AS type FROM projects WHERE archived=0 AND (name LIKE ? OR summary LIKE ? OR description LIKE ?) LIMIT 30", (like, like, like)))
    return {"results": result[:80]}


def remove_unused_tables(con):
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    removed = tables & REMOVED_TABLES
    resource_columns = {r[1] for r in con.execute("PRAGMA table_info(team_resources)")}
    if "document_id" in resource_columns:
        con.execute("CREATE TABLE team_resources_new (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, section TEXT NOT NULL DEFAULT 'Resources', title TEXT NOT NULL, url TEXT)")
        con.execute("INSERT INTO team_resources_new SELECT id,team_id,section,title,url FROM team_resources")
        con.execute("DROP TABLE team_resources")
        con.execute("ALTER TABLE team_resources_new RENAME TO team_resources")
    for table in ("agent_messages", "agent_threads", "reviews", "documents"):
        if table in removed:
            con.execute(f'DROP TABLE "{table}"')
    return bool(removed or "document_id" in resource_columns)
