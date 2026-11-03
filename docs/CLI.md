# CLI and Git snapshots

Clone requires Node.js 24.15 or later. Run it with `npx @andrestobelem/clone@0.3.0`, or use `node bin/clone.js` after `npm ci` and `npm run build` in this repository. The CLI uses an operating system file lock to share storage with the web server. Keep one database per storage directory. Keep all processes on the same database and snapshot paths.

See the [HTTP API](API.md) for payload fields and the [development guide](DEVELOPMENT.md) for temporary-storage checks.

## Start

For an existing database without a snapshot, create the first snapshot:

```sh
npx @andrestobelem/clone@0.3.0 sync export
npx @andrestobelem/clone@0.3.0 sync validate
```

For a new workspace, use `npx @andrestobelem/clone@0.3.0 init`. Use `init --demo` to load demo data. To restore a workspace from Git, use `npx @andrestobelem/clone@0.3.0 sync import` instead of `init`.

Start the web server with `npx @andrestobelem/clone@0.3.0`. The server creates an empty database on first launch if no snapshot exists. Stop an old server before you start the updated server. Queries do not create a database or load demo data.

## Commands

Use `npx @andrestobelem/clone@0.3.0 --help` or add `--help` to any command. Global options can appear before or after the command:

- `--local`: use `./.clone/` in the current directory.
- `--data-dir PATH`: use an explicit storage directory.
- `--db PATH`: use an explicit SQLite file. Without this option, Clone uses `workspace.sqlite3` in the selected local, explicit, or installed user data directory.
- `--sync-dir PATH`: snapshot directory. The default is `snapshot/` next to the database.
- `--actor ID`: actor who performs an action. `CLONE_ACTOR_ID` supplies the actor when the option is absent. Clone 0.3 warns when both are absent and it uses actor 1. Clone 0.4 requires a selected actor.
- `--json`: JSON output and JSON errors. Structured results also use JSON by default.

Select only one of `--local`, `--data-dir`, and `--db`. Clone rejects ambiguous storage selection before it opens or creates storage. `--sync-dir` can be used with each storage mode.

Run `context --json` to inspect the selected mode and the absolute database, data, snapshot, attachment, and backup paths. This command does not open or create storage.

Run `doctor --json` to inspect the existing Workspace ID, schema, snapshot format, synchronization state, selected actor, and CLI compatibility. Doctor opens the database in read-only mode and does not change storage.

Doctor reports `healthy: false` for an unsupported future schema or missing synchronization state. A future schema returns a schema check with status `unsupported`; use a compatible Clone version. Missing state returns `synchronization.state_missing: true` and a synchronization check with status `state_missing`. Review recovery instructions before changing storage.

Results use stdout. Errors use stderr. Exit codes are 0 for success, 2 for invalid input, 3 for a conflict, and 4 for a storage failure. A storage error can report that a change was committed and its export is pending. Do not repeat that change. Run `sync status` or `sync export` to recover it.

| Command group | Actions |
| --- | --- |
| `init` | Create empty storage; `--demo` adds demo records |
| `context` | Show the resolved storage mode and paths in JSON |
| `doctor` | Check workspace identity, compatibility, actor selection, and storage health |
| `serve` | Start the web server and recurring scheduler |
| `search` | Search active issues and projects |
| `export` | Write UI JSON data to stdout |
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
| `describe [COMMAND...]` | Full or filtered command catalog in JSON |
| `batch` | Apply canonical mutations in one transaction and snapshot publication |

Members remain read-only. CLI mutations use the same actions and validation as the API. Settings can store the rule configuration used by the existing UI. Entities that the app only reads or creates do not have update or delete commands.

Issues use their identifier, such as `PRO-248`. Other entities use their numeric ID. Settings use their key. Use `--all` with `list` to include archived and inactive records. `inbox list` selects the caller's active notifications; `inbox list --all` includes all recipients and archived notifications. Lists support `--team-id`, `--project-id`, and `--status` where those fields apply. Issue and active project `show` include related data. Archived project `show` returns stored fields. Team `show` includes participants, workflow statuses, and resources. Other lists return stored fields.

The following commands are separate examples. Replace IDs and identifiers with values from your workspace. Use the identifier returned by `issues create` for later issue commands. External agents must also add their registered `--actor ID` to each write.

```sh
npx @andrestobelem/clone@0.3.0 issues create --actor 1 --team-id 1 --title 'Fix search' --priority High
npx @andrestobelem/clone@0.3.0 issues update PRO-249 --actor 1 --if-revision 1 --status 'In Progress'
npx @andrestobelem/clone@0.3.0 issues comment PRO-249 --actor 1 --body 'Started work'
npx @andrestobelem/clone@0.3.0 issues create --actor 1 --team-id 1 --title 'Check keyboard input' --parent-id 13
npx @andrestobelem/clone@0.3.0 issues attach PRO-249 --actor 1 --file ./notes.txt
npx @andrestobelem/clone@0.3.0 attachments get 1 --output ./download.txt
npx @andrestobelem/clone@0.3.0 projects post-update 1 --actor 1 --body 'Search is ready' --health 'On track'
npx @andrestobelem/clone@0.3.0 inbox read-selected --actor 1 --ids '[1,2]'
npx @andrestobelem/clone@0.3.0 search search --scope Issues
npx @andrestobelem/clone@0.3.0 recurring run
```

Use `--data @file.json`, `--data -` for stdin, or a JSON object for a complete payload. Payload fields use the current API names, such as `teamId`, `labelIds`, and `subscriberIds`. Flags override the matching fields in `--data`. `--actor` takes precedence over `CLONE_ACTOR_ID` and payload `actorId`; selectors must agree. Use JSON `null` to clear a field. Array and object flags accept JSON.

List commands return `{ "items": [], "page": { "nextCursor": null } }`. Use `--limit` and the returned opaque `--cursor` to read another page. The default limit is 100 and the maximum is 500.

Changes to existing records require `--if-revision NUMBER`. Read the record again and retry with its current revision after a `record_conflict` error.

```sh
npx @andrestobelem/clone@0.3.0 issues update PRO-249 --actor 1 --if-revision 1 --data '{"assigneeId":null,"labelIds":[1,2]}'
npx @andrestobelem/clone@0.3.0 views create --actor 1 --name Urgent --filters '{"priority":"Urgent"}'
npx @andrestobelem/clone@0.3.0 settings update --actor 1 --if-revision 1 --key preferences --value '{"defaultHome":"Home"}'
```

`issues import --data @issues.json --dry-run` previews the existing issue import. The input is an object with an `issues` array. `npx @andrestobelem/clone@0.3.0 export` writes the existing UI JSON export to stdout. That export is not a complete database backup. Use `sync export` for Git storage.

## Git workflow

### Record work evidence

```sh
npx @andrestobelem/clone@0.3.0 issues evidence PRO-249 --actor 6 --kind test --reference 'npm run check' --result pass --summary 'Runtime and UI checks passed' --json
```

Use `commit`, `test`, or `artifact` for `--kind`. The optional `--result` accepts `pass`, `fail`, or `not_applicable`. Evidence is append-only and needs no `--if-revision`. Read `issues show` to verify it. Record the scope of the check; a local test does not establish a deployed result.

The web server, CLI, and recurring issue scheduler export after each change. With the direct CLI defaults, the complete snapshot is stored in `data/snapshot/`. SQLite, local sync state, and backups stay outside Git. Other database paths use a `snapshot/` directory next to the database unless `--sync-dir` selects another directory.

```sh
npx @andrestobelem/clone@0.3.0 sync status
npx @andrestobelem/clone@0.3.0 sync validate
git add data/snapshot
git commit -m 'chore(data): save workspace changes'
```

Before you pull, save your local changes in Git. After you pull or edit snapshot files, review and import the result:

```sh
git pull
npx @andrestobelem/clone@0.3.0 sync validate
npx @andrestobelem/clone@0.3.0 sync import --dry-run
npx @andrestobelem/clone@0.3.0 sync import
```

Import replaces the complete database. A record missing from the snapshot is deleted. IDs, dates, history, preferences, inactive members, archived records, and attachment bytes are preserved. Import does not trigger automations or create activity events. An empty snapshot is supported. It will need workspace and member records before normal issue operations can resume.

Files changed by Git or a text editor block new writes until import. A database changed outside the app blocks import and new writes. Use `sync export` to save those database changes if the snapshot files have not changed. These checks prevent one side from silently replacing the other.

`sync export --dry-run` lists files added, changed, and deleted. `sync import --dry-run` lists the database changes as record and attachment paths. Neither preview changes workspace data. Commands can finish recovery of an earlier interrupted operation before they run.

To discard conflicting changes, use `sync export --force` or `sync import --force`. Both create a backup when a database exists. Forced export also backs up the old snapshot. Import backs up the database and its attachments before each replacement. Backup paths appear in the result and are stored under `data/backups/`.

Unused document, review, and agent chat tables are deleted on startup, export, import, or the next mutation. The unused document reference in team resources is also removed. These tables are not saved in Git. Export previews do not delete tables.

## File format and recovery

`manifest.json` records format version 3, all supported tables, their columns, and their primary keys. Each supported application table has one JSON file per row. Internal SQLite sequence and synchronization token tables are not exported. Filenames use `row-` followed by the primary key. Composite keys use `--` between values. String keys use URL encoding. Empty tables need no directory. The manifest still declares them.

JSON uses UTF-8, two-space indentation, sorted field names, and a final newline. Stored JSON columns remain JSON strings to preserve their exact database values. Attachment metadata stays in `issue_attachments/`. Attachment files use their stored names under `attachments/`.

Validation rejects unknown tables, fields, files, format versions, duplicate or invalid keys, invalid references, missing attachments, unsafe paths, symbolic links, invalid JSON, and unresolved Git conflict markers. Resolve Git conflicts before you import. A snapshot is a complete state, not a patch. It does not merge independently changed databases.

An export is staged before commit. A local journal and a transaction marker record whether the database commit finished. Recovery publishes the staged files after a successful commit or removes them after a rollback. Attachment imports use a staged directory and keep the old attachment directory until the transaction finishes. Do not remove `.sync-*` files while recovery is pending. If an external edit conflicts with a pending export, restore the previous snapshot files before recovery.

The internal `__sync_meta` SQLite table stores only the recovery marker. It is excluded from snapshots. The app tables are exported in full. The CLI does not run Git commands.

Run the test suite with:

```sh
npm run check
```


## Actors and agents

An actor is a person or an agent. Members are human profiles. `members list/show` remains read-only and returns people. `actors list/show` returns actor identities. `agents list/show` returns only agents. Add `--all` to include inactive identities.

Use `agents create --key KEY --name NAME` to register an agent. Add `--team-id ID` to make the new agent a participant in one team. Keys are unique, case-sensitive, and fixed. Outer spaces are removed at registration. `agents update ID --name NAME` changes its display name. `agents deactivate ID` blocks new writes and new assignments to that agent. `agents restore ID` enables them again. Deactivation preserves existing relations and history. Agents cannot be deleted. Use `agents list --team-id ID` to list agents that participate in one team.

`--actor` and `actorId` accept an actor ID. These fields also accept actor IDs: `assigneeId`, `leadId`, `memberIds`, and `subscriberIds`. Their flag names remain unchanged. For teams, `memberIds` sets participants on create or update. Creation also adds the acting actor as Lead. For projects, creation defaults the lead and participants to the acting actor. Existing inactive relations can be kept or removed during an update, but cannot be added to other records.

The API adds `GET /api/actors`, `GET /api/actors/ID`, `GET /api/agents`, and `GET /api/agents/ID`. Lists support `?all=true`. Agent mutations use `POST /api/agents`, `PATCH /api/agents/ID`, and `POST /api/agents/ID/deactivate` or `restore`. Bootstrap includes `actors` and `currentActorId`. The Members roster contains people only.

## Discovery and errors

`npx @andrestobelem/clone@0.3.0 describe` returns the complete format-version-2 command catalog without opening storage. Add a command path prefix to return only matching contracts. For example, `describe issues` returns all issue commands and `describe issues comment` returns one command. An unknown path returns `invalid_input`. A close path also returns up to three canonical suggestions in the JSON `suggestions` field.

Each command has a path and argument records. These records contain flag names, types, required status, defaults or default rules, choices where defined, and whether the flag can repeat. The `--db` default is the resolved path for the current `--local` or `--data-dir` selection. Resolution does not open storage. The catalog describes parser arguments. Required payload fields are validated by the shared actions.

For agent workflows and strict JSON pipelines, run `npx --yes --loglevel=error @andrestobelem/clone@0.3.0`. The extra options suppress npm notices. Clone does not control output written by the parent npm process. Install the same package as a local development dependency and use `npx --no-install clone` for repeated operations.

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

Stop the web server before a database upgrade. Use `sync export` to save database changes outside synchronization, or validate and import intended snapshot edits before migration. Import can also upgrade an older database when it replaces its contents. Run `npx @andrestobelem/clone@0.3.0 sync status`, then `npx @andrestobelem/clone@0.3.0 sync migrate`. Migration checks for conflicts, makes a backup of the database, attachments, and snapshot, and adds the Workspace ID and Record revisions. It preserves IDs and history. A second migration reports `migrated: false`. Read commands on an old database request migration without changing its schema.

Format-1 and format-2 snapshots are accepted by validation and import preview. Validation converts records in memory. Preview preserves the snapshot and does not create a database. Import adds actor identities when required, a Workspace ID, Record revisions, and publishes a format-3 snapshot. Exports from upgraded databases use format 3. An export from an older database keeps its source format so changes can be saved before migration. Old app versions cannot use format 3 safely. All processes that share storage must use the updated code.

## Input and relationship checks

See the [API payload reference](API.md#common-payloads) for fields and supported values. Priority must be a name or a number from 0 to 4. Nonfinite numbers, negative estimates/capacity, invalid dates, and malformed array/object fields are rejected.

Issue creation accepts `--milestone-id` and an object, text, or null for `recurringRule`. New issues use the team's default workflow status unless `--status` is supplied. A team move resolves status in the destination team, retains the issue identifier, and keeps that identifier reserved. Clear or replace incompatible project, cycle, and milestone references in the same payload.

```sh
npx @andrestobelem/clone@0.3.0 issues update PRO-248 --actor 1 --if-revision 1 --team-id 2 --status Todo --data '{"projectId":null,"cycleId":null,"milestoneId":null}'
```

Use `[]` to clear list relationships. A label or subscriber update records activity and runs issue update automations. `attachments get --output` must point outside the database storage directory and the snapshot directory; it cannot replace recovery files, backups, or SQLite files.
