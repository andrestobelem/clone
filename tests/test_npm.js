"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const packageMetadata = require("../npm/package.json");
const { cacheDirectory, dataDirectory, parseStartArguments, target } = require("../npm/bin/clone.js");

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

test("parses start options and validates ports", () => {
  assert.deepEqual(parseStartArguments(["--port", "5000", "--no-open"]), { port: "5000", open: false });
  assert.deepEqual(parseStartArguments(["--port=6001"]), { port: "6001", open: true });
  assert.throws(() => parseStartArguments(["--port", "0"]), /between 1 and 65535/);
  assert.throws(() => parseStartArguments(["--port", "4190"]), /blocked by web browsers/);
  assert.throws(() => parseStartArguments(["--wat"]), /Unknown start option/);
});

test("uses one version for Python and npm releases", () => {
  const project = fs.readFileSync(require("node:path").join(__dirname, "..", "pyproject.toml"), "utf8");
  assert.equal(project.match(/^version = "([^"]+)"/m)[1], packageMetadata.version);
});

function pathFromWorkingDirectory(name) {
  return require("node:path").resolve(name);
}
