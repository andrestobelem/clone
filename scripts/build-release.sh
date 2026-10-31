#!/bin/sh
# Build a source archive that starts with no workspace records.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"

if [ -n "$(git status --porcelain)" ]; then
    echo "Commit or stash repository changes before you build a release." >&2
    exit 1
fi

version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' pyproject.toml)
if [ -z "$version" ]; then
    echo "Project version not found in pyproject.toml." >&2
    exit 1
fi

release_name="local-workspace-$version"
stage=$(mktemp -d "${TMPDIR:-/tmp}/local-workspace-release.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM

mkdir -p "$stage/$release_name" dist
git archive HEAD | tar -x -C "$stage/$release_name"
rm -rf "$stage/$release_name/data/snapshot"
tar -czf "dist/$release_name.tar.gz" -C "$stage" "$release_name"

echo "Created dist/$release_name.tar.gz"
