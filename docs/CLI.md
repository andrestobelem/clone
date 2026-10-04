# CLI and Git snapshots

The project pins Python 3.14 with uv and uses the standard library. It runs on macOS and Linux. Run `uv sync` to create the project environment. The CLI uses an operating system file lock to share storage with the web server. Keep one database per storage directory. Keep all processes on the same database and snapshot paths.

See the [HTTP API](API.md) for payload fields and the [development guide](DEVELOPMENT.md) for temporary-storage checks.

## Start

For an existing database without a snapshot, create the first snapshot:

```sh
uv run python cli.py sync export
uv run python cli.py sync validate
```

For a new workspace, use `uv run python cli.py init`. Use `init --demo` to load demo data. To restore a workspace from Git, use `uv run python cli.py sync import` instead of `init`.

Start the web server with `uv run python cli.py serve` or `uv run python server.py`. The server can create a demo database on first launch if no snapshot exists. Stop an old server before you start the updated server. Queries do not create a database or load demo data.

## Commands

Use `uv run python cli.py --help` or add `--help` to any command. Global options can appear before or after the command:

- `--db PATH`: SQLite file. The default is `data/workspace.sqlite3`.
- `--sync-dir PATH`: snapshot directory. The default is `snapshot/` next to the database.
- `--actor ID`: actor who performs an action. The default is 1.
- `--json`: JSON output and JSON errors. Structured results also use JSON by default.

Results use stdout. Errors use stderr. Exit codes are 0 for success, 2 for invalid input, 3 for a conflict, and 4 for a storage failure. A storage error can report that a change was committed and its export is pending. Do not repeat that change. Run `sync status` or `sync export` to recover it.

| Command group | Actions |
| --- | --- |
| `issues` | list, show, create, update, archive, restore, comment, attach, relate, import |
| `projects` | list, show, create, update, archive, restore, milestone, post-update, depend |
| `teams` | list, show, create, update, add-resource, remove-resource |
| `members` | list, show |
| `actors` | list, show |
| `agents` | list, show, create, update, deactivate, restore |
| `statuses`, `labels`, `cycles` | list, show, create |
| `views` | list, show, create, update, delete |
| `inbox` | list, show, read, unread, archive, read-all, read-selected, archive-selected |
| `preferences`, `workspace` | list, show, update |
| `settings` | list, show, update |
| `automations` | list, show, create |
| `recurring` | list, show, create, run |
| `attachments` | get |
| `sync` | status, export, import, validate, migrate |
| `describe` | Command catalog in JSON |

Members remain read-only. CLI mutations use the same actions and validation as the API. Settings can store the rule configuration used by the existing UI. Entities that the app only reads or creates do not have update or delete commands.

Issues use their identifier, such as `PRO-248`. Other entities use their numeric ID. Settings use their key. Use `--all` with `list` to include archived and inactive records. Lists support `--team-id`, `--project-id`, and `--status` where those fields apply. Issue and project `show` include related data. Other lists return stored fields.

```sh
uv run python cli.py issues create --team-id 1 --title 'Fix search' --priority High
uv run python cli.py issues update PRO-249 --status 'In Progress'
uv run python cli.py issues comment PRO-249 --body 'Started work'
uv run python cli.py issues create --team-id 1 --title 'Check keyboard input' --parent-id 13
uv run python cli.py issues attach PRO-249 --file ./notes.txt
uv run python cli.py attachments get 1 --output ./download.txt
uv run python cli.py projects post-update 1 --body 'Search is ready' --health 'On track'
uv run python cli.py inbox read-selected --ids '[1,2]'
uv run python cli.py search search --scope Issues
uv run python cli.py recurring run
```

Use `--data @file.json`, `--data -` for stdin, or a JSON object for a complete payload. Payload fields use the current API names, such as `teamId`, `labelIds`, and `subscriberIds`. Flags override the matching fields in `--data`. `--actor` overrides payload `actorId`, including the default actor 1. Use JSON `null` to clear a field. Array and object flags accept JSON.

```sh
uv run python cli.py issues update PRO-249 --data '{"assigneeId":null,"labelIds":[1,2]}'
uv run python cli.py views create --name Urgent --filters '{"priority":"Urgent"}'
uv run python cli.py settings update --key preferences --value '{"defaultHome":"Home"}'
```

`issues import --data @issues.json --dry-run` previews the existing issue import. The input is an object with an `issues` array. `uv run python cli.py export` writes the existing UI JSON export to stdout. That export is not a complete database backup. Use `sync export` for Git storage.

## Git workflow

The web server, CLI, and recurring issue scheduler export after each change. The complete snapshot is stored in `data/snapshot/`. SQLite, local sync state, and backups stay outside Git.

```sh
uv run python cli.py sync status
uv run python cli.py sync validate
git add data/snapshot
git commit -m 'chore(data): save workspace changes'
```

Before you pull, save your local changes in Git. After you pull or edit snapshot files, review and import the result:

```sh
git pull
uv run python cli.py sync validate
uv run python cli.py sync import --dry-run
uv run python cli.py sync import
```

Import replaces the complete database. A record missing from the snapshot is deleted. IDs, dates, history, preferences, inactive members, archived records, and attachment bytes are preserved. Import does not trigger automations or create activity events. An empty snapshot is supported. It will need workspace and member records before normal issue operations can resume.

Files changed by Git or a text editor block new writes until import. A database changed outside the app blocks import and new writes. Use `sync export` to save those database changes if the snapshot files have not changed. These checks prevent one side from silently replacing the other.

`sync export --dry-run` lists files added, changed, and deleted. `sync import --dry-run` lists the database changes as record and attachment paths. Neither preview changes workspace data. Commands can finish recovery of an earlier interrupted operation before they run.

To discard conflicting changes, use `sync export --force` or `sync import --force`. Both create a backup when a database exists. Forced export also backs up the old snapshot. Import backs up the database and its attachments before each replacement. Backup paths appear in the result and are stored under `data/backups/`.

Unused document, review, and agent chat tables are deleted on startup, export, import, or the next mutation. The unused document reference in team resources is also removed. These tables are not saved in Git. Export previews do not delete tables.

## File format and recovery

`manifest.json` records format version 2, all supported tables, their columns, and their primary keys. Each supported application table has one JSON file per row. Internal SQLite sequence and synchronization token tables are not exported. Filenames use `row-` followed by the primary key. Composite keys use `--` between values. String keys use URL encoding. Empty tables need no directory. The manifest still declares them.

JSON uses UTF-8, two-space indentation, sorted field names, and a final newline. Stored JSON columns remain JSON strings to preserve their exact database values. Attachment metadata stays in `issue_attachments/`. Attachment files use their stored names under `attachments/`.

Validation rejects unknown tables, fields, files, format versions, duplicate or invalid keys, invalid references, missing attachments, unsafe paths, symbolic links, invalid JSON, and unresolved Git conflict markers. Resolve Git conflicts before you import. A snapshot is a complete state, not a patch. It does not merge independently changed databases.

An export is staged before commit. A local journal and a transaction marker record whether the database commit finished. Recovery publishes the staged files after a successful commit or removes them after a rollback. Attachment imports use a staged directory and keep the old attachment directory until the transaction finishes. Do not remove `.sync-*` files while recovery is pending. If an external edit conflicts with a pending export, restore the previous snapshot files before recovery.

The internal `__sync_meta` SQLite table stores only the recovery marker. It is excluded from snapshots. The app tables are exported in full. The CLI does not run Git commands.

Run the test suite with:

```sh
uv run python -m unittest discover -s tests -v
```


## Actors and agents

An actor is a person or an agent. Members are human profiles. `members list/show` remains read-only and returns people. `actors list/show` returns actor identities. `agents list/show` returns only agents. Add `--all` to include inactive identities.

Use `agents create --key KEY --name NAME` to register an agent. Keys are unique, case-sensitive, and fixed. Outer spaces are removed at registration. `agents update ID --name NAME` changes its display name. `agents deactivate ID` blocks new writes and new assignments to that agent. `agents restore ID` enables them again. Deactivation preserves existing relations and history. Agents cannot be deleted.

`--actor` and `actorId` accept an actor ID. These fields also accept actor IDs: `assigneeId`, `leadId`, `memberIds`, and `subscriberIds`. Their flag names remain unchanged. For teams, `memberIds` sets participants on create or update. Creation also adds the acting actor as Lead. For projects, creation defaults the lead and participants to the acting actor. Existing inactive relations can be kept or removed during an update, but cannot be added to other records.

The API adds `GET /api/actors`, `GET /api/actors/ID`, `GET /api/agents`, and `GET /api/agents/ID`. Lists support `?all=true`. Agent mutations use `POST /api/agents`, `PATCH /api/agents/ID`, and `POST /api/agents/ID/deactivate` or `restore`. Bootstrap includes `actors` and `currentActorId`. The Members roster contains people only.

## Discovery and errors

`uv run python cli.py describe` returns a format-version-1 command catalog without opening storage. Each command has a path and argument records. These records contain flag names, types, required status, defaults or default rules, choices where defined, and whether the flag can repeat. The catalog describes parser arguments. Required payload fields are validated by the shared actions.

With `--json`, each error is one JSON object on stderr. Stdout is empty on failure. Errors contain `code`, `message`, and `exitCode`.

| Code | Exit code |
| --- | --- |
| `invalid_input` | 2 |
| `sync_conflict` | 3 |
| `relationship_conflict` | 3 |
| `storage_error` | 4 |
| `pending_export` | 4 |

A `pending_export` error also contains `committed: true` and `recoveryRequired: true`. Recover synchronization before another write. Do not repeat the action. `--help` remains text and exits with code 0.

## Upgrade older storage

Stop the web server before a database upgrade. Use `sync export` to save database changes outside synchronization, or validate and import intended snapshot edits before migration. Import can also upgrade an older database when it replaces its contents. Run `uv run python cli.py sync status`, then `uv run python cli.py sync migrate`. Migration checks for conflicts, makes a backup of the database, attachments, and snapshot, and converts human references to actor references. It preserves IDs and history. A second migration reports `migrated: false`. Read commands on an old database request migration without changing its schema.

Format-1 snapshots are accepted by validation and import preview. Validation converts records in memory. Preview preserves the snapshot and does not create a database. Import creates actor identities for members and publishes a format-2 snapshot. Exports from upgraded databases use format 2. An export from an older database uses format 1 so changes can be saved before migration. Old app versions cannot read format 2. All processes that share storage must use the updated code.

## Input and relationship checks

See the [API payload reference](API.md#common-payloads) for fields and supported values. Priority must be a name or a number from 0 to 4. Nonfinite numbers, negative estimates/capacity, invalid dates, and malformed array/object fields are rejected.

Issue creation accepts `--milestone-id` and an object, text, or null for `recurringRule`. New issues use the team's default workflow status unless `--status` is supplied. A team move resolves status in the destination team, retains the issue identifier, and keeps that identifier reserved. Clear or replace incompatible project, cycle, and milestone references in the same payload.

```sh
uv run python cli.py issues update PRO-248 --team-id 2 --status Todo --data '{"projectId":null,"cycleId":null,"milestoneId":null}'
```

Use `[]` to clear list relationships. A label or subscriber update records activity and runs issue update automations. `attachments get --output` must point outside the database storage directory and the snapshot directory; it cannot replace recovery files, backups, or SQLite files.
