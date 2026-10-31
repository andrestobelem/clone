#!/bin/sh
# Start Clone from the source repository with no demo records.
set -eu
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
    echo "Install uv first: https://docs.astral.sh/uv/getting-started/installation/" >&2
    exit 1
fi

uv sync --locked
storage="${CLONE_DATA_DIR:-data/clone}"
if [ ! -e "$storage/workspace.sqlite3" ] && [ ! -e "$storage/snapshot" ]; then
    uv run python cli.py --db "$storage/workspace.sqlite3" init
fi
echo "Open Clone at http://127.0.0.1:${PORT:-4173}. Stop with Ctrl+C."
exec uv run python cli.py --db "$storage/workspace.sqlite3" serve
