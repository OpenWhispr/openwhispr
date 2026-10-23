const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createAudioFeaturePolicy } = require("../../src/helpers/audioFeaturePolicy");
const { deferred } = require("./harness/deferred");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() } };
  }
  if (request === "./windowBroadcast") return { broadcastToWindows() {} };
  return originalLoad.call(this, request, parent, isMain);
};

const CliBridge = require("../../src/helpers/cliBridge.js");
const { call } = require("./harness/cliBridge.js");

const MODELS = [
  { provider: "whisper", model: "base", downloaded: true, default: true },
  { provider: "whisper", model: "large", downloaded: false, default: false },
  { provider: "nvidia", model: "parakeet-tdt-0.6b-v3", downloaded: true, default: false },
];

function createBridge(models = MODELS, snapshot = { success: true, managed: false }) {
  const calls = { approved: [], transcribed: [] };
  const policy = createAudioFeaturePolicy({ getPolicy: async () => snapshot });
  const bridge = new CliBridge({
    databaseManager: {},
    _audioFeaturePolicy: policy,
    listLocalTranscriptionModels: () => models,
    approveAudioPath: (p) => calls.approved.push(p),
    transcribeLocalFile: async (p, options) => {
      calls.transcribed.push({ path: p, options });
      return { success: true, text: "hello from disk" };
    },
  });
  return { bridge, calls, policy };
}

function audioFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-transcribe-"));
  const file = path.join(dir, "memo.wav");
  fs.writeFileSync(file, "RIFF....WAVE");
  return { dir, file };
}

test("GET /v1/transcribe/models lists every local model with its state", () => {
  const { bridge } = createBridge();
  assert.deepEqual(call(bridge, "GET", "/v1/transcribe/models"), { data: MODELS });
});

test("POST /v1/transcribe approves the real path and runs the app's default model", async () => {
  const { bridge, calls } = createBridge();
  const { file } = audioFile();

  const result = await call(bridge, "POST", "/v1/transcribe", { path: file });

  assert.deepEqual(result, {
    data: { text: "hello from disk", provider: "whisper", model: "base" },
  });
  assert.deepEqual(calls.approved, [fs.realpathSync(file)]);
  assert.equal(calls.transcribed.length, 1);
  const { signal, ...options } = calls.transcribed[0].options;
  assert.equal(calls.transcribed[0].path, fs.realpathSync(file));
  assert.deepEqual(options, { provider: "whisper", model: "base", language: undefined });
  assert.equal(signal.aborted, false);
});

test("POST /v1/transcribe honors an explicit model and language", async () => {
  const { bridge, calls } = createBridge();
  const { file } = audioFile();

  await call(bridge, "POST", "/v1/transcribe", {
    path: file,
    model: "parakeet-tdt-0.6b-v3",
    language: "de",
  });

  const { signal, ...options } = calls.transcribed[0].options;
  assert.deepEqual(options, {
    provider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
    language: "de",
  });
  assert.equal(signal.aborted, false);
});

test("POST /v1/transcribe reports silence as empty text, not an error", async () => {
  const { bridge } = createBridge();
  bridge.ipcHandlers.transcribeLocalFile = async () => ({
    success: false,
    code: "NO_SPEECH_DETECTED",
    message: "No audio detected",
  });
  const { file } = audioFile();

  const result = await call(bridge, "POST", "/v1/transcribe", { path: file });

  assert.deepEqual(result, {
    data: { text: "", provider: "whisper", model: "base", warning: "No speech detected" },
  });
});

test("POST /v1/transcribe refuses models that are unknown or not downloaded", async () => {
  const { bridge, calls } = createBridge();
  const { file } = audioFile();

  await assert.rejects(call(bridge, "POST", "/v1/transcribe", { path: file, model: "large" }), {
    code: "VALIDATION",
    message: /not downloaded/,
  });
  await assert.rejects(call(bridge, "POST", "/v1/transcribe", { path: file, model: "nope" }), {
    code: "VALIDATION",
    message: /Unknown model 'nope'. Available: base, large, parakeet-tdt-0.6b-v3/,
  });
  assert.equal(calls.approved.length, 0);
});

test("POST /v1/transcribe explains when the app has no local model selected", async () => {
  const { bridge } = createBridge(MODELS.map((m) => ({ ...m, default: false })));
  const { file } = audioFile();

  await assert.rejects(call(bridge, "POST", "/v1/transcribe", { path: file }), {
    code: "VALIDATION",
    message: /No local transcription model is selected/,
  });
});

test("POST /v1/transcribe validates the path before touching anything", async () => {
  const { bridge, calls } = createBridge();
  const { dir } = audioFile();

  await assert.rejects(call(bridge, "POST", "/v1/transcribe", {}), { code: "VALIDATION" });
  await assert.rejects(call(bridge, "POST", "/v1/transcribe", { path: dir }), {
    code: "VALIDATION",
    message: /not a directory/,
  });
  await assert.rejects(
    call(bridge, "POST", "/v1/transcribe", { path: path.join(dir, "missing.wav") }),
    { code: "NOT_FOUND" }
  );
  assert.equal(calls.approved.length, 0);
  assert.equal(calls.transcribed.length, 0);
});

test("CLI files remain uploads even when callers request dictation; policy refusals return 403 before inference", async () => {
  const { file } = audioFile();
  for (const [snapshot, code] of [
    [
      {
        success: true,
        managed: true,
        policy: { features: { meetingRecordingEnabled: true, audioUploadEnabled: false } },
      },
      "POLICY_AUDIO_UPLOAD_DISABLED",
    ],
    [{ success: false }, "POLICY_UNRESOLVABLE"],
  ]) {
    const { bridge, calls } = createBridge(MODELS, snapshot);
    let failure;
    await assert.rejects(
      call(bridge, "POST", "/v1/transcribe", { path: file, purpose: "dictation" }),
      (error) => {
        failure = error;
        return error.code === code;
      }
    );
    assert.deepEqual(calls.approved, []);
    assert.deepEqual(calls.transcribed, []);
    const response = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    bridge._sendError(response, failure);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, code.toLowerCase());
    assert.equal(response.body.error.message, failure.message);
  }
});

test("upload revocation aborts CLI inference and suppresses a late result", async () => {
  const { bridge, policy } = createBridge();
  const { file } = audioFile();
  const entered = deferred();
  const finish = deferred();
  let signal;
  bridge.ipcHandlers.transcribeLocalFile = async (_path, options) => {
    signal = options.signal;
    entered.resolve();
    await finish.promise;
    return { success: true, text: "late transcript" };
  };
  const pending = call(bridge, "POST", "/v1/transcribe", { path: file });
  await entered.promise;
  policy.update({
    success: true,
    managed: true,
    policy: { features: { audioUploadEnabled: false } },
  });
  assert.equal(signal.aborted, true);
  finish.resolve();
  await assert.rejects(pending, { code: "POLICY_AUDIO_UPLOAD_DISABLED" });
});
