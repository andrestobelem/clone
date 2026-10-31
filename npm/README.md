# Clone

Run a local issue and project workspace without installing Python.

```sh
npx @andrestobelem/clone
```

Clone stores its database, attachments, snapshots, and backups in the operating system's user data directory. The server listens on `127.0.0.1` and opens `http://127.0.0.1:4173`.

## Commands

```sh
npx @andrestobelem/clone start --port 5000
npx @andrestobelem/clone teams list --json
npx @andrestobelem/clone --help
```

Use `--no-open` with `start` to keep the browser closed. Set `CLONE_DATA_DIR` to select another data directory.

Clone supports macOS on ARM64 and x64, Linux on ARM64 and x64, and Windows on x64.
