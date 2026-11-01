import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { storagePaths } from "../src/paths.js";
import {
  exportSnapshot,
  importSnapshot,
  initialize,
  mutate,
  syncStatus,
  validateSnapshot,
  withStorageLock,
} from "../src/sync.js";
import { dispatchMutation, runDueRecurring } from "../src/workspace.js";
import {
  action,
  cleanupDirectories,
  demoWorkspace,
  read,
  temporaryDirectory,
} from "./helpers.js";

afterEach(cleanupDirectories);

describe("storage and synchronization", () => {
  it("reports a consistent initialized workspace", () => {
    expect(syncStatus(demoWorkspace())).toMatchObject({
      database_exists: true,
      snapshot_exists: true,
      files_changed: false,
      database_changed: false,
      migration_required: false,
    });
  });

  it("exports stable snapshots", () => {
    const paths = demoWorkspace();
    expect(exportSnapshot(paths, undefined, { dryRun: true })).toMatchObject({
      added: [],
      changed: [],
      deleted: [],
    });
    expect(exportSnapshot(paths)).toMatchObject({
      exported: true,
      added: [],
      changed: [],
      deleted: [],
    });
  });

  it("validates complete snapshots", () => {
    const result = validateSnapshot(demoWorkspace());
    expect(result).toMatchObject({
      valid: true,
      formatVersion: 2,
      attachments: 0,
    });
    expect(Number(result.records)).toBeGreaterThan(40);
  });

  it("restores records from a snapshot", () => {
    const paths = demoWorkspace();
    fs.rmSync(paths.database);
    expect(importSnapshot(paths, { force: true })).toMatchObject({
      imported: true,
    });
    expect(
      read(paths, (database) =>
        database.prepare("SELECT COUNT(*) AS count FROM issues").get(),
      ),
    ).toEqual({ count: 12 });
  });

  it("detects edited snapshot files", () => {
    const paths = demoWorkspace();
    const file = path.join(paths.snapshotDirectory, "workspace", "row-1.json");
    fs.appendFileSync(file, "\n");
    expect(syncStatus(paths)).toMatchObject({ files_changed: true });
    expect(() =>
      action(paths, "POST", "/api/issues", { teamId: 1, title: "Blocked" }),
    ).toThrow();
  });

  it("detects database changes made outside Clone", () => {
    const paths = demoWorkspace();
    const database = openDatabase(paths);
    database.prepare("UPDATE workspace SET name='Changed outside'").run();
    database.close();
    expect(syncStatus(paths)).toMatchObject({ database_changed: true });
    expect(() => importSnapshot(paths)).toThrow();
  });

  it("forces export after external database changes", () => {
    const paths = demoWorkspace();
    const database = openDatabase(paths);
    database.prepare("UPDATE workspace SET name='Changed outside'").run();
    database.close();
    expect(exportSnapshot(paths, undefined, { force: true })).toMatchObject({
      exported: true,
    });
    expect(syncStatus(paths)).toMatchObject({
      database_changed: false,
      files_changed: false,
    });
  });

  it("creates a backup before forced import", () => {
    const paths = demoWorkspace();
    const database = openDatabase(paths);
    database.prepare("UPDATE workspace SET name='Changed outside'").run();
    database.close();
    expect(importSnapshot(paths, { force: true })).toMatchObject({
      imported: true,
    });
    expect(fs.readdirSync(paths.backupsDirectory).length).toBeGreaterThan(0);
  });

  it("preserves attachment bytes through export and import", () => {
    const paths = demoWorkspace();
    action(paths, "POST", "/api/issues/PRO-248/attachments", {
      files: [
        {
          name: "note.txt",
          type: "text/plain",
          data: Buffer.from("saved bytes").toString("base64"),
        },
      ],
    });
    fs.rmSync(paths.database);
    fs.rmSync(paths.attachmentsDirectory, { recursive: true, force: true });
    importSnapshot(paths, { force: true });
    const attachment = read(paths, (database) =>
      database.prepare("SELECT storage_name FROM issue_attachments").get(),
    ) as { storage_name: string };
    expect(
      fs.readFileSync(
        path.join(paths.attachmentsDirectory, attachment.storage_name),
        "utf8",
      ),
    ).toBe("saved bytes");
  });

  it("runs one recurring issue and advances its date", () => {
    const paths = demoWorkspace();
    read(paths, (database) =>
      database
        .prepare("UPDATE recurring_rules SET next_run='2020-01-01'")
        .run(),
    );
    const first = mutate(paths, (database) => runDueRecurring(database, paths));
    const second = mutate(paths, (database) =>
      runDueRecurring(database, paths),
    );
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("serializes concurrent storage locks", async () => {
    const paths = demoWorkspace();
    const order: string[] = [];
    await Promise.all([
      withStorageLock(paths, async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("first-end");
      }),
      withStorageLock(paths, () => {
        order.push("second");
      }),
    ]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("does not create storage for read-only CLI failures", () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, "workspace.sqlite3");
    const result = spawnSync(
      process.execPath,
      ["bin/clone.js", "--db", database, "issues", "list", "--json"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(2);
    expect(fs.existsSync(database)).toBe(false);
  });
});
