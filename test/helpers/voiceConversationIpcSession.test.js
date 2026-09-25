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
  }
  request(method) {
    assert.equal(method, "configure");
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
        pocket: { referenceVoiceWav: "/models/voice.wav" },
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
registerVoiceConversationIpc({
  parakeetManager: {
    isModelDownloaded: () => true,
    startServer: async (model) => void startedServers.push(model),
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

test.beforeEach(() => {
  activeChanges.length = 0;
  startedServers.length = 0;
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
  listeners.get("voice-conversation:mic")({}, new Float32Array(4));
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
