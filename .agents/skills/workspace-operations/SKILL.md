---
name: workspace-operations
description: Read or change issues, projects, teams, views, and other data in this local workspace with its CLI. Use when a task asks you to inspect or act on workspace records.
---

# Workspace operations

Use this skill for requests to read or change data in this repository's local issue and project workspace. Answer the user in the language they used.

## Find the workspace and CLI

Use the repository root as the working directory. Read the linked Agent CLI guide for the command contract and recovery steps:

- [Agent CLI guide](../../../docs/AGENTS.md)
- [CLI reference](../../../docs/CLI.md)

Run `uv run python cli.py describe --json` to discover commands and options. Run `uv run python cli.py sync status --json` before a write. Use `--json` on commands so you can read their results and errors.

Use `--db PATH` and `--sync-dir PATH` only when the task identifies a different workspace. Keep the database and snapshot paths the same for every command in one task.

## Choose an actor

Read `uv run python cli.py actors list --json` and `uv run python cli.py agents list --all --json` when the requested action needs an actor identity. Reuse the stable actor for this agent. Find it by key; do not assume its numeric ID from an example.

If this agent has no registered identity and the requested write needs one, register it once with a stable key and name:

```sh
uv run python cli.py agents create --key codex --name Codex --json
```

Use the returned actor ID as `--actor ID` on each write. Keep `--actor` off read-only commands unless it changes which records are returned, such as the Inbox. Actor IDs identify the recorded actor. They do not authenticate the process.

If the agent is inactive, do not write as it. Restore it with `agents restore ID` only when the user asked for work that requires this identity and the actor should be active again. Do not create a replacement identity just to bypass deactivation.

## Read and change records

Read current data before you change it. Use `teams list` and `statuses list --team-id ID` to select a valid team and workflow status. Search or list records, then use `show` with the issue identifier or numeric record ID to inspect related data.

Use the shared CLI actions for writes, with the user-selected fields and registered actor:

```sh
uv run python cli.py issues create --actor ID --team-id TEAM_ID --title 'Title' --json
uv run python cli.py issues update ISSUE_ID --actor ID --status 'In Progress' --json
uv run python cli.py issues comment ISSUE_ID --actor ID --body 'Comment' --json
```

Use `--data @file.json` or `--data -` for a JSON payload that needs fields without flags. Flags override payload values. Use JSON `null` to clear nullable fields. Check team and project links before creating or moving an issue: every issue linked to a project must belong to one of that project's teams.

Read the result after each write. Confirm the record has the requested values and that the workspace returned no error. Do not infer success from the command having started.

## Recover safely

- For `invalid_input`, correct the arguments or field values.
- For `relationship_conflict`, read the affected records and use a valid active actor or relationship.
- For `sync_conflict`, inspect `sync status` and follow the CLI guide. Do not force an import or export as a shortcut.
- For `storage_error`, inspect storage status before retrying.
- For `pending_export`, the change is committed. Run the stated synchronization recovery. Never repeat that write.

Do not edit SQLite or snapshot files for routine actions. Do not delete a database, remove recovery files, or run import with `--force` to bypass a conflict. For older database formats, follow the migration steps in the CLI guide.
