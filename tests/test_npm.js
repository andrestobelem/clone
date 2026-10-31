"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const packageMetadata = require("../npm/package.json");
const { cacheDirectory, dataDirectory, parseLauncherArguments, parseStartArguments, target } = require("../npm/bin/clone.js");

test("selects release assets by platform", () => {
  assert.equal(target("darwin", "arm64"), "clone-darwin-arm64");
  assert.equal(target("darwin", "x64"), "clone-darwin-x64");
  assert.equal(target("linux", "arm64"), "clone-linux-arm64");
  assert.equal(target("linux", "x64"), "clone-linux-x64");
  assert.equal(target("win32", "x64"), "clone-win32-x64.exe");
  assert.throws(() => target("win32", "arm64"), /does not support/);
});

test("honors explicit cache and data directories", () => {
  assert.equal(cacheDirectory("linux", { CLONE_CACHE_DIR: "./cache" }), pathFromWorkingDirectory("cache"));
  assert.equal(dataDirectory("linux", { CLONE_DATA_DIR: "./data" }), pathFromWorkingDirectory("data"));
});

test("selects a repository-local data directory", () => {
  const workingDirectory = pathFromWorkingDirectory("project");
  assert.deepEqual(parseLauncherArguments(["--local", "start", "--no-open"], workingDirectory), {
    arguments: ["start", "--no-open"],
    storage: require("node:path").join(workingDirectory, ".clone"),
  });
  assert.deepEqual(parseLauncherArguments(["issues", "list", "--data-dir", "records"], workingDirectory), {
    arguments: ["issues", "list"],
    storage: require("node:path").join(workingDirectory, "records"),
  });
  assert.deepEqual(parseLauncherArguments(["--data-dir=../shared"], workingDirectory), {
    arguments: [],
    storage: require("node:path").resolve(workingDirectory, "../shared"),
  });
  assert.throws(() => parseLauncherArguments(["--local", "--data-dir", "records"]), /only one/);
  assert.throws(() => parseLauncherArguments(["--data-dir"]), /requires a path/);
  assert.throws(() => parseLauncherArguments(["--data-dir="]), /requires a path/);
});

test("parses start options and validates ports", () => {
  assert.deepEqual(parseStartArguments(["--port", "5000", "--no-open"]), { port: "5000", open: false });
  assert.deepEqual(parseStartArguments(["--port=6001"]), { port: "6001", open: true });
  assert.throws(() => parseStartArguments(["--port", "0"]), /between 1 and 65535/);
  assert.throws(() => parseStartArguments(["--port", "4190"]), /blocked by web browsers/);
  assert.throws(() => parseStartArguments(["--wat"]), /Unknown start option/);
});

test("uses one version for Python and npm releases", () => {
  const project = fs.readFileSync(path.join(__dirname, "..", "pyproject.toml"), "utf8");
  assert.equal(project.match(/^version = "([^"]+)"/m)[1], packageMetadata.version);
});

test("keeps first-run JSON output parseable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clone-npm-test-"));
  const binary = path.join(directory, "fake-clone");
  const launcher = path.join(__dirname, "..", "npm", "bin", "clone.js");
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.at(-1) === "init") {
  fs.writeFileSync(args[1], "");
  console.log(JSON.stringify({ initialized: true }));
} else {
  console.log(JSON.stringify({ arguments: args }));
}
`);
  fs.chmodSync(binary, 0o755);
  try {
    const result = spawnSync(process.execPath, [launcher, "--local", "describe", "--json"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, CLONE_BINARY_PATH: binary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).arguments.slice(-2), ["describe", "--json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function pathFromWorkingDirectory(name) {
  return path.resolve(name);
}
