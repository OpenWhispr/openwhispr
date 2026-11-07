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
      return Promise.resolve(payload.texts ? { queued: payload.texts.length } : {});
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
  if (request === "../models/registryData.js") {
    const parakeetModels = {
      "parakeet-tdt-0.6b-v3": { supportedLanguages: ["en", "es", "fr", "de"] },
      "parakeet-unified-en-0.6b": { supportedLanguages: ["en"] },
    };
    return {
      registryData: { parakeetModels, whisperModels: { base: {}, turbo: {} } },
      listRunnableLocalModels: (section) =>
        Object.entries(section === "parakeetModels" ? parakeetModels : {}),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { registerVoiceConversationIpc } = require("../../src/helpers/voiceConversationIpc");
Module._load = originalLoad;

const startedServers = [];
const transcriptions = [];
const whisperTranscriptions = [];
const downloadedParakeet = new Set(["parakeet-tdt-0.6b-v3", "parakeet-unified-en-0.6b"]);
const downloadedWhisper = new Set(["base"]);
let callWindow = null;
const voiceConversation = registerVoiceConversationIpc({
  parakeetManager: {
    isModelDownloaded: (name) => downloadedParakeet.has(name),
    startServer: async (model) => void startedServers.push(model),
    transcribeLocalParakeet: (_wav, options) =>
      new Promise((resolve) => transcriptions.push({ resolve, options })),
  },
  whisperManager: {
    isModelDownloaded: (name) => downloadedWhisper.has(name),
    startServer: async (model) => void startedServers.push(`whisper:${model}`),
    transcribeLocalWhisper: (_wav, options) =>
      new Promise((resolve) => whisperTranscriptions.push({ resolve, options })),
  },
  isFromCallWindow: (event) => event.sender === callWindow,
});

function fakeRenderer() {
  const webContents = new EventEmitter();
  webContents.sent = [];
  webContents.isDestroyed = () => false;
  webContents.send = (channel, payload) => webContents.sent.push({ channel, payload });
  return webContents;
}

const start = (webContents, options = { language: "en" }) => {
  callWindow = webContents;
  return handlers.get("voice-conversation:start")({ sender: webContents }, options);
};
const stop = (sessionId) =>
  handlers.get("voice-conversation:stop")({ sender: callWindow }, sessionId);

async function startSession(options) {
  const webContents = fakeRenderer();
  const started = start(webContents, options);
  voiceWorker.configure?.resolve();
  await started;
  return webContents;
}

// Whether the session still takes the window's mic frames.
function hearsMic(webContents) {
  const before = voiceWorker.notified.length;
  listeners.get("voice-conversation:mic")({ sender: webContents }, new Float32Array(4));
  return voiceWorker.notified.slice(before).some(({ method }) => method === "vad-feed");
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const speak = () => voiceWorker.emit("speech-segment", { samples: new Float32Array(1600) });
const sentOfType = (webContents, type) =>
  webContents.sent.map(({ payload }) => payload).filter((payload) => payload.type === type);

test.beforeEach(() => {
  startedServers.length = 0;
  transcriptions.length = 0;
  whisperTranscriptions.length = 0;
  voiceWorker.notified.length = 0;
  voiceWorker.running = false;
});

test("a worker crash ends the session in main and tells the renderer", async () => {
  const webContents = await startSession();
  assert.equal(hearsMic(webContents), true);
  voiceWorker.running = false;
  voiceWorker.emit("exit", { code: 134 });

  assert.equal(webContents.sent.at(-1).payload.stage, "worker");
  // Mic frames no longer reach a worker that isn't there.
  assert.equal(hearsMic(webContents), false);
});

test("a renderer reload or crash ends the session it left behind", async () => {
  for (const event of ["did-navigate", "render-process-gone", "destroyed"]) {
    const webContents = await startSession();
    webContents.emit(event);
    assert.equal(hearsMic(webContents), false, event);
    // Ending it again (a late stop) changes nothing.
    assert.deepEqual(await stop(), { stopped: false }, event);
  }
});

test("only the call window can start a session", async () => {
  callWindow = fakeRenderer();
  await assert.rejects(
    handlers.get("voice-conversation:start")({ sender: fakeRenderer() }, { language: "en" }),
    /not-call-window/
  );
});

test("a stop during the worker load wins", async () => {
  const webContents = fakeRenderer();
  const started = start(webContents);
  await stop();
  voiceWorker.configure.resolve();
  await started;

  assert.equal(hearsMic(webContents), false);
  assert.deepEqual(startedServers, [], "a cancelled start doesn't warm the speech model");
});

test("a late stop naming an earlier session leaves the current one running", async () => {
  await startSession();
  await stop();
  const webContents = fakeRenderer();
  const { sessionId } = await start(webContents);

  assert.deepEqual(await stop(sessionId - 1), { stopped: false });
  assert.equal(hearsMic(webContents), true);
  assert.deepEqual(await stop(sessionId), { stopped: true });
  assert.equal(hearsMic(webContents), false);
});

test("a worker that fails to load ends the session", async () => {
  voiceWorker.running = false;
  const webContents = fakeRenderer();
  const started = start(webContents);
  voiceWorker.configure.reject(new Error("load failed"));

  await assert.rejects(started, /load failed/);
  assert.equal(hearsMic(webContents), false);
});

test("our own shutdown on quit ends the session without an error", async () => {
  const webContents = await startSession();
  voiceWorker.emit("exit", { code: 0 });

  assert.equal(hearsMic(webContents), false);
  assert.deepEqual(sentOfType(webContents, "error"), []);
});

test("turns decode one at a time, and one that finishes after its session ended is dropped", async () => {
  const webContents = await startSession();
  speak();
  speak();
  await settle();
  assert.equal(transcriptions.length, 1, "the second turn waits for the first");

  transcriptions[0].resolve({ success: true, text: "first" });
  await settle();
  assert.deepEqual(
    sentOfType(webContents, "transcript").map(({ text }) => text),
    ["first"]
  );

  await stop();
  transcriptions[1].resolve({ success: true, text: "second" });
  await settle();
  assert.equal(sentOfType(webContents, "transcript").length, 1);
});

test("what a session hears is marked with that session", async () => {
  const webContents = await startSession();
  speak();
  await settle();
  transcriptions[0].resolve({ success: true, text: "hello" });
  await settle();

  const [transcript] = sentOfType(webContents, "transcript");
  assert.equal(typeof transcript.sessionId, "number");
});

test("only the call window can cancel speech", async () => {
  callWindow = fakeRenderer();
  const other = { sender: fakeRenderer() };
  assert.deepEqual(
    await handlers.get("voice-conversation:cancel-speech")(other, { utteranceId: "u1" }),
    { cancelled: false }
  );
});

test("a transcription that fails is reported, not sent as silence", async () => {
  const webContents = await startSession();
  speak();
  await settle();
  transcriptions[0].resolve({ success: false, error: "invalid_response" });
  await settle();

  assert.deepEqual(sentOfType(webContents, "transcript"), []);
  assert.equal(sentOfType(webContents, "error")[0].stage, "stt");
});

test("speech that transcribes to nothing is an empty transcript, not an error", async () => {
  const webContents = await startSession();
  speak();
  await settle();
  transcriptions[0].resolve({
    success: false,
    code: "NO_SPEECH_DETECTED",
    message: "No audio detected",
  });
  await settle();

  assert.deepEqual(sentOfType(webContents, "error"), []);
  assert.equal(sentOfType(webContents, "transcript")[0].text, "");
});

test("each call language is heard by a model that knows it", async () => {
  await startSession({ language: "es", preferredParakeet: "parakeet-unified-en-0.6b" });
  speak();
  await settle();
  assert.equal(transcriptions[0].options.model, "parakeet-tdt-0.6b-v3");
  await stop();

  // English keeps dictation's own model, so the shared server isn't swapped.
  await startSession({ language: "en", preferredParakeet: "parakeet-unified-en-0.6b" });
  speak();
  await settle();
  assert.equal(transcriptions[1].options.model, "parakeet-unified-en-0.6b");
  await stop();

  // No Parakeet model here knows Hindi: the downloaded Whisper model hears it.
  const webContents = await startSession({ language: "hi" });
  assert.deepEqual(startedServers.at(-1), "whisper:base");
  speak();
  await settle();
  assert.deepEqual(whisperTranscriptions[0].options, {
    model: "base",
    language: "hi",
    initialPrompt: "नमस्ते, आज क्या करना है?",
  });
  whisperTranscriptions[0].resolve({ success: true, text: "नमस्ते" });
  await settle();
  assert.equal(sentOfType(webContents, "transcript")[0].text, "नमस्ते");
  await stop();
});

test("a language no downloaded model knows is refused before the worker loads", async () => {
  downloadedWhisper.clear();
  try {
    callWindow = fakeRenderer();
    await assert.rejects(start(callWindow, { language: "hi" }), /speech-model-missing/);
    const languages = await handlers.get("voice-conversation:languages")(
      { sender: callWindow },
      {}
    );
    assert.deepEqual(
      Object.fromEntries(languages.map(({ language, engine }) => [language, engine])),
      { auto: "parakeet", en: "parakeet", hi: null, es: "parakeet", fr: "parakeet", de: "parakeet" }
    );
  } finally {
    downloadedWhisper.add("base");
  }
});

test("paused input never becomes a turn, and the pause resets turn detection", async () => {
  const webContents = fakeRenderer();
  const started = start(webContents);
  voiceWorker.configure?.resolve();
  const { sessionId } = await started;
  voiceWorker.notified.length = 0;
  const pause = (id, paused) =>
    handlers.get("voice-conversation:pause-input")({ sender: webContents }, id, paused);

  assert.equal(await pause(sessionId - 1, true), false, "a pause names its session");
  assert.equal(await pause(sessionId, true), true);
  assert.deepEqual(voiceWorker.notified, [{ method: "vad-reset", payload: {} }]);
  assert.equal(hearsMic(webContents), false);
  speak();
  await settle();
  assert.equal(transcriptions.length, 0, "a turn the VAD had already cut is dropped too");

  await pause(sessionId, false);
  assert.equal(hearsMic(webContents), true);
  await stop();
});

test("a meeting recording that starts ends the voice session and tells the renderer why", async () => {
  const webContents = await startSession();

  voiceConversation.endSessionForMeeting();

  assert.equal(hearsMic(webContents), false);
  assert.deepEqual(sentOfType(webContents, "ended"), [{ type: "ended", reason: "meeting" }]);
  // With no session running it does nothing.
  voiceConversation.endSessionForMeeting();
  assert.equal(sentOfType(webContents, "ended").length, 1);
});

test("readiness checks the BYOK provider's API key in the main process", async () => {
  callWindow = fakeRenderer();
  const readiness = (provider) =>
    handlers.get("voice-conversation:get-readiness")(
      { sender: callWindow },
      { language: "en", brain: { mode: "providers", model: "m", provider } }
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

test("speech is spoken with the voice, rate and language the renderer chose", async () => {
  const webContents = await startSession();
  voiceWorker.requests.length = 0;
  await handlers.get("voice-conversation:speak")(
    { sender: webContents },
    {
      utteranceId: "u",
      chunkIndex: 0,
      text: "Hola.",
      profile: { voice: "aurora", speed: 1.3, language: "es" },
    }
  );
  assert.deepEqual(voiceWorker.requests[0], {
    method: "speak",
    payload: {
      utteranceId: "u",
      chunkIndex: 0,
      text: "Hola.",
      profile: { sid: 1, speed: 1.25, lang: "es" },
    },
  });
  await stop();
});

test("prepared speech only reaches a running session's worker, and only short lines", async () => {
  callWindow = fakeRenderer();
  const prepare = (webContents, texts) =>
    handlers.get("voice-conversation:prepare-speech")(
      { sender: webContents },
      { texts, profile: { voice: "helios", speed: 1, language: "en" } }
    );
  voiceWorker.requests.length = 0;
  assert.deepEqual(await prepare(callWindow, ["One moment."]), { queued: 0 }, "no session");

  const webContents = await startSession();
  await prepare(webContents, ["One moment.", 42, "x".repeat(500)]);

  assert.deepEqual(voiceWorker.requests, [
    {
      method: "prepare-speech",
      payload: { texts: ["One moment."], profile: { sid: 5, speed: 1, lang: "en" } },
    },
  ]);
  await stop();
});

test("a language changed mid-call is heard by a model that knows it from the next turn", async () => {
  const webContents = fakeRenderer();
  const started = start(webContents, { language: "en" });
  voiceWorker.configure?.resolve();
  const { sessionId } = await started;
  const setLanguage = (language) =>
    handlers.get("voice-conversation:set-language")({ sender: webContents }, sessionId, {
      language,
    });

  assert.equal(await setLanguage("hi"), true);
  speak();
  await settle();
  assert.deepEqual(whisperTranscriptions.at(-1).options, {
    model: "base",
    language: "hi",
    initialPrompt: "नमस्ते, आज क्या करना है?",
  });

  downloadedWhisper.clear();
  try {
    assert.equal(await setLanguage("hi"), false, "nothing here hears it: the old model stays");
  } finally {
    downloadedWhisper.add("base");
  }
  await stop();
});
