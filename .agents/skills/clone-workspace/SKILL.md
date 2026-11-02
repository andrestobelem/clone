---
name: clone-workspace
description: Operate a Clone issue and project workspace from another repository through npx. Use when reading or changing Clone issues, projects, teams, views, or other workspace records. Do not use for developing the Clone source repository itself.
---

# Clone workspace

Use Clone `0.3.0` through `npx --yes --loglevel=error @andrestobelem/clone@0.3.0`. These npm options leave stdout and stderr available for Clone JSON. For repeated operations with a local dependency, use `npx --no-install clone`. The CLI and browser use the same records and actions. A web server is not required for CLI work.

## Select storage

Use one storage mode for the complete task.

- Use the global workspace by default.
- Use `--local` when the user requests a workspace for the current repository or when that repository already contains `.clone/`.
- Use `--data-dir PATH` only when the user selects an explicit data directory.
- Use `--db PATH` only when the user selects an explicit SQLite file.
- Select only one of `--local`, `--data-dir`, and `--db`.

For a new local workspace, add `.clone/` to the repository's `.gitignore` unless the user has a specific Git backup workflow.

## Prepare

Run `context --json` and `doctor --json` with the selected storage mode. Then run `describe COMMAND... --json` with the same mode. Select the command group or complete command path required by the task. Run `describe --json` only when the task needs the complete catalog. Describe is the source of truth for current commands and flags.

Before a write, also run `sync status --json`. Preparation is complete when the command contract and storage state are known. Keep the same storage mode for every later command.

## Select the actor

Writes must identify the calling agent. Run `agents list --all --json` and find its stable key:

- Codex uses `codex` and the name `Codex`.
- Claude uses `claude` and the name `Claude`.

If the key does not exist, register it once with `agents create --key KEY --name NAME --json`. If it is inactive, restore it explicitly. Keep the returned actor ID and pass `--actor ID` on every later write, or set `CLONE_ACTOR_ID` for the complete process.

Actor selection is complete when one active actor ID is known. Actor identity records authorship; it does not authenticate the caller.

## Operate

Read the target record and related records before a write. Keep the returned `revision` and pass it as `--if-revision` when changing, archiving, restoring, or deleting that record. Use issue identifiers such as `PRO-248` for issue commands. Use numeric IDs for actors, projects, teams, and other records.

Perform the requested action with JSON output. After each write, read the result again. The operation is complete only when the returned record contains the requested values and the command reports no storage error.

Example with repository-local storage:

```sh
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 --local teams list --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 --local issues show PRO-248 --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 --local issues update PRO-248 --actor 6 --if-revision 3 --status "In Progress" --json
npx --yes --loglevel=error @andrestobelem/clone@0.3.0 --local issues show PRO-248 --json
```

Use `--data -` for a JSON object through stdin or `--data @file.json` for a file. Flags override matching payload fields. Use JSON `null` to clear nullable fields.

List results contain `items` and `page.nextCursor`. Continue with `--cursor` until `nextCursor` is `null`. Use `batch --data @file.json` for multiple independent writes that must commit together.

## Recover

Use the error category and returned recovery action:

- `invalid_input`: correct the arguments or payload.
- `relationship_conflict`: read the current related records, then correct the relationship.
- `record_conflict`: read the record again and retry with its current revision.
- `sync_conflict`: inspect both database and snapshot state before import or export.
- `pending_export`: the write committed. Recover with `sync status` or `sync export`; do not repeat the write.
- `storage_error`: inspect storage and synchronization state before retrying.

Keep SQLite, snapshot records, and recovery files under CLI control. Import replaces the complete workspace; it is not a merge. Use `--force` only when the user explicitly chooses which conflicting side must replace the other.

Recovery is complete when `sync status --json` reports a consistent state.

## Open the browser

Run `start` only when the user asks to open or serve the UI. Keep the same storage mode used by the CLI. Stop the process with Ctrl+C.
