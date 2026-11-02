import { describe, expect, it } from "vitest";

import { mutationPayload } from "../src/validation.js";

describe("payload validation", () => {
  it("rejects fields outside the route contract", () => {
    expect(() =>
      mutationPayload(
        { title: "Valid", timezone: "UTC" },
        "/api/issues",
        "POST",
      ),
    ).toThrow("Unknown field: timezone");
  });
  it.each([
    ["rejects arrays", [], "/api/issues", "Request body must be an object"],
    [
      "rejects empty titles",
      { title: "  " },
      "/api/issues",
      "title must not be empty",
    ],
    [
      "rejects boolean team IDs",
      { teamId: true },
      "/api/issues",
      "teamId must be a positive integer",
    ],
    [
      "rejects zero IDs",
      { projectId: 0 },
      "/api/issues",
      "projectId must be a positive integer",
    ],
    [
      "rejects invalid ID arrays",
      { labelIds: [1, 0] },
      "/api/issues",
      "labelIds must be an array",
    ],
    [
      "rejects invalid objects",
      { filters: [] },
      "/api/views",
      "filters must be an object",
    ],
    [
      "rejects negative estimates",
      { estimate: -1 },
      "/api/issues",
      "estimate must be a finite number",
    ],
    [
      "rejects invalid dates",
      { dueDate: "2026-02-30" },
      "/api/issues",
      "dueDate must use YYYY-MM-DD",
    ],
    [
      "rejects reversed cycles",
      { startsAt: "2026-11-02", endsAt: "2026-11-01" },
      "/api/cycles",
      "Cycle end must not be before",
    ],
    [
      "rejects unknown cadence",
      { cadence: "Sometimes" },
      "/api/recurring",
      "Unknown recurring cadence",
    ],
    [
      "rejects unknown status category",
      { category: "Doing" },
      "/api/statuses",
      "Unknown workflow status category",
    ],
    [
      "rejects unknown project status",
      { status: "Open" },
      "/api/projects",
      "Unknown project status",
    ],
    [
      "rejects unknown view entity",
      { entity: "cycles" },
      "/api/views",
      "Unknown view entity",
    ],
    [
      "rejects unknown view scope",
      { scope: "Private" },
      "/api/views",
      "Unknown view scope",
    ],
    [
      "rejects invalid favorite values",
      { isFavorite: "yes" },
      "/api/views",
      "isFavorite must be",
    ],
    [
      "rejects unknown automation events",
      { trigger: { event: "issue.deleted" } },
      "/api/automations",
      "Unknown automation event",
    ],
    [
      "rejects invalid automation priorities",
      { condition: { priority: "Critical" } },
      "/api/automations",
      "Unknown automation priority",
    ],
    [
      "rejects invalid preference booleans",
      { spelling: 1 },
      "/api/preferences",
      "spelling must be a boolean",
    ],
    [
      "rejects invalid integrations",
      { key: "integrations", value: {} },
      "/api/settings",
      "integrations must be an array",
    ],
    [
      "rejects invalid recurring rules",
      { recurringRule: 42 },
      "/api/issues",
      "recurringRule must be",
    ],
  ])("%s", (_name, payload, route, message) => {
    expect(() => mutationPayload(payload, route)).toThrow(message);
  });

  it("normalizes text, duplicate IDs, dates, and recurring rules", () => {
    expect(
      mutationPayload(
        {
          title: "  Issue  ",
          labelIds: [2, 2, 3],
          dueDate: "2026-11-01",
          recurringRule: { cadence: "Weekly" },
        },
        "/api/issues",
      ),
    ).toMatchObject({
      title: "Issue",
      labelIds: [2, 3],
      dueDate: "2026-11-01",
      recurringRule: '{"cadence":"Weekly"}',
    });
  });
});
