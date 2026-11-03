import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { storagePaths } from "../src/paths.js";
import { initialize } from "../src/sync.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clone-cli-review-"));
  directories.push(directory);
  const paths = storagePaths(path.join(directory, "workspace.sqlite3"));
  initialize(paths, true);
  return paths;
}
async function cli(database: string, ...arguments_: string[]) {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await main(["--db", database, ...arguments_, "--json"]);
    return {
      code,
      output: output.mock.calls.length
        ? JSON.parse(String(output.mock.calls[0]?.[0]))
        : null,
      error: errors.mock.calls.length
        ? JSON.parse(String(errors.mock.calls[0]?.[0]))
        : null,
    };
  } finally {
    output.mockRestore();
    errors.mockRestore();
  }
}

describe("reviewed CLI contracts", () => {
  it("preserves complete inline comment text and inline JSON data", async () => {
    const paths = fixture();
    const body = "commit=abc123; tests=pass; https://example.test/?a=b=c";
    expect(
      (
        await cli(
          paths.database,
          "issues",
          "comment",
          "PRO-93",
          "--actor",
          "1",
          `--body=${body}`,
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await cli(
          paths.database,
          "issues",
          "comment",
          "PRO-93",
          "--actor",
          "1",
          `--data=${JSON.stringify({ body })}`,
        )
      ).code,
    ).toBe(0);
    const read = await cli(paths.database, "issues", "show", "PRO-93");
    expect(
      read.output.comments.map((comment: { body: string }) => comment.body),
    ).toEqual([body, body]);
  });
});
