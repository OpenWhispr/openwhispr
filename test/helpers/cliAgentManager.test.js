const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// cliAgentManager requires ../debugLogger, which requires "electron" at load
// time; outside an Electron process that require hangs. Stub it out, matching
// the pattern used by other helper tests (e.g. audioActivityDetector.test.js).
const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "../debugLogger") {
    return { info() {}, warn() {}, debug() {}, error() {} };
  }
  return originalLoad.apply(this, arguments);
};

const { CliAgentManager, CLI_CHANNEL_PROMPT } = require("../../src/helpers/cliAgent/cliAgentManager");
const { CliAgentError } = require("../../src/helpers/cliAgent/baseCliAdapter");

Module._load = originalLoad;

function sessionFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-mgr-")), "sessions.json");
}

// Scriptable fake adapter: `script` is an array of functions run per call.
function makeFakeAdapter(script, calls) {
  return {
    id: "claude-code",
    binaryName: "claude",
    isUnknownSessionError: (s) => s.includes("No conversation found"),
    run(request, { onEvent, signal }) {
      calls.push({ request, signal });
      return script[calls.length - 1]({ request, onEvent, signal });
    },
  };
}

function makeManager({ script, calls, sendStage = () => {} }) {
  return new CliAgentManager({
    sessionFilePath: sessionFile(),
    sendStage,
    adapterFactories: { "claude-code": () => makeFakeAdapter(script, calls) },
    resolveBinary: async () => "/usr/local/bin/claude",
  });
}

const baseOpts = {
  cli: "claude-code",
  prompt: "do it",
  model: "",
  permissionMode: "auto",
  workingDir: "",
  timeoutSeconds: 240,
  sessionMinutes: 30,
  systemPrompt: "SCOPE",
  extraPrompt: "EXTRA",
};

test("happy path: composes system prompt, stores session, forwards stages", async () => {
  const calls = [];
  const stages = [];
  const mgr = makeManager({
    calls,
    sendStage: (l) => stages.push(l),
    script: [async ({ onEvent }) => {
      onEvent({ type: "stage", label: { kind: "command" } });
      return { text: "ok", sessionId: "s1", permissionDenials: [] };
    }],
  });
  const res = await mgr.run(baseOpts);
  assert.equal(res.text, "ok");
  assert.deepEqual(stages, [{ kind: "thinking" }, { kind: "command" }]);
  const reqSys = calls[0].request.systemPrompt;
  assert.ok(reqSys.startsWith("SCOPE"));
  assert.ok(reqSys.includes(CLI_CHANNEL_PROMPT));
  assert.ok(reqSys.endsWith("EXTRA"));
  assert.equal(calls[0].request.cwd, os.homedir()); // empty workingDir → home
  assert.equal(calls[0].request.timeoutMs, 240_000);
});

test("negative timeoutSeconds clamps to the 240s default", async () => {
  const calls = [];
  const mgr = makeManager({
    calls,
    script: [async () => ({ text: "ok", sessionId: "s1", permissionDenials: [] })],
  });
  await mgr.run({ ...baseOpts, timeoutSeconds: -5 });
  assert.equal(calls[0].request.timeoutMs, 240_000);
});

test("second run reuses the stored session id", async () => {
  const calls = [];
  const mgr = makeManager({
    calls,
    script: [
      async () => ({ text: "a", sessionId: "s1", permissionDenials: [] }),
      async () => ({ text: "b", sessionId: "s1", permissionDenials: [] }),
    ],
  });
  await mgr.run(baseOpts);
  await mgr.run(baseOpts);
  assert.equal(calls[0].request.resumeSessionId, null);
  assert.equal(calls[1].request.resumeSessionId, "s1");
});

test("unknown-session failure clears the session and retries exactly once without resume", async () => {
  const calls = [];
  const mgr = makeManager({
    calls,
    script: [
      async () => ({ text: "a", sessionId: "stale", permissionDenials: [] }),
      async () => { throw new CliAgentError("bad", "no_result", "No conversation found"); },
      async () => ({ text: "recovered", sessionId: "s2", permissionDenials: [] }),
    ],
  });
  await mgr.run(baseOpts);
  const res = await mgr.run(baseOpts);
  assert.equal(res.text, "recovered");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].request.resumeSessionId, "stale");
  assert.equal(calls[2].request.resumeSessionId, null);
});

test("non-session failures are NOT retried", async () => {
  const calls = [];
  const mgr = makeManager({
    calls,
    script: [async () => { throw new CliAgentError("t", "timeout", ""); }],
  });
  await assert.rejects(mgr.run(baseOpts), (e) => e.code === "timeout");
  assert.equal(calls.length, 1);
});

test("starting a new run aborts the in-flight one", async () => {
  const calls = [];
  let firstSignal;
  const mgr = makeManager({
    calls,
    script: [
      ({ signal }) =>
        new Promise((_, rej) => {
          firstSignal = signal;
          // Mirror BaseCliAdapter's synchronous pre-check: if the signal is
          // already aborted by the time run() reaches us, don't wait for an
          // 'abort' event that already fired before we could listen for it.
          if (signal.aborted) return rej(new CliAgentError("c", "cancelled", ""));
          signal.addEventListener("abort", () => rej(new CliAgentError("c", "cancelled", "")));
        }),
      async () => ({ text: "second", sessionId: "s", permissionDenials: [] }),
    ],
  });
  const p1 = mgr.run(baseOpts).catch((e) => e);
  const res2 = await mgr.run(baseOpts);
  assert.equal(res2.text, "second");
  assert.equal(firstSignal.aborted, true);
  assert.equal((await p1).code, "cancelled");
});

test("run rejects with cli_not_found when binary missing", async () => {
  const mgr = new CliAgentManager({
    sessionFilePath: sessionFile(),
    sendStage: () => {},
    adapterFactories: {
      "claude-code": () => ({
        binaryName: "claude",
        run: () => { throw new Error("adapter.run must not be called when binary is missing"); },
      }),
    },
    resolveBinary: async () => null,
  });
  await assert.rejects(mgr.run(baseOpts), (e) => e.code === "cli_not_found");
  assert.deepEqual(await mgr.check("claude-code"), { available: false, path: null });
});
