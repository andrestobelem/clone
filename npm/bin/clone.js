#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const packageMetadata = require("../package.json");

const RELEASE_ROOT = "https://github.com/andrestobelem/clone/releases/download";
const TARGETS = new Map([
  ["darwin-arm64", "clone-darwin-arm64"],
  ["darwin-x64", "clone-darwin-x64"],
  ["linux-arm64", "clone-linux-arm64"],
  ["linux-x64", "clone-linux-x64"],
  ["win32-x64", "clone-win32-x64.exe"],
]);
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

function target(platform = process.platform, architecture = process.arch) {
  const value = TARGETS.get(`${platform}-${architecture}`);
  if (!value) throw new Error(`Clone does not support ${platform}/${architecture}.`);
  return value;
}

function cacheDirectory(platform = process.platform, environment = process.env) {
  if (environment.CLONE_CACHE_DIR) return path.resolve(environment.CLONE_CACHE_DIR);
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "Clone");
  if (platform === "win32") return path.join(environment.LOCALAPPDATA || os.homedir(), "Clone", "cache");
  return path.join(environment.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "clone");
}

function dataDirectory(platform = process.platform, environment = process.env, override = null) {
  if (override) return path.resolve(override);
  if (environment.CLONE_DATA_DIR) return path.resolve(environment.CLONE_DATA_DIR);
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Clone");
  if (platform === "win32") return path.join(environment.APPDATA || os.homedir(), "Clone");
  return path.join(environment.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "clone");
}

function parseLauncherArguments(arguments_, workingDirectory = process.cwd()) {
  let storage = null;
  const forwarded = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === "--local") {
      if (storage) throw new Error("Use only one data directory option.");
      storage = path.join(workingDirectory, ".clone");
    } else if (value === "--data-dir") {
      if (storage) throw new Error("Use only one data directory option.");
      const directory = arguments_[++index];
      if (!directory) throw new Error("--data-dir requires a path.");
      storage = path.resolve(workingDirectory, directory);
    } else if (value.startsWith("--data-dir=")) {
      if (storage) throw new Error("Use only one data directory option.");
      const directory = value.slice(11);
      if (!directory) throw new Error("--data-dir requires a path.");
      storage = path.resolve(workingDirectory, directory);
    } else {
      forwarded.push(value);
    }
  }
  return { arguments: forwarded, storage };
}

async function download(url, destination) {
  const response = await fetch(url, { headers: { "user-agent": `clone/${packageMetadata.version}` } });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const temporary = `${destination}.download`;
  fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });
  fs.renameSync(temporary, destination);
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function binaryPath() {
  if (process.env.CLONE_BINARY_PATH) return path.resolve(process.env.CLONE_BINARY_PATH);
  const filename = target();
  const directory = path.join(cacheDirectory(), packageMetadata.version);
  const binary = path.join(directory, filename);
  const checksums = path.join(directory, "checksums.txt");
  fs.mkdirSync(directory, { recursive: true });
  const release = `${RELEASE_ROOT}/v${packageMetadata.version}`;
  if (!fs.existsSync(checksums)) await download(`${release}/checksums.txt`, checksums);
  const expectedLine = fs.readFileSync(checksums, "utf8").split(/\r?\n/).find((line) => line.endsWith(`  ${filename}`));
  if (!expectedLine) throw new Error(`The release has no checksum for ${filename}.`);
  const expected = expectedLine.split(/\s+/)[0];
  if (!fs.existsSync(binary) || checksum(binary) !== expected) {
    fs.rmSync(binary, { force: true });
    await download(`${release}/${filename}`, binary);
  }
  if (checksum(binary) !== expected) {
    fs.rmSync(binary, { force: true });
    throw new Error(`Checksum verification failed for ${filename}.`);
  }
  if (process.platform !== "win32") fs.chmodSync(binary, 0o755);
  return binary;
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/d", "/s", "/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.unref();
}

async function waitForServer(url, child, errorState) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (errorState.value) throw errorState.value;
    if (child.exitCode !== null) throw new Error(`Clone stopped with exit code ${child.exitCode}.`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Clone did not start at ${url}.`);
}

function parseStartArguments(arguments_) {
  let port = process.env.PORT || "4173";
  let open = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === "--no-open") open = false;
    else if (value === "--port") port = arguments_[++index];
    else if (value.startsWith("--port=")) port = value.slice(7);
    else throw new Error(`Unknown start option: ${value}`);
  }
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error("Port must be between 1 and 65535.");
  if (BLOCKED_PORTS.has(Number(port))) throw new Error(`Port ${port} is blocked by web browsers.`);
  return { port: String(port), open };
}

function initialize(binary, database, storage) {
  if (fs.existsSync(database) || fs.existsSync(path.join(storage, "snapshot"))) return;
  fs.mkdirSync(storage, { recursive: true });
  const result = spawnSync(binary, ["--db", database, "init"], { encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Clone initialization failed with exit code ${result.status}.`);
}

async function start(binary, arguments_, environment = process.env) {
  const options = parseStartArguments(arguments_);
  const storage = dataDirectory(process.platform, environment);
  const database = path.join(storage, "workspace.sqlite3");
  initialize(binary, database, storage);
  const url = `http://127.0.0.1:${options.port}`;
  const child = spawn(binary, ["--db", database, "serve"], {
    env: { ...environment, CLONE_HOST: "127.0.0.1", PORT: options.port },
    stdio: "inherit",
  });
  const errorState = { value: null };
  child.once("error", (error) => { errorState.value = error; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  try {
    await waitForServer(url, child, errorState);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  console.log(`Open ${url}. Stop with Ctrl+C.`);
  if (options.open) openBrowser(url);
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code || 0)));
  });
}

function help(storage = null) {
  console.log(`Clone ${packageMetadata.version}

Usage:
  clone [--local | --data-dir PATH] [start] [--port PORT] [--no-open]
  clone [--local | --data-dir PATH] <CLI command> [options]

Examples:
  npx @andrestobelem/clone
  npx @andrestobelem/clone --local
  npx @andrestobelem/clone --data-dir ./project-data
  npx @andrestobelem/clone start --port 5000
  npx @andrestobelem/clone teams list --json

Data: ${dataDirectory(process.platform, process.env, storage)}`);
}

async function main(arguments_ = process.argv.slice(2)) {
  const launcher = parseLauncherArguments(arguments_);
  arguments_ = launcher.arguments;
  if (arguments_.includes("--version") || arguments_.includes("-V")) {
    console.log(packageMetadata.version);
    return 0;
  }
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    help(launcher.storage);
    return 0;
  }
  const binary = await binaryPath();
  const command = arguments_[0];
  if (!command || command === "start") {
    const environment = launcher.storage ? { ...process.env, CLONE_DATA_DIR: launcher.storage } : process.env;
    return start(binary, command ? arguments_.slice(1) : arguments_, environment);
  }
  const storage = dataDirectory(process.platform, process.env, launcher.storage);
  const database = path.join(storage, "workspace.sqlite3");
  initialize(binary, database, storage);
  const result = spawnSync(binary, ["--db", database, ...arguments_], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status || 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Clone: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { cacheDirectory, dataDirectory, parseLauncherArguments, parseStartArguments, target };
