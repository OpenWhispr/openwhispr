const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AgentCliRunner } = require("../../src/helpers/agentCliRunner");

function fakeChild({ stdout = " cleaned text \n", exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end("");
    child.emit("close", exitCode, null);
  });
  child.kill = () => true;
  return child;
}

function controllableChild(pid = 5000) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}

test("Claude uses fixed argv, shell:false, neutral cwd, and stdin for user content", async () => {
  const calls = [];
  let stdin = "";
  let systemPromptContents;
  let systemPromptMode;
  const runner = new AgentCliRunner({
    spawn(command, args, options) {
      const promptPath = args[args.indexOf("--system-prompt-file") + 1];
      systemPromptContents = fsSync.readFileSync(promptPath, "utf8");
      systemPromptMode = fsSync.statSync(promptPath).mode & 0o777;
      const child = fakeChild();
      child.stdin.on("data", (chunk) => (stdin += chunk.toString()));
      calls.push({ command, args, options });
      return child;
    },
  });

  const result = await runner.process({
    requestId: "request-1",
    adapter: "claude-cli",
    model: "haiku",
    executablePath: "/opt/claude",
    systemPrompt: "clean this transcript",
    userPrompt: "secret transcript; $(touch /tmp/nope)",
  });

  assert.equal(result.text, "cleaned text");
  assert.equal(calls[0].command, "/opt/claude");
  const systemPromptPath =
    calls[0].args[calls[0].args.indexOf("--system-prompt-file") + 1];
  assert.deepEqual(calls[0].args, [
    "-p",
    "--model",
    "haiku",
    "--system-prompt-file",
    systemPromptPath,
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--output-format",
    "text",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, process.platform !== "win32");
  assert.notEqual(calls[0].options.cwd, process.cwd());
  assert.equal(calls[0].args.includes("clean this transcript"), false);
  assert.equal(calls[0].args.includes("secret transcript; $(touch /tmp/nope)"), false);
  assert.equal(stdin, "secret transcript; $(touch /tmp/nope)");
  assert.equal(systemPromptContents, "clean this transcript");
  assert.equal(systemPromptMode, 0o600);
  await assert.rejects(fs.access(systemPromptPath));
});

test("Devin uses a 0600 prompt file and removes all temporary data", async () => {
  let promptPath;
  let promptContents;
  let promptMode;
  let cwd;
  const runner = new AgentCliRunner({
    spawn(command, args, options) {
      assert.equal(command, "devin");
      assert.deepEqual(args.slice(0, 6), [
        "-p",
        "--model",
        "swe",
        "--permission-mode",
        "auto",
        "--prompt-file",
      ]);
      promptPath = args[args.indexOf("--prompt-file") + 1];
      cwd = options.cwd;
      const child = new EventEmitter();
      child.pid = 4343;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(async () => {
        promptContents = await fs.readFile(promptPath, "utf8");
        promptMode = (await fs.stat(promptPath)).mode & 0o777;
        child.stdout.end(" devin result \n");
        child.stderr.end("");
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  const result = await runner.process({
    requestId: "devin-1",
    adapter: "devin-cli",
    systemPrompt: "SYSTEM",
    userPrompt: "PRIVATE TRANSCRIPT",
  });

  assert.equal(result.text, "devin result");
  assert.equal(promptContents, "SYSTEM\n\nPRIVATE TRANSCRIPT");
  assert.equal(promptMode, 0o600);
  await assert.rejects(fs.access(promptPath));
  await assert.rejects(fs.access(cwd));
});

test("maps ENOENT, auth exits, other exits, and empty output to structured codes", async (t) => {
  const cases = [
    {
      name: "missing executable",
      drive(child) {
        const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        child.emit("error", error);
      },
      code: "NOT_FOUND",
    },
    {
      name: "authentication failure",
      drive(child) {
        child.stderr.end("Please login to continue");
        child.emit("close", 1, null);
      },
      code: "AUTH_FAILED",
    },
    {
      name: "nonzero exit",
      drive(child) {
        child.stderr.end("ordinary failure");
        child.emit("close", 2, null);
      },
      code: "PROCESS_EXIT",
    },
    {
      name: "empty output",
      drive(child) {
        child.stdout.end(" \n");
        child.emit("close", 0, null);
      },
      code: "EMPTY_OUTPUT",
    },
    {
      name: "insufficient credits",
      drive(child) {
        child.stdout.end("Credit balance is too low");
        child.emit("close", 1, null);
      },
      code: "BILLING_REQUIRED",
    },
    {
      name: "unavailable model",
      drive(child) {
        child.stderr.end("Error: /upgrade to access this model");
        child.emit("close", 1, null);
      },
      code: "MODEL_UNAVAILABLE",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const runner = new AgentCliRunner({
        spawn() {
          const child = controllableChild();
          queueMicrotask(() => item.drive(child));
          return child;
        },
      });
      await assert.rejects(
        runner.process({
          requestId: item.name,
          adapter: "claude-cli",
          systemPrompt: "system",
          userPrompt: "private",
        }),
        (error) => error.code === item.code
      );
    });
  }
});

test("times out with SIGTERM then SIGKILL and supports explicit cancellation", async () => {
  const signals = [];
  let nextPid = 6000;
  const runner = new AgentCliRunner({
    timeoutMs: 10,
    killGraceMs: 5,
    killProcess(pid, signal) {
      signals.push([pid, signal]);
    },
    spawn() {
      return controllableChild(nextPid++);
    },
  });

  await assert.rejects(
    runner.process({
      requestId: "timeout",
      adapter: "claude-cli",
      systemPrompt: "system",
      userPrompt: "private",
    }),
    (error) => error.code === "TIMEOUT"
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(signals.slice(0, 2), [
    [-6000, "SIGTERM"],
    [-6000, "SIGKILL"],
  ]);

  const pending = runner.process({
    requestId: "cancel",
    adapter: "claude-cli",
    systemPrompt: "system",
    userPrompt: "private",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.cancel("cancel"), true);
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
});

test("Windows cancellation terminates the full child process tree even when the root exits", async () => {
  const child = controllableChild(6060);
  const childSignals = [];
  const treeKills = [];
  child.kill = (signal) => {
    childSignals.push(signal);
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  const runner = new AgentCliRunner({
    platform: "win32",
    timeoutMs: 10,
    killGraceMs: 5,
    spawn: () => child,
    spawnTreeKiller(command, args, options) {
      treeKills.push({ command, args, options });
      const killer = controllableChild(9000);
      killer.unref = () => {};
      queueMicrotask(() => killer.emit("close", 0, null));
      return killer;
    },
  });

  await assert.rejects(
    runner.process({
      requestId: "windows-timeout",
      adapter: "claude-cli",
      systemPrompt: "system",
      userPrompt: "private",
    }),
    (error) => error.code === "TIMEOUT"
  );
  assert.deepEqual(childSignals, []);
  assert.deepEqual(treeKills, [
    {
      command: "taskkill",
      args: ["/PID", "6060", "/T", "/F"],
      options: { shell: false, windowsHide: true, stdio: "ignore" },
    },
  ]);
});

test("cancellation waits for process-group escalation even when the root exits", async () => {
  const child = controllableChild(6061);
  const signals = [];
  const runner = new AgentCliRunner({
    timeoutMs: 5_000,
    killGraceMs: 20,
    spawn: () => child,
    killProcess(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", null, signal));
    },
  });
  const pending = runner.process({
    requestId: "wait-for-tree",
    adapter: "claude-cli",
    systemPrompt: "system",
    userPrompt: "private",
  });
  const rejected = assert.rejects(pending, (error) => error.code === "CANCELLED");
  await waitFor(() => runner.active.has("wait-for-tree"));
  runner.cancel("wait-for-tree");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(signals, [[-6061, "SIGTERM"]]);
  await rejected;
  assert.deepEqual(signals, [
    [-6061, "SIGTERM"],
    [-6061, "SIGKILL"],
  ]);
});

test("temp cleanup failure cannot replace a cancellation error", async () => {
  const child = controllableChild(6062);
  let cleanupAttempts = 0;
  const runner = new AgentCliRunner({
    killGraceMs: 1,
    spawn: () => child,
    killProcess() {},
    async removeTempDir() {
      cleanupAttempts += 1;
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
  });
  const pending = runner.process({
    requestId: "cleanup-primary-error",
    adapter: "claude-cli",
    systemPrompt: "system",
    userPrompt: "private",
  });
  const rejected = assert.rejects(pending, (error) => error.code === "CANCELLED");
  await waitFor(() => runner.active.has("cleanup-primary-error"));
  runner.cancel("cleanup-primary-error");
  await rejected;
  assert.equal(cleanupAttempts, 1);
});

test("caps output, isolates concurrent requests, and killAll cancels every request", async () => {
  const children = new Map();
  let pid = 7000;
  const runner = new AgentCliRunner({
    outputLimit: 8,
    killProcess() {},
    spawn(_command, _args) {
      const child = controllableChild(pid++);
      children.set(child.pid, child);
      return child;
    },
  });

  const tooLarge = runner.process({
    requestId: "large",
    adapter: "claude-cli",
    systemPrompt: "system",
    userPrompt: "private",
  });
  await waitFor(() => children.has(7000));
  children.get(7000).stdout.write("123456789");
  await assert.rejects(tooLarge, (error) => error.code === "OUTPUT_LIMIT");

  const first = runner.process({
    requestId: "first",
    adapter: "claude-cli",
    systemPrompt: "system",
    userPrompt: "one",
  });
  const second = runner.process({
    requestId: "second",
    adapter: "claude-cli",
    systemPrompt: "system",
    userPrompt: "two",
  });
  await waitFor(() => children.has(7002));
  children.get(7002).stdout.end("second");
  children.get(7002).emit("close", 0, null);
  children.get(7001).stdout.end("first");
  children.get(7001).emit("close", 0, null);
  assert.deepEqual(await Promise.all([first, second]), [
    { requestId: "first", text: "first" },
    { requestId: "second", text: "second" },
  ]);

  const a = runner.process({
    requestId: "a",
    adapter: "claude-cli",
    systemPrompt: "system",
    userPrompt: "a",
  });
  const b = runner.process({
    requestId: "b",
    adapter: "claude-cli",
    systemPrompt: "system",
    userPrompt: "b",
  });
  const cancelledA = assert.rejects(a, (error) => error.code === "CANCELLED");
  const cancelledB = assert.rejects(b, (error) => error.code === "CANCELLED");
  await waitFor(() => runner.active.size === 2);
  runner.killAll();
  await Promise.all([cancelledA, cancelledB]);
});

test("availability timeout waits for process-tree termination before temp cleanup", async () => {
  const child = controllableChild(8080);
  const signals = [];
  let cleanupSignals;
  const runner = new AgentCliRunner({
    availabilityTimeoutMs: 5,
    killGraceMs: 10,
    spawn: () => child,
    killProcess(pid, signal) {
      signals.push([pid, signal]);
    },
    async removeTempDir() {
      cleanupSignals = [...signals];
    },
  });

  assert.deepEqual(await runner.checkAvailability({ adapter: "claude-cli" }), {
    available: false,
    adapter: "claude-cli",
    code: "TIMEOUT",
  });
  assert.deepEqual(signals, [
    [-8080, "SIGTERM"],
    [-8080, "SIGKILL"],
  ]);
  assert.deepEqual(cleanupSignals, signals);
});

test("checks only the selected adapter and supports an absolute fake executable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-fake-"));
  const executable = path.join(dir, "fake-claude");
  await fs.writeFile(
    executable,
    '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi\ncat >/dev/null\necho fake-cleanup\n',
    { mode: 0o700 }
  );
  try {
    const runner = new AgentCliRunner();
    assert.deepEqual(
      await runner.checkAvailability({ adapter: "claude-cli", executablePath: executable }),
      { available: true, adapter: "claude-cli" }
    );
    assert.deepEqual(
      await runner.checkAvailability({
        adapter: "devin-cli",
        executablePath: path.join(dir, "missing-devin"),
      }),
      { available: false, adapter: "devin-cli", code: "NOT_FOUND" }
    );
    const result = await runner.process({
      requestId: "real-fake",
      adapter: "claude-cli",
      executablePath: executable,
      systemPrompt: "system",
      userPrompt: "private",
    });
    assert.equal(result.text, "fake-cleanup");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("cancels a request before its child has spawned", async () => {
  let spawned = false;
  const runner = new AgentCliRunner({
    spawn() {
      spawned = true;
      return controllableChild();
    },
  });
  const pending = runner.process({
    requestId: "immediate-cancel",
    adapter: "devin-cli",
    systemPrompt: "system",
    userPrompt: "private",
  });
  assert.equal(runner.cancel("immediate-cancel"), true);
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
  assert.equal(spawned, false);
});
