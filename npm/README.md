# Clone

Run a local issue and project workspace without installing Python.

Website: <https://clone.andrestobelem.dev>

```sh
npx @andrestobelem/clone
```

Clone stores its database, attachments, snapshots, and backups in the operating system's user data directory. The server listens on `127.0.0.1` and opens `http://127.0.0.1:4173`.

## Commands

```sh
npx @andrestobelem/clone start --port 5000
npx @andrestobelem/clone --local
npx @andrestobelem/clone --data-dir ./project-data
npx @andrestobelem/clone teams list --json
npx @andrestobelem/clone --help
```

Use `--no-open` with `start` to keep the browser closed. Set `CLONE_DATA_DIR` to select another data directory.

## Use one workspace per repository

Open a terminal in the repository that the workspace belongs to. Then run:

```sh
npx @andrestobelem/clone --local
```

With `--local`, the current directory determines where Clone stores data. Clone creates `.clone/` there and stores `workspace.sqlite3`, snapshots, attachments, and backups inside it. Running the same command from another repository creates a separate workspace.

Add the directory to that repository's `.gitignore` unless you have a specific backup workflow:

```gitignore
.clone/
```

Always run the command from the same repository to reopen that workspace. `--local` does not copy or move records from the operating system's user data directory. `--data-dir PATH` selects an explicit directory.

## Agent skill

Open the repository where the agents will use Clone. Then install the shared skill for Codex and Claude Code:

```sh
npx skills add andrestobelem/clone --skill clone-workspace --agent codex claude-code -y
```

The installer creates `.agents/skills/clone-workspace` for Codex, `.claude/skills/clone-workspace` for Claude Code, and `skills-lock.json` for updates.

Start Clone with global storage or add `--local` for one workspace in the current repository. Then ask the agent to use Clone:

```text
Use Clone to create an issue for the login error.
```

The skill selects storage, registers a stable `codex` or `claude` actor, reads related records, verifies writes, and handles synchronization recovery. Update it with `npx skills update clone-workspace`.

## Data locations

| System | Workspace data | Downloaded executable cache |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Clone/` | `~/Library/Caches/Clone/` |
| Linux | `$XDG_DATA_HOME/clone/` or `~/.local/share/clone/` | `$XDG_CACHE_HOME/clone/` or `~/.cache/clone/` |
| Windows | `%APPDATA%\Clone\` | `%LOCALAPPDATA%\Clone\cache\` |

The workspace data directory contains `workspace.sqlite3`, snapshots, attachments, and backups. Set `CLONE_CACHE_DIR` to select another executable cache.

Clone supports macOS on ARM64 and x64, Linux on ARM64 and x64, and Windows on x64.
