const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const handlers = new Map();
const listeners = new Map();

class FakeVoiceWorker extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.notified = [];
    this.configure = null;
    this.requests = [];
  }
  request(method, payload) {
    if (method !== "configure") {
      this.requests.push({ method, payload });
      return Promise.resolve({ queued: payload.texts.length });
    }
    return new Promise((resolve, reject) => {
      this.configure = {
        resolve: () => {
          this.running = true;
          resolve({ smartTurn: true, loadMs: 5, sampleRate: 24000 });
        },
        reject,
      };
    });
  }
  notify(method, payload) {
    this.notified.push({ method, payload });
  }
  stop() {
    return new Promise((resolve) => {
      this.stopping = () => {
        this.running = false;
        this.emit("exit", { code: 0 });
        resolve();
      };
    });
  }
}
const voiceWorker = new FakeVoiceWorker();

const originalLoad = Module._load;
Module._load = function loadVoiceIpcWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        on: (channel, listener) => listeners.set(channel, listener),
      },
    };
  }
  if (request === "./debugLogger") return { info() {}, warn() {}, error() {}, debug() {} };
  if (request === "./voiceWorkerClient") return voiceWorker;
  if (request === "./voiceModels") {
    return {
      getVoiceModelStatus: () => ({ ready: true }),
      getVoiceModelPaths: () => ({
        vad: "/models/silero_vad.onnx",
        smartTurn: "/models/smart-turn.onnx",
        supertonic: { voiceStyle: "/models/voice.bin" },
      }),
    };
  }
  if (request === "./downloadUtils") return { createDownloadSignal: () => ({}) };
  return originalLoad.call(this, request, parent, isMain);
};
const { registerVoiceConversationIpc } = require("../../src/helpers/voiceConversationIpc");
Module._load = originalLoad;

const activeChanges = [];
const startedServers = [];
const transcriptions = [];
const voiceConversation = registerVoiceConversationIpc({
  parakeetManager: {
    isModelDownloaded: () => true,
    startServer: async (model) => void startedServers.push(model),
    transcribeLocalParakeet: () => new Promise((resolve) => transcriptions.push(resolve)),
  },
  onSessionActiveChange: (active) => activeChanges.push(active),
});

function fakeRenderer() {
  const webContents = new EventEmitter();
  webContents.sent = [];
  webContents.isDestroyed = () => false;
  webContents.send = (channel, payload) => webContents.sent.push({ channel, payload });
  return webContents;
}

const start = (webContents) =>
  handlers.get("voice-conversation:start")({ sender: webContents }, { parakeetModel: "p" });
const stop = () => handlers.get("voice-conversation:stop")();

async function startSession() {
  const webContents = fakeRenderer();
  const started = start(webContents);
  voiceWorker.configure.resolve();
  await started;
  return webContents;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const speak = () => voiceWorker.emit("speech-segment", { samples: new Float32Array(1600) });
const sentOfType = (webContents, type) =>
  webContents.sent.map(({ payload }) => payload).filter((payload) => payload.type === type);

test.beforeEach(() => {
  activeChanges.length = 0;
  startedServers.length = 0;
  transcriptions.length = 0;
  voiceWorker.notified.length = 0;
  voiceWorker.running = false;
});

test("a worker crash ends the session in main and tells the renderer", async () => {
  const webContents = await startSession();
  voiceWorker.running = false;
  voiceWorker.emit("exit", { code: 134 });

  assert.deepEqual(activeChanges, [true, false]);
  assert.equal(webContents.sent.at(-1).payload.stage, "worker");
  // Mic frames no longer reach a worker that isn't there.
  listeners.get("voice-conversation:mic")({ sender: webContents }, new Float32Array(4));
  assert.equal(
    voiceWorker.notified.some(({ method }) => method === "vad-feed"),
    false
  );
});

test("a renderer reload or crash ends the session it left behind", async () => {
  for (const event of ["did-navigate", "render-process-gone", "destroyed"]) {
    activeChanges.length = 0;
    const webContents = await startSession();
    webContents.emit(event);
    assert.deepEqual(activeChanges, [true, false], event);
    // Ending it again (a late stop) changes nothing.
    await stop();
    assert.deepEqual(activeChanges, [true, false], event);
  }
});

test("the session holds dictation off while the worker loads, and a stop then wins", async () => {
  const webContents = fakeRenderer();
  const started = start(webContents);
  assert.deepEqual(activeChanges, [true]);

  await stop();
  voiceWorker.configure.resolve();
  await started;

  assert.deepEqual(activeChanges, [true, false]);
  assert.deepEqual(startedServers, [], "a cancelled start doesn't warm the speech model");
});

test("a late stop naming an earlier session leaves the current one running", async () => {
  await startSession();
  await stop();
  const { sessionId } = await start(fakeRenderer());
  activeChanges.length = 0;

  const result = await handlers.get("voice-conversation:stop")({}, sessionId - 1);

  assert.deepEqual(result, { stopped: false });
  assert.deepEqual(activeChanges, []);
  await handlers.get("voice-conversation:stop")({}, sessionId);
  assert.deepEqual(activeChanges, [false]);
});

test("a worker that fails to load ends the session", async () => {
  const started = start(fakeRenderer());
  voiceWorker.configure.reject(new Error("load failed"));

  await assert.rejects(started, /load failed/);
  assert.deepEqual(activeChanges, [true, false]);
});

test("the harness brain override is ignored outside the harness", async () => {
  process.env.OPENWHISPR_VOICE_HARNESS_BRAIN = "qwen3.5-4b";
  try {
    assert.equal(await handlers.get("voice-conversation:brain-override")(), null);
  } finally {
    delete process.env.OPENWHISPR_VOICE_HARNESS_BRAIN;
  }
});

test("our own shutdown on quit ends the session without a crash toast", async () => {
  const webContents = await startSession();
  voiceWorker.emit("exit", { code: 0 });

  assert.deepEqual(activeChanges, [true, false]);
  assert.deepEqual(sentOfType(webContents, "error"), []);
});

test("turns decode one at a time, and one that finishes after its session ended is dropped", async () => {
  const webContents = await startSession();
  speak();
  speak();
  await settle();
  assert.equal(transcriptions.length, 1, "the second turn waits for the first");

  transcriptions[0]({ success: true, text: "first" });
  await settle();
  assert.deepEqual(
    sentOfType(webContents, "transcript").map(({ text }) => text),
    ["first"]
  );

  await stop();
  transcriptions[1]({ success: true, text: "second" });
  await settle();
  assert.equal(sentOfType(webContents, "transcript").length, 1);
});

test("a transcription that fails is reported, not sent as silence", async () => {
  const webContents = await startSession();
  speak();
  await settle();
  transcriptions[0]({ success: false, error: "invalid_response" });
  await settle();

  assert.deepEqual(sentOfType(webContents, "transcript"), []);
  assert.equal(sentOfType(webContents, "error")[0].stage, "stt");
});

test("speech that transcribes to nothing is an empty transcript, not an error", async () => {
  const webContents = await startSession();
  speak();
  await settle();
  transcriptions[0]({ success: false, code: "NO_SPEECH_DETECTED", message: "No audio detected" });
  await settle();

  assert.deepEqual(sentOfType(webContents, "error"), []);
  assert.equal(sentOfType(webContents, "transcript")[0].text, "");
});

test("a session starting while the idle worker shuts down waits for it, then loads a fresh one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await startSession();
  await stop();
  t.mock.timers.tick(5 * 60 * 1000);
  assert.ok(voiceWorker.stopping, "the idle worker is being stopped");
  activeChanges.length = 0;

  const started = start(fakeRenderer());
  await settle();
  assert.deepEqual(activeChanges, [], "the new session waits for the old worker to exit");

  voiceWorker.stopping();
  await settle();
  voiceWorker.configure.resolve();
  await started;
  assert.deepEqual(activeChanges, [true], "its exit doesn't end the new session");
});

test("a meeting recording that starts ends the voice session and tells the renderer why", async () => {
  const webContents = await startSession();

  voiceConversation.endSessionForMeeting();

  assert.deepEqual(activeChanges, [true, false]);
  assert.deepEqual(sentOfType(webContents, "ended"), [{ type: "ended", reason: "meeting" }]);
  // With no session running it does nothing.
  voiceConversation.endSessionForMeeting();
  assert.equal(sentOfType(webContents, "ended").length, 1);
});

test("readiness checks the BYOK provider's API key in the main process", async () => {
  const readiness = (provider) =>
    handlers.get("voice-conversation:get-readiness")(
      {},
      { parakeetModel: "p", language: "en", brain: { mode: "providers", model: "m", provider } }
    );
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal((await readiness("openai")).reason, "brain-key-missing");
    process.env.OPENAI_API_KEY = "sk-test";
    assert.deepEqual(await readiness("openai"), { ready: true });
    // Custom endpoints bring their own credentials; they aren't checked here.
    assert.deepEqual(await readiness("custom"), { ready: true });
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test("prepared speech only reaches a running session's worker, and only short lines", async () => {
  const prepare = (texts) => handlers.get("voice-conversation:prepare-speech")({}, texts);
  voiceWorker.requests.length = 0;
  assert.deepEqual(await prepare(["One moment."]), { queued: 0 }, "no session, no worker work");

  await startSession();
  await prepare(["One moment.", 42, "x".repeat(500)]);

  assert.deepEqual(voiceWorker.requests, [
    { method: "prepare-speech", payload: { texts: ["One moment."] } },
  ]);
  await stop();
});
