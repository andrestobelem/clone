---
name: workspace-operations
description: Read or change issues, projects, teams, views, and other data in this local workspace with its CLI. Use when a task asks you to inspect or act on workspace records.
---

# Workspace operations

Use the workspace CLI for every record read or write. Answer the user in the language they used.

## Prepare

Work from the repository root. Read the [Agent CLI guide](../../../docs/AGENTS.md) before the first command in the task. Use the [CLI reference](../../../docs/CLI.md) when command discovery does not provide enough detail.

Run `npx @andrestobelem/clone describe --json`. Before a write, also run `npx @andrestobelem/clone sync status --json`. In the Clone source repository, use `node bin/clone.js` after `npm run build`. Preparation is complete when the command contract and storage state are known.

## Select the actor

For a write, find this agent's stable actor by key. Register it only when it does not exist. Use its actor ID on every write. The Agent CLI guide defines registration, inactive actors, and actor fields. Actor selection is complete when one active actor ID is selected.

## Operate

Read the current record and its related records. Use JSON output. Perform the requested action with the selected actor. Read the result after each write.

The operation is complete only when the returned record contains the requested values and storage reports no error.

## Recover

Follow the recovery action for the exact error category in the Agent CLI guide. A `pending_export` means the write committed; recover publication without repeating the write. A `sync_conflict` requires inspection of both sides.

Use the CLI recovery commands. Keep SQLite, snapshot records, and recovery files under CLI control. Recovery is complete when `sync status --json` reports a consistent state.
