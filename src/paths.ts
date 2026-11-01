import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { InvalidInputError } from "./errors.js";
import type { StoragePaths } from "./types.js";

export const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function defaultDataDirectory(
  platform = process.platform,
  environment = process.env,
): string {
  if (environment.CLONE_DATA_DIR) {
    return path.resolve(environment.CLONE_DATA_DIR);
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Clone");
  }
  if (platform === "win32") {
    return path.join(environment.APPDATA ?? os.homedir(), "Clone");
  }
  return path.join(
    environment.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "clone",
  );
}

export function storagePaths(
  database: string,
  snapshotDirectory?: string,
): StoragePaths {
  const resolvedDatabase = path.resolve(database);
  const dataDirectory = path.dirname(resolvedDatabase);
  const resolvedSnapshot = path.resolve(
    snapshotDirectory ?? path.join(dataDirectory, "snapshot"),
  );
  const attachmentsDirectory = path.join(dataDirectory, "attachments");
  const backupsDirectory = path.join(dataDirectory, "backups");

  if (
    containsPath(resolvedSnapshot, dataDirectory) ||
    containsPath(attachmentsDirectory, resolvedSnapshot) ||
    containsPath(backupsDirectory, resolvedSnapshot)
  ) {
    throw new InvalidInputError(
      "Snapshot directory must be separate from database storage, attachments, and backups",
    );
  }

  return {
    database: resolvedDatabase,
    dataDirectory,
    snapshotDirectory: resolvedSnapshot,
    attachmentsDirectory,
    backupsDirectory,
  };
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
