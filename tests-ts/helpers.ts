import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase, type Database } from "../src/database.js";
import { storagePaths } from "../src/paths.js";
import { initialize, mutate } from "../src/sync.js";
import type { JsonObject, StoragePaths } from "../src/types.js";
import { dispatchMutation } from "../src/workspace.js";

const directories: string[] = [];

export function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clone-test-"));
  directories.push(directory);
  return directory;
}

export function cleanupDirectories(): void {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function demoWorkspace(): StoragePaths {
  const paths = storagePaths(
    path.join(temporaryDirectory(), "workspace.sqlite3"),
  );
  initialize(paths, true);
  return paths;
}

export function emptyWorkspace(): StoragePaths {
  const paths = storagePaths(
    path.join(temporaryDirectory(), "workspace.sqlite3"),
  );
  initialize(paths);
  return paths;
}

export function action(
  paths: StoragePaths,
  method: string,
  route: string,
  payload: JsonObject = {},
): Record<string, unknown> {
  return mutate(paths, (database) =>
    dispatchMutation(
      database,
      method,
      route,
      { actorId: 1, ...payload },
      paths,
    ),
  );
}

export function read<T>(
  paths: StoragePaths,
  operation: (database: Database) => T,
): T {
  const database = openDatabase(paths);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}
