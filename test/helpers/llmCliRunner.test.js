const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const { createRunner } = require("../../src/helpers/llmCli/llmCliRunner");

const FAKE = path.join(__dirname, "..", "fixtures", "llm-cli", "fake-cli.js");
const CANARY_TOKEN = `sk-ant-oat01-${"A".repeat(110)}`;
const PLAIN_TOKEN = "plain-canary-token-value-0001";

function makeHarness({ mode, extraEnv = {}, token = null, timeouts = {} } = {}) {
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
