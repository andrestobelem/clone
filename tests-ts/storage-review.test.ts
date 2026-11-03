import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { storagePaths } from "../src/paths.js";
import {
  exportSnapshot,
  importSnapshot,
  initialize,
  migrateStorage,
  mutate,
  recover,
  syncStatus,
} from "../src/sync.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-storage-review-"));
  roots.push(root);
  const paths = storagePaths(path.join(root, "workspace.sqlite3"));
  initialize(paths, true);
  return paths;
}

function contents(root: string): unknown {
  return fs
    .readdirSync(root)
    .sort()
    .map((name) => {
      const file = path.join(root, name);
      return [
        name,
        fs.statSync(file).isDirectory()
          ? contents(file)
          : fs.readFileSync(file).toString("base64"),
      ];
    });
}

describe("storage review regressions", () => {
  it("rejects every writable future-schema path before changing storage", () => {
    const paths = workspace();
    const sql = new DatabaseSync(paths.database);
    sql.exec(
      "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA user_version=4",
    );
    sql.close();
    const before = contents(paths.dataDirectory);
    for (const operation of [
      () => openDatabase(paths),
      () => openDatabase(paths, { allowLegacy: true }),
      () => openDatabase(paths, { create: true }),
      () =>
        mutate(paths, () => {
          throw new Error("Mutation must not run");
        }),
      () => exportSnapshot(paths, undefined, { force: true }),
      () => importSnapshot(paths, { force: true }),
      () => importSnapshot(paths, { dryRun: true }),
      () => migrateStorage(paths),
    ]) {
      expect(operation).toThrow(/newer than this Clone version/);
      expect(contents(paths.dataDirectory)).toEqual(before);
    }
    const inspection = openDatabase(paths, {
      allowLegacy: true,
      readOnly: true,
    });
    try {
      expect(inspection.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: 4,
      });
      expect(() => exportSnapshot(paths, inspection, { force: true })).toThrow(
        /newer than this Clone version/,
      );
      expect(() => recover(paths, inspection)).toThrow(
        /newer than this Clone version/,
      );
    } finally {
      inspection.close();
    }
    expect(contents(paths.dataDirectory)).toEqual(before);
  });

  it("reports absent synchronization state even when database and snapshot match", () => {
    const paths = workspace();
    expect(syncStatus(paths)).toMatchObject({ state_missing: false });
    fs.renameSync(
      path.join(paths.dataDirectory, ".sync-workspace.sqlite3-state.json"),
      path.join(paths.dataDirectory, "saved-state.json"),
    );
    expect(syncStatus(paths)).toMatchObject({
      state_missing: true,
      files_changed: false,
      database_changed: false,
    });
    expect(() => exportSnapshot(paths)).toThrow(
      /Synchronization state is missing/,
    );
  });
});
