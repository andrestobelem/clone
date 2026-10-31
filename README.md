# Clone

A local application for issues, projects, and team planning, inspired by Linear. The browser UI, CLI, and scheduler use the same Python actions and SQLite database. People and external agents have actor identities.

Website: <https://clone.andrestobelem.dev>

## Run with npx

Published releases include Python and all application files. Node.js 18 or later is the only requirement.

```sh
npx @andrestobelem/clone
```

The command downloads the verified executable for the current platform, creates an empty workspace on the first run, starts Clone on `127.0.0.1`, and opens the browser. Stop it with Ctrl+C. Later runs use the same records from the operating system's user data directory.

Use another port or keep the browser closed when needed:

```sh
npx @andrestobelem/clone start --port 5000 --no-open
```

### Use one workspace per repository

Open a terminal in the repository that the workspace belongs to. Then run:

```sh
npx @andrestobelem/clone --local
```

With `--local`, the current directory determines where Clone stores data. Clone creates `.clone/` there and stores `workspace.sqlite3`, snapshots, attachments, and backups inside it. Running the same command from another repository creates a separate workspace.

Add the directory to that repository's `.gitignore` unless you have a specific backup workflow:

```gitignore
.clone/
```

Always run the command from the same repository to reopen that workspace. `--local` does not copy or move records from the operating system's user data directory. Use `--data-dir PATH` when the data must be in another location.

The npm package is scoped because the unscoped `clone` name belongs to another package. The installed executable is still named `clone`.

### Install the agent skill

Open the repository where the agents will use Clone. Install the shared `clone-workspace` skill for Codex and Claude Code:

```sh
npx skills add andrestobelem/clone --skill clone-workspace --agent codex claude-code -y
```

The installer creates `.agents/skills/clone-workspace` for Codex, `.claude/skills/clone-workspace` for Claude Code, and `skills-lock.json` for updates. Both agents use the same skill source.

Start Clone with global storage or repository-local storage:

```sh
npx @andrestobelem/clone
npx @andrestobelem/clone --local
```

Then ask the agent to use Clone:

```text
Use Clone to create an issue for the login error.
```

The skill selects the correct storage, registers `codex` or `claude` as a stable actor, reads related records before a write, verifies the result, and recovers synchronization errors. Invoke it explicitly as `$clone-workspace` when needed. Update installed skills with `npx skills update clone-workspace`.

The canonical skill source is [`.agents/skills/clone-workspace`](.agents/skills/clone-workspace/SKILL.md). Claude Code uses the same source through `.claude/skills/clone-workspace`.

### Data locations

The npm launcher stores workspace records outside the package and outside the current directory:

| System | Workspace data | Downloaded executable cache |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Clone/` | `~/Library/Caches/Clone/` |
| Linux | `$XDG_DATA_HOME/clone/` or `~/.local/share/clone/` | `$XDG_CACHE_HOME/clone/` or `~/.cache/clone/` |
| Windows | `%APPDATA%\Clone\` | `%LOCALAPPDATA%\Clone\cache\` |

The workspace data directory contains `workspace.sqlite3`, snapshots, attachments, and backups. Set `CLONE_DATA_DIR` to use another data directory. Set `CLONE_CACHE_DIR` to use another executable cache.

## Run from the repository

- uv and Python 3.14 on macOS or Linux.
- A current browser with JavaScript enabled.

The application uses the Python standard library. There are no third-party Python dependencies, build steps, or external services. Run `uv sync --locked` to prepare the pinned environment. Keep the server on the default loopback address. The application has no authentication.

For personal use with no demo records, open a terminal in this directory and run:

```sh
sh start.sh
```

The script prepares Python with uv and creates an empty workspace on the first
run. Open [http://127.0.0.1:4173](http://127.0.0.1:4173), then create a team.
Run the same command for each later session. Stop with Ctrl+C.
Your database, snapshots, attachments, and backups stay in `data/clone/`.
Keep this directory to keep your records.
The recurring issue scheduler runs while the server is running.

To give the application to another person, build a release archive from a clean
commit:

```sh
sh scripts/build-release.sh
```

The script writes `dist/clone-VERSION.tar.gz`. The archive starts with no
records. It excludes your local environment, databases, attachments, and
backups. Windows is not verified.

## Publish a release

A `vVERSION` tag runs the release workflow. It builds standalone executables for supported macOS, Linux, and Windows targets and publishes them with SHA-256 checksums in a GitHub release. The tag, `pyproject.toml`, and `npm/package.json` versions must match.

Published versions are available on [npm](https://www.npmjs.com/package/@andrestobelem/clone) and in [GitHub Releases](https://github.com/andrestobelem/clone/releases).

For a new release, update the version in `pyproject.toml` and `npm/package.json`, commit the change, and push the matching `vVERSION` tag. The release workflow builds and publishes the platform executables first. It publishes npm only when trusted publishing is configured and the `NPM_PUBLISH_ENABLED` repository variable is `true`.

Until trusted publishing is enabled, publish npm after the GitHub release succeeds:

```sh
cd npm
npm publish --access public --provenance=false
```

Do not set `NPM_PUBLISH_ENABLED` before npm trusted publishing is configured for repository `andrestobelem/clone` and workflow `release.yml`. The workflow skips npm without blocking the GitHub release while the variable is absent.

Test a package without publishing it:

```sh
npm pack ./npm --dry-run
uv sync --locked --group package
uv run --group package python scripts/build-binary.py
```

## Create a separate workspace

Use another database path to keep test or demo records separate from your workspace:

```sh
uv run python cli.py --db /tmp/clone-demo/workspace.sqlite3 init --demo
uv run python cli.py --db /tmp/clone-demo/workspace.sqlite3 serve
```

Choose an unused directory. Omit `--demo` to create a workspace with one local member and no teams. Create a team in the UI or CLI before you add issues. `init` rejects existing storage. `serve` and `server.py` create demo data only when both the database and snapshot are absent.

## Included behavior

- Issues: workflow statuses, priorities, actor assignment, labels, comments, activity, attachments, relations, sub-issues, and archive/restore.
- Projects: linked teams, actor participation, milestones, dependencies, progress, updates, and archive/restore.
- Planning: cycles, triage, saved views, search, list and board layouts, filters, grouping, and sorting.
- Workspace: team management, read-only human rosters, Inbox actions, local preferences, issue JSON import, and UI JSON export.
- Automation: local recurring issues and rules for issue creation, update, and completion.
- Storage: SQLite plus complete Git snapshots, conflict checks, backups, migration, and interrupted-operation recovery.

The application has one local workspace. It does not provide hosted collaboration, sign-in, enforced roles, external notifications, GitHub/Slack connections, document authoring, reviews, member invitations, or agent chat. Actor IDs record who performed an action; they do not authenticate the caller. See [the product specification](SPEC.md) for behavior and limits.

## CLI and agent access

```sh
uv run python cli.py --help
uv run python cli.py describe
uv run python cli.py teams list --json
uv run python cli.py agents list --all --json
```

Register each external agent once with a stable key. Use its returned actor ID on writes. Follow the [Agent CLI guide](docs/AGENTS.md) for registration and recovery. See the [CLI reference](docs/CLI.md) for commands, payloads, and the Git workflow.

SQLite, attachment storage, recovery files, and backups remain local. The selected snapshot directory stores complete records and attachment bytes for Git. Review snapshot contents before committing them. UI JSON export contains application data but is not a complete backup.

## Verify changes

```sh
uv run python -m unittest discover -s tests -v
```

Tests use temporary storage. They cover CLI/HTTP parity, validation, actors, concurrency, snapshots, migration, and recovery. See the [development guide](docs/DEVELOPMENT.md) for browser checks and documentation checks.

## Documentation

- [Constitution](CONSTITUTION.md): binding product and engineering principles.
- [Mission](MISSION.md): the current purpose of Clone.
- [Vision](VISION.md): the future that Clone works toward.
- [Values](VALUES.md): standards for product and engineering choices.
- [Product specification](SPEC.md): current behavior and product limits.
- [Domain glossary](GLOSSARY.md): preferred product terms.
- [Architecture](docs/ARCHITECTURE.md): components, data flow, and storage.
- [HTTP API](docs/API.md): routes, payloads, validation, and errors.
- [CLI reference](docs/CLI.md): commands and synchronization.
- [Agent CLI guide](docs/AGENTS.md): identities and agent operations.
- [Development guide](docs/DEVELOPMENT.md): safe setup and verification.
- [Reference audit](docs/REFERENCE-AUDIT.md): source and limits of the original UI audit.

The repository uses the [MIT license](LICENSE).
