const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const { createRunner, defaultKillTree } = require("../../src/helpers/llmCli/llmCliRunner");

const FAKE = path.join(__dirname, "..", "fixtures", "llm-cli", "fake-cli.js");
const CANARY_TOKEN = `sk-ant-oat01-${"A".repeat(110)}`;
const PLAIN_TOKEN = "plain-canary-token-value-0001";

function makeHarness({ mode, extraEnv = {}, token = null, timeouts = {}, killTree } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-cli-runner-"));
  const reportFile = path.join(tmpDir, "report.json");
  const children = [];
  const runner = createRunner({
    spawn: (...args) => {
      const child = childProcess.spawn(...args);
      children.push(child);
      return child;
    },
    tmpDir: path.join(tmpDir, "runs"),
    env: {
      ...process.env,
      FAKE_CLI_MODE: mode,
      FAKE_CLI_REPORT: reportFile,
      FAKE_CLI_CANARY: PLAIN_TOKEN,
      ...extraEnv,
    },
    resolveExe: async () => ({ exe: process.execPath, args: [FAKE] }),
    getClaudeToken: async () => token,
    timeouts,
    ...(killTree ? { killTree } : {}),
  });
  const report = () => JSON.parse(fs.readFileSync(reportFile, "utf8"));
  return { runner, children, report, tmpDir };
}

async function waitGone(child) {
  if (child.exitCode !== null || child.signalCode) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test("codex run streams text-delta then finish; prompt on stdin, never in argv", async () => {
  const h = makeHarness({ mode: "codex-ok" });
  const parts = [];
  const prompt = "Reply with the single word OK";
  const result = await h.runner.runStream({ seat: "codex", prompt, onPart: (p) => parts.push(p) });
  assert.equal(result.ok, true);
  assert.deepEqual(
    parts.map((p) => p.type),
    ["text-start", "text-delta", "text-end", "finish"]
  );
  assert.equal(parts[1].delta, "OK");
  assert.equal(parts[3].finishReason.unified, "stop");
  const r = h.report();
  assert.equal(r.stdin, prompt);
  assert.ok(!r.argv.join(" ").includes(prompt));
  assert.ok(r.argv.includes("--sandbox") && r.argv.includes("read-only"));
  // Private per-run cwd, removed afterwards.
  assert.notEqual(path.resolve(r.cwd), path.resolve(process.cwd()));
  assert.ok(!fs.existsSync(r.cwd));
});

test("claude run streams deltas, carries the token only in env", async () => {
  const h = makeHarness({ mode: "claude-stream", token: CANARY_TOKEN });
  const parts = [];
  const result = await h.runner.runStream({
    seat: "claude",
    prompt: "hi",
    onPart: (p) => parts.push(p),
  });
  assert.equal(result.ok, true);
  assert.ok(parts.some((p) => p.type === "text-delta"));
  assert.equal(parts[parts.length - 1].type, "finish");
  const r = h.report();
  assert.equal(r.hasOauthEnv, true);
  assert.equal(r.argvHasCanary, false);
  assert.ok(!r.argv.join(" ").includes(CANARY_TOKEN));
  assert.equal(r.stdin, "hi");
});

test("claude without a stored token is not-signed-in and nothing is spawned", async () => {
  const h = makeHarness({ mode: "claude-stream", token: null });
  const result = await h.runner.runStream({ seat: "claude", prompt: "hi" });
  assert.equal(result.code, "not-signed-in");
  assert.equal(h.children.length, 0);
});

test("grok reads a prompt file, agy takes the prompt in argv; both parse JSON", async () => {
  const grok = makeHarness({ mode: "grok-json" });
  const g = await grok.runner.runStream({ seat: "grok", prompt: "grok prompt text" });
  assert.equal(g.ok, true, JSON.stringify(g));
  const gr = grok.report();
  assert.equal(gr.promptFileContent, "grok prompt text");
  assert.ok(!gr.argv.join(" ").includes("grok prompt text"));
  // The spawned grok must not import the user's Claude/Cursor MCP servers and hooks.
  for (const key of [
    "GROK_CLAUDE_MCPS_ENABLED",
    "GROK_CURSOR_MCPS_ENABLED",
    "GROK_CLAUDE_HOOKS_ENABLED",
  ]) {
    assert.ok(gr.envKeys.includes(key), key);
  }

  const agy = makeHarness({ mode: "agy-json" });
  const a = await agy.runner.runStream({ seat: "agy", prompt: "agy prompt text" });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.text.trim(), "OK");
});

test("a hung CLI is killed at the idle timeout with code timeout and the child is gone", async () => {
  const h = makeHarness({ mode: "hang", timeouts: { firstOutputMs: 400, idleMs: 400 } });
  const result = await h.runner.runStream({ seat: "codex", prompt: "hello" });
  assert.equal(result.code, "timeout");
  assert.equal(await waitGone(h.children[0]), true);
});

test("a killed run resolves only after the tree-kill is awaited and the run dir is gone", async () => {
  const events = [];
  const h = makeHarness({
    mode: "hang",
    timeouts: { firstOutputMs: 300, idleMs: 300 },
    killTree: async (child) => {
      events.push("kill-start");
      await new Promise((r) => setTimeout(r, 300));
      child.kill("SIGKILL");
      events.push("kill-done");
    },
  });
  const result = await h.runner.runStream({ seat: "codex", prompt: "hello" });
  events.push("resolved");
  assert.equal(result.code, "timeout");
  assert.deepEqual(events, ["kill-start", "kill-done", "resolved"]);
  assert.equal(h.children[0].exitCode !== null || h.children[0].signalCode !== null, true);
  assert.deepEqual(fs.readdirSync(path.join(h.tmpDir, "runs")), []);
});

test("cancel through the abort signal kills the child", async () => {
  const h = makeHarness({ mode: "hang" });
  const controller = new AbortController();
  const pending = h.runner.runStream({ seat: "codex", prompt: "hello", signal: controller.signal });
  await new Promise((r) => setTimeout(r, 400));
  controller.abort();
  const result = await pending;
  assert.equal(result.code, "killed");
  assert.equal(await waitGone(h.children[0]), true);
});

test("a second concurrent start for the same seat returns busy", async () => {
  const h = makeHarness({ mode: "hang" });
  const first = h.runner.runStream({ seat: "codex", prompt: "one" });
  await new Promise((r) => setTimeout(r, 300));
  const second = await h.runner.runStream({ seat: "codex", prompt: "two" });
  assert.equal(second.code, "busy");
  h.runner.cancel("codex");
  assert.equal((await first).code, "killed");
  assert.equal(await waitGone(h.children[0]), true);
});

test("stderr containing the token is redacted in the emitted error", async () => {
  const sk = makeHarness({ mode: "stderr-canary", extraEnv: { FAKE_CLI_CANARY: CANARY_TOKEN } });
  const a = await sk.runner.runStream({ seat: "codex", prompt: "x" });
  assert.equal(a.ok, false);
  assert.ok(!a.message.includes(CANARY_TOKEN), a.message);

  const plain = makeHarness({ mode: "stderr-canary", token: PLAIN_TOKEN });
  const b = await plain.runner.runStream({ seat: "claude", prompt: "x" });
  assert.equal(b.ok, false);
  assert.ok(!b.message.includes(PLAIN_TOKEN), b.message);
});

test("signed-out output classifies as not-signed-in; other failures as exit-nonzero", async () => {
  const out = makeHarness({ mode: "signed-out" });
  assert.equal((await out.runner.runStream({ seat: "codex", prompt: "x" })).code, "not-signed-in");
  const fail = makeHarness({ mode: "fail" });
  assert.equal((await fail.runner.runStream({ seat: "codex", prompt: "x" })).code, "exit-nonzero");
});

test("unknown seat and bad prompt are invalid-input", async () => {
  const h = makeHarness({ mode: "codex-ok" });
  assert.equal((await h.runner.runStream({ seat: "nope", prompt: "x" })).code, "invalid-input");
  assert.equal((await h.runner.runStream({ seat: "codex", prompt: "" })).code, "invalid-input");
});

test("win32 tree-kill awaits taskkill and never calls child.kill first", async () => {
  const { EventEmitter } = require("events");
  const calls = [];
  const killer = new EventEmitter();
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    setTimeout(() => killer.emit("exit", 0), 50);
    return killer;
  };
  const child = { pid: 4242, kill: () => calls.push(["child.kill"]) };
  const done = defaultKillTree(child, { platform: "win32", spawn });
  assert.deepEqual(calls, [["taskkill", "/T", "/F", "/PID", "4242"]]);
  await done;
  assert.deepEqual(calls, [["taskkill", "/T", "/F", "/PID", "4242"]]);
});

test("posix tree-kill signals the process group, then the child, and never runs taskkill", async () => {
  const { mock } = require("node:test");
  const killed = mock.method(process, "kill", () => true);
  try {
    const calls = [];
    const spawn = (cmd) => calls.push(["spawn", cmd]);
    const child = { pid: 5151, kill: (sig) => calls.push(["child.kill", sig]) };
    await defaultKillTree(child, { platform: "linux", spawn });
    assert.deepEqual(
      killed.mock.calls.map((c) => c.arguments),
      [[-5151, "SIGKILL"]]
    );
    assert.deepEqual(calls, [["child.kill", "SIGKILL"]]);
  } finally {
    killed.mock.restore();
  }
});

test("posix tree-kill tolerates an already-gone group (ESRCH)", async () => {
  const { mock } = require("node:test");
  const killed = mock.method(process, "kill", () => {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  });
  try {
    const child = {
      pid: 5152,
      kill: () => {
        throw new Error("already exited");
      },
    };
    await defaultKillTree(child, { platform: "linux" });
    assert.equal(killed.mock.calls.length, 1);
  } finally {
    killed.mock.restore();
  }
});

for (const [platform, detached] of [
  ["linux", true],
  ["darwin", true],
  ["win32", false],
]) {
  test(`runner spawns ${platform} children with detached=${detached} so the group kill can reach them`, async () => {
    const { EventEmitter } = require("events");
    const { PassThrough } = require("stream");
    const spawned = [];
    const runner = createRunner({
      spawn: (exe, args, opts) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.pid = 4244;
        spawned.push({ opts, child });
        return child;
      },
      platform,
      tmpDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-cli-runner-plat-")), "runs"),
      env: { ...process.env },
      resolveExe: async () => ({ exe: process.execPath, args: [] }),
      killTree: async (child) => child.emit("close", null),
      timeouts: { firstOutputMs: 300, idleMs: 300, totalMs: 600 },
    });
    const run = runner.runStream({ seat: "codex", prompt: "hi" });
    for (let i = 0; i < 100 && spawned.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(spawned[0].opts.detached, detached);
    assert.equal(spawned[0].opts.shell, false);
    runner.cancel("codex");
    assert.equal((await run).code, "killed");
  });
}

// ---- fake-child helpers: cancel during async resolve, multibyte output ----

function makeFakeSpawnHarness({ resolveExe, getClaudeToken } = {}) {
  const { EventEmitter } = require("events");
  const { PassThrough } = require("stream");
  const calls = [];
  const spawn = (...args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 4243;
    calls.push({ args, child });
    return child;
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-cli-runner-fake-"));
  const runner = createRunner({
    spawn,
    tmpDir: path.join(tmpDir, "runs"),
    env: { ...process.env },
    resolveExe: resolveExe || (async () => ({ exe: process.execPath, args: [] })),
    getClaudeToken: getClaudeToken || (async () => CANARY_TOKEN),
    killTree: async (child) => child.emit("close", null),
    timeouts: { firstOutputMs: 300, idleMs: 300, totalMs: 600 },
  });
  return { runner, calls };
}

// Writes `bytes` split at `at`, closes stdout, then emits close(0).
async function feedAndClose(child, bytes, at) {
  child.stdout.write(bytes.subarray(0, at));
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(bytes.subarray(at));
  child.stdout.end();
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0);
}

async function waitForSpawn(calls) {
  for (let i = 0; i < 100 && calls.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return calls[0];
}

for (const gated of ["resolveExe", "getClaudeToken"]) {
  for (const how of ["runner.cancel", "AbortSignal"]) {
    test(`a ${how} during async ${gated} spawns nothing and returns killed`, async () => {
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const opts =
        gated === "resolveExe"
          ? {
              resolveExe: async () => {
                await gate;
                return { exe: process.execPath, args: [] };
              },
            }
          : {
              getClaudeToken: async () => {
                await gate;
                return CANARY_TOKEN;
              },
            };
      const h = makeFakeSpawnHarness(opts);
      const controller = new AbortController();
      const run = h.runner.runStream({ seat: "claude", prompt: "hi", signal: controller.signal });
      if (how === "runner.cancel") h.runner.cancel("claude");
      else controller.abort();
      release();
      const result = await run;
      assert.equal(h.calls.length, 0, "spawned after a cancel");
      assert.equal(result.ok, false);
      assert.equal(result.code, "killed");
      assert.equal(h.runner.isBusy("claude"), false);
    });
  }
}

test("agy buffered stdout keeps a multibyte character split across chunks", async () => {
  const h = makeFakeSpawnHarness();
  const run = h.runner.runStream({ seat: "agy", prompt: "hi" });
  const spawned = await waitForSpawn(h.calls);
  const bytes = Buffer.from("café");
  await feedAndClose(spawned.child, bytes, bytes.indexOf(0xc3) + 1);
  const result = await run;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, "café");
});

test("claude streamed stdout keeps a multibyte character split across chunks", async () => {
  const h = makeFakeSpawnHarness();
  const parts = [];
  const run = h.runner.runStream({ seat: "claude", prompt: "hi", onPart: (p) => parts.push(p) });
  const spawned = await waitForSpawn(h.calls);
  const delta = {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "café" } },
  };
  const final = { type: "result", is_error: false, result: "café" };
  const bytes = Buffer.from(`${JSON.stringify(delta)}\n${JSON.stringify(final)}\n`);
  await feedAndClose(spawned.child, bytes, bytes.indexOf(0xc3) + 1);
  const result = await run;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, "café");
  assert.equal(parts.find((p) => p.type === "text-delta").delta, "café");
});

test("stderr keeps a multibyte character split across chunks (failure message)", async () => {
  const h = makeFakeSpawnHarness();
  const run = h.runner.runStream({ seat: "agy", prompt: "hi" });
  const spawned = await waitForSpawn(h.calls);
  const bytes = Buffer.from("boom café");
  spawned.child.stderr.write(bytes.subarray(0, bytes.indexOf(0xc3) + 1));
  await new Promise((resolve) => setImmediate(resolve));
  spawned.child.stderr.write(bytes.subarray(bytes.indexOf(0xc3) + 1));
  spawned.child.stdout.end();
  await new Promise((resolve) => setImmediate(resolve));
  spawned.child.emit("close", 2);
  const result = await run;
  assert.equal(result.ok, false);
  assert.ok(result.message.includes("café"), result.message);
});
