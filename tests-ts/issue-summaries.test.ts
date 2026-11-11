import { afterEach, expect, it } from "vitest";
import { issueRow, bootstrap } from "../src/workspace.js";
import { action, cleanupDirectories, demoWorkspace, read } from "./helpers.js";
import type { Row } from "../src/types.js";

afterEach(cleanupDirectories);

it("returns current compact summaries without changing issue visibility", () => {
  const paths = demoWorkspace();
  const root = action(paths, "POST", "/api/issues", {
    teamId: 1,
    title: "Summary parent",
  }).issue as Row;
  const parentId = Number(root.id);
  const agent = action(paths, "POST", "/api/agents", {
    key: "summary-agent",
    name: "Summary Agent",
  }).agent as Row;
  const child = action(paths, "POST", "/api/issues", {
    teamId: 1,
    title: "First child",
    parentId,
    status: "Todo",
    assigneeId: Number(agent.id),
  }).issue as Row;
  const other = action(paths, "POST", "/api/issues", {
    teamId: 1,
    title: "Second child",
    parentId,
  }).issue as Row;
  action(paths, "POST", `/api/issues/${root.identifier}/relations`, {
    relatedIssueId: String(child.identifier),
    type: "blocked by",
  });
  action(paths, "POST", `/api/issues/${root.identifier}/relations`, {
    url: "https://example.com",
    type: "reference",
  });
  const changed = action(paths, "PATCH", `/api/issues/${child.identifier}`, {
    status: "Done",
    ifRevision: Number(child.revision),
  }).issue as Row;
  const parent = read(paths, (db) => issueRow(db, parentId))!;
  const children = parent.subissues as Row[];
  expect(children.map((c) => c.id)).toEqual([child.id, other.id]);
  expect(children[0]).toMatchObject({
    status: "Done",
    status_category: "Completed",
    status_color: expect.any(String),
    revision: changed.revision,
    assignee_id: agent.id,
    assignee: "Summary Agent (Agent)",
    assignee_kind: "agent",
  });
  expect(children[1]).toMatchObject({
    assignee_id: null,
    assignee: null,
    assignee_kind: null,
  });
  expect(children[0]).not.toHaveProperty("activity");
  expect(children[0]).not.toHaveProperty("description");
  expect(parent.relations).toEqual([
    expect.objectContaining({
      related_id: child.id,
      related_identifier: child.identifier,
      related_status: "Done",
      related_status_category: "Completed",
      related_revision: changed.revision,
      related_archived: 0,
      related_assignee: "Summary Agent (Agent)",
      related_assignee_kind: "agent",
    }),
    expect.objectContaining({
      url: "https://example.com",
      related_id: null,
      related_status: null,
      related_revision: null,
      related_archived: null,
      related_assignee_id: null,
      related_assignee: null,
    }),
  ]);
  const boot = read(paths, (db) => bootstrap(db));
  expect(
    (boot.issues as Row[]).find((i) => i.id === parentId)?.subissues,
  ).toEqual(children);
  action(paths, "DELETE", `/api/issues/${child.identifier}`, {
    ifRevision: Number(changed.revision),
  });
  const archived = read(paths, (db) => issueRow(db, parentId))!;
  expect((archived.subissues as Row[]).map((c) => c.id)).toEqual([other.id]);
  expect((archived.relations as Row[])[0]).toMatchObject({
    related_archived: 1,
  });
});
