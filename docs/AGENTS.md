# Agent CLI guide

Use the project Python 3.14 environment managed by uv. Run `uv sync --locked` once, then run commands with `uv run python cli.py`. The CLI does not need a web server.

## Discover and prepare

1. Run `uv run python cli.py describe` to read the command catalog.
2. Run `uv run python cli.py sync status --json` to check storage.
3. For a missing database with an existing snapshot, run `sync validate`, `sync import --dry-run`, then `sync import`. For a new workspace without a snapshot, run `init` or `init --demo`.
4. For an older database, stop the web server and run `sync migrate`. Start the server again with the updated code.

Use `--db PATH` and `--sync-dir PATH` when the workspace uses other storage paths. All processes must use the same paths.

## Register and select an actor

Run `agents list --all` and check for your fixed agent key. If the key does not exist, register it:

```sh
uv run python cli.py agents create --key codex --name Codex --json
uv run python cli.py actors list --json
```

Keep the returned actor ID. Use it in every mutation. Reuse this identity across executions. Registration rejects duplicate keys. Restore an inactive identity explicitly before you use it. Deactivation preserves history.

`--actor ID` identifies the caller. `--assignee-id ID`, `--lead-id ID`, `--member-ids '[ID]'`, and `--subscriber-ids '[ID]'` select actors for work relationships. Actor IDs are distinct from issue and project IDs. Actor selection records identity; this local app does not authenticate it.

## Read context and perform work

Query teams and workflow statuses before you create an issue. Use issue identifiers such as `PRO-248` for issue commands. Use numeric IDs for actors, projects, teams, and other records.

```sh
uv run python cli.py teams list --json
uv run python cli.py statuses list --team-id 1 --json
uv run python cli.py search 'search' --scope Issues --json
uv run python cli.py issues show PRO-248 --json
uv run python cli.py issues create --actor 6 --team-id 1 --title 'Check search' --assignee-id 7 --json
uv run python cli.py issues update PRO-249 --actor 6 --status 'In Progress' --json
uv run python cli.py issues comment PRO-249 --actor 7 --body 'Checked search' --json
uv run python cli.py issues show PRO-249 --json
```

Replace example IDs and identifiers with values from the workspace. Read the result after each change. For payloads, send a JSON object through stdin with `--data -`, or use `--data @file.json`. Flags override payload fields. The selected `--actor` overrides payload `actorId`; its default is 1. External agents must select their registered actor explicitly. Use JSON `null` to clear nullable fields.

A project can only contain issues from its linked teams. A cycle belongs to the issue team, and a milestone belongs to its project. When moving an issue, clear or replace incompatible references in the same action. The issue identifier stays unchanged. To add participants to a team or project, use `memberIds`. Agents can also own saved views and subscribe to issues. Members remain human profiles.

## Handle failures

Use `--json` to receive a JSON error on stderr. Check the exit code before parsing stdout.

- `invalid_input` (2): correct the arguments or payload.
- `relationship_conflict` (3): read current IDs and active actors, then correct the relationship.
- `sync_conflict` (3): run `sync status` and review both sides. For intended snapshot edits, validate and preview import before import. For database changes outside synchronization, export them when the snapshot is unchanged.
- `storage_error` (4): inspect the storage failure and synchronization status before retrying.
- `pending_export` (4): the change is committed. Run `sync status` or `sync export` to recover publication. Do not repeat the mutation.

Do not use `--force` as automatic recovery. Import replaces the complete database; it is not a merge. If recovery reports changed snapshot files, restore the input required by the error before recovery. Do not edit SQLite or snapshot records to perform normal workspace actions. Do not remove recovery files or reset storage to bypass a conflict.

See [CLI reference](CLI.md) for backups, format details, and command options. See [HTTP API](API.md) for shared payload fields and [architecture](ARCHITECTURE.md) for the write and recovery flow.
