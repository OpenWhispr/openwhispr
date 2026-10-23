const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Captures every ipcMain.handle registration and every net.fetch request so the
// registered handler closures can be invoked directly against a fake `this`.
const handlers = new Map();
const fetches = [];
let fetchResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: "transcribed" }),
  text: async () => JSON.stringify({ text: "transcribed" }),
});

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: {
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      return fetchResponse(String(url), init);
    },
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    // Cloud retries need a window to read auth from; a sender opts in with one.
    static fromWebContents(sender) {
      return sender?.window ?? null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: {
    fromPartition: () => ({
      webRequest: { onBeforeSendHeaders: () => {} },
      fetch: (url, init) => electronStub.net.fetch(url, init),
      closeAllConnections: async () => {},
    }),
  },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

// A 44-byte RIFF header is enough for isWavFormat, which only sniffs the magic.
const WAV_BUFFER = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(32),
]);
const CONVERTED_WAV = Buffer.concat([WAV_BUFFER, Buffer.from("converted")]);
// Just over the inline upload limit, so an OpenWhispr Cloud retry is chunked.
const CHUNKED_BUFFER = Buffer.alloc(4 * 1024 * 1024 + 1);
const CLOUD_CHUNKS = ["chunk-000.mp3", "chunk-001.mp3", "chunk-002.mp3", "chunk-003.mp3"];

// Conversion is mocked rather than run: spawning ffmpeg from a unit test would
// make it slow and dependent on the runner having a usable binary.
const wavConversions = [];
let convertBehavior = async () => CONVERTED_WAV;

const cortiCalls = [];
const tinfoilCalls = [];
const textUpdates = [];
const statusUpdates = [];
let parakeetBehavior = async () => ({ success: true, text: "local text" });
let whisperBehavior = async () => ({ success: true, text: "whisper text" });
let cortiBehavior = async () => ({ text: "corti text" });

// Kept installed for the whole file: the corti client is require()d lazily at
// handler invocation time, not at module load.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./cortiTranscription") {
      return {
        transcribeAudio: async (opts) => {
          cortiCalls.push(opts);
          return cortiBehavior(opts);
        },
      };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async (opts) => {
          tinfoilCalls.push(opts);
          return { text: "tinfoil text", model: "tinfoil-model" };
        },
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./workspacePolicyManager")
      return {
        ...originalLoad.call(this, request, parent, isMain),
        createWorkspacePolicyManager: () => ({
          getPolicy: async () => ({ success: true, managed: false }),
        }),
      };
    if (request === "./tokenStore") {
      return { ...originalLoad.call(this, request, parent, isMain), get: () => "test-token" };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
    if (request === "./ffmpegUtils") {
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        ...real,
        convertBufferToWav: async (buffer, options) => {
          wavConversions.push(buffer);
          return convertBehavior(buffer, options);
        },
        splitAudioFile: async (inputPath, chunkDir) => {
          const chunkPaths = CLOUD_CHUNKS.map((name) => path.join(chunkDir, name));
          for (const chunkPath of chunkPaths) fs.writeFileSync(chunkPath, "audio");
          return { chunkPaths, durationSeconds: 120 };
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by the retry handler can be an inert stub.
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const dbRows = new Map([
    [7, { id: 7, audio_duration_ms: 1200 }],
    [8, { id: 8, audio_duration_ms: 1200 }],
  ]);
  const target = {
    sessionId: "test-session",
    _uploadCancelRegistry:
      require("../../src/helpers/uploadCancelRegistry").createUploadCancelRegistry(),
    audioStorageManager: {
      // 7 is a stored WebM recording, 8 one already in WAV, 9 one too large to
      // upload inline.
      getAudioBuffer: (id) =>
        id === 7
          ? Buffer.from([1, 2, 3])
          : id === 8
            ? WAV_BUFFER
            : id === 9
              ? CHUNKED_BUFFER
              : null,
    },
    databaseManager: {
      updateTranscriptionText: (id, text) => textUpdates.push({ id, text }),
      updateTranscriptionStatus: (id, status) => statusUpdates.push({ id, status }),
      updateTranscriptionAudio: () => {},
      getTranscriptionById: (id) => dbRows.get(id),
    },
    parakeetManager: {
      transcribeLocalParakeet: (buffer, options) => parakeetBehavior(buffer, options),
    },
    whisperManager: {
      serverManager: { isAvailable: () => true },
      transcribeLocalWhisper: (buffer, options) => whisperBehavior(buffer, options),
    },
    _resolveWhisperVadOptions: () => ({}),
    environmentManager: {
      getOpenAIKey: () => "sk-openai",
      getGroqKey: () => "gk-groq",
      getMistralKey: () => "mk-mistral",
      getXaiKey: () => "xk-xai",
      getTinfoilKey: () => "tk-tinfoil",
      getCustomTranscriptionKey: () => "ck-custom",
      getCortiClientId: () => "corti-id",
      getCortiClientSecret: () => "corti-secret",
    },
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let retryHandler;
let fakeThis;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  fakeThis = buildFakeThis();
  Ctor.prototype.setupHandlers.call(fakeThis);
  retryHandler = handlers.get("retry-transcription");
  assert.ok(retryHandler, "retry-transcription must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

const invoke = (settings, id = 7) => retryHandler({ sender: {} }, id, settings);

test("retry: corti routes to the corti client, never OpenAI", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cortiEnvironment: "eu",
    cortiTenant: "acme",
    preferredLanguage: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(cortiCalls.length, 1);
  assert.equal(cortiCalls[0].environment, "eu");
  assert.equal(cortiCalls[0].tenant, "acme");
  assert.equal(cortiCalls[0].language, "en");
  assert.equal(fetches.length, 0, "corti retry must not touch HTTP endpoints");
});

test("retry: custom misconfiguration fails closed with a coded error", async () => {
  fetches.length = 0;
  for (const cloudTranscriptionBaseUrl of ["", "https://api.openai.com/v1", "not a url"]) {
    const result = await invoke({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cloudTranscriptionBaseUrl,
    });
    assert.equal(result.success, false, cloudTranscriptionBaseUrl);
    assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID", cloudTranscriptionBaseUrl);
  }
  assert.equal(fetches.length, 0);
});

test("retry: openwhispr cloud masks a leftover BYOK misconfiguration", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "openwhispr",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "",
  });
  // BrowserWindow.fromWebContents is stubbed to null, so the cloud branch
  // produces no result — but the route error must NOT surface.
  assert.equal(result.success, false);
  assert.notEqual(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.match(result.error, /No transcription engine available/);
  assert.equal(fetches.length, 0);
});

test("retry: Azure custom endpoints get deployment URLs and api-key auth", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://myres.openai.azure.com",
    cloudTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /myres\.openai\.azure\.com\/openai\/deployments\/my-deployment/);
  assert.equal(fetches[0].init.headers["api-key"], "ck-custom");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
});

test("retry: plain custom endpoints use Bearer auth at the configured URL", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
    cloudTranscriptionModel: "parasail-model",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].url, "https://stt.parasail.example.com/v1/audio/transcriptions");
  assert.equal(fetches[0].init.headers.Authorization, "Bearer ck-custom");
});

const CUSTOM_SETTINGS = {
  cloudTranscriptionProvider: "custom",
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
  cloudTranscriptionModel: "parasail-model",
};

const uploadedPart = () => fetches[0].init.body.get("file");

test("retry: a stored WebM is re-encoded before reaching a custom endpoint", async () => {
  // Without this the renderer-side fix covers fresh dictations only, and every
  // retry of a recording that failed for the container reason fails again.
  fetches.length = 0;
  wavConversions.length = 0;

  const result = await invoke(CUSTOM_SETTINGS);

  assert.equal(result.success, true);
  assert.equal(wavConversions.length, 1, "the stored container must be converted");
  const part = uploadedPart();
  assert.equal(part.name, "audio.wav");
  assert.equal(part.type, "audio/wav");
  assert.equal(part.size, CONVERTED_WAV.length, "the converted bytes are what gets uploaded");
});

test("retry: audio already in WAV is uploaded untouched", async () => {
  fetches.length = 0;
  wavConversions.length = 0;

  const result = await invoke(CUSTOM_SETTINGS, 8);

  assert.equal(result.success, true);
  assert.equal(wavConversions.length, 0, "re-encoding WAV would only cost time");
  assert.equal(uploadedPart().size, WAV_BUFFER.length);
});

test("retry: WAV expansion preserves uploads that fit the provider limit", async (t) => {
  for (const wavSize of [25 * 1024 * 1024, 25 * 1024 * 1024 + 1]) {
    await t.test(`${wavSize} converted bytes`, async () => {
      fetches.length = 0;
      const converted = Buffer.alloc(wavSize);
      WAV_BUFFER.copy(converted);
      convertBehavior = async () => converted;
      try {
        const result = await invoke(CUSTOM_SETTINGS);
        assert.equal(result.success, true);
        const part = uploadedPart();
        const fits = wavSize === 25 * 1024 * 1024;
        assert.equal(part.type, fits ? "audio/wav" : "audio/webm");
        assert.equal(part.name, fits ? "audio.wav" : "audio.webm");
        assert.deepEqual(
          Buffer.from(await part.arrayBuffer()),
          fits ? converted : Buffer.from([1, 2, 3])
        );
      } finally {
        convertBehavior = async () => CONVERTED_WAV;
      }
    });
  }
});

test("retry: built-in providers keep sending the stored container", async () => {
  fetches.length = 0;
  wavConversions.length = 0;

  await invoke({
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionModel: "whisper-1",
  });

  assert.equal(wavConversions.length, 0, "only custom endpoints need the re-encode");
  assert.equal(uploadedPart().name, "audio.webm");
});

test("retry: a conversion failure falls open to the stored container", async () => {
  fetches.length = 0;
  wavConversions.length = 0;
  convertBehavior = async () => {
    throw new Error("ffmpeg missing");
  };

  try {
    const result = await invoke(CUSTOM_SETTINGS);
    assert.equal(result.success, true, "a failed re-encode must not fail the retry");
    const part = uploadedPart();
    assert.equal(part.name, "audio.webm");
    assert.equal(part.type, "audio/webm");
  } finally {
    convertBehavior = async () => CONVERTED_WAV;
  }
});

test("retry: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
  assert.equal(tinfoilCalls.length, 0);
});

const PARAKEET_SETTINGS = {
  transcriptionMode: "local",
  useLocalWhisper: true,
  localTranscriptionProvider: "nvidia",
  parakeetModel: "parakeet-tdt-0.6b-v3",
};
const WHISPER_SETTINGS = {
  transcriptionMode: "local",
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
};

async function withLocalResult(behavior, settings, run) {
  const key = settings === WHISPER_SETTINGS ? "whisper" : "parakeet";
  const original = key === "whisper" ? whisperBehavior : parakeetBehavior;
  if (key === "whisper") whisperBehavior = behavior;
  else parakeetBehavior = behavior;
  textUpdates.length = 0;
  statusUpdates.length = 0;
  try {
    return await run(await invoke(settings));
  } finally {
    if (key === "whisper") whisperBehavior = original;
    else parakeetBehavior = original;
  }
}

test("retry: a clean local decode reports no warning", async () => {
  await withLocalResult(
    async () => ({ success: true, text: "local text" }),
    PARAKEET_SETTINGS,
    (result) => {
      assert.equal(result.success, true);
      assert.equal("warning" in result, false);
      assert.deepEqual(textUpdates, [{ id: 7, text: "local text" }]);
    }
  );
});

test("retry: a truncated Parakeet decode keeps its text and returns the warning", async () => {
  await withLocalResult(
    async () => ({ success: true, text: "first half", warning: "truncated" }),
    PARAKEET_SETTINGS,
    (result) => {
      assert.equal(result.success, true);
      assert.equal(result.warning, "truncated", "the renderer needs it for the partial toast");
      assert.deepEqual(textUpdates, [{ id: 7, text: "first half" }]);
      assert.deepEqual(statusUpdates, [{ id: 7, status: "completed" }]);
    }
  );
});

test("retry: an all-empty Parakeet decode reports the invalid response, not a missing engine", async () => {
  await withLocalResult(
    async () => ({
      success: false,
      error: "invalid_response",
      message: "Transcription engine returned an unexpected response",
    }),
    PARAKEET_SETTINGS,
    (result) => {
      assert.equal(result.success, false);
      assert.equal(result.code, "INVALID_RESPONSE");
      assert.equal(result.messageKey, "controlPanel.history.retryErrors.invalidResponse");
      assert.equal(result.error, "Transcription engine returned an unexpected response");
      assert.equal(textUpdates.length, 0, "a failed retry must leave the row alone");
      assert.equal(statusUpdates.length, 0);
    }
  );
});

test("retry: no speech from a local engine is reported as such", async (t) => {
  for (const [name, settings, failure] of [
    [
      "parakeet",
      PARAKEET_SETTINGS,
      { success: false, code: "NO_SPEECH_DETECTED", message: "No audio detected" },
    ],
    ["whisper", WHISPER_SETTINGS, { success: false, message: "No audio detected" }],
  ]) {
    await t.test(name, () =>
      withLocalResult(
        async () => failure,
        settings,
        (result) => {
          assert.equal(result.success, false);
          assert.equal(result.code, "NO_SPEECH_DETECTED");
          assert.equal(result.messageKey, "notes.upload.noSpeechDetected");
          assert.equal(textUpdates.length, 0);
        }
      )
    );
  }
});

test("retry: an unclassified local failure keeps the engine's own message", async () => {
  await withLocalResult(
    async () => ({ success: false, error: "decode_failed", message: "Decoder crashed" }),
    PARAKEET_SETTINGS,
    (result) => {
      assert.equal(result.success, false);
      assert.equal(result.error, "Decoder crashed");
      assert.equal(result.messageKey, undefined);
    }
  );
});

const CLOUD_SETTINGS = {
  transcriptionMode: "providers",
  cloudTranscriptionMode: "openwhispr",
  cloudTranscriptionProvider: "openai",
};

async function withCloudResponse(t, respond, id) {
  const originalFetchResponse = fetchResponse;
  const originalApiUrl = process.env.OPENWHISPR_API_URL;
  t.after(() => {
    fetchResponse = originalFetchResponse;
    if (originalApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = originalApiUrl;
  });
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  fetchResponse = (url, init) => {
    const { status, body } = respond(init);
    return { ok: status === 200, status, text: async () => JSON.stringify(body) };
  };
  textUpdates.length = 0;
  return retryHandler({ sender: { window: {} } }, id, CLOUD_SETTINGS);
}

test("retry: no speech from OpenWhispr Cloud is translated like a local engine's", async (t) => {
  const result = await withCloudResponse(
    t,
    () => ({
      status: 422,
      body: { code: "NO_SPEECH_DETECTED", error: "No speech detected in audio" },
    }),
    7
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "NO_SPEECH_DETECTED");
  assert.equal(result.messageKey, "notes.upload.noSpeechDetected");
  assert.equal(textUpdates.length, 0);
});

test("retry: an empty answer from a BYOK engine is no speech, not a missing engine", async (t) => {
  const originalFetchResponse = fetchResponse;
  const originalCortiBehavior = cortiBehavior;
  t.after(() => {
    fetchResponse = originalFetchResponse;
    cortiBehavior = originalCortiBehavior;
  });
  fetchResponse = () => ({ ok: true, status: 200, json: async () => ({ text: "" }) });
  cortiBehavior = async () => ({ text: "" });
  for (const [name, settings] of [
    ["custom", CUSTOM_SETTINGS],
    [
      "corti",
      {
        cloudTranscriptionProvider: "corti",
        cloudTranscriptionMode: "byok",
        transcriptionMode: "providers",
      },
    ],
  ]) {
    textUpdates.length = 0;
    const result = await invoke(settings);
    assert.equal(result.success, false, name);
    assert.equal(result.code, "NO_SPEECH_DETECTED", name);
    assert.equal(result.messageKey, "notes.upload.noSpeechDetected", name);
    assert.equal(textUpdates.length, 0, name);
  }
});

test("retry: a chunked cloud retry that lost a chunk saves the rest and returns the warning", async (t) => {
  const result = await withCloudResponse(
    t,
    (init) =>
      init.body.includes("chunk-001.mp3")
        ? { status: 400, body: { error: "Bad chunk" } }
        : { status: 200, body: { text: "part" } },
    9
  );
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.warning, "1 of 4 chunks failed");
  assert.equal(textUpdates.length, 1);
  assert.match(textUpdates[0].text, /part/);
});

test("retry: a clean chunked cloud retry reports no warning", async (t) => {
  const result = await withCloudResponse(t, () => ({ status: 200, body: { text: "part" } }), 9);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal("warning" in result, false);
});

test("retry: mistral goes to Mistral with x-api-key", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
});

test("retry: a missing BYOK key on the generic provider branch is a classified error", async () => {
  fetches.length = 0;
  const originalGetMistralKey = fakeThis.environmentManager.getMistralKey;
  fakeThis.environmentManager.getMistralKey = () => "";
  try {
    const result = await invoke({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
    });
    assert.equal(result.success, false);
    assert.equal(result.code, "API_KEY_MISSING");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.deepEqual(result.messageParams, { provider: "Mistral" });
    assert.equal(fetches.length, 0, "a missing key must fail before any request is sent");
  } finally {
    fakeThis.environmentManager.getMistralKey = originalGetMistralKey;
  }
});

test("retry: missing Corti credentials are a classified error", async () => {
  fetches.length = 0;
  const cortiCallsBefore = cortiCalls.length;
  const originalGetCortiClientId = fakeThis.environmentManager.getCortiClientId;
  fakeThis.environmentManager.getCortiClientId = () => "";
  try {
    const result = await invoke({
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "eu",
      cortiTenant: "acme",
    });
    assert.equal(result.success, false);
    assert.equal(result.code, "API_KEY_MISSING");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.deepEqual(result.messageParams, { provider: "Corti" });
    assert.equal(
      cortiCalls.length,
      cortiCallsBefore,
      "a missing credential must fail before calling Corti"
    );
  } finally {
    fakeThis.environmentManager.getCortiClientId = originalGetCortiClientId;
  }
});

test("proxy-corti-transcription: missing credentials are a classified error", async () => {
  const fn = handlers.get("proxy-corti-transcription");
  assert.ok(fn, "proxy-corti-transcription must be registered");
  const cortiCallsBefore = cortiCalls.length;
  const originalGetCortiClientId = fakeThis.environmentManager.getCortiClientId;
  fakeThis.environmentManager.getCortiClientId = () => "";
  try {
    const result = await fn({ sender: {} }, { audioBuffer: new ArrayBuffer(4) });
    assert.equal(result.code, "API_KEY_MISSING");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.deepEqual(result.messageParams, { provider: "Corti" });
    assert.equal(
      cortiCalls.length,
      cortiCallsBefore,
      "a missing credential must fail before calling Corti"
    );
  } finally {
    fakeThis.environmentManager.getCortiClientId = originalGetCortiClientId;
  }
});

test("proxy transcription handlers resolve to structured errors instead of rejecting", async () => {
  fetchResponse = () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
    json: async () => ({}),
  });
  cortiBehavior = async () => {
    const err = new Error("Corti API Error: 401");
    err.code = "INVALID_KEY";
    throw err;
  };
  try {
    for (const channel of [
      "proxy-mistral-transcription",
      "proxy-xai-transcription",
      "proxy-corti-transcription",
    ]) {
      const fn = handlers.get(channel);
      assert.ok(fn, `${channel} must be registered`);
      const result = await fn({ sender: {} }, { audioBuffer: new ArrayBuffer(4) });
      assert.equal(typeof result.error, "string", channel);
    }
  } finally {
    cortiBehavior = async () => ({ text: "corti text" });
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

const fsNode = require("node:fs");
const osNode = require("node:os");
const pathNode = require("node:path");

const uploadTempFile = pathNode.join(osNode.tmpdir(), "openwhispr-upload-handler-test.webm");

const invokeUpload = (payload) => {
  const uploadHandler = handlers.get("transcribe-audio-file-byok");
  assert.ok(uploadHandler, "transcribe-audio-file-byok must be registered");
  fsNode.writeFileSync(uploadTempFile, Buffer.from([1, 2, 3, 4]));
  return uploadHandler({ sender: {} }, { filePath: uploadTempFile, ...payload });
};

test("upload: mistral sends x-api-key with a provider-validated model and no language on auto", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "mk-mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "gpt-4o-mini-transcribe", // stale from an openai era — must degrade
    provider: "mistral",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
  const body = fetches[0].init.body.toString();
  assert.match(body, /voxtral-mini-latest/);
  assert.doesNotMatch(body, /name="language"/);
});

test("upload: openai diarization fields ride the route, Bearer auth", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    provider: "openai",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].init.headers.Authorization, "Bearer sk-openai");
  const body = fetches[0].init.body.toString();
  assert.match(body, /gpt-4o-transcribe-diarize/);
  assert.match(body, /diarized_json/);
});

test("upload: sentinel custom URL fails closed before any request", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.equal(fetches.length, 0);
});

test("upload: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://inference.tinfoil.sh/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
});

// An uploaded file is frequently not in the dictation language, and a wrong hint
// silently mistranscribes it — so BYOK cloud uploads auto-detect even when the
// user has pinned a preferred language for dictation.
test("upload: a preferred language never constrains a BYOK cloud upload", async () => {
  for (const provider of ["openai", "groq", "custom"]) {
    fetches.length = 0;
    const result = await invokeUpload({
      apiKey: "sk-key",
      baseUrl: provider === "custom" ? "https://gateway.example.com/v1" : "",
      model: "whisper-1",
      provider,
      language: "de",
      transcriptionMode: "providers",
    });
    assert.equal(result.success, true, provider);
    assert.doesNotMatch(fetches[0].init.body.toString(), /name="language"/, provider);
  }
});

// Providers that require a concrete language still receive one.
test("upload: corti and xai still get their language", async () => {
  fetches.length = 0;
  const xai = await invokeUpload({
    apiKey: "xk-key",
    baseUrl: "",
    model: "grok-stt",
    provider: "xai",
    language: "de",
    transcriptionMode: "providers",
  });
  assert.equal(xai.success, true);
  assert.match(fetches[0].url, /api\.x\.ai/);
  const xaiBody = fetches[0].init.body.toString();
  assert.match(xaiBody, /name="language"[\s\S]*?de/);
  assert.doesNotMatch(xaiBody, /name="model"/);

  const corti = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "corti-transcribe",
    provider: "corti",
    language: "",
    environment: "eu",
    tenant: " acme ",
    transcriptionMode: "providers",
  });
  assert.equal(corti.success, true);
  assert.equal(cortiCalls.at(-1).language, "en", "corti needs a concrete primaryLanguage");
  assert.equal(cortiCalls.at(-1).environment, "eu");
  assert.equal(cortiCalls.at(-1).tenant, "acme");
});

// #1459 made cloudTranscriptionBaseUrl Custom-only, so provider id alone can no
// longer tell whether a Custom endpoint fronts a diarization-capable API.
test("upload: a Custom endpoint fronting OpenAI or Mistral keeps diarization", async () => {
  fetches.length = 0;
  const openaiFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(openaiFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /gpt-4o-transcribe-diarize/);

  fetches.length = 0;
  const mistralFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.mistral.ai/v1/audio/transcriptions",
    model: "voxtral-mini-latest",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(mistralFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /name="diarize"/);

  fetches.length = 0;
  const unknownGateway = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://gateway.example.com/v1",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(unknownGateway.success, true, "an unknown gateway degrades, never fails");
  assert.doesNotMatch(fetches[0].init.body.toString(), /diarized_json/);
});

test("upload: a self-hosted Azure endpoint keeps its deployment URL", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "",
    provider: "custom",
    language: "",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.openai.azure.com",
    remoteTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(
    fetches[0].url,
    "https://myorg.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );
});

// Electron's net.fetch rejects with a plain Error whose message is the Chromium
// net error and no code; both BYOK handlers must classify it before replying.
async function withFetchRejecting(message, run) {
  const originalFetchResponse = fetchResponse;
  fetchResponse = () => {
    throw new Error(message);
  };
  try {
    return await run();
  } finally {
    fetchResponse = originalFetchResponse;
  }
}

test("retry: a net::ERR_* failure from a BYOK provider is classified as unreachable", async () => {
  const result = await withFetchRejecting("net::ERR_INTERNET_DISCONNECTED", () =>
    invoke({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
    })
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_UNREACHABLE");
  assert.equal(result.messageKey, "providerErrors.unreachable");
  assert.equal(result.messageParams.provider, "Mistral");
  assert.equal(result.surface, "transcription");
});

test("retry: a self-hosted timeout names the user's server", async () => {
  const result = await withFetchRejecting("net::ERR_CONNECTION_TIMED_OUT", () =>
    invoke({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://stt.example.com/v1",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionMode: "byok",
    })
  );
  assert.equal(result.code, "PROVIDER_TIMEOUT");
  assert.equal(result.messageKey, "providerErrors.selfHosted.timeout");
});

test("retry: a cancelled request (net::ERR_ABORTED) is not classified", async () => {
  const result = await withFetchRejecting("net::ERR_ABORTED", () =>
    invoke({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
    })
  );
  assert.equal(result.success, false);
  assert.equal(result.messageKey, undefined);
  assert.equal(result.error, "net::ERR_ABORTED");
});

test("upload: a net::ERR_* failure from a BYOK provider is classified as unreachable", async () => {
  const result = await withFetchRejecting("net::ERR_NAME_NOT_RESOLVED", () =>
    invokeUpload({
      apiKey: "sk-openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-transcribe",
      provider: "openai",
      language: "",
      transcriptionMode: "providers",
    })
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_UNREACHABLE");
  assert.equal(result.messageParams.provider, "OpenAI");
  assert.equal(result.surface, "transcription");
  assert.equal(result.error, "Couldn't reach OpenAI. Check your connection.");
});

test("upload: an HTTP failure logs its status and a redacted body", async (t) => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const warnings = [];
  t.mock.method(debugLogger, "warn", (message, meta) => warnings.push({ message, meta }));
  const originalFetchResponse = fetchResponse;
  t.after(() => {
    fetchResponse = originalFetchResponse;
  });
  const body = '{"error":{"message":"Incorrect API key provided: sk-proj-leakedKey12345"}}';
  fetchResponse = () => ({
    ok: false,
    status: 401,
    headers: new Headers(),
    text: async () => body,
    json: async () => JSON.parse(body),
  });

  const result = await invokeUpload({
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    provider: "openai",
    language: "",
    transcriptionMode: "providers",
  });

  assert.equal(result.code, "PROVIDER_AUTH_FAILED");
  const failure = warnings.find(({ message }) => message === "BYOK file transcription failed");
  assert.ok(failure, "the failure must be logged");
  assert.equal(failure.meta.status, 401);
  assert.match(failure.meta.body, /Incorrect API key provided/);
  assert.equal(failure.meta.body.includes("sk-proj-leakedKey12345"), false);
});

test("file IPCs preserve dictation when uploads are disabled, including cloud source metadata", async (t) => {
  const { createAudioFeaturePolicy } = require("../../src/helpers/audioFeaturePolicy");
  const originalPolicy = fakeThis._audioFeaturePolicy;
  const originalLocal = fakeThis.transcribeLocalFile;
  const originalApiUrl = process.env.OPENWHISPR_API_URL;
  t.after(() => {
    fakeThis._audioFeaturePolicy = originalPolicy;
    fakeThis.transcribeLocalFile = originalLocal;
    if (originalApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = originalApiUrl;
  });
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  fakeThis._audioFeaturePolicy = createAudioFeaturePolicy({
    getPolicy: async () => ({
      success: true,
      managed: true,
      policy: { features: { meetingRecordingEnabled: false, audioUploadEnabled: false } },
    }),
  });
  let localCalls = 0;
  fakeThis.transcribeLocalFile = async () => {
    localCalls++;
    return { success: true, text: "dictation" };
  };
  fsNode.writeFileSync(uploadTempFile, WAV_BUFFER);

  for (const channel of [
    "transcribe-audio-file",
    "transcribe-audio-file-cloud",
    "transcribe-audio-file-byok",
  ]) {
    const invokeFile = (purpose) => {
      const options = {
        purpose,
        apiKey: "sk-test",
        provider: "openai",
        model: "whisper-1",
        transcriptionMode: "providers",
      };
      return channel.endsWith("-byok")
        ? handlers.get(channel)({ sender: {} }, { filePath: uploadTempFile, ...options })
        : handlers.get(channel)({ sender: {} }, uploadTempFile, options);
    };
    fetches.length = 0;
    assert.equal((await invokeFile("dictation")).success, true, channel);
    if (channel.endsWith("-cloud")) {
      assert.match(fetches[0].init.body.toString(), /name="source"\r\n\r\ndictation\r\n/);
    }
    const networkCalls = fetches.length;
    const refused = await invokeFile(undefined);
    assert.equal(refused.code, "POLICY_AUDIO_UPLOAD_DISABLED", channel);
    assert.equal(fetches.length, networkCalls, channel);
  }
  assert.equal(localCalls, 1);
});

test("cancelling during policy lookup prevents every upload handler's later side effects", async (t) => {
  const { createAudioFeaturePolicy } = require("../../src/helpers/audioFeaturePolicy");
  const { deferred } = require("./harness/deferred");
  const originalPolicy = fakeThis._audioFeaturePolicy;
  const originalDiarization = fakeThis.diarizationManager;
  fakeThis.diarizationManager = { isModelDownloaded: () => true };
  const local = t.mock.method(fakeThis, "transcribeLocalFile", async () => ({ success: true }));
  const downloader = require("../../src/helpers/urlAudioDownloader");
  const download = t.mock.method(downloader, "download", async () => ({ tempPath: "/tmp/audio" }));
  const diarization = t.mock.method(fakeThis.diarizationManager, "isModelDownloaded", () => true);
  t.after(() => {
    fakeThis._audioFeaturePolicy = originalPolicy;
    fakeThis.diarizationManager = originalDiarization;
  });

  for (const channel of [
    "transcribe-audio-file",
    "transcribe-audio-file-cloud",
    "transcribe-audio-file-byok",
    "diarize-audio-file",
    "download-url-audio",
  ]) {
    const policy = deferred();
    fakeThis._audioFeaturePolicy = createAudioFeaturePolicy({ getPolicy: () => policy.promise });
    const requestId = `cancel-${channel}`;
    const options = { requestId };
    const args = channel.endsWith("-byok")
      ? [{ filePath: uploadTempFile, ...options }]
      : channel === "download-url-audio"
        ? ["https://example.com/audio.mp3", requestId]
        : [uploadTempFile, options];
    fetches.length = 0;
    const pending = handlers.get(channel)({ sender: {} }, ...args);
    const cancellationChannel =
      channel === "download-url-audio" ? "cancel-url-download" : "cancel-upload-transcription";
    assert.equal((await handlers.get(cancellationChannel)({}, requestId)).success, true, channel);
    policy.resolve({ success: true, managed: false });
    const result = await pending;
    assert.equal(result.success, false, channel);
    assert.equal(
      result.code,
      channel === "download-url-audio" ? "DOWNLOAD_CANCELLED" : "UPLOAD_CANCELLED",
      channel
    );
    assert.equal(fetches.length, 0, channel);
    assert.equal((await handlers.get(cancellationChannel)({}, requestId)).success, false, channel);
  }
  assert.equal(local.mock.callCount(), 0);
  assert.equal(download.mock.callCount(), 0);
  assert.equal(diarization.mock.callCount(), 0);
});
