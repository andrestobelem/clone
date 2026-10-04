# CLI and Git snapshots

The CLI uses Python 3.10 or later and the standard library. It runs on macOS and Linux. It uses an operating system file lock to share storage with the web server. Keep one database per storage directory. Keep all processes on the same database and snapshot paths.

## Start

For an existing database, create the first snapshot:

```sh
python3 cli.py sync export
python3 cli.py sync validate
```

For a new workspace, use `python3 cli.py init`. Use `init --demo` to load demo data. To restore a workspace from Git, use `python3 cli.py sync import` instead of `init`.

Start the web server with `python3 cli.py serve` or `python3 server.py`. The server can create a demo database on first launch if no snapshot exists. Stop an old server before you start the updated server. Queries do not create a database or load demo data.

## Commands

Use `python3 cli.py --help` or add `--help` to any command. Global options can appear before or after the command:

- `--db PATH`: SQLite file. The default is `data/workspace.sqlite3`.
- `--sync-dir PATH`: snapshot directory. The default is `snapshot/` next to the database.
- `--actor ID`: member who performs an action. The default is 1.
- `--json`: JSON output. Structured results also use JSON by default.

Results use stdout. Errors use stderr. Exit codes are 0 for success, 2 for invalid input, 3 for a conflict, and 4 for a storage failure. A storage error can report that a change was committed and its export is pending. Do not repeat that change. Run `sync status` or `sync export` to recover it.

| Command group | Actions |
| --- | --- |
| `issues` | list, show, create, update, archive, restore, comment, attach, relate, import |
| `projects` | list, show, create, update, archive, restore, milestone, post-update, depend |
| `teams` | list, show, create, update, add-resource, remove-resource |
| `members` | list, show |
| `statuses`, `labels`, `cycles` | list, show, create |
| `views` | list, show, create, update, delete |
| `inbox` | list, show, read, unread, archive, read-all, read-selected, archive-selected |
| `preferences`, `workspace` | list, show, update |
| `settings` | list, show, update |
| `automations` | list, show, create |
| `recurring` | list, show, create, run |
| `attachments` | get |
| `sync` | status, export, import, validate |

Members remain read-only. Each command exposes an action already supported by the app. Settings can store the rule configuration used by the existing UI. No new CRUD operations are added for entities that the app only reads or creates.

Issues use their identifier, such as `PRO-248`. Other entities use their numeric ID. Settings use their key. Use `--all` with `list` to include archived and inactive records. Lists support `--team-id`, `--project-id`, and `--status` where those fields apply. Issue and project `show` include related data. Other lists return stored fields.

```sh
python3 cli.py issues create --team-id 1 --title 'Fix search' --priority High
python3 cli.py issues update PRO-249 --status 'In Progress'
python3 cli.py issues comment PRO-249 --body 'Started work'
python3 cli.py issues create --team-id 1 --title 'Check keyboard input' --parent-id 13
python3 cli.py issues attach PRO-249 --file ./notes.txt
python3 cli.py attachments get 1 --output ./download.txt
python3 cli.py projects post-update 1 --body 'Search is ready' --health 'On track'
python3 cli.py inbox read-selected --ids '[1,2]'
python3 cli.py search search --scope Issues
python3 cli.py recurring run
```

Use `--data @file.json`, `--data -` for stdin, or a JSON object for a complete payload. Payload fields use the current API names, such as `teamId`, `labelIds`, and `subscriberIds`. Flags override the matching fields in `--data`. Use JSON `null` to clear a field. Array and object flags accept JSON.

```sh
python3 cli.py issues update PRO-249 --data '{"assigneeId":null,"labelIds":[1,2]}'
python3 cli.py views create --name Urgent --filters '{"priority":[0]}'
python3 cli.py settings update --key preferences --value '{"defaultHome":"Home"}'
```

`issues import --data @issues.json --dry-run` previews the existing issue import. The input is an object with an `issues` array. `python3 cli.py export` writes the existing UI JSON export to stdout. That export is not a complete database backup. Use `sync export` for Git storage.

## Git workflow

The web server, CLI, and recurring issue scheduler export after each change. The complete snapshot is stored in `data/snapshot/`. SQLite, local sync state, and backups stay outside Git.

```sh
python3 cli.py sync status
python3 cli.py sync validate
git add data/snapshot
git commit -m 'chore(data): save workspace changes'
```

Before you pull, save your local changes in Git. After you pull or edit snapshot files, review and import the result:

```sh
git pull
python3 cli.py sync validate
python3 cli.py sync import --dry-run
python3 cli.py sync import
```

Import replaces the complete database. A record missing from the snapshot is deleted. IDs, dates, history, preferences, inactive members, archived records, and attachment bytes are preserved. Import does not trigger automations or create activity events. An empty snapshot is supported. It will need workspace and member records before normal issue operations can resume.

Files changed by Git or a text editor block new writes until import. A database changed outside the app blocks import and new writes. Use `sync export` to save those database changes if the snapshot files have not changed. These checks prevent one side from silently replacing the other.

`sync export --dry-run` lists files added, changed, and deleted. `sync import --dry-run` lists the database changes as record and attachment paths. Neither preview changes workspace data. Commands can finish recovery of an earlier interrupted operation before they run.

To discard conflicting changes, use `sync export --force` or `sync import --force`. Both create a backup when a database exists. Forced export also backs up the old snapshot. Import backs up the database and its attachments before each replacement. Backup paths appear in the result and are stored under `data/backups/`.

Unused document, review, and Agent tables are deleted on startup, export, import, or the next mutation. The unused document reference in team resources is also removed. These tables are not saved in Git. Export previews do not delete tables.

## File format and recovery

`manifest.json` records format version 1, all supported tables, their columns, and their primary keys. Each table has one JSON file per row. Filenames use `row-` followed by the primary key. Composite keys use `--` between values. String keys use URL encoding. Empty tables need no directory. The manifest still declares them.

JSON uses UTF-8, two-space indentation, sorted field names, and a final newline. Stored JSON columns remain JSON strings to preserve their exact database values. Attachment metadata stays in `issue_attachments/`. Attachment files use their stored names under `attachments/`.

Validation rejects unknown tables, fields, files, format versions, duplicate or invalid keys, invalid references, missing attachments, unsafe paths, symbolic links, invalid JSON, and unresolved Git conflict markers. Resolve Git conflicts before you import. A snapshot is a complete state, not a patch. It does not merge independently changed databases.

An export is staged before commit. A local journal and a transaction marker record whether the database commit finished. Recovery publishes the staged files after a successful commit or removes them after a rollback. Attachment imports use a staged directory and keep the old attachment directory until the transaction finishes. Do not remove `.sync-*` files while recovery is pending. If an external edit conflicts with a pending export, restore the previous snapshot files before recovery.

The internal `__sync_meta` SQLite table stores only the recovery marker. It is excluded from snapshots. The app tables are exported in full. The CLI does not run Git commands.

Run the test suite with:

```sh
python3 -m unittest discover -s tests -v
```
