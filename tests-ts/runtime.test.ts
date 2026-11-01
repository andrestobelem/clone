import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import { storagePaths } from "../src/paths.js";
import { importSnapshot, initialize, mutate, syncStatus } from "../src/sync.js";
import { dispatchMutation } from "../src/workspace.js";
import { mutationPayload } from "../src/validation.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("TypeScript runtime", () => {
  it("creates a usable empty workspace", () => {
    const directory = temporaryDirectory();
    const paths = storagePaths(path.join(directory, "workspace.sqlite3"));
    initialize(paths);
    const database = openDatabase(paths);
    try {
      expect(
        database.prepare("SELECT name FROM workspace WHERE id=1").get(),
      ).toEqual({
        name: "My Workspace",
      });
      expect(
        database.prepare("SELECT kind,name FROM actors WHERE id=1").get(),
      ).toEqual({
        kind: "member",
        name: "Local User",
      });
    } finally {
      database.close();
    }
  });

  it("creates compatible storage and keeps snapshots consistent", () => {
    const directory = temporaryDirectory();
    const paths = storagePaths(path.join(directory, "workspace.sqlite3"));

    initialize(paths, true);
    const agent = mutate(paths, (database) =>
      dispatchMutation(
        database,
        "POST",
        "/api/agents",
        { actorId: 1, key: "tester", name: "Test Agent", teamId: 1 },
        paths,
      ),
    );

    expect(agent).toMatchObject({
      agent: { kind: "agent", key: "tester", name: "Test Agent" },
      _status: 201,
    });
    expect(syncStatus(paths)).toMatchObject({
      database_exists: true,
      snapshot_exists: true,
      files_changed: false,
      database_changed: false,
      migration_required: false,
    });
  });

  it("validates the shared JSON contract", () => {
    expect(
      mutationPayload(
        {
          title: "  Test issue  ",
          teamId: 1,
          labelIds: [2, 2, 3],
          dueDate: "2026-11-01",
        },
        "/api/issues",
      ),
    ).toMatchObject({
      title: "Test issue",
      labelIds: [2, 3],
    });

    expect(() =>
      mutationPayload({ title: " ", teamId: true }, "/api/issues"),
    ).toThrow("title must not be empty");
  });

  it("loads the complete demo workspace", () => {
    const directory = temporaryDirectory();
    const paths = storagePaths(path.join(directory, "workspace.sqlite3"));
    initialize(paths, true);
    const database = openDatabase(paths);
    try {
      const count = (table: string) =>
        Number(
          (
            database
              .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
              .get() as { count: number }
          ).count,
        );
      expect({
        actors: count("actors"),
        issues: count("issues"),
        projects: count("projects"),
        views: count("views"),
        recurring: count("recurring_rules"),
        automations: count("automations"),
      }).toEqual({
        actors: 5,
        issues: 12,
        projects: 3,
        views: 3,
        recurring: 1,
        automations: 1,
      });
    } finally {
      database.close();
    }
  });

  it("restores the database from its snapshot", () => {
    const directory = temporaryDirectory();
    const paths = storagePaths(path.join(directory, "workspace.sqlite3"));
    initialize(paths, true);
    fs.rmSync(paths.database);

    expect(importSnapshot(paths, { force: true })).toMatchObject({
      imported: true,
    });
    const database = openDatabase(paths);
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM issues").get(),
      ).toMatchObject({ count: 12 });
    } finally {
      database.close();
    }
  });
});

describe("CLI contract", () => {
  it("describes mutation arguments and recurring execution", () => {
    const result = runTypeScript(["describe", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const catalog = JSON.parse(result.stdout) as {
      formatVersion: number;
      commands: Array<{ path: string[]; arguments: Array<{ name: string }> }>;
    };
    const issueCreate = catalog.commands.find(
      (command) => command.path.join(" ") === "issues create",
    );
    expect(catalog.formatVersion).toBe(1);
    expect(issueCreate?.arguments.map((argument) => argument.name)).toEqual(
      expect.arrayContaining([
        "data",
        "title",
        "teamId",
        "labelIds",
        "priority",
      ]),
    );
    expect(
      catalog.commands.some(
        (command) => command.path.join(" ") === "recurring run",
      ),
    ).toBe(true);
  });

  it("filters the command catalog by path prefix", () => {
    const group = runTypeScript(["describe", "issues", "--json"]);
    expect(group.status, group.stderr).toBe(0);
    const groupCatalog = JSON.parse(group.stdout) as {
      formatVersion: number;
      commands: Array<{ path: string[] }>;
    };
    expect(groupCatalog.formatVersion).toBe(1);
    expect(groupCatalog.commands.length).toBeGreaterThan(1);
    expect(
      groupCatalog.commands.every((command) => command.path[0] === "issues"),
    ).toBe(true);

    const command = runTypeScript(["describe", "issues", "comment", "--json"]);
    expect(command.status, command.stderr).toBe(0);
    expect(JSON.parse(command.stdout)).toMatchObject({
      formatVersion: 1,
      commands: [{ path: ["issues", "comment"] }],
    });
  });

  it("returns a stable JSON error for an unknown describe path", () => {
    const result = runTypeScript(["describe", "issues", "missing", "--json"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      code: "invalid_input",
      message: "Unknown command path: issues missing",
      exitCode: 2,
    });
  });

  it("includes filtered describe syntax in help", () => {
    const result = runTypeScript(["--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("clone describe [COMMAND...] [--json]");
  });

  it("creates an agent through the command entry point", () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, "workspace.sqlite3");
    const snapshot = path.join(directory, "snapshot");
    expect(
      runTypeScript([
        "--db",
        database,
        "--sync-dir",
        snapshot,
        "init",
        "--demo",
        "--json",
      ]).status,
    ).toBe(0);
    const result = runTypeScript([
      "--db",
      database,
      "--sync-dir",
      snapshot,
      "agents",
      "create",
      "--key",
      "contract",
      "--name",
      "Contract Agent",
      "--team-id",
      "1",
      "--json",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      agent: { kind: "agent", key: "contract", name: "Contract Agent" },
    });
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clone-ts-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runTypeScript(arguments_: string[]) {
  return spawnSync(process.execPath, ["bin/clone.js", ...arguments_], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}
