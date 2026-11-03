import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";

import { openDatabase } from "./database.js";
import { CloneError, InvalidInputError } from "./errors.js";
import { rootDirectory } from "./paths.js";
import { initialize, mutate, prepare, withStorageLock } from "./sync.js";
import type { JsonObject, Row, StoragePaths } from "./types.js";
import {
  actorRecord,
  actorRecords,
  bootstrap,
  dispatchMutation,
  issueRow,
  now,
  runDueRecurring,
  search,
} from "./workspace.js";

const staticTypes: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "app.js": "application/javascript; charset=utf-8",
};

export async function startServer(
  paths: StoragePaths,
  port: number,
  open: boolean,
): Promise<void> {
  if (!fs.existsSync(paths.database)) {
    if (fs.existsSync(paths.snapshotDirectory))
      throw new InvalidInputError(
        "Snapshot found. Run clone sync import first.",
      );
    await withStorageLock(paths, () => initialize(paths, false));
  } else {
    await withStorageLock(paths, () => prepare(paths));
  }
  const host = process.env.CLONE_HOST ?? "127.0.0.1";
  const server = http.createServer(
    (request, response) => void handle(paths, request, response),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${port}`;
  console.log(`Clone running at ${url} (SQLite: ${paths.database})`);
  if (open) openBrowser(url);
  const timer = setInterval(() => {
    void withStorageLock(paths, () =>
      mutate(paths, (database) => runDueRecurring(database, paths)),
    ).catch((error) => {
      console.error(
        `Recurring issue scheduler error: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, 30_000);
  timer.unref();
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => {
        clearInterval(timer);
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function handle(
  paths: StoragePaths,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (process.env.CLONE_ACCESS_LOG === "1")
    console.log(`${request.method} ${request.url}`);
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = decodeURIComponent(url.pathname);
    if (!route.startsWith("/api/")) {
      serveStatic(route, response);
      return;
    }
    if (request.method === "GET") {
      const result = await withStorageLock(paths, () =>
        apiRead(paths, route, url.searchParams),
      );
      if (result instanceof AttachmentResponse) {
        sendAttachment(response, result);
        return;
      }
      sendJson(response, result.body, result.status);
      return;
    }
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) {
      sendJson(response, { error: "Not found" }, 404);
      return;
    }
    const body = await readBody(request);
    const result = await withStorageLock(paths, () =>
      mutate(paths, (database) =>
        dispatchMutation(database, request.method!, route, body, paths),
      ),
    );
    const status = Number(result._status ?? 200);
    delete result._status;
    sendJson(response, result, status);
  } catch (error) {
    const status =
      error instanceof CloneError
        ? ["sync_conflict", "record_conflict"].includes(error.code)
          ? 409
          : error.code === "pending_export"
            ? 503
            : 400
        : 500;
    const body: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (error instanceof CloneError)
      Object.assign(body, { code: error.code, ...error.details });
    else
      ((body.error = "Internal error"),
        (body.detail = error instanceof Error ? error.message : String(error)));
    sendJson(response, body, status);
  }
}

function apiRead(
  paths: StoragePaths,
  route: string,
  query: URLSearchParams,
): JsonResponse | AttachmentResponse {
  const database = openDatabase(paths);
  try {
    if (route === "/api/bootstrap") return json(bootstrap(database));
    if (route === "/api/health")
      return json({ ok: true, database: "sqlite", mode: "local-single-user" });
    if (route === "/api/export")
      return json({ ...bootstrap(database), exportedAt: now() });
    if (route === "/api/search")
      return json(
        search(database, query.get("q") ?? "", query.get("scope") ?? "All"),
      );
    const actor = route.match(/^\/api\/(actors|agents)(?:\/(\d+))?$/);
    if (actor) {
      const kind = actor[1] === "agents" ? "agent" : null;
      if (actor[2]) {
        const record = actorRecord(database, Number(actor[2]));
        return !record || (kind && record.kind !== kind)
          ? json({ error: "Actor not found" }, 404)
          : json(record);
      }
      return json(actorRecords(database, kind, query.get("all") === "true"));
    }
    const attachment = route.match(/^\/api\/attachments\/(\d+)$/);
    if (attachment) {
      const row = database
        .prepare("SELECT * FROM issue_attachments WHERE id=?")
        .get(Number(attachment[1])) as Row | undefined;
      if (!row) return json({ error: "Attachment not found" }, 404);
      const content = fs.readFileSync(
        path.join(paths.attachmentsDirectory, String(row.storage_name)),
      );
      return new AttachmentResponse(
        content,
        String(row.name),
        String(row.content_type),
      );
    }
    const issue = route.match(/^\/api\/issues\/([^/]+)$/);
    if (issue) {
      const row = database
        .prepare("SELECT id FROM issues WHERE identifier=?")
        .get(issue[1]!) as { id: number } | undefined;
      return row
        ? json(issueRow(database, row.id))
        : json({ error: "Issue not found" }, 404);
    }
    const project = route.match(/^\/api\/projects\/(\d+)$/);
    if (project) {
      const record = (bootstrap(database).projects as Row[]).find(
        (item) => Number(item.id) === Number(project[1]),
      );
      return record ? json(record) : json({ error: "Project not found" }, 404);
    }
    return json({ error: "Not found" }, 404);
  } finally {
    database.close();
  }
}

function serveStatic(route: string, response: ServerResponse) {
  const name = route === "/" ? "index.html" : route.slice(1);
  if (!staticTypes[name]) {
    response.writeHead(404);
    response.end();
    return;
  }
  const target = path.join(rootDirectory, name);
  const content = fs.readFileSync(target);
  response.writeHead(200, {
    "Content-Type": staticTypes[name],
    "Content-Length": content.length,
  });
  response.end(content);
}
async function readBody(request: IncomingMessage): Promise<JsonObject> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0)
    throw new InvalidInputError("Content-Length must not be negative");
  if (declared > 5_000_000)
    throw new InvalidInputError("Request body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 5_000_000) throw new InvalidInputError("Request body too large");
    chunks.push(buffer);
  }
  if (!size) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidInputError("Request body must be an object");
  return value as JsonObject;
}
function sendJson(response: ServerResponse, body: unknown, status = 200) {
  const content = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
  });
  response.end(content);
}
function sendAttachment(response: ServerResponse, result: AttachmentResponse) {
  const fallback = result.name.replace(/[^A-Za-z0-9._-]/g, "_") || "attachment";
  response.writeHead(200, {
    "Content-Type": result.type,
    "Content-Length": result.content.length,
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  response.end(result.content);
}
function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/d", "/s", "/c", "start", "", url]
        : ["xdg-open", url];
  import("node:child_process").then(({ spawn }) =>
    spawn(command[0]!, command.slice(1), {
      detached: true,
      stdio: "ignore",
    }).unref(),
  );
}
class AttachmentResponse {
  constructor(
    readonly content: Buffer,
    readonly name: string,
    readonly type: string,
  ) {}
}
interface JsonResponse {
  readonly body: unknown;
  readonly status: number;
}
function json(body: unknown, status = 200): JsonResponse {
  return { body, status };
}
