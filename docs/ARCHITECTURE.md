# Architecture

The application runs in one local process or several cooperating local processes. It uses Python 3.14, SQLite, and browser JavaScript. The project pins Python 3.14 through uv. It does not need third-party Python packages.

## Components

| Component | Responsibility |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | UI shell, rendering, forms, navigation, and HTTP requests |
| `server.py` | Static UI files, JSON routes, attachment downloads, and recurring scheduler |
| `cli.py` | Command parser, discovery catalog, queries, payload flags, and output/error handling |
| `workspace.py` | SQLite schemas, demo seed, actor and relationship checks, queries, mutations, and automations |
| `validation.py` | Shared input types, dates, numeric bounds, and payload normalization |
| `snapshot.py` | File lock, stable snapshots, conflict checks, backups, import/export, migration, and recovery |
| `tests/` | Temporary-storage checks for actions, actors, validation, snapshots, and failure recovery |

HTTP and CLI mutations call `snapshot.mutate`, which calls `workspace.dispatch_mutation`. The shared validation runs before the action changes records. UI forms can apply more specific display and required-field rules.

Reads use SQL rows or assembled issue/project records. Bootstrap returns the UI data, including related records and progress. It loads active issues and projects plus separate archives. The UI refreshes bootstrap after writes.

The database schema retains some column names such as `member_id` for relationships that now reference actors. Keep those names for format compatibility. Human profiles remain in `members`; actor identity is in `actors`.

## Mutation flow

1. Acquire the database's operating system file lock.
2. Recover an interrupted operation and compare database/snapshot fingerprints.
3. Begin a SQLite write transaction and perform the action. Events and automations use the same transaction.
4. Build a complete snapshot in a staging directory. Record a recovery journal and transaction token.
5. Commit SQLite.
6. Publish the staged snapshot, save fingerprints, and remove completed recovery files.

A failure before commit rolls back records and removes new unreferenced attachment files. A publication failure after commit returns a pending-export error. The caller must recover publication instead of repeating the action.

The CLI, HTTP server, and scheduler share this lock. Do not use a separate lock or write directly to SQLite for normal actions. Filesystem readers outside the application do not acquire this lock; review Git changes before import.

## Storage and recovery

Default storage is `data/workspace.sqlite3`. Attachments, backups, and `.sync-*` state files are next to the database. The default snapshot is `snapshot/` next to the database; `--sync-dir` can select another directory.

SQLite uses foreign keys and WAL mode. Snapshots contain all supported table rows and referenced attachment bytes. IDs, timestamps, inactive actors, archives, and history are retained. The manifest describes format version 2. Format-1 import creates member actors; explicit migration upgrades an existing database.

Snapshot JSON is sorted and formatted with stable filenames. Digests detect database and snapshot changes outside synchronization. Validation checks the manifest, field types, foreign keys, actor profiles, issue/team status links, project/team links, and attachment paths and sizes.

Import validates in memory, creates a backup when a database exists, and replaces records and attachments. It does not run events or automations. Empty snapshots are valid storage but need workspace and member records for normal writes.

See [the CLI guide](CLI.md) for backups, recovery commands, format details, and conflict resolution. Never delete recovery files to bypass a conflict.

## UI and scheduling

The UI uses native DOM events and HTML templates. Text values are escaped before insertion. Browser storage holds the selected page/team and sidebar state. Saved views and product preferences are database records.

Dialogs contain keyboard focus and return it on close. Issue and notification rows support keyboard activation. Search requests use a sequence number so an older response cannot replace newer results or update a closed dialog.

The server scheduler runs every 30 seconds. Rules use UTC dates and actor 1. It holds the same storage lock as normal writes. A stopped server does not run rules; missed runs create one issue when processing resumes.

## Boundaries

The server serves only the three UI files and explicit API routes. Attachment reads reject symbolic links and paths outside attachment storage. CLI downloads must be outside database storage and the snapshot directory.

The default bind address is `127.0.0.1`. `CLONE_HOST` can change it, but the application has no authentication or permission enforcement. `PORT` changes the default port 4173. `CLONE_ACCESS_LOG=1` enables HTTP access logs. Actor identity and saved-view scope are not security boundaries.
