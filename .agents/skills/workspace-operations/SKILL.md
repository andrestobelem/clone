---
name: workspace-operations
description: Read or change issues, projects, teams, views, and other data in this local workspace with its CLI. Use when a task asks you to inspect or act on workspace records.
---

# Workspace operations

Use the workspace CLI for every record read or write. Answer the user in the language they used.

Before the first command, read the [Agent CLI guide](../../../docs/AGENTS.md) completely. It is the source of truth for storage, actor identity, relationships, and recovery. Use the [CLI reference](../../../docs/CLI.md) only when command discovery does not provide enough detail.

## Operate

1. Work from the repository root. Use the source-repository command defined in the Agent CLI guide.
2. Discover the command contract. Before a write, also check storage and select one active actor.
3. Read the target record and its related records.
4. Perform the requested action with JSON output. For a write, use the selected actor.
5. Read the result after each write.

The operation is complete only when the returned record contains the requested values and storage reports no error.

If a command fails, follow the recovery action for its exact error category in the Agent CLI guide. Recovery is complete when storage reports a consistent state.
