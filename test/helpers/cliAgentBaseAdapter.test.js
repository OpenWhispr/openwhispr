const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { BaseCliAdapter, CliAgentError } = require("../../src/helpers/cliAgent/baseCliAdapter");

class FakeChild extends EventEmitter {
  constructor({ pid } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.exitCode = null;
    if (pid !== undefined) this.pid = pid;
  }
  kill() {
    this.killed = true;
    this.emit("close", null, "SIGKILL");
  }
}

// Minimal concrete adapter: events pass through pre-normalized under `evt`.
class EchoAdapter extends BaseCliAdapter {
  get id() { return "echo"; }
  get binaryName() { return "echo-cli"; }
  buildArgs() { return ["--x"]; }
  mapEvent(json) { return json.evt || null; }
  isUnknownSessionError(stderr) { return stderr.includes("No conversation found"); }
}

function baseRequest(overrides = {}) {
  return {
    commandPath: "/bin/echo-cli",
    prompt: "hi",
    systemPrompt: "",
    model: "",
    permissionMode: "auto",
    cwd: "/tmp",
    timeoutMs: 5000,
    resumeSessionId: null,
    ...overrides,
  };
}

test("parses line-buffered json, emits stages, resolves on result", async () => {
  const adapter = new EchoAdapter();
  let child;
  const stages = [];
  const promise = adapter.run(baseRequest(), {
    onEvent: (e) => { if (e.type === "stage") stages.push(e.label); },
    spawnFn: (cmd, args, opts) => {
      assert.equal(cmd, "/bin/echo-cli");
      assert.deepEqual(args, ["--x"]);
      assert.equal(opts.cwd, "/tmp");
      child = new FakeChild();
      return child;
    },
  });
  // split a line across chunks to prove buffering
  child.stdout.emit("data", Buffer.from('{"evt":{"type":"init","sessionId":"s1"}}\n{"evt":{"type":"stage","la'));
  child.stdout.emit("data", Buffer.from('bel":{"kind":"command"}}}\n'));
  child.stdout.emit("data", Buffer.from('not json at all\n')); // skipped, not fatal
  child.stdout.emit(
    "data",
    Buffer.from('{"evt":{"type":"result","text":"done","isError":false,"permissionDenials":["Bash"]}}\n')
  );
  child.emit("close", 0);
  const res = await promise;
  assert.deepEqual(res, { text: "done", sessionId: "s1", permissionDenials: ["Bash"] });
  assert.deepEqual(stages, [{ kind: "command" }]);
});

test("rejects cli_error when result has isError", async () => {
  const adapter = new EchoAdapter();
  let child;
  const promise = adapter.run(baseRequest(), {
    spawnFn: () => (child = new FakeChild()),
  });
  child.stdout.emit("data", Buffer.from('{"evt":{"type":"result","text":"boom","isError":true,"permissionDenials":[]}}\n'));
  child.emit("close", 1);
  await assert.rejects(promise, (e) => e instanceof CliAgentError && e.code === "cli_error");
});

test("rejects no_result when process exits without a result event", async () => {
  const adapter = new EchoAdapter();
  let child;
  const promise = adapter.run(baseRequest(), { spawnFn: () => (child = new FakeChild()) });
  child.stderr.emit("data", Buffer.from("something broke"));
  child.emit("close", 1);
  await assert.rejects(promise, (e) => e.code === "no_result" && e.stderr.includes("something broke"));
});

test("watchdog kills the child and rejects with timeout", async () => {
  const adapter = new EchoAdapter();
  let child;
  const promise = adapter.run(baseRequest({ timeoutMs: 10 }), {
    spawnFn: () => (child = new FakeChild()),
  });
  await assert.rejects(promise, (e) => e.code === "timeout");
  assert.equal(child.killed, true);
});

test("abort signal kills the child and rejects with cancelled", async () => {
  const adapter = new EchoAdapter();
  const controller = new AbortController();
  let child;
  const promise = adapter.run(baseRequest(), {
    signal: controller.signal,
    spawnFn: () => (child = new FakeChild()),
  });
  controller.abort();
  await assert.rejects(promise, (e) => e.code === "cancelled");
  assert.equal(child.killed, true);
});

test("spawn error rejects with spawn code", async () => {
  const adapter = new EchoAdapter();
  let child;
  const promise = adapter.run(baseRequest(), { spawnFn: () => (child = new FakeChild()) });
  child.emit("error", new Error("ENOENT"));
  await assert.rejects(promise, (e) => e.code === "spawn");
});

test("spawn env excludes secrets but keeps normal vars, and sets platform-correct detached", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalNormal = process.env.OPENWHISPR_TEST_NORMAL_VAR;
  process.env.OPENAI_API_KEY = "sk-secret";
  process.env.OPENWHISPR_TEST_NORMAL_VAR = "keep-me";
  try {
    const adapter = new EchoAdapter();
    let child;
    let capturedOpts;
    const promise = adapter.run(baseRequest(), {
      spawnFn: (cmd, args, opts) => {
        capturedOpts = opts;
        child = new FakeChild();
        return child;
      },
    });
    child.stdout.emit(
      "data",
      Buffer.from('{"evt":{"type":"result","text":"done","isError":false,"permissionDenials":[]}}\n')
    );
    child.emit("close", 0);
    await promise;

    assert.equal(capturedOpts.env.OPENAI_API_KEY, undefined);
    assert.equal(capturedOpts.env.OPENWHISPR_TEST_NORMAL_VAR, "keep-me");
    assert.equal(capturedOpts.detached, process.platform !== "win32");
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalNormal === undefined) delete process.env.OPENWHISPR_TEST_NORMAL_VAR;
    else process.env.OPENWHISPR_TEST_NORMAL_VAR = originalNormal;
  }
});

test("watchdog kill falls back to direct kill when group signal fails", async () => {
  const adapter = new EchoAdapter();
  let child;
  // A pid whose process group doesn't exist: process.kill(-pid) throws,
  // exercising the fallback to child.kill().
  const promise = adapter.run(baseRequest({ timeoutMs: 10 }), {
    spawnFn: () => (child = new FakeChild({ pid: 2 ** 30 })),
  });
  await assert.rejects(promise, (e) => e.code === "timeout");
  assert.equal(child.killed, true);
});
