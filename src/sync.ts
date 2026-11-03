import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

import {
  hasTable,
  assertSupportedSchema,
  openDatabase,
  schemaVersion,
  type Database,
} from "./database.js";
import {
  InvalidInputError,
  PendingExportError,
  SyncConflictError,
} from "./errors.js";
import { initializeSchema, seedDemo, seedEmpty } from "./workspace.js";
import type { JsonObject, JsonValue, Row, StoragePaths } from "./types.js";

interface TableSpec {
  readonly columns: string[];
  readonly primary_key: string[];
}

interface Manifest {
  readonly format_version: number;
  readonly tables: Record<string, TableSpec>;
}

interface SyncState {
  readonly snapshot_dir: string;
  readonly digest: string;
  readonly database_digest: string;
}

interface Journal {
  readonly token: string;
  readonly stage: string;
}

export async function withStorageLock<T>(
  paths: StoragePaths,
  operation: () => Promise<T> | T,
): Promise<T> {
  fs.mkdirSync(paths.dataDirectory, { recursive: true });
  const target = localPath(paths, "lock");
  if (!fs.existsSync(target)) fs.writeFileSync(target, "");
  const release = await lockfile.lock(target, {
    realpath: false,
    retries: { retries: 150, minTimeout: 100, maxTimeout: 100 },
    stale: 30_000,
    update: 10_000,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function initialize(
  paths: StoragePaths,
  demo = false,
): Record<string, unknown> {
  if (fs.existsSync(paths.database))
    throw new InvalidInputError("Database already exists");
  const database = openDatabase(paths, { create: true });
  try {
    database.exec("BEGIN IMMEDIATE");
    demo ? seedDemo(database) : seedEmpty(database);
    database.exec("COMMIT");
    exportSnapshot(paths, database, { force: true });
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    database.close();
    fs.rmSync(paths.database, { force: true });
    throw error;
  }
  database.close();
  return { initialized: true, demo };
}

export function prepare(paths: StoragePaths): void {
  const database = openDatabase(paths);
  try {
    recover(paths, database);
    removeUnusedTables(database);
  } finally {
    database.close();
  }
}

export function mutate<T>(
  paths: StoragePaths,
  operation: (database: Database) => T,
): T {
  const database = openDatabase(paths);
  let committed = false;
  let stage: string | null = null;
  try {
    recover(paths, database);
    checkFiles(paths, database);
    database.exec("BEGIN IMMEDIATE");
    const result = operation(database);
    removeUnusedTables(database);
    const files = databaseFiles(paths, database);
    stage = stageFiles(paths, files);
    const token = randomUUID();
    ensureSyncMeta(database);
    database
      .prepare(
        "INSERT INTO __sync_meta(id,token) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token",
      )
      .run(token);
    writeJson(localPath(paths, "journal.json"), { token, stage });
    database.exec("COMMIT");
    committed = true;
    publish(paths, database, files, stage);
    stage = null;
    return result;
  } catch (error) {
    if (!committed) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      if (stage) fs.rmSync(stage, { recursive: true, force: true });
    } else if (!(error instanceof PendingExportError)) {
      throw new PendingExportError(
        String(error instanceof Error ? error.message : error),
      );
    }
    throw error;
  } finally {
    database.close();
  }
}

export function exportSnapshot(
  paths: StoragePaths,
  existing?: Database,
  options: { readonly force?: boolean; readonly dryRun?: boolean } = {},
): Record<string, unknown> {
  const database = existing ?? openDatabase(paths, { allowLegacy: true });
  try {
    assertSupportedSchema(database);
    recover(paths, database);
    if (!options.force) checkFiles(paths, database, "export");
    const files = databaseFiles(paths, database);
    const before = diskFiles(paths.snapshotDirectory);
    const diff = differences(before, files);
    if (options.dryRun) return diff;
    const stage = stageFiles(paths, files);
    replaceDirectory(paths.snapshotDirectory, stage);
    saveState(paths, files, files);
    clearRecovery(paths, database);
    return { ...diff, exported: true };
  } finally {
    if (!existing) database.close();
  }
}

export function validateSnapshot(paths: StoragePaths): Record<string, unknown> {
  const loaded = loadSnapshot(paths);
  return {
    valid: true,
    formatVersion: loaded.manifest.format_version,
    records: Object.values(loaded.records).reduce(
      (sum, records) => sum + records.length,
      0,
    ),
    attachments: Object.keys(loaded.attachments).length,
  };
}

export function importSnapshot(
  paths: StoragePaths,
  options: { readonly force?: boolean; readonly dryRun?: boolean } = {},
): Record<string, unknown> {
  if (fs.existsSync(paths.database)) {
    const inspection = openDatabase(paths, {
      allowLegacy: true,
      readOnly: true,
    });
    try {
      assertSupportedSchema(inspection);
    } finally {
      inspection.close();
    }
  }
  const loaded = loadSnapshot(paths);
  const records = upgradeRecordsToCurrent(
    loaded.records,
    loaded.manifest.format_version,
  );
  const candidatePath = path.join(
    paths.dataDirectory,
    `.sync-${path.basename(paths.database)}-import-${randomUUID()}.sqlite3`,
  );
  const candidatePaths = { ...paths, database: candidatePath };
  const candidate = openDatabase(candidatePaths, { create: true });
  try {
    initializeSchema(candidate);
    insertRecords(candidate, records);
    validateActorRecords(candidate);
  } finally {
    candidate.close();
  }
  let before: Record<string, Buffer> = {};
  if (fs.existsSync(paths.database)) {
    const current = openDatabase(paths, { allowLegacy: true });
    try {
      try {
        before = databaseFiles(paths, current);
      } catch (error) {
        if (!options.force) throw error;
      }
    } finally {
      current.close();
    }
  }
  const candidateForFiles = openDatabase(candidatePaths);
  let after: Record<string, Buffer>;
  try {
    after = filesFromRecords(
      schemaManifest(candidateForFiles),
      records,
      loaded.attachments,
    );
  } finally {
    candidateForFiles.close();
  }
  const diff = differences(before, after);
  if (options.dryRun) {
    fs.rmSync(candidatePath, { force: true });
    return diff;
  }
  if (fs.existsSync(paths.database) && !options.force) {
    const current = openDatabase(paths, { allowLegacy: true });
    try {
      checkFiles(paths, current, "import");
    } finally {
      current.close();
    }
  }
  backupStorage(paths);
  removeDatabaseSidecars(paths.database);
  fs.rmSync(paths.database, { force: true });
  fs.mkdirSync(paths.dataDirectory, { recursive: true });
  fs.renameSync(candidatePath, paths.database);
  replaceAttachments(paths, loaded.attachments);
  const stage = stageFiles(paths, after);
  replaceDirectory(paths.snapshotDirectory, stage);
  saveState(paths, after, after);
  return { ...diff, imported: true };
}

export function migrateStorage(paths: StoragePaths): Record<string, unknown> {
  const source = openDatabase(paths, { allowLegacy: true });
  try {
    recover(paths, source);
    const sourceVersion = schemaVersion(source);
    if (sourceVersion >= 3) return { migrated: false, format_version: 3 };
    checkFiles(paths, source);
    const manifest = schemaManifest(source);
    const records: Record<string, Row[]> = {};
    for (const [table, spec] of Object.entries(manifest.tables)) {
      const order = spec.primary_key.map(quoteIdentifier).join(",");
      records[table] = source
        .prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${order}`)
        .all() as Row[];
    }
    const upgraded = upgradeRecordsToCurrent(records, sourceVersion);
    const candidatePath = path.join(
      paths.dataDirectory,
      `.sync-${path.basename(paths.database)}-migrate-${randomUUID()}.sqlite3`,
    );
    const candidatePaths = { ...paths, database: candidatePath };
    const candidate = openDatabase(candidatePaths, { create: true });
    let files: Record<string, Buffer>;
    try {
      initializeSchema(candidate);
      insertRecords(candidate, upgraded);
      validateActorRecords(candidate);
      files = databaseFiles({ ...paths, database: candidatePath }, candidate);
    } finally {
      candidate.close();
    }
    source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    backupStorage(paths);
    source.close();
    removeDatabaseSidecars(paths.database);
    fs.rmSync(paths.database, { force: true });
    fs.renameSync(candidatePath, paths.database);
    const stage = stageFiles(paths, files);
    replaceDirectory(paths.snapshotDirectory, stage);
    saveState(paths, files, files);
    return { migrated: true, format_version: 3 };
  } finally {
    try {
      source.close();
    } catch {}
  }
}

export function syncStatus(paths: StoragePaths): Record<string, unknown> {
  const databaseExists = fs.existsSync(paths.database);
  const snapshotExists = fs.existsSync(paths.snapshotDirectory);
  if (!databaseExists && !snapshotExists)
    return {
      database_exists: false,
      snapshot_exists: false,
      files_changed: false,
      database_changed: false,
      differences: { added: [], changed: [], deleted: [] },
      migration_required: false,
      state_missing: false,
    };
  const snapshot = diskFiles(paths.snapshotDirectory);
  let databaseFilesValue: Record<string, Buffer> = {};
  let migrationRequired = false;
  if (databaseExists) {
    const database = openDatabase(paths, { allowLegacy: true, readOnly: true });
    try {
      migrationRequired = schemaVersion(database) < 3;
      databaseFilesValue = databaseFiles(paths, database);
    } finally {
      database.close();
    }
  }
  const saved = readState(paths);
  const snapshotDigest = digest(snapshot);
  const databaseDigest = digest(databaseFilesValue);
  return {
    database_exists: databaseExists,
    snapshot_exists: snapshotExists,
    files_changed: Boolean(saved && saved.digest !== snapshotDigest),
    database_changed: Boolean(
      saved && saved.database_digest !== databaseDigest,
    ),
    differences: differences(snapshot, databaseFilesValue),
    migration_required: migrationRequired,
    state_missing: databaseExists && !saved,
  };
}

export function recover(paths: StoragePaths, database: Database): void {
  assertSupportedSchema(database);
  const journalPath = localPath(paths, "journal.json");
  if (!fs.existsSync(journalPath)) return;
  const journal = readJson(journalPath) as unknown as Journal;
  const token = hasTable(database, "__sync_meta")
    ? (
        database.prepare("SELECT token FROM __sync_meta WHERE id=1").get() as
          { token?: string } | undefined
      )?.token
    : undefined;
  if (token === journal.token) {
    const files = fs.existsSync(journal.stage)
      ? diskFiles(journal.stage)
      : diskFiles(paths.snapshotDirectory);
    if (fs.existsSync(journal.stage))
      replaceDirectory(paths.snapshotDirectory, journal.stage);
    saveState(paths, files, databaseFiles(paths, database));
  } else {
    fs.rmSync(journal.stage, { recursive: true, force: true });
  }
  clearRecovery(paths, database);
}

function publish(
  paths: StoragePaths,
  database: Database,
  files: Record<string, Buffer>,
  stage: string,
): void {
  try {
    replaceDirectory(paths.snapshotDirectory, stage);
    saveState(paths, files, files);
    clearRecovery(paths, database);
  } catch (error) {
    throw new PendingExportError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function databaseFiles(
  paths: StoragePaths,
  database: Database,
): Record<string, Buffer> {
  const manifest = schemaManifest(database);
  const records: Record<string, Row[]> = {};
  for (const [table, spec] of Object.entries(manifest.tables)) {
    const order = spec.primary_key.map(quoteIdentifier).join(",");
    const selected = spec.columns.map(quoteIdentifier).join(",");
    records[table] = database
      .prepare(
        `SELECT ${selected} FROM ${quoteIdentifier(table)} ORDER BY ${order}`,
      )
      .all() as Row[];
  }
  const attachments: Record<string, Buffer> = {};
  for (const row of records.issue_attachments ?? []) {
    const name = String(row.storage_name);
    if (
      path.basename(name) !== name ||
      name === "." ||
      name === ".." ||
      name.includes("\\")
    )
      throw new InvalidInputError("Unsafe attachment path");
    const file = path.join(paths.attachmentsDirectory, name);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink())
      throw new InvalidInputError(
        `Attachment file not found or unsafe: ${name}`,
      );
    const content = fs.readFileSync(file);
    if (content.length !== Number(row.size))
      throw new InvalidInputError(`Attachment size does not match: ${name}`);
    attachments[name] = content;
  }
  return filesFromRecords(manifest, records, attachments);
}

function schemaManifest(database: Database): Manifest {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='__sync_meta' ORDER BY name",
    )
    .all() as { name: string }[];
  const specs: Record<string, TableSpec> = {};
  for (const { name } of tables) {
    const fields = database
      .prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
      .all() as { name: string; pk: number }[];
    specs[name] = {
      columns: fields.map((field) => field.name),
      primary_key: fields
        .filter((field) => field.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((field) => field.name),
    };
  }
  return {
    format_version: schemaVersion(database),
    tables: specs,
  };
}

function filesFromRecords(
  manifest: Manifest,
  records: Record<string, Row[]>,
  attachments: Record<string, Buffer>,
): Record<string, Buffer> {
  const files: Record<string, Buffer> = {
    "manifest.json": encode(manifest as unknown as JsonValue),
  };
  for (const [table, rows] of Object.entries(records)) {
    const spec = manifest.tables[table]!;
    for (const row of rows)
      files[`${table}/${recordName(row, spec)}.json`] = encode(
        row as unknown as JsonValue,
      );
  }
  for (const [name, content] of Object.entries(attachments))
    files[`attachments/${name}`] = content;
  return files;
}

function loadSnapshot(paths: StoragePaths): {
  manifest: Manifest;
  records: Record<string, Row[]>;
  attachments: Record<string, Buffer>;
} {
  const files = diskFiles(paths.snapshotDirectory);
  const manifestBuffer = files["manifest.json"];
  if (!manifestBuffer)
    throw new InvalidInputError("Snapshot manifest not found");
  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as Manifest;
  if (![1, 2, 3].includes(manifest.format_version))
    throw new InvalidInputError("Unsupported snapshot format");
  const records = Object.fromEntries(
    Object.keys(manifest.tables).map((table) => [table, [] as Row[]]),
  );
  const attachments: Record<string, Buffer> = {};
  for (const [name, content] of Object.entries(files)) {
    if (name === "manifest.json") continue;
    if (name.startsWith("attachments/")) {
      attachments[name.slice(12)] = content;
      continue;
    }
    const [table, filename, extra] = name.split("/");
    if (
      extra ||
      !table ||
      !filename ||
      !filename.startsWith("row-") ||
      !filename.endsWith(".json") ||
      !records[table]
    )
      throw new InvalidInputError(`Unknown snapshot file: ${name}`);
    const row = JSON.parse(content.toString("utf8")) as Row;
    const allowed = manifest.tables[table]!.columns;
    if (Object.keys(row).some((column) => !allowed.includes(column)))
      throw new InvalidInputError(`Unknown field in ${name}`);
    records[table].push(row);
  }
  return { manifest, records, attachments };
}

function insertRecords(
  database: Database,
  records: Record<string, Row[]>,
): void {
  database.exec("PRAGMA defer_foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    for (const [table, entries] of Object.entries(records)) {
      for (const row of entries) {
        const columns = Object.keys(row);
        database
          .prepare(
            `INSERT INTO ${quoteIdentifier(table)}(${columns.map(quoteIdentifier).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...columns.map((column) => row[column] ?? null));
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function validateActorRecords(database: Database): void {
  if (!hasTable(database, "actors")) return;
  const invalid = database
    .prepare(
      `SELECT id FROM actors WHERE
    (kind='member' AND (member_id IS NULL OR member_id!=id OR key IS NOT NULL)) OR
    (kind='agent' AND (member_id IS NOT NULL OR key IS NULL OR length(trim(key))=0)) LIMIT 1`,
    )
    .get();
  if (invalid) throw new InvalidInputError("Invalid actor records");
}

function upgradeRecords(records: Record<string, Row[]>): Record<string, Row[]> {
  return {
    ...records,
    actors: (records.members ?? []).map((member) => ({
      id: member.id ?? null,
      kind: "member",
      name: member.name ?? "",
      active: member.active ?? 1,
      member_id: member.id ?? null,
      key: null,
      avatar_color: member.avatar_color ?? "#8585cc",
      created_at: member.created_at ?? "",
    })),
  };
}

const revisionTables = new Set([
  "workspace",
  "actors",
  "teams",
  "issue_statuses",
  "labels",
  "projects",
  "cycles",
  "milestones",
  "issues",
  "views",
  "team_resources",
  "notifications",
  "app_settings",
  "recurring_rules",
  "automations",
]);

function upgradeRecordsToCurrent(
  source: Record<string, Row[]>,
  formatVersion: number,
): Record<string, Row[]> {
  const records = formatVersion === 1 ? upgradeRecords(source) : source;
  const upgraded = Object.fromEntries(
    Object.entries(records).map(([table, entries]) => [
      table,
      entries.map((entry) => ({
        ...entry,
        ...(revisionTables.has(table)
          ? { revision: Number(entry.revision ?? 1) }
          : {}),
        ...(table === "workspace"
          ? { workspace_id: entry.workspace_id ?? randomUUID() }
          : {}),
      })),
    ]),
  );
  if (!("work_evidence" in upgraded)) upgraded.work_evidence = [];
  return upgraded;
}

function checkFiles(
  paths: StoragePaths,
  database: Database,
  direction = "write",
): void {
  const saved = readState(paths);
  if (!saved) {
    if (
      fs.existsSync(paths.snapshotDirectory) &&
      fs.readdirSync(paths.snapshotDirectory).length
    )
      throw new SyncConflictError(
        "Synchronization state is missing. Use sync export --force or sync import --force.",
      );
    return;
  }
  if (saved.snapshot_dir !== paths.snapshotDirectory)
    throw new SyncConflictError(
      "Snapshot path changed. Use sync export --force or sync import --force.",
    );
  const snapshotChanged =
    saved.digest !== digest(diskFiles(paths.snapshotDirectory));
  const databaseChanged =
    saved.database_digest !== digest(databaseFiles(paths, database));
  if (snapshotChanged || (direction === "import" && databaseChanged))
    throw new SyncConflictError(
      "Database and snapshot changed independently. Review changes before import or export.",
    );
}

function stageFiles(
  paths: StoragePaths,
  files: Record<string, Buffer>,
): string {
  const stage = path.join(
    paths.dataDirectory,
    `.sync-${path.basename(paths.database)}-stage-${randomUUID()}`,
  );
  writeFiles(stage, files);
  return stage;
}

function replaceDirectory(destination: string, source: string): void {
  const previous = `${destination}.previous-${randomUUID()}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) fs.renameSync(destination, previous);
  try {
    fs.renameSync(source, destination);
    fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(destination) && fs.existsSync(previous))
      fs.renameSync(previous, destination);
    throw error;
  }
}

function replaceAttachments(
  paths: StoragePaths,
  attachments: Record<string, Buffer>,
): void {
  const stage = path.join(
    paths.dataDirectory,
    `.sync-attachments-${randomUUID()}`,
  );
  fs.mkdirSync(stage, { recursive: true });
  for (const [name, content] of Object.entries(attachments))
    fs.writeFileSync(path.join(stage, name), content);
  replaceDirectory(paths.attachmentsDirectory, stage);
}

function backupStorage(paths: StoragePaths): void {
  if (!fs.existsSync(paths.database)) return;
  fs.mkdirSync(paths.backupsDirectory, { recursive: true });
  const destination = path.join(
    paths.backupsDirectory,
    `workspace-${new Date().toISOString().replaceAll(":", "-")}.sqlite3`,
  );
  fs.copyFileSync(paths.database, destination);
  if (fs.existsSync(paths.attachmentsDirectory)) {
    fs.cpSync(
      paths.attachmentsDirectory,
      path.join(
        paths.backupsDirectory,
        `${path.basename(destination, ".sqlite3")}-attachments`,
      ),
      { recursive: true },
    );
  }
  if (fs.existsSync(paths.snapshotDirectory)) {
    fs.cpSync(
      paths.snapshotDirectory,
      path.join(
        paths.backupsDirectory,
        `${path.basename(destination, ".sqlite3")}-snapshot`,
      ),
      { recursive: true },
    );
  }
}

function removeDatabaseSidecars(database: string): void {
  fs.rmSync(`${database}-wal`, { force: true });
  fs.rmSync(`${database}-shm`, { force: true });
}

function removeUnusedTables(database: Database): void {
  for (const table of [
    "agent_messages",
    "agent_threads",
    "reviews",
    "documents",
  ]) {
    if (hasTable(database, table))
      database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
  }
}

function ensureSyncMeta(database: Database): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS __sync_meta (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT)",
  );
}

function clearRecovery(paths: StoragePaths, database: Database): void {
  if (hasTable(database, "__sync_meta"))
    database.exec("DELETE FROM __sync_meta");
  fs.rmSync(localPath(paths, "journal.json"), { force: true });
}

function saveState(
  paths: StoragePaths,
  snapshot: Record<string, Buffer>,
  database: Record<string, Buffer>,
): void {
  writeJson(localPath(paths, "state.json"), {
    snapshot_dir: paths.snapshotDirectory,
    digest: digest(snapshot),
    database_digest: digest(database),
  });
}

function readState(paths: StoragePaths): SyncState | null {
  const file = localPath(paths, "state.json");
  return fs.existsSync(file) ? (readJson(file) as unknown as SyncState) : null;
}

function writeFiles(directory: string, files: Record<string, Buffer>): void {
  fs.rmSync(directory, { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function diskFiles(directory: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  if (!fs.existsSync(directory)) return result;
  if (
    fs.lstatSync(directory).isSymbolicLink() ||
    !fs.statSync(directory).isDirectory()
  )
    throw new InvalidInputError("Snapshot path must be a directory");
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new InvalidInputError(
          `Symbolic links are not allowed: ${target}`,
        );
      if (entry.isDirectory()) visit(target);
      else
        result[path.relative(directory, target).split(path.sep).join("/")] =
          fs.readFileSync(target);
    }
  };
  visit(directory);
  return result;
}

function differences(
  before: Record<string, Buffer>,
  after: Record<string, Buffer>,
): Record<string, string[]> {
  const beforeNames = new Set(Object.keys(before));
  const afterNames = new Set(Object.keys(after));
  return {
    added: [...afterNames].filter((name) => !beforeNames.has(name)).sort(),
    changed: [...afterNames]
      .filter(
        (name) => beforeNames.has(name) && !after[name]!.equals(before[name]!),
      )
      .sort(),
    deleted: [...beforeNames].filter((name) => !afterNames.has(name)).sort(),
  };
}

function digest(files: Record<string, Buffer>): string {
  const hash = crypto.createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    hash.update(
      encode([
        name,
        crypto.createHash("sha256").update(files[name]!).digest("hex"),
      ]),
    );
  }
  return hash.digest("hex");
}

function recordName(row: Row, spec: TableSpec): string {
  return `row-${spec.primary_key.map((key) => encodePart(String(row[key]))).join("--")}`;
}

function encodePart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encode(value: JsonValue): Buffer {
  return Buffer.from(`${JSON.stringify(sortJson(value), null, 2)}\n`, "utf8");
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function localPath(paths: StoragePaths, name: string): string {
  return path.join(
    paths.dataDirectory,
    `.sync-${path.basename(paths.database)}-${name}`,
  );
}

function writeJson(file: string, value: JsonValue): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, encode(value));
  fs.renameSync(temporary, file);
}

function readJson(file: string): JsonValue {
  return JSON.parse(fs.readFileSync(file, "utf8")) as JsonValue;
}
