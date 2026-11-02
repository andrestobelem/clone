import fs from "node:fs";
import path from "node:path";

import { actions, fieldTypes, listFilters, resources } from "./commands.js";
import { openDatabase, schemaVersion } from "./database.js";
import {
  BatchOperationError,
  CloneError,
  InvalidInputError,
  RelationshipConflictError,
  StorageError,
} from "./errors.js";
import { defaultDataDirectory, storagePaths } from "./paths.js";
import { priorities } from "./schema.js";
import { startServer } from "./server.js";
import {
  exportSnapshot,
  importSnapshot,
  initialize,
  migrateStorage,
  mutate,
  syncStatus,
  validateSnapshot,
  withStorageLock,
} from "./sync.js";
import type { JsonObject, JsonValue, Row } from "./types.js";
import {
  actorRecord,
  bootstrap,
  dispatchMutation,
  issueRow,
  runDueRecurring,
  search,
} from "./workspace.js";

const packageVersion = String(
  (
    JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: unknown }
  ).version,
);

interface Parsed {
  readonly command: string;
  readonly verb: string | undefined;
  readonly positionals: string[];
  readonly options: Record<string, string | boolean | string[]>;
}

export async function main(argv: string[]): Promise<number> {
  const wantsJson = argv.includes("--json");
  try {
    if (argv.includes("--version") || argv.includes("-V")) {
      console.log(packageVersion);
      return 0;
    }
    if (argv.includes("--help") || argv.includes("-h")) {
      printHelp();
      return 0;
    }
    const parsed = parseArguments(argv);
    if (parsed.command === "describe") {
      writeResult(
        describe(parsed.positionals, resolveDatabasePath(parsed)),
        true,
      );
      return 0;
    }
    if (parsed.command === "context") {
      writeResult(storageContext(parsed), true);
      return 0;
    }
    if (parsed.command === "doctor") {
      writeResult(doctor(parsed), true);
      return 0;
    }
    const paths = resolvePaths(parsed);
    if (parsed.command === "start" || parsed.command === "serve") {
      await startServer(
        paths,
        parsePort(parsed),
        parsed.command === "start" && parsed.options.open !== false,
      );
      return 0;
    }
    const result = await withStorageLock(paths, () => execute(parsed, paths));
    writeResult(result, wantsJson || typeof result === "object");
    return 0;
  } catch (error) {
    const converted = convertError(error);
    if (wantsJson)
      console.error(
        JSON.stringify({
          code: converted.code,
          message: converted.message,
          exitCode: converted.exitCode,
          ...converted.details,
        }),
      );
    else console.error(converted.message);
    return converted.exitCode;
  }
}

async function execute(
  parsed: Parsed,
  paths: ReturnType<typeof storagePaths>,
): Promise<unknown> {
  if (parsed.command === "init")
    return initialize(paths, Boolean(parsed.options.demo));
  if (parsed.command === "sync") {
    if (parsed.verb === "status") return syncStatus(paths);
    if (parsed.verb === "validate") return validateSnapshot(paths);
    if (parsed.verb === "export")
      return exportSnapshot(paths, undefined, {
        force: Boolean(parsed.options.force),
        dryRun: Boolean(parsed.options.dryRun),
      });
    if (parsed.verb === "import")
      return importSnapshot(paths, {
        force: Boolean(parsed.options.force),
        dryRun: Boolean(parsed.options.dryRun),
      });
    if (parsed.verb === "migrate") return migrateStorage(paths);
  }
  if (parsed.command === "search")
    return read(paths, (database) =>
      search(
        database,
        parsed.positionals[0] ?? "",
        String(parsed.options.scope ?? "All"),
      ),
    );
  if (parsed.command === "batch") return executeBatch(parsed, paths);
  if (parsed.command === "export")
    return read(paths, (database) => ({
      ...bootstrap(database),
      exportedAt: new Date().toISOString(),
    }));
  if (parsed.command === "attachments" && parsed.verb === "get")
    return attachmentGet(paths, parsed);
  if (resources[parsed.command] && ["list", "show"].includes(parsed.verb ?? ""))
    return readResource(paths, parsed);
  if (parsed.command === "recurring" && parsed.verb === "run")
    return mutate(paths, (database) => ({
      created: runDueRecurring(database, paths),
    }));
  const action = actions[parsed.command]?.[parsed.verb ?? ""];
  if (!action) throw new InvalidInputError("Unknown command");
  const payload = readPayload(parsed);
  const actor = resolveActor(parsed, payload, true).actorId;
  payload.actorId = actor;
  let route = action.route
    .replace("{id}", parsed.positionals[0] ?? "")
    .replace("{resource_id}", parsed.positionals[1] ?? "");
  if (parsed.command === "workspace") {
    const { actorId, ...value } = payload;
    Object.assign(payload, { key: "workspace", value, actorId });
  }
  if (parsed.command === "issues" && parsed.verb === "attach")
    addFiles(payload, optionList(parsed.options.file));
  if (
    parsed.command === "issues" &&
    parsed.verb === "import" &&
    parsed.options.dryRun
  ) {
    return read(paths, (database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        return dispatchMutation(database, action.method, route, payload, paths);
      } finally {
        database.exec("ROLLBACK");
      }
    });
  }
  return mutate(paths, (database) => {
    const result = dispatchMutation(
      database,
      action.method,
      route,
      payload,
      paths,
    );
    if (Number(result._status ?? 200) >= 400)
      throw new InvalidInputError(String(result.error ?? "Command failed"));
    delete result._status;
    return result;
  });
}

function read<T>(
  paths: ReturnType<typeof storagePaths>,
  operation: (database: ReturnType<typeof openDatabase>) => T,
): T {
  const database = openDatabase(paths);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function readResource(
  paths: ReturnType<typeof storagePaths>,
  parsed: Parsed,
): unknown {
  return read(paths, (database) => {
    const table = resources[parsed.command]!;
    if (parsed.verb === "list") {
      return listResources(database, parsed, table);
    }
    const entries = database.prepare(`SELECT * FROM "${table}"`).all() as Row[];
    const identifier =
      parsed.positionals[0] ??
      (parsed.command === "preferences" ? "preferences" : "1");
    const key =
      parsed.command === "issues"
        ? "identifier"
        : table === "app_settings"
          ? "key"
          : "id";
    const item = entries.find((row) => String(row[key]) === identifier);
    if (!item) throw new InvalidInputError("Record not found");
    if (["actors", "agents"].includes(parsed.command))
      return actorRecord(database, Number(item.id));
    if (parsed.command === "issues") return issueRow(database, Number(item.id));
    if (parsed.command === "teams")
      return (bootstrap(database).teams as Row[]).find(
        (team) => team.id === item.id,
      );
    if (table === "app_settings") return JSON.parse(String(item.value_json));
    return item;
  });
}

function executeBatch(
  parsed: Parsed,
  paths: ReturnType<typeof storagePaths>,
): unknown {
  const input = readPayload(parsed);
  const actor = resolveActor(parsed, input, true).actorId;
  const unknown = Object.keys(input).filter(
    (key) => !["actorId", "operations"].includes(key),
  );
  if (unknown.length)
    throw new InvalidInputError(`Unknown batch field: ${unknown.join(", ")}`);
  if (!Array.isArray(input.operations) || !input.operations.length)
    throw new InvalidInputError("Batch operations must be a non-empty array");
  const operations = input.operations;
  return mutate(paths, (database) => {
    const results: Array<{ operationId: string; result: JsonObject }> = [];
    operations.forEach((raw, operationIndex) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new InvalidInputError("Each batch operation must be an object");
      const operation = raw as JsonObject;
      const operationId = String(operation.operationId ?? operationIndex);
      try {
        if (
          !Array.isArray(operation.path) ||
          operation.path.length !== 2 ||
          operation.path.some((part) => typeof part !== "string")
        )
          throw new InvalidInputError(
            "Batch operation path must contain two names",
          );
        const [resource, verb] = operation.path as string[];
        const definition = actions[resource!]?.[verb!];
        if (!definition)
          throw new InvalidInputError(
            `Unknown batch operation: ${operation.path.join(" ")}`,
          );
        if (
          !operation.arguments ||
          typeof operation.arguments !== "object" ||
          Array.isArray(operation.arguments)
        )
          throw new InvalidInputError(
            "Batch operation arguments must be an object",
          );
        const arguments_ = { ...(operation.arguments as JsonObject) };
        if ("actorId" in arguments_)
          throw new InvalidInputError("Batch operations use the Batch actor");
        const route = definition.route
          .replace("{id}", String(arguments_.id ?? ""))
          .replace("{resource_id}", String(arguments_.resourceId ?? ""));
        delete arguments_.id;
        delete arguments_.resourceId;
        const result = dispatchMutation(
          database,
          definition.method,
          route,
          { ...arguments_, actorId: actor },
          paths,
        );
        if (Number(result._status ?? 200) >= 400)
          throw new InvalidInputError(String(result.error ?? "Command failed"));
        delete result._status;
        results.push({ operationId, result });
      } catch (error) {
        throw new BatchOperationError(
          operationIndex,
          operationId,
          convertError(error),
        );
      }
    });
    return { results };
  });
}

function listResources(
  database: ReturnType<typeof openDatabase>,
  parsed: Parsed,
  table: string,
): { items: Row[]; page: { nextCursor: string | null } } {
  const columns = new Set(
    (
      database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
  );
  const conditions: string[] = [];
  const values: Array<string | number> = [];
  if (parsed.command === "agents") conditions.push("kind='agent'");
  if (!parsed.options.all) {
    if (columns.has("archived")) conditions.push("archived=0");
    if (columns.has("active")) conditions.push("active=1");
  }
  const directFilters: Array<[string, string]> = [
    ["teamId", "team_id"],
    ["projectId", "project_id"],
    ["assigneeId", "assignee_id"],
    ["parentId", "parent_id"],
  ];
  for (const [option, column] of directFilters) {
    if (parsed.options[option] === undefined || !columns.has(column)) continue;
    conditions.push(`${column}=?`);
    values.push(numberOption(parsed.options[option]));
  }
  if (
    parsed.options.teamId !== undefined &&
    ["actors", "agents"].includes(parsed.command)
  ) {
    conditions.push(
      "id IN (SELECT member_id FROM team_members WHERE team_id=?)",
    );
    values.push(numberOption(parsed.options.teamId));
  }
  if (parsed.options.status !== undefined) {
    if (parsed.command === "issues") {
      conditions.push(
        "status_id IN (SELECT id FROM issue_statuses WHERE name=?)",
      );
    } else if (columns.has("status")) conditions.push("status=?");
    values.push(String(parsed.options.status));
  }
  if (parsed.options.priority !== undefined && columns.has("priority")) {
    const raw = String(parsed.options.priority);
    const numeric = /^\d+$/.test(raw)
      ? Number(raw)
      : priorities.indexOf(raw as never);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 4)
      throw new InvalidInputError("Unknown priority");
    conditions.push("priority=?");
    values.push(numeric);
  }
  if (parsed.options.updatedSince !== undefined && columns.has("updated_at")) {
    const updatedSince = String(parsed.options.updatedSince);
    if (!Number.isFinite(Date.parse(updatedSince)))
      throw new InvalidInputError("--updated-since must be an ISO timestamp");
    conditions.push("updated_at>=?");
    values.push(updatedSince);
  }
  const sortColumn = columns.has("updated_at")
    ? "updated_at"
    : columns.has("created_at")
      ? "created_at"
      : "id";
  const cursor = decodeListCursor(parsed.options.cursor);
  if (cursor) {
    conditions.push(
      sortColumn === "id"
        ? "id<?"
        : `(${sortColumn}<? OR (${sortColumn}=? AND id<?))`,
    );
    if (sortColumn === "id") values.push(cursor.id);
    else values.push(cursor.sort, cursor.sort, cursor.id);
  }
  const limit = numberOption(parsed.options.limit, 100);
  if (limit < 1 || limit > 500)
    throw new InvalidInputError("--limit must be between 1 and 500");
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const order = sortColumn === "id" ? "id DESC" : `${sortColumn} DESC,id DESC`;
  const entries = database
    .prepare(`SELECT * FROM "${table}"${where} ORDER BY ${order} LIMIT ?`)
    .all(...values, limit + 1) as Row[];
  const items = entries.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    page: {
      nextCursor:
        entries.length > limit && last
          ? Buffer.from(
              JSON.stringify({ sort: last[sortColumn], id: Number(last.id) }),
            ).toString("base64url")
          : null,
    },
  };
}

function decodeListCursor(
  value: string | boolean | string[] | undefined,
): { sort: string | number; id: number } | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(String(value), "base64url").toString("utf8"),
    ) as { sort?: unknown; id?: unknown };
    if (
      !["string", "number"].includes(typeof parsed.sort) ||
      !Number.isInteger(parsed.id)
    )
      throw new Error("invalid");
    return { sort: parsed.sort as string | number, id: Number(parsed.id) };
  } catch {
    throw new InvalidInputError("Invalid list cursor");
  }
}

function attachmentGet(
  paths: ReturnType<typeof storagePaths>,
  parsed: Parsed,
): unknown {
  const id = Number(parsed.positionals[0]);
  const output = path.resolve(String(parsed.options.output ?? ""));
  if (!output) throw new InvalidInputError("--output is required");
  if (
    isInside(paths.dataDirectory, output) ||
    isInside(paths.snapshotDirectory, output)
  )
    throw new InvalidInputError("Output must not replace workspace storage");
  return read(paths, (database) => {
    const row = database
      .prepare("SELECT * FROM issue_attachments WHERE id=?")
      .get(id) as Row | undefined;
    if (!row) throw new InvalidInputError("Attachment not found");
    const content = fs.readFileSync(
      path.join(paths.attachmentsDirectory, String(row.storage_name)),
    );
    fs.writeFileSync(output, content);
    return { output, size: content.length };
  });
}

function parseArguments(argv: string[]): Parsed {
  const tokens = [...argv];
  const options: Record<string, string | boolean | string[]> = {};
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const [rawKey, inline] = token.slice(2).split("=", 2);
    const key = camel(rawKey!);
    if (
      ["json", "all", "demo", "dryRun", "force", "local", "noOpen"].includes(
        key,
      )
    ) {
      options[key === "noOpen" ? "open" : key] =
        key === "noOpen" ? false : true;
      continue;
    }
    const value = inline ?? tokens[++index];
    if (value === undefined)
      throw new InvalidInputError(`${token} requires a value`);
    if (key === "file") {
      const current = optionList(options.file);
      options.file = [...current, value];
    } else options[key] = value;
  }
  let command = words.shift() ?? "start";
  validateStorageSelection(options);
  if (
    command !== "start" &&
    !resources[command] &&
    ![
      "init",
      "batch",
      "context",
      "doctor",
      "describe",
      "serve",
      "search",
      "export",
      "sync",
      "attachments",
    ].includes(command)
  )
    throw unknownCommandError(
      [command, ...words],
      `Unknown command: ${command}`,
    );
  const needsVerb =
    resources[command] || ["sync", "attachments"].includes(command);
  const verb = needsVerb ? words.shift() : undefined;
  if (needsVerb && !isKnownVerb(command, verb))
    throw unknownCommandError(
      [command, ...(verb ? [verb] : []), ...words],
      `Unknown command path: ${[command, verb].filter(Boolean).join(" ")}`,
    );
  const parsed = { command, verb, positionals: words, options };
  validateCommandOptions(parsed);
  return parsed;
}

function validateCommandOptions(parsed: Parsed): void {
  const allowed = new Set([
    "db",
    "syncDir",
    "local",
    "dataDir",
    "json",
    "actor",
  ]);
  if (["start", "serve"].includes(parsed.command)) {
    allowed.add("port");
    allowed.add("open");
  }
  if (parsed.command === "init") allowed.add("demo");
  if (parsed.command === "batch") allowed.add("data");
  if (parsed.command === "search") allowed.add("scope");
  if (parsed.command === "attachments") allowed.add("output");
  if (
    parsed.command === "sync" &&
    ["export", "import"].includes(parsed.verb ?? "")
  ) {
    allowed.add("dryRun");
    allowed.add("force");
  }
  if (resources[parsed.command] && parsed.verb === "list") {
    allowed.add("all");
    allowed.add("limit");
    allowed.add("cursor");
    for (const field of listFilters[parsed.command] ?? []) allowed.add(field);
  }
  const definition = actions[parsed.command]?.[parsed.verb ?? ""];
  if (definition) {
    allowed.add("data");
    allowed.add("actor");
    for (const field of definition.fields) allowed.add(field);
    if (parsed.command === "issues" && parsed.verb === "attach")
      allowed.add("file");
    if (parsed.command === "issues" && parsed.verb === "import")
      allowed.add("dryRun");
  }
  const unknown = Object.keys(parsed.options).filter(
    (key) => !allowed.has(key),
  );
  if (unknown.length)
    throw new InvalidInputError(
      `Unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => `--${kebab(key)}`).join(", ")}`,
    );
}

function validateStorageSelection(
  options: Record<string, string | boolean | string[]>,
): void {
  const selected = [
    options.local ? "--local" : null,
    options.dataDir !== undefined ? "--data-dir" : null,
    options.db !== undefined ? "--db" : null,
  ].filter((value): value is string => value !== null);
  if (selected.length > 1)
    throw new InvalidInputError(
      `Select one storage mode: ${selected.join(", ")}`,
    );
}

function isKnownVerb(command: string, verb: string | undefined): boolean {
  if (!verb) return false;
  if (command === "sync")
    return ["status", "validate", "export", "import", "migrate"].includes(verb);
  if (command === "attachments") return verb === "get";
  return (
    ["list", "show"].includes(verb) ||
    Boolean(actions[command]?.[verb]) ||
    (command === "recurring" && verb === "run")
  );
}

function canonicalCommandPaths(): string[][] {
  const paths = [
    ["init"],
    ["batch"],
    ["context"],
    ["doctor"],
    ["describe"],
    ["serve"],
    ["search"],
    ["export"],
    ...["status", "validate", "export", "import", "migrate"].map((verb) => [
      "sync",
      verb,
    ]),
    ["attachments", "get"],
  ];
  for (const resource of Object.keys(resources)) {
    paths.push([resource, "list"], [resource, "show"]);
    for (const verb of Object.keys(actions[resource] ?? {}))
      paths.push([resource, verb]);
    if (resource === "recurring") paths.push(["recurring", "run"]);
  }
  return paths;
}

function unknownCommandError(
  input: readonly string[],
  baseMessage: string,
): InvalidInputError {
  const suggestions = commandSuggestions(input);
  const suffix = suggestions.length
    ? ` Did you mean: ${suggestions.join(", ")}?`
    : "";
  return new InvalidInputError(`${baseMessage}.${suffix}`.trim(), {
    ...(suggestions.length ? { suggestions } : {}),
  });
}

function commandSuggestions(input: readonly string[]): string[] {
  const [inputCommand, inputVerb] = input;
  return canonicalCommandPaths()
    .map((candidate) => {
      const [command, verb] = candidate;
      const commandDistance = editDistance(inputCommand ?? "", command ?? "");
      const verbDistance =
        inputVerb && verb
          ? editDistance(inputVerb, verb)
          : inputVerb
            ? Number.POSITIVE_INFINITY
            : 0;
      const accepted =
        commandDistance <= 2 && (!inputVerb || verbDistance <= 1);
      return {
        accepted,
        path: candidate.join(" "),
        score: commandDistance * 4 + verbDistance,
      };
    })
    .filter((candidate) => candidate.accepted)
    .sort((left, right) =>
      left.score === right.score
        ? left.path.localeCompare(right.path)
        : left.score - right.score,
    )
    .slice(0, 3)
    .map((candidate) => candidate.path);
}

function editDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function resolvePaths(parsed: Parsed) {
  return storagePaths(
    resolveDatabasePath(parsed),
    parsed.options.syncDir
      ? path.resolve(String(parsed.options.syncDir))
      : undefined,
  );
}
function storageContext(parsed: Parsed) {
  const paths = resolvePaths(parsed);
  const storageMode = parsed.options.local
    ? "local"
    : parsed.options.dataDir !== undefined
      ? "data-dir"
      : parsed.options.db !== undefined
        ? "database"
        : "global";
  return {
    formatVersion: 1,
    cliVersion: packageVersion,
    storageMode,
    actorSelection: resolveActor(parsed, {}, false),
    database: paths.database,
    dataDirectory: paths.dataDirectory,
    snapshotDirectory: paths.snapshotDirectory,
    attachmentsDirectory: paths.attachmentsDirectory,
    backupsDirectory: paths.backupsDirectory,
  };
}

function doctor(parsed: Parsed): Record<string, unknown> {
  const paths = resolvePaths(parsed);
  const actorSelection = resolveActor(parsed, {}, false);
  if (!fs.existsSync(paths.database))
    return {
      formatVersion: 1,
      healthy: false,
      cliVersion: packageVersion,
      actorSelection,
      storage: storageContext(parsed),
      checks: [{ name: "database", status: "missing" }],
    };
  const database = openDatabase(paths, { allowLegacy: true, readOnly: true });
  try {
    const version = schemaVersion(database);
    const workspace = database
      .prepare(
        version >= 3
          ? "SELECT workspace_id,name FROM workspace LIMIT 1"
          : "SELECT NULL AS workspace_id,name FROM workspace LIMIT 1",
      )
      .get() as { workspace_id?: string; name?: string } | undefined;
    const actor = database
      .prepare("SELECT id,kind,name,active FROM actors WHERE id=?")
      .get(actorSelection.actorId) as Row | undefined;
    const synchronization = syncStatus(paths);
    let snapshotFormatVersion: number | null = null;
    if (fs.existsSync(path.join(paths.snapshotDirectory, "manifest.json")))
      snapshotFormatVersion = Number(validateSnapshot(paths).formatVersion);
    const migrationRequired = version < 3;
    const actorReady = Boolean(actor && Number(actor.active));
    const clean =
      !synchronization.files_changed && !synchronization.database_changed;
    return {
      formatVersion: 1,
      healthy: !migrationRequired && actorReady && clean,
      cliVersion: packageVersion,
      schemaVersion: version,
      snapshotFormatVersion,
      workspace: workspace
        ? { id: workspace.workspace_id ?? null, name: workspace.name }
        : null,
      actorSelection: {
        ...actorSelection,
        exists: Boolean(actor),
        active: actorReady,
      },
      synchronization,
      compatibility: {
        supported: version <= 3,
        migrationRequired,
        minimumCliVersion: version >= 3 ? "0.3.0" : "0.2.0",
      },
      checks: [
        { name: "database", status: "ok" },
        {
          name: "schema",
          status: migrationRequired ? "migration_required" : "ok",
        },
        {
          name: "actor",
          status: actorReady ? "ok" : actor ? "inactive" : "missing",
        },
        { name: "synchronization", status: clean ? "ok" : "conflict" },
      ],
    };
  } finally {
    database.close();
  }
}

function resolveActor(
  parsed: Parsed,
  payload: JsonObject,
  warnOnLegacy: boolean,
): {
  actorId: number;
  source: "flag" | "environment" | "payload" | "legacy-default";
} {
  const candidates = [
    parsed.options.actor !== undefined
      ? { source: "flag" as const, actorId: numberOption(parsed.options.actor) }
      : null,
    process.env.CLONE_ACTOR_ID !== undefined
      ? {
          source: "environment" as const,
          actorId: numberOption(process.env.CLONE_ACTOR_ID),
        }
      : null,
    payload.actorId !== undefined
      ? { source: "payload" as const, actorId: numberOption(payload.actorId) }
      : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null);
  if (new Set(candidates.map(({ actorId }) => actorId)).size > 1)
    throw new InvalidInputError("Actor selectors must identify the same actor");
  const selected = candidates[0];
  if (selected) return selected;
  if (warnOnLegacy)
    console.error(
      "Warning: actor 1 is a temporary fallback. Use --actor or CLONE_ACTOR_ID. Clone 0.4 will require an actor.",
    );
  return { actorId: 1, source: "legacy-default" };
}
function resolveDatabasePath(parsed: Parsed): string {
  let directory: string;
  if (parsed.options.local) directory = path.join(process.cwd(), ".clone");
  else if (parsed.options.dataDir)
    directory = path.resolve(String(parsed.options.dataDir));
  else directory = defaultDataDirectory();
  return parsed.options.db
    ? path.resolve(String(parsed.options.db))
    : path.join(directory, "workspace.sqlite3");
}
function readPayload(parsed: Parsed): JsonObject {
  let value: unknown = {};
  const raw = parsed.options.data;
  if (raw === "-") value = JSON.parse(fs.readFileSync(0, "utf8"));
  else if (typeof raw === "string" && raw.startsWith("@"))
    value = JSON.parse(fs.readFileSync(raw.slice(1), "utf8"));
  else if (typeof raw === "string") value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidInputError("--data must contain a JSON object");
  const result = { ...(value as JsonObject) };
  const definition = actions[parsed.command]?.[parsed.verb ?? ""];
  for (const field of definition?.fields ?? []) {
    if (parsed.options[field] === undefined) continue;
    const type = fieldTypes[field];
    if (type === "integer") result[field] = numberOption(parsed.options[field]);
    else if (type === "number") result[field] = Number(parsed.options[field]);
    else if (type === "json")
      result[field] = JSON.parse(String(parsed.options[field])) as JsonValue;
    else result[field] = String(parsed.options[field]);
  }
  return result;
}
function addFiles(payload: JsonObject, files: string[]) {
  const items = (payload.files as JsonObject[] | undefined) ?? [];
  for (const filename of files) {
    const source = path.resolve(filename);
    items.push({
      name: path.basename(source),
      type: "application/octet-stream",
      data: fs.readFileSync(source).toString("base64"),
    });
  }
  payload.files = items;
}

function describe(pathPrefix: readonly string[], resolvedDatabase: string) {
  const commands: Array<{ path: string[]; arguments: unknown[] }> = [];
  const globals = [
    argument(
      "db",
      ["--db"],
      "string",
      false,
      resolvedDatabase,
      undefined,
      "SQLite path",
    ),
    argument(
      "sync_dir",
      ["--sync-dir"],
      "string",
      false,
      undefined,
      "snapshot/ next to the database",
      "Snapshot directory",
    ),
    argument(
      "actor",
      ["--actor"],
      "integer",
      false,
      1,
      undefined,
      "Actor ID (default: 1)",
    ),
    argument(
      "json",
      ["--json"],
      "boolean",
      false,
      false,
      undefined,
      "Write JSON output",
    ),
  ];
  const add = (commandPath: string[], extra: unknown[] = []): void => {
    commands.push({ path: commandPath, arguments: [...globals, ...extra] });
  };
  add(
    ["init"],
    [
      argument(
        "demo",
        ["--demo"],
        "boolean",
        false,
        false,
        undefined,
        "Load demo data",
      ),
    ],
  );
  add(
    ["batch"],
    [
      argument(
        "data",
        ["--data"],
        "string",
        true,
        undefined,
        undefined,
        "JSON object, @file.json, or - for stdin",
      ),
    ],
  );
  add(
    ["describe"],
    [
      {
        ...argument(
          "path",
          [],
          "string",
          false,
          [],
          undefined,
          "Command path prefix",
        ),
        repeatable: true,
      },
    ],
  );
  add(["context"]);
  add(["doctor"]);
  add(["serve"]);
  add(
    ["search"],
    [
      argument("query", [], "string", true),
      {
        ...argument("scope", ["--scope"], "string", false, "All"),
        choices: ["All", "Issues", "Projects"],
      },
    ],
  );
  add(["export"]);
  for (const verb of ["status", "validate", "export", "import", "migrate"])
    add(
      ["sync", verb],
      [
        ...(verb === "export" || verb === "import"
          ? [
              argument("dry_run", ["--dry-run"], "boolean", false, false),
              argument(
                "force",
                ["--force"],
                "boolean",
                false,
                false,
                undefined,
                "Back up and replace conflicting data",
              ),
            ]
          : []),
      ],
    );
  add(
    ["attachments", "get"],
    [
      argument("id", [], "integer", true),
      argument("output", ["--output"], "string", true),
    ],
  );
  for (const resource of Object.keys(resources)) {
    for (const verb of ["list", "show"]) {
      const extra = [];
      if (verb === "show" && !["preferences", "workspace"].includes(resource))
        extra.push(argument("id", [], "string", true));
      if (verb === "list")
        extra.push(
          argument(
            "all",
            ["--all"],
            "boolean",
            false,
            false,
            undefined,
            "Include archived and inactive records",
          ),
          argument("limit", ["--limit"], "integer", false, 100),
          argument("cursor", ["--cursor"], "string", false),
          ...(listFilters[resource] ?? []).map((field) =>
            argument(
              field,
              [`--${kebab(field)}`],
              fieldTypes[field] ?? "string",
              false,
            ),
          ),
        );
      add([resource, verb], extra);
    }
    for (const [verb, definition] of Object.entries(actions[resource] ?? {})) {
      const extra = [];
      const route = definition.route;
      if (route.includes("{id}"))
        extra.push(argument("id", [], "string", true));
      if (route.includes("{resource_id}"))
        extra.push(argument("resource_id", [], "integer", true));
      extra.push(
        argument(
          "data",
          ["--data"],
          "string",
          false,
          undefined,
          undefined,
          "JSON object, @file.json, or - for stdin",
        ),
        ...definition.fields.map((field) =>
          argument(
            field,
            [`--${kebab(field)}`],
            fieldTypes[field] ?? "string",
            definition.required?.includes(field) ?? false,
            undefined,
            undefined,
            field === "priority"
              ? "Priority name or number from 0 to 4"
              : undefined,
          ),
        ),
      );
      if (verb === "attach")
        extra.push({
          ...argument("file", ["--file"], "string", false, []),
          repeatable: true,
        });
      if (resource === "issues" && verb === "import")
        extra.push(argument("dry_run", ["--dry-run"], "boolean", false, false));
      add([resource, verb], extra);
    }
    if (resource === "recurring") add(["recurring", "run"]);
  }
  const selected = pathPrefix.length
    ? commands.filter((command) =>
        pathPrefix.every((part, index) => command.path[index] === part),
      )
    : commands;
  if (pathPrefix.length && selected.length === 0)
    throw unknownCommandError(
      pathPrefix,
      `Unknown command path: ${pathPrefix.join(" ")}`,
    );
  return { formatVersion: 2, commands: selected };
}
function argument(
  name: string,
  flags: string[],
  type: string,
  required: boolean,
  defaultValue?: unknown,
  defaultRule?: string,
  description?: string,
) {
  return {
    name,
    flags,
    required,
    type,
    repeatable: false,
    ...(defaultRule ? { defaultRule } : { default: defaultValue ?? null }),
    ...(description ? { description } : {}),
  };
}
function printHelp() {
  console.log(
    `Clone ${packageVersion}\n\nUsage:\n  clone [--local | --data-dir PATH | --db PATH] [start] [--port PORT] [--no-open]\n  clone [--local | --data-dir PATH | --db PATH] <CLI command> [options]\n  clone batch --actor ID --data @operations.json --json\n  clone context [--json]\n  clone doctor [--json]\n  clone describe [COMMAND...] [--json]`,
  );
}
function writeResult(value: unknown, json: boolean) {
  if (json || typeof value === "object")
    console.log(JSON.stringify(value, null, 2));
  else console.log(String(value));
}
function convertError(error: unknown): CloneError {
  if (error instanceof CloneError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/constraint/i.test(message))
    return new RelationshipConflictError(
      `Conflict or invalid relationship: ${message}`,
    );
  return new StorageError(message);
}
function camel(value: string) {
  return value.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}
function kebab(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
function numberOption(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result))
    throw new InvalidInputError("Expected an integer");
  return result;
}
function optionalNumber(value: unknown): number | null {
  return value === undefined ? null : numberOption(value);
}
function optionList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String)
    : value === undefined
      ? []
      : [String(value)];
}
function parsePort(parsed: Parsed) {
  return numberOption(parsed.options.port ?? process.env.PORT ?? 4173);
}
function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
