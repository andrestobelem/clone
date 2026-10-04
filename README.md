# Local issue and project workspace

A local application for issues, projects, and team planning, inspired by Linear. The browser UI, CLI, and scheduler use the same Python actions and SQLite database. People and external agents have actor identities.

## Requirements

- uv and Python 3.14 on macOS or Linux.
- A current browser with JavaScript enabled.

The application uses the Python standard library. There are no third-party Python dependencies, build steps, or external services. Run `uv sync --locked` to prepare the pinned environment. Keep the server on the default loopback address. The application has no authentication.

## Start from this repository

The repository includes a Git snapshot. If the local database does not exist, restore it before you start the server:

```sh
uv sync --locked
uv run python cli.py sync validate
uv run python cli.py sync import --dry-run
uv run python cli.py sync import
uv run python server.py
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Stop the server with Ctrl+C. Changes survive refresh and server restart.

If a database already exists, use `uv run python cli.py sync status --json` to check storage. For a database from an earlier version, stop the server and run `uv run python cli.py sync migrate`. Review conflicts before you import or export. Do not delete a database to reset storage.

## Create a separate workspace

Use another database path to keep test or demo records separate from your workspace:

```sh
uv run python cli.py --db /tmp/clone-demo/workspace.sqlite3 init --demo
uv run python cli.py --db /tmp/clone-demo/workspace.sqlite3 serve
```

Choose an unused directory. Omit `--demo` to create a workspace with one local member and no teams. Create a team in the UI or CLI before you add issues. `init` rejects existing storage. `serve` and `server.py` create demo data only when both the database and snapshot are absent.

## Included behavior

- Issues: workflow statuses, priorities, actor assignment, labels, comments, activity, attachments, relations, sub-issues, and archive/restore.
- Projects: linked teams, actor participation, milestones, dependencies, progress, updates, and archive/restore.
- Planning: cycles, triage, saved views, search, list and board layouts, filters, grouping, and sorting.
- Workspace: team management, read-only human rosters, Inbox actions, local preferences, issue JSON import, and UI JSON export.
- Automation: local recurring issues and rules for issue creation, update, and completion.
- Storage: SQLite plus complete Git snapshots, conflict checks, backups, migration, and interrupted-operation recovery.

The application has one local workspace. It does not provide hosted collaboration, sign-in, enforced roles, external notifications, GitHub/Slack connections, document authoring, reviews, member invitations, or agent chat. Actor IDs record who performed an action; they do not authenticate the caller. See [the product specification](SPEC.md) for behavior and limits.

## CLI and agent access

```sh
uv run python cli.py --help
uv run python cli.py describe
uv run python cli.py teams list --json
uv run python cli.py agents list --all --json
```

Register each external agent once with a stable key. Use its returned actor ID on writes. Follow the [Agent CLI guide](docs/AGENTS.md) for registration and recovery. See the [CLI reference](docs/CLI.md) for commands, payloads, and the Git workflow.

SQLite, attachment storage, recovery files, and backups remain local. `data/snapshot/` stores complete records and attachment bytes for Git. Review snapshot contents before committing them. UI JSON export contains application data but is not a complete backup.

## Verify changes

```sh
uv run python -m unittest discover -s tests -v
```

Tests use temporary storage. They cover CLI/HTTP parity, validation, actors, concurrency, snapshots, migration, and recovery. See the [development guide](docs/DEVELOPMENT.md) for browser checks and documentation checks.

## Documentation

- [Product specification](SPEC.md): current behavior and product limits.
- [Domain glossary](GLOSSARY.md): preferred product terms.
- [Architecture](docs/ARCHITECTURE.md): components, data flow, and storage.
- [HTTP API](docs/API.md): routes, payloads, validation, and errors.
- [CLI reference](docs/CLI.md): commands and synchronization.
- [Agent CLI guide](docs/AGENTS.md): identities and agent operations.
- [Development guide](docs/DEVELOPMENT.md): safe setup and verification.
- [Reference audit](docs/REFERENCE-AUDIT.md): source and limits of the original UI audit.

The repository uses the [MIT license](LICENSE).
