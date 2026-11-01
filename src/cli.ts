import fs from "node:fs";
import path from "node:path";

import { openDatabase } from "./database.js";
import {
  CloneError,
  InvalidInputError,
  RelationshipConflictError,
  StorageError,
} from "./errors.js";
import { defaultDataDirectory, storagePaths } from "./paths.js";
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

const resources: Record<string, string> = {
  actors: "actors",
  agents: "actors",
  issues: "issues",
  projects: "projects",
  teams: "teams",
  members: "members",
  statuses: "issue_statuses",
  labels: "labels",
  cycles: "cycles",
  views: "views",
  inbox: "notifications",
  automations: "automations",
  recurring: "recurring_rules",
  settings: "app_settings",
  preferences: "app_settings",
  workspace: "workspace",
};

const actions: Record<string, Record<string, [string, string]>> = {
  agents: {
    create: ["POST", "/api/agents"],
    update: ["PATCH", "/api/agents/{id}"],
    deactivate: ["POST", "/api/agents/{id}/deactivate"],
    restore: ["POST", "/api/agents/{id}/restore"],
  },
  issues: {
    create: ["POST", "/api/issues"],
    update: ["PATCH", "/api/issues/{id}"],
    archive: ["DELETE", "/api/issues/{id}"],
    restore: ["POST", "/api/issues/{id}/restore"],
    comment: ["POST", "/api/issues/{id}/comments"],
    attach: ["POST", "/api/issues/{id}/attachments"],
    relate: ["POST", "/api/issues/{id}/relations"],
    import: ["POST", "/api/import"],
  },
  projects: {
    create: ["POST", "/api/projects"],
    update: ["PATCH", "/api/projects/{id}"],
    archive: ["DELETE", "/api/projects/{id}"],
    restore: ["POST", "/api/projects/{id}/restore"],
    milestone: ["POST", "/api/projects/{id}/milestones"],
    "post-update": ["POST", "/api/projects/{id}/updates"],
    depend: ["POST", "/api/projects/{id}/dependencies"],
  },
  teams: {
    create: ["POST", "/api/teams"],
    update: ["PATCH", "/api/teams/{id}"],
    "add-resource": ["POST", "/api/teams/{id}/resources"],
    "remove-resource": ["DELETE", "/api/teams/{id}/resources/{resource_id}"],
  },
  statuses: { create: ["POST", "/api/statuses"] },
  labels: { create: ["POST", "/api/labels"] },
  cycles: { create: ["POST", "/api/cycles"] },
  views: {
    create: ["POST", "/api/views"],
    update: ["PATCH", "/api/views/{id}"],
    delete: ["DELETE", "/api/views/{id}"],
  },
  inbox: {
    read: ["POST", "/api/notifications/{id}/read"],
    unread: ["POST", "/api/notifications/{id}/unread"],
    archive: ["POST", "/api/notifications/{id}/archive"],
    "read-all": ["POST", "/api/notifications/read-all"],
    "read-selected": ["POST", "/api/notifications/read-selected"],
    "archive-selected": ["POST", "/api/notifications/archive-selected"],
  },
  preferences: { update: ["PATCH", "/api/preferences"] },
  settings: { update: ["PATCH", "/api/settings"] },
  workspace: { update: ["PATCH", "/api/settings"] },
  automations: { create: ["POST", "/api/automations"] },
  recurring: { create: ["POST", "/api/recurring"] },
};

const textFields = [
  "title",
  "name",
  "description",
  "summary",
  "status",
  "body",
  "health",
  "key",
  "icon",
  "color",
  "category",
  "timezone",
  "estimateType",
  "dueDate",
  "startDate",
  "targetDate",
  "startsAt",
  "endsAt",
  "cadence",
  "nextRun",
  "externalUrl",
  "scope",
  "entity",
  "section",
  "url",
  "type",
  "relatedIssueId",
];
const integerFields = [
  "teamId",
  "projectId",
  "cycleId",
  "milestoneId",
  "assigneeId",
  "leadId",
  "parentId",
  "dependsOnId",
];
const jsonFields = [
  "labelIds",
  "teamIds",
  "memberIds",
  "subscriberIds",
  "ids",
  "filters",
  "display",
  "trigger",
  "condition",
  "action",
  "value",
  "dependencies",
  "milestones",
  "recurringRule",
  "isFavorite",
];

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
      console.log("0.2.0");
      return 0;
    }
    if (argv.includes("--help") || argv.includes("-h")) {
      printHelp();
      return 0;
    }
    const parsed = parseArguments(argv);
    if (parsed.command === "describe") {
      writeResult(describe(), true);
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
  const actor = numberOption(parsed.options.actor, 1);
  payload.actorId = actor;
  let route = action[1]
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
        return dispatchMutation(database, action[0], route, payload, paths);
      } finally {
        database.exec("ROLLBACK");
      }
    });
  }
  return mutate(paths, (database) => {
    const result = dispatchMutation(database, action[0], route, payload, paths);
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
    let entries = database.prepare(`SELECT * FROM "${table}"`).all() as Row[];
    if (parsed.verb === "list") {
      if (parsed.command === "agents")
        entries = entries.filter((row) => row.kind === "agent");
      if (!parsed.options.all)
        entries = entries.filter(
          (row) => !Number(row.archived ?? 0) && Number(row.active ?? 1),
        );
      const teamId = optionalNumber(parsed.options.teamId);
      if (teamId !== null) {
        if (["actors", "agents"].includes(parsed.command)) {
          const ids = new Set(
            (
              database
                .prepare("SELECT member_id FROM team_members WHERE team_id=?")
                .all(teamId) as Row[]
            ).map((r) => Number(r.member_id)),
          );
          entries = entries.filter((r) => ids.has(Number(r.id)));
        } else entries = entries.filter((r) => Number(r.team_id) === teamId);
      }
      const status = parsed.options.status;
      if (status) {
        if (parsed.command === "issues") {
          const ids = new Set(
            (
              database
                .prepare("SELECT id FROM issue_statuses WHERE name=?")
                .all(String(status)) as Row[]
            ).map((r) => Number(r.id)),
          );
          entries = entries.filter((r) => ids.has(Number(r.status_id)));
        } else entries = entries.filter((r) => r.status === status);
      }
      return entries;
    }
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
  if (
    command !== "start" &&
    !resources[command] &&
    ![
      "init",
      "describe",
      "serve",
      "search",
      "export",
      "sync",
      "attachments",
    ].includes(command)
  )
    throw new InvalidInputError(`Unknown command: ${command}`);
  const needsVerb =
    resources[command] || ["sync", "attachments"].includes(command);
  const verb = needsVerb ? words.shift() : undefined;
  return { command, verb, positionals: words, options };
}

function resolvePaths(parsed: Parsed) {
  let directory: string;
  if (parsed.options.local) directory = path.join(process.cwd(), ".clone");
  else if (parsed.options.dataDir)
    directory = path.resolve(String(parsed.options.dataDir));
  else directory = defaultDataDirectory();
  const database = parsed.options.db
    ? path.resolve(String(parsed.options.db))
    : path.join(directory, "workspace.sqlite3");
  return storagePaths(
    database,
    parsed.options.syncDir
      ? path.resolve(String(parsed.options.syncDir))
      : undefined,
  );
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
  for (const field of textFields)
    if (parsed.options[field] !== undefined)
      result[field] = String(parsed.options[field]);
  for (const field of integerFields)
    if (parsed.options[field] !== undefined)
      result[field] = numberOption(parsed.options[field]);
  for (const field of jsonFields)
    if (parsed.options[field] !== undefined)
      result[field] = JSON.parse(String(parsed.options[field])) as JsonValue;
  for (const field of ["estimate", "capacity"])
    if (parsed.options[field] !== undefined)
      result[field] = Number(parsed.options[field]);
  if (parsed.options.priority !== undefined)
    result.priority = String(parsed.options.priority);
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

function describe() {
  const commands: unknown[] = [];
  const globals = [
    argument(
      "db",
      ["--db"],
      "string",
      false,
      path.join(process.cwd(), "data/workspace.sqlite3"),
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
  add(["describe"]);
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
  const mutationArguments = [
    argument(
      "data",
      ["--data"],
      "string",
      false,
      undefined,
      undefined,
      "JSON object, @file.json, or - for stdin",
    ),
    ...textFields.map((field) =>
      argument(field, [`--${kebab(field)}`], "string", false),
    ),
    ...integerFields.map((field) =>
      argument(field, [`--${kebab(field)}`], "integer", false),
    ),
    ...jsonFields.map((field) =>
      argument(field, [`--${kebab(field)}`], "json", false),
    ),
    argument("estimate", ["--estimate"], "number", false),
    argument("capacity", ["--capacity"], "number", false),
    argument(
      "priority",
      ["--priority"],
      "string",
      false,
      undefined,
      undefined,
      "Priority name or number from 0 to 4",
    ),
  ];
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
          argument("team_id", ["--team-id"], "integer", false),
          argument("project_id", ["--project-id"], "integer", false),
          argument("status", ["--status"], "string", false),
        );
      add([resource, verb], extra);
    }
    for (const [verb, [, route]] of Object.entries(actions[resource] ?? {})) {
      const extra = [];
      if (route.includes("{id}"))
        extra.push(argument("id", [], "string", true));
      if (route.includes("{resource_id}"))
        extra.push(argument("resource_id", [], "integer", true));
      extra.push(...mutationArguments);
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
  return { formatVersion: 1, commands };
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
    `Clone 0.2.0\n\nUsage:\n  clone [--local | --data-dir PATH] [start] [--port PORT] [--no-open]\n  clone [--local | --data-dir PATH] <CLI command> [options]`,
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
