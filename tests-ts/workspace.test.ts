import fs from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupDirectories,
  action,
  demoWorkspace,
  emptyWorkspace,
  read,
} from "./helpers.js";

afterEach(cleanupDirectories);

describe("workspace actions", () => {
  it("registers an agent with a fixed key", () => {
    const paths = demoWorkspace();
    expect(
      action(paths, "POST", "/api/agents", { key: "codex", name: "Codex" }),
    ).toMatchObject({
      agent: { kind: "agent", key: "codex", name: "Codex", active: 1 },
    });
  });

  it("rejects duplicate agent keys", () => {
    const paths = demoWorkspace();
    action(paths, "POST", "/api/agents", { key: "codex", name: "Codex" });
    expect(() =>
      action(paths, "POST", "/api/agents", { key: "codex", name: "Other" }),
    ).toThrow();
  });

  it("deactivates and restores an agent without deleting history", () => {
    const paths = demoWorkspace();
    const created = action(paths, "POST", "/api/agents", {
      key: "worker",
      name: "Worker",
    }) as { agent: { id: number } };
    action(paths, "POST", `/api/agents/${created.agent.id}/deactivate`, {
      ifRevision: 1,
    });
    expect(() =>
      action(paths, "POST", "/api/issues", {
        actorId: created.agent.id,
        teamId: 1,
        title: "Blocked",
      }),
    ).toThrow("inactive");
    expect(
      action(paths, "POST", `/api/agents/${created.agent.id}/restore`, {
        ifRevision: 2,
      }),
    ).toMatchObject({ agent: { active: 1 } });
  });

  it("creates a first team in an empty workspace", () => {
    const paths = emptyWorkspace();
    expect(
      action(paths, "POST", "/api/teams", { name: "Product", key: "PRO" }),
    ).toMatchObject({ teamId: 1 });
    expect(
      read(paths, (database) =>
        database.prepare("SELECT COUNT(*) AS count FROM issue_statuses").get(),
      ),
    ).toEqual({ count: 7 });
  });

  it("creates custom workflow statuses", () => {
    const paths = demoWorkspace();
    expect(
      action(paths, "POST", "/api/statuses", {
        teamId: 1,
        name: "Released",
        category: "Completed",
      }),
    ).toMatchObject({ statusId: expect.any(Number) });
  });

  it("creates team and global labels", () => {
    const paths = demoWorkspace();
    const team = action(paths, "POST", "/api/labels", {
      name: "Backend",
      teamId: 1,
    });
    const global = action(paths, "POST", "/api/labels", {
      name: "Global",
      teamId: null,
    });
    expect(team).toMatchObject({ labelId: expect.any(Number) });
    expect(global).toMatchObject({ labelId: expect.any(Number) });
  });

  it("creates an issue with relationships", () => {
    const paths = demoWorkspace();
    const result = action(paths, "POST", "/api/issues", {
      teamId: 1,
      title: "Action test",
      status: "Todo",
      priority: "High",
      assigneeId: 2,
      labelIds: [1, 2],
      projectId: 1,
      cycleId: 1,
    });
    expect(result).toMatchObject({
      issue: { identifier: "PRO-249", status: "Todo", assignee_id: 2 },
    });
  });

  it("updates issue fields and records activity", () => {
    const paths = demoWorkspace();
    const result = action(paths, "PATCH", "/api/issues/PRO-248", {
      title: "Updated title",
      status: "Done",
      priority: "Low",
      labelIds: [2],
      ifRevision: 1,
    });
    expect(result).toMatchObject({
      issue: {
        title: "Updated title",
        status: "Done",
        priority_name: "Low",
        revision: 2,
      },
    });
    expect(
      (result.issue as { activity: unknown[] }).activity.length,
    ).toBeGreaterThan(0);
  });

  it("rejects a stale issue revision without partial changes", () => {
    const paths = demoWorkspace();
    action(paths, "PATCH", "/api/issues/PRO-248", {
      title: "First change",
      ifRevision: 1,
    });
    expect(() =>
      action(paths, "PATCH", "/api/issues/PRO-248", {
        title: "Stale change",
        ifRevision: 1,
      }),
    ).toThrow("changed after it was read");
    expect(
      read(paths, (database) =>
        database
          .prepare(
            "SELECT title,revision FROM issues WHERE identifier='PRO-248'",
          )
          .get(),
      ),
    ).toEqual({ title: "First change", revision: 2 });
  });

  it("archives and restores issues", () => {
    const paths = demoWorkspace();
    expect(
      action(paths, "DELETE", "/api/issues/PRO-248", { ifRevision: 1 }),
    ).toEqual({
      ok: true,
    });
    expect(
      read(paths, (database) =>
        database
          .prepare("SELECT archived FROM issues WHERE identifier='PRO-248'")
          .get(),
      ),
    ).toEqual({ archived: 1 });
    action(paths, "POST", "/api/issues/PRO-248/restore", { ifRevision: 2 });
    expect(
      read(paths, (database) =>
        database
          .prepare("SELECT archived FROM issues WHERE identifier='PRO-248'")
          .get(),
      ),
    ).toEqual({ archived: 0 });
  });

  it("adds comments with the acting author", () => {
    const paths = demoWorkspace();
    const result = action(paths, "POST", "/api/issues/PRO-248/comments", {
      body: "Checked",
    });
    expect(result).toMatchObject({
      issue: {
        comments: expect.arrayContaining([
          expect.objectContaining({ body: "Checked", author_id: 1 }),
        ]),
      },
    });
  });

  it("stores attachment bytes and metadata", () => {
    const paths = demoWorkspace();
    const data = Buffer.from("attachment body").toString("base64");
    const result = action(paths, "POST", "/api/issues/PRO-248/attachments", {
      files: [{ name: "note.txt", type: "text/plain", data }],
    });
    expect(result).toMatchObject({
      attachments: [expect.objectContaining({ name: "note.txt" })],
    });
    const attachment = read(paths, (database) =>
      database
        .prepare("SELECT storage_name,size FROM issue_attachments WHERE id=1")
        .get(),
    ) as { storage_name: string; size: number };
    expect(attachment.size).toBe(15);
    expect(
      fs.readFileSync(
        `${paths.attachmentsDirectory}/${attachment.storage_name}`,
        "utf8",
      ),
    ).toBe("attachment body");
  });

  it("links issues and external URLs", () => {
    const paths = demoWorkspace();
    action(paths, "POST", "/api/issues/PRO-248/relations", {
      relatedIssueId: "PRO-246",
      type: "relates to",
    });
    const result = action(paths, "POST", "/api/issues/PRO-248/relations", {
      url: "https://example.com",
      type: "reference",
    });
    expect(result).toMatchObject({
      issue: {
        relations: expect.arrayContaining([
          expect.objectContaining({ url: "https://example.com" }),
        ]),
      },
    });
  });

  it("creates, updates, archives, and restores a project", () => {
    const paths = demoWorkspace();
    const created = action(paths, "POST", "/api/projects", {
      name: "Project test",
      teamIds: [1],
      memberIds: [1],
    }) as { projectId: number };
    action(paths, "PATCH", `/api/projects/${created.projectId}`, {
      summary: "Updated",
      priority: "High",
      ifRevision: 1,
    });
    action(paths, "DELETE", `/api/projects/${created.projectId}`, {
      ifRevision: 2,
    });
    expect(
      read(paths, (database) =>
        database
          .prepare("SELECT summary,archived FROM projects WHERE id=?")
          .get(created.projectId),
      ),
    ).toEqual({ summary: "Updated", archived: 1 });
    action(paths, "POST", `/api/projects/${created.projectId}/restore`, {
      ifRevision: 3,
    });
    expect(
      read(paths, (database) =>
        database
          .prepare("SELECT archived FROM projects WHERE id=?")
          .get(created.projectId),
      ),
    ).toEqual({ archived: 0 });
  });

  it("creates, updates, and deletes saved views", () => {
    const paths = demoWorkspace();
    const created = action(paths, "POST", "/api/views", {
      name: "My bugs",
      entity: "issues",
      scope: "Personal",
      filters: { label: "Bug" },
    }) as { viewId: number };
    action(paths, "PATCH", `/api/views/${created.viewId}`, {
      name: "My open bugs",
      isFavorite: true,
      ifRevision: 1,
    });
    expect(
      read(paths, (database) =>
        database
          .prepare("SELECT name,is_favorite FROM views WHERE id=?")
          .get(created.viewId),
      ),
    ).toEqual({ name: "My open bugs", is_favorite: 1 });
    action(paths, "DELETE", `/api/views/${created.viewId}`, {
      ifRevision: 2,
    });
    expect(
      read(paths, (database) =>
        database.prepare("SELECT id FROM views WHERE id=?").get(created.viewId),
      ),
    ).toBeUndefined();
  });

  it("limits notification actions to the acting recipient", () => {
    const paths = demoWorkspace();
    expect(
      action(paths, "POST", "/api/notifications/read-selected", {
        ids: [1, 4],
      }),
    ).toMatchObject({ count: 1 });
    expect(
      read(paths, (database) =>
        database.prepare("SELECT is_read FROM notifications WHERE id=4").get(),
      ),
    ).toEqual({ is_read: 0 });
  });

  it("imports issues and runs creation automations", () => {
    const paths = demoWorkspace();
    action(paths, "POST", "/api/automations", {
      teamId: 1,
      name: "Assign bugs",
      trigger: { event: "issue.created" },
      condition: { label: "Bug" },
      action: { assignTo: 2 },
    });
    const result = action(paths, "POST", "/api/import", {
      issues: [{ title: "Imported bug", labelIds: [2] }],
    });
    expect(result).toMatchObject({ count: 1, created: ["PRO-249"] });
    expect(
      read(paths, (database) =>
        database
          .prepare("SELECT assignee_id FROM issues WHERE identifier='PRO-249'")
          .get(),
      ),
    ).toEqual({ assignee_id: 2 });
  });
});
