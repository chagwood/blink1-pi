#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function findPiPackageRoot() {
  if (process.env.PI_PACKAGE_ROOT) return process.env.PI_PACKAGE_ROOT;
  const piBinary = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
  if (!piBinary) throw new Error("pi is not on PATH; set PI_PACKAGE_ROOT to the package directory");
  const piEntry = fs.realpathSync(piBinary);
  return path.resolve(path.dirname(piEntry), "..", "..");
}

const piPackageRoot = findPiPackageRoot();
const { createJiti } = require(path.join(piPackageRoot, "node_modules", "jiti"));
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "blink1-pi-test."));
const configPath = path.join(testDir, "extensions", "blink1-pi", "config.json");
const extensionPath = path.resolve(__dirname, "..", "extensions", "index.ts");

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({
  version: 1,
  stages: {
    idle: { color: "00ff00", mode: "solid" },
    working: { color: "ffff00", mode: "solid" },
    waiting: { color: "0000ff", mode: "solid" },
    error: { color: "ff0000", mode: "solid" },
  },
}));

process.env.BLINK1_TOOL_PATH = "/mock/blink1-tool";
process.env.PI_CODING_AGENT_DIR = testDir;
delete process.env.BLINK1_PI_CONFIG_PATH;

const jiti = createJiti(path.join(testDir, "runner.js"), { interopDefault: true });
const loaded = jiti(extensionPath);
const extension = typeof loaded === "function" ? loaded : loaded.default;
const handlers = new Map();
const customEventHandlers = new Map();
const commands = new Map();
const calls = [];
const notices = [];
let selections = [];
let inputs = [];
let effectSelectCount = 0;

const pi = {
  on(name, handler) {
    handlers.set(name, handler);
  },
  registerCommand(name, definition) {
    commands.set(name, definition);
  },
  events: {
    on(name, handler) {
      const listeners = customEventHandlers.get(name) ?? new Set();
      listeners.add(handler);
      customEventHandlers.set(name, listeners);
      return () => listeners.delete(handler);
    },
    emit(name, payload) {
      for (const handler of customEventHandlers.get(name) ?? []) handler(payload);
    },
  },
  async exec(command, args, options) {
    calls.push({ command, args, options });
    return { code: 0, stdout: "", stderr: "", killed: false };
  },
};

const ctx = {
  ui: {
    notify(message, level) {
      notices.push({ message, level });
    },
    async select(title, options) {
      if (title.startsWith("Color for")) {
        assert.deepEqual(options.slice(0, 7).map((option) => option.replace(/ \(current\)$/, "")), [
          "Red (#ff0000)",
          "Green (#00ff00)",
          "Blue (#0000ff)",
          "Cyan (#00ffff)",
          "Magenta (#ff00ff)",
          "Yellow (#ffff00)",
          "Off / disabled (#000000)",
        ]);
        assert.match(options[7], /^Custom #RGB\/#RRGGBB/);
      }
      if (title.startsWith("Effect for")) {
        effectSelectCount++;
        assert.ok(options.includes("Front/back fade"));
      }
      return selections.shift();
    },
    async input() {
      return inputs.shift();
    },
    async confirm() {
      return false;
    },
  },
};

const originalSubagentChildEnv = process.env.PI_SUBAGENT_CHILD;
process.env.PI_SUBAGENT_CHILD = "1";
const childRegistrations = [];
extension({
  on(name) {
    childRegistrations.push(`event:${name}`);
  },
  registerCommand(name) {
    childRegistrations.push(`command:${name}`);
  },
  events: {
    on(name) {
      childRegistrations.push(`custom:${name}`);
      return () => {};
    },
  },
  async exec() {
    throw new Error("child extension must not access blink1-tool");
  },
});
assert.deepEqual(childRegistrations, [], "blink1-pi must be inert inside pi-subagent child processes");
delete process.env.PI_SUBAGENT_CHILD;
extension(pi);

async function emit(name, payload = {}) {
  const handler = handlers.get(name);
  assert.ok(handler, `missing ${name} handler`);
  await handler({ type: name, ...payload }, ctx);
}

function lastColor() {
  const argument = calls.at(-1)?.args.find((item) => item.startsWith("--rgb="));
  return argument?.slice("--rgb=".length);
}

async function flushCustomEvents() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const command = commands.get("blink1-pi");
  assert.ok(command, "missing /blink1-pi command");

  // Core lifecycle mapping.
  await emit("session_start");
  assert.equal(lastColor(), "00ff00");
  await emit("agent_start");
  assert.equal(lastColor(), "ffff00");
  await emit("ui_prompt_start");
  assert.equal(lastColor(), "0000ff");
  await emit("ui_prompt_end");
  assert.equal(lastColor(), "ffff00");
  await emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  assert.equal(lastColor(), "ff0000");
  await emit("agent_settled");
  assert.equal(lastColor(), "ff0000");
  await emit("agent_start");
  await emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
  await emit("agent_settled");
  assert.equal(lastColor(), "00ff00");

  // Async subagents use the ordinary working stage, overlap safely, and never
  // promote child failure to the parent error stage.
  calls.length = 0;
  pi.events.emit("subagent:async-started", { id: "async-a" });
  await flushCustomEvents();
  assert.equal(lastColor(), "ffff00");
  const firstWorkingCallCount = calls.length;
  pi.events.emit("subagent:async-started", { id: "async-b" });
  await flushCustomEvents();
  assert.equal(calls.length, firstWorkingCallCount, "a second child must not restart the same working effect");
  pi.events.emit("subagent:async-complete", { runId: "async-a", success: false, state: "failed" });
  await flushCustomEvents();
  assert.equal(calls.length, firstWorkingCallCount, "remaining child must keep the working effect active");
  pi.events.emit("subagent:async-complete", { runId: "async-b", success: true, state: "complete" });
  await flushCustomEvents();
  assert.equal(lastColor(), "00ff00", "child failure must not select the parent error stage");

  pi.events.emit("subagent:async-started", { id: "async-terminal" });
  await flushCustomEvents();
  assert.equal(lastColor(), "ffff00");
  pi.events.emit("subagent:process-terminal", { runId: "async-terminal", state: "observed" });
  await flushCustomEvents();
  assert.equal(lastColor(), "00ff00");

  await emit("agent_start");
  pi.events.emit("subagent:async-started", { id: "async-overlap" });
  await flushCustomEvents();
  await emit("agent_settled");
  assert.equal(lastColor(), "ffff00", "working must continue after the parent settles while a child runs");
  pi.events.emit("subagent:async-complete", { runId: "async-overlap", success: true });
  await flushCustomEvents();
  assert.equal(lastColor(), "00ff00");

  // Hardware front/back pattern and stage transition cleanup.
  await command.handler("set waiting cyan frontback", ctx);
  calls.length = 0;
  await emit("ui_prompt_start");
  assert.deepEqual(calls.map((call) => call.args), [
    ["--quiet", "--play", "0"],
    ["--quiet", "--led=1", "--millis=500", "--rgb=00ffff", "--setpattline", "29"],
    ["--quiet", "--led=2", "--millis=500", "--rgb=00ffff", "--setpattline", "30"],
    ["--quiet", "--led=0", "--millis=500", "--rgb=000000", "--setpattline", "31"],
    ["--quiet", "--play", "1,29,31,0"],
  ]);
  calls.length = 0;
  await emit("ui_prompt_end");
  assert.deepEqual(calls[0].args, ["--quiet", "--play", "0"]);
  assert.equal(lastColor(), "00ff00");

  // Persistent disabled stage: picker skips the meaningless effect prompt.
  selections = ["Off / disabled (#000000)"];
  const priorEffectSelectCount = effectSelectCount;
  await command.handler("set error", ctx);
  let saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.stages.error, { color: "000000", mode: "solid" });
  assert.equal(effectSelectCount, priorEffectSelectCount);
  await emit("agent_start");
  calls.length = 0;
  await emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  assert.deepEqual(calls.map((call) => call.args), [
    ["--quiet", "--play", "0"],
    ["--quiet", "--millis=0", "--rgb=000000"],
  ]);

  // Temporary global off survives UI prompts and clears at the next agent run.
  await command.handler("off", ctx);
  const callsAfterOff = calls.length;
  await emit("ui_prompt_start");
  await emit("ui_prompt_end");
  assert.equal(calls.length, callsAfterOff);
  await emit("agent_start");
  assert.equal(lastColor(), "ffff00");

  // Direct disabled alias and status rendering.
  await command.handler("set idle disabled frontback", ctx);
  saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.stages.idle, { color: "000000", mode: "solid" });
  await command.handler("show", ctx);
  assert.match(notices.at(-1).message, /Idle \/ ready: Off \/ disabled/);

  await emit("session_shutdown");
  assert.equal(lastColor(), "000000");
  const callsAfterShutdown = calls.length;
  pi.events.emit("subagent:async-started", { id: "after-shutdown" });
  await flushCustomEvents();
  assert.equal(calls.length, callsAfterShutdown, "shutdown must unsubscribe subagent event listeners");
  assert.ok(calls.every((call) => call.command === "/mock/blink1-tool"));
  assert.ok(calls.every((call) => call.options.timeout === 3000));

  console.log("blink1-pi extension tests: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (originalSubagentChildEnv === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = originalSubagentChildEnv;
    fs.rmSync(testDir, { recursive: true, force: true });
  });
