import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initialize, mutate } from "../src/sync.js";
import { storagePaths } from "../src/paths.js";
import { dispatchMutation } from "../src/workspace.js";
import { openDatabase } from "../src/database.js";
import os from "node:os";

describe("HTTP input and revision regressions", () => {
  let directory: string;
  let child: ChildProcess;
  let baseUrl: string;
  let paths: ReturnType<typeof storagePaths>;

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "clone-http-review-"));
    paths = storagePaths(path.join(directory, "workspace.sqlite3"));
    initialize(paths, true);
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      [
        "bin/clone.js",
        "--db",
        paths.database,
        "start",
        "--port",
        String(port),
        "--no-open",
      ],
      {
        env: { ...process.env, CLONE_HOST: "127.0.0.1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await Promise.race([
      once(child.stdout!, "data"),
      once(child, "exit").then(() => {
        throw new Error("Server exited before startup");
      }),
    ]);
  });

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  const send = (route: string, method: string, body: unknown) =>
    fetch(baseUrl + route, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

  it("enforces the same revision and field contract for legacy PUT", async () => {
    const route = "/api/issues/PRO-93";
    const initial = (await (await fetch(baseUrl + route)).json()) as {
      revision: number;
    };
    expect(
      (
        await send(route, "PATCH", {
          actorId: 1,
          ifRevision: initial.revision,
          title: "First writer",
        })
      ).status,
    ).toBe(200);
    const stale = await send(route, "PUT", {
      actorId: 1,
      ifRevision: initial.revision,
      title: "Stale writer",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "record_conflict" });
    const current = (await (await fetch(baseUrl + route)).json()) as {
      revision: number;
      title: string;
    };
    expect(current).toMatchObject({
      title: "First writer",
      revision: initial.revision + 1,
    });
    expect(
      (await send(route, "PUT", { actorId: 1, title: "No precondition" }))
        .status,
    ).toBe(400);
    expect(
      (
        await send(route, "PUT", {
          actorId: 1,
          ifRevision: current.revision,
          title: "Unknown field",
          unknownField: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(route, "PUT", {
          actorId: 1,
          ifRevision: current.revision,
          title: "Accepted PUT",
        })
      ).status,
    ).toBe(200);
    expect(await (await fetch(baseUrl + route)).json()).toMatchObject({
      title: "Accepted PUT",
      revision: current.revision + 1,
    });
  });

  it.each(["{", "[", "null", "42"])(
    "returns invalid_input for malformed or non-object JSON: %s",
    async (raw) => {
      const route = "/api/issues/PRO-93";
      const before = await (await fetch(baseUrl + route)).json();
      const response = await fetch(baseUrl + route, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(response.status).toBe(400);
      const error = (await response.json()) as Record<string, unknown>;
      expect(error.code).toBe("invalid_input");
      expect(error).not.toHaveProperty("detail");
      expect(await (await fetch(baseUrl + route)).json()).toEqual(before);
    },
  );

  it("does not advance a revision for an unsupported resource method", async () => {
    const route = "/api/issues/PRO-93";
    const before = (await (await fetch(baseUrl + route)).json()) as {
      revision: number;
    };
    expect(
      (await send(route, "POST", { actorId: 1, ifRevision: before.revision }))
        .status,
    ).toBe(404);
    expect(await (await fetch(baseUrl + route)).json()).toEqual(before);
  });

  it("requires and advances revisions for every supported PUT update", () => {
    const db = openDatabase(paths);
    const targets = [
      {
        route: "/api/projects/1",
        table: "projects",
        key: "id",
        value: 1,
        patch: { name: "PUT project" },
      },
      {
        route: "/api/teams/1",
        table: "teams",
        key: "id",
        value: 1,
        patch: { name: "PUT team" },
      },
      {
        route: "/api/views/1",
        table: "views",
        key: "id",
        value: 1,
        patch: { name: "PUT view" },
      },
      {
        route: "/api/preferences",
        table: "app_settings",
        key: "key",
        value: "preferences",
        patch: { theme: "Dark" },
      },
      {
        route: "/api/settings",
        table: "app_settings",
        key: "key",
        value: "workspace",
        patch: { key: "workspace", value: { name: "PUT workspace" } },
      },
    ];
    try {
      for (const target of targets) {
        const record = db
          .prepare(`SELECT revision FROM ${target.table} WHERE ${target.key}=?`)
          .get(target.value) as { revision: number };
        expect(record).toBeDefined();
        expect(() =>
          mutate(paths, (connection) =>
            dispatchMutation(
              connection,
              "PUT",
              target.route,
              { actorId: 1, ...target.patch },
              paths,
            ),
          ),
        ).toThrow("ifRevision");
        mutate(paths, (connection) =>
          dispatchMutation(
            connection,
            "PUT",
            target.route,
            { actorId: 1, ifRevision: record.revision, ...target.patch },
            paths,
          ),
        );
        expect(
          db
            .prepare(
              `SELECT revision FROM ${target.table} WHERE ${target.key}=?`,
            )
            .get(target.value),
        ).toMatchObject({ revision: record.revision + 1 });
        expect(() =>
          mutate(paths, (connection) =>
            dispatchMutation(
              connection,
              "PUT",
              target.route,
              { actorId: 1, ifRevision: record.revision, ...target.patch },
              paths,
            ),
          ),
        ).toThrow("record changed");
      }
    } finally {
      db.close();
    }
  });
});
