# Agent CLI guide

Use Node.js 24.15 or later. Run agent commands with `npx --yes --loglevel=error @andrestobelem/clone@0.3.0`. The npm options keep stdout and stderr available for Clone JSON only. For repeated commands with a local dependency, use `npx --no-install clone`. In this repository, run `npm ci` and use `node bin/clone.js` after `npm run build`. The CLI does not need a web server.

## Discover and prepare

1. Run `npx --yes --loglevel=error @andrestobelem/clone@0.3.0 context --json` and `doctor --json` with the selected storage option. Keep the returned storage mode for the complete task.
2. Run `npx --yes --loglevel=error @andrestobelem/clone@0.3.0 describe COMMAND... --json` to read the contract for the command group or command you need. Run `describe --json` only when you need the complete catalog.
3. Before a write, run `npx --yes --loglevel=error @andrestobelem/clone@0.3.0 sync status --json` to check storage.
4. For a missing database with an existing snapshot, run `sync validate`, `sync import --dry-run`, then `sync import`. For a new workspace without a snapshot, run `init` or `init --demo`.
5. For an older database, stop the web server and run `sync migrate`. Start the server again with the updated code.

Use `--db PATH` and `--sync-dir PATH` when the workspace uses other storage paths. All processes must use the same paths.

## Register and select an actor

Run `agents list --all` and check for your fixed agent key. If the key does not exist, register it:

```sh
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 agents create --key codex --name Codex --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 actors list --json
```

Keep the returned actor ID. Use it in every mutation or set `CLONE_ACTOR_ID` for the complete process. Reuse this identity across executions. Registration rejects duplicate keys. Restore an inactive identity explicitly before you use it. Deactivation preserves history.

`--actor ID` identifies the caller. `--assignee-id ID`, `--lead-id ID`, `--member-ids '[ID]'`, and `--subscriber-ids '[ID]'` select actors for work relationships. Actor IDs are distinct from issue and project IDs. Actor selection records identity; this local app does not authenticate it.

## Read context and perform work

Query teams and workflow statuses before you create an issue. Use issue identifiers such as `PRO-248` for issue commands. Use numeric IDs for actors, projects, teams, and other records.

```sh
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 teams list --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 statuses list --team-id 1 --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 search 'search' --scope Issues --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 issues show PRO-248 --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 issues create --actor 6 --team-id 1 --title 'Check search' --assignee-id 7 --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 issues update PRO-249 --actor 6 --if-revision 1 --status 'In Progress' --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 issues comment PRO-249 --actor 7 --body 'Checked search' --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 issues show PRO-249 --json
```

Replace example IDs and identifiers with values from the workspace. Read the result after each change. For payloads, send a JSON object through stdin with `--data -`, or use `--data @file.json`. Flags override payload fields. `--actor` takes precedence over `CLONE_ACTOR_ID` and payload `actorId`; selectors must agree when more than one is present. External agents must select their registered actor explicitly. Use JSON `null` to clear nullable fields.

List responses contain `items` and `page.nextCursor`. Read every required page. Existing-record changes require the revision returned by the last read. Use Batch for multiple independent mutations that must commit together.

Record verified work with `issues evidence`. Use `kind` values `commit`, `test`, or `artifact` and a concrete `reference`. Test results use `pass`, `fail`, or `not_applicable`. Append-only evidence and comments do not require the issue revision. Evidence records what was checked; it does not prove deployment or complete an issue automatically.

A project can only contain issues from its linked teams. A cycle belongs to the issue team, and a milestone belongs to its project. When moving an issue, clear or replace incompatible references in the same action. The issue identifier stays unchanged. To add participants to a team or project, use `memberIds`. Agents can also own saved views and subscribe to issues. Members remain human profiles.

## Handle failures

Use `--json` to receive a JSON error on stderr. Check the exit code before parsing stdout.

- `invalid_input` (2): correct the arguments or payload.
- `relationship_conflict` (3): read current IDs and active actors, then correct the relationship.
- `record_conflict` (3): read the current record and retry with its new revision.
- `sync_conflict` (3): run `sync status` and review both sides. For intended snapshot edits, validate and preview import before import. For database changes outside synchronization, export them when the snapshot is unchanged.
- `storage_error` (4): inspect the storage failure and synchronization status before retrying.
- `pending_export` (4): the change is committed. Run `sync status` or `sync export` to recover publication. Do not repeat the mutation.

Do not use `--force` as automatic recovery. Import replaces the complete database; it is not a merge. If recovery reports changed snapshot files, restore the input required by the error before recovery. Do not edit SQLite or snapshot records to perform normal workspace actions. Do not remove recovery files or reset storage to bypass a conflict.

See [CLI reference](CLI.md) for backups, format details, and command options. See [HTTP API](API.md) for shared payload fields and [architecture](ARCHITECTURE.md) for the write and recovery flow.
