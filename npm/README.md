# Clone

Run a local issue and project workspace without installing Python.

Website: <https://clone-andrestobelem-prod.web.app>

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

`--local` stores the workspace in `.clone/` in the current directory. Add `.clone/` to the repository's `.gitignore` unless you have a specific backup workflow. `--data-dir PATH` selects an explicit directory.

## Data locations

| System | Workspace data | Downloaded executable cache |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Clone/` | `~/Library/Caches/Clone/` |
| Linux | `$XDG_DATA_HOME/clone/` or `~/.local/share/clone/` | `$XDG_CACHE_HOME/clone/` or `~/.cache/clone/` |
| Windows | `%APPDATA%\Clone\` | `%LOCALAPPDATA%\Clone\cache\` |

The workspace data directory contains `workspace.sqlite3`, snapshots, attachments, and backups. Set `CLONE_CACHE_DIR` to select another executable cache.

Clone supports macOS on ARM64 and x64, Linux on ARM64 and x64, and Windows on x64.
