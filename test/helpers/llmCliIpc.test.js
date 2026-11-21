const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { registerLlmCliIpc } = require("../../src/helpers/llmCli/llmCliIpc");

const ROOT = path.join(__dirname, "..", "..");

function makeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}

function makeDetector(overrides = {}) {
  const listeners = new Set();
  return {
    onChange: (fn) => listeners.add(fn),
    emit: (seat, state) => listeners.forEach((fn) => fn(seat, state)),
    detectAll: async () => ({ codex: { status: "installed" } }),
    testSeat: async (seat) => ({ ok: true, seat }),
    ...overrides,
  };
}

function makeSender() {
  const sent = [];
  const listeners = new Map();
  return {
    sent,
    listeners,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
    on: (name, fn) => listeners.set(name, fn),
    once: (name, fn) => listeners.set(name, fn),
    removeListener: (name) => listeners.delete(name),
  };
}

test("stream channels are registered and relay parts then done", async () => {
  const ipcMain = makeIpcMain();
  const runner = {
    runStream: async ({ onPart }) => {
      onPart({ type: "text-delta", id: "1", delta: "hi" });
      return { ok: true, text: "hi" };
    },
  };
  registerLlmCliIpc({ ipcMain, runner, detector: makeDetector() });
  assert.ok(ipcMain.handlers.has("llm-cli-stream-start"));
  assert.ok(ipcMain.handlers.has("llm-cli-stream-cancel"));

  const sender = makeSender();
  const result = await ipcMain.handlers.get("llm-cli-stream-start")(
    { sender },
    { streamId: "s1", seat: "codex", prompt: "x" }
  );
  assert.deepEqual(result, { success: true });
  assert.deepEqual(
    sender.sent.map((m) => [m.channel, m.payload.streamId, m.payload.part?.type ?? m.payload.done]),
    [
      ["llm-cli-stream-part", "s1", "text-delta"],
      ["llm-cli-stream-part", "s1", true],
    ]
  );
});

test("a failed run sends a redacted error part", async () => {
  const ipcMain = makeIpcMain();
  const runner = {
    runStream: async () => ({
      ok: false,
      code: "exit-nonzero",
      message: "bad sk-ant-oat01-abcdefghij",
    }),
  };
  registerLlmCliIpc({ ipcMain, runner, detector: makeDetector() });
  const sender = makeSender();
  const result = await ipcMain.handlers.get("llm-cli-stream-start")(
    { sender },
    { streamId: "s2", seat: "grok", prompt: "x" }
  );
  assert.equal(result.success, false);
  assert.ok(!JSON.stringify(sender.sent).includes("abcdefghij"));
  assert.equal(sender.sent[0].payload.code, "exit-nonzero");
});

test("unknown seat, oversize payload and bad ids are rejected before the runner", async () => {
  const ipcMain = makeIpcMain();
  let called = 0;
  registerLlmCliIpc({
    ipcMain,
    detector: makeDetector(),
    runner: {
      runStream: async () => {
        called += 1;
        return { ok: true };
      },
    },
  });
  const start = ipcMain.handlers.get("llm-cli-stream-start");
  const sender = makeSender();
  for (const payload of [
    { streamId: "a", seat: "gemini", prompt: "x" },
    { streamId: "", seat: "codex", prompt: "x" },
    { streamId: "a", seat: "codex", prompt: "x".repeat(1100000) },
    { streamId: "a", seat: "codex", prompt: "x", modelId: { evil: true } },
    null,
  ]) {
    const result = await start({ sender }, payload);
    assert.equal(result.code, "invalid-input");
  }
  assert.equal(called, 0);
});

test("stream-cancel aborts the in-flight run", async () => {
  const ipcMain = makeIpcMain();
  let aborted = false;
  const runner = {
    runStream: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ ok: false, code: "killed", message: "cancelled" });
        });
      }),
  };
  registerLlmCliIpc({ ipcMain, runner, detector: makeDetector() });
  const sender = makeSender();
  const pending = ipcMain.handlers.get("llm-cli-stream-start")(
    { sender },
    { streamId: "s3", seat: "agy", prompt: "x" }
  );
  await ipcMain.handlers.get("llm-cli-stream-cancel")({}, "s3");
  const result = await pending;
  assert.equal(aborted, true);
  assert.equal(result.code, "killed");
});

function channelsIn(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return new Set(text.match(/"llm-cli-[a-z-]+"/g) || []);
}

test("preload and llmCliIpc.js agree on every llm-cli channel (invoke and event)", () => {
  const ipc = channelsIn("src/helpers/llmCli/llmCliIpc.js");
  const preload = channelsIn("preload.js");
  assert.ok(ipc.size > 0);
  assert.deepEqual([...preload].sort(), [...ipc].sort());
});

test("detect and test channels delegate to the detector and validate the seat", async () => {
  const ipcMain = makeIpcMain();
  const detector = makeDetector();
  const events = [];
  registerLlmCliIpc({
    ipcMain,
    runner: {},
    detector,
    emitEvent: (event) => events.push(event),
  });
  assert.deepEqual(await ipcMain.handlers.get("llm-cli-detect")({}), {
    codex: { status: "installed" },
  });
  assert.deepEqual(await ipcMain.handlers.get("llm-cli-test")({}, "agy"), {
    ok: true,
    seat: "agy",
  });
  assert.equal((await ipcMain.handlers.get("llm-cli-test")({}, "gemini")).code, "invalid-input");
  detector.emit("codex", { status: "signed-in" });
  assert.deepEqual(events, [{ type: "state", seat: "codex", state: { status: "signed-in" } }]);
});
