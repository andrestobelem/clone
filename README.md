# Linear-style local workspace

A single-user, local issue and project workspace inspired by Linear. The UI is served with a small Python standard-library server and saves its data in SQLite. No external service or package installation is needed.

## Run

From this folder, run:

```sh
python3 server.py
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). The server creates and seeds `data/workspace.sqlite3` on first launch. Refreshing or restarting the app keeps changes. To restore a workspace from Git, run `python3 cli.py sync import` before you start the server. Do not remove a database to reset it when a snapshot exists.

## Included

- Workspace and team navigation, issues, projects, saved views, issue/project search, Inbox, a read-only members roster, cycles, and local preferences.
- Issue and project creation/editing, issue workflow, labels, comments, activity, attachments, relations, sub-issues, milestones, project updates, project dependencies, triage, and archive/restore actions.
- List and board layouts, filters, grouping, sorting, saved views, JSON import preview, and JSON export.
- Inbox bulk actions, a read-only team roster, cycles with progress, workflow settings, executing recurring rules, and issue event automations.
- SQLite persistence with a small local JSON API. The database is under `data/` and is not served as a public static file.

This build is intentionally local and single-user. Recurring issues run on a small local scheduler; automation rules execute for issue create/update/complete events. Git/Slack connectors, authentication, rich collaborative documents, billing, and hosted multi-user permissions need service credentials or a separate deployment design; the interface reports those integration limits instead of simulating a connection. Reviews, document authoring/search, and member invitations are omitted from this build at the user’s request; the roster remains view-only. Unused document, review, and Agent tables are removed from SQLite. The Agent experience is also intentionally omitted. Attachments are stored in `data/attachments/` and limited to 3 MB per upload.

See [SPEC.md](SPEC.md) for the audited scope, behaviors, and remaining product boundaries.

## CLI and Git storage

Use `python3 cli.py --help` to manage the workspace without a server. The CLI and web server share the same actions and validation. After each change, they save all app tables and attachments to `data/snapshot/`. This directory can be stored in Git. SQLite and local recovery files stay outside Git.

For an existing database, run `python3 cli.py sync export` once. After you pull snapshot changes from Git, run `python3 cli.py sync validate`, then `python3 cli.py sync import --dry-run`, then `python3 cli.py sync import`. Import replaces the complete database. It preserves IDs and does not run automations.

See [CLI commands and Git workflow](docs/CLI.md) for all commands, conflict checks, backups, and recovery. The CLI requires Python 3.10 or later on macOS or Linux.
