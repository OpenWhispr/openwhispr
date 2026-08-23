const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const transcriptionModulePath = require.resolve("../../src/helpers/cortiTranscription.js");
const originalLoad = Module._load;

test("authorization cancellation while authenticating prevents the first Corti interaction", async () => {
  let resolveToken;
  const token = new Promise((resolve) => {
    resolveToken = resolve;
  });
  const fetches = [];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        net: {
          fetch: async (...args) => {
            fetches.push(args);
            return { ok: true, json: async () => ({ interactionId: "interaction-1" }) };
          },
        },
      };
    }
    if (request === "./cortiAuth") return { getCortiToken: () => token };
    if (request === "./debugLogger") return { debug() {}, error() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[transcriptionModulePath];
  const { transcribeAudio } = require(transcriptionModulePath);
  Module._load = originalLoad;

  const controller = new AbortController();
  const transcription = transcribeAudio({
    environment: "us",
    tenant: "base",
    clientId: "client-id",
    clientSecret: "client-secret",
    audioBuffer: Buffer.from("audio"),
    language: "en",
    signal: controller.signal,
  });
  controller.abort();
  resolveToken("token");

  await assert.rejects(transcription, { name: "AbortError" });
  assert.deepEqual(fetches, []);
});

test("cancellation aborts transcription but still starts independently bounded privacy cleanup", async (t) => {
  const fetches = [];
  let recordingRequest;
  let cleanupRequest;
  let resolveCleanup;
  let cleanupTimeoutMs = null;
  const cleanupController = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    cleanupTimeoutMs = milliseconds;
    return cleanupController.signal;
  };
  t.after(() => {
    AbortSignal.timeout = originalTimeout;
  });

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        net: {
          fetch: async (url, init) => {
            fetches.push({ url, init });
            if (url.endsWith("/interactions/")) {
              return { ok: true, json: async () => ({ interactionId: "interaction-1" }) };
            }
            if (url.endsWith("/recordings/")) {
              recordingRequest = { init };
              return new Promise((_resolve, reject) => {
                const rejectAbort = () => {
                  const error = new Error("Corti recording request aborted");
                  error.name = "AbortError";
                  reject(error);
                };
                if (init.signal.aborted) rejectAbort();
                else init.signal.addEventListener("abort", rejectAbort, { once: true });
              });
            }
            if (url.endsWith("/interactions/interaction-1")) {
              cleanupRequest = { init };
              return new Promise((resolve) => {
                resolveCleanup = resolve;
              });
            }
            throw new Error(`Unexpected Corti request: ${url}`);
          },
        },
      };
    }
    if (request === "./cortiAuth") return { getCortiToken: async () => "token" };
    if (request === "./debugLogger") return { debug() {}, error() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[transcriptionModulePath];
  const { transcribeAudio } = require(transcriptionModulePath);
  Module._load = originalLoad;

  const controller = new AbortController();
  const transcription = transcribeAudio({
    environment: "us",
    tenant: "base",
    clientId: "client-id",
    clientSecret: "client-secret",
    audioBuffer: Buffer.from("audio"),
    language: "en",
    signal: controller.signal,
  });
  while (!recordingRequest) await new Promise((resolve) => setImmediate(resolve));

  controller.abort();

  assert.equal(recordingRequest.init.signal, controller.signal);
  assert.equal(recordingRequest.init.signal.aborted, true);
  let settled = false;
  void transcription.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  while (!cleanupRequest) await new Promise((resolve) => setImmediate(resolve));

  assert.ok(cleanupRequest, "cleanup DELETE must be issued after cancellation");
  assert.equal(settled, false, "transcription must not settle before the privacy DELETE");
  assert.equal(fetches.length, 3);
  assert.notEqual(cleanupRequest.init.signal, controller.signal);
  assert.equal(cleanupRequest.init.signal, cleanupController.signal);
  assert.ok(cleanupTimeoutMs > 0 && cleanupTimeoutMs <= 10_000);
  resolveCleanup({ ok: true, text: async () => "" });
  await assert.rejects(transcription, { name: "AbortError" });
});

test("bounded cleanup timeout is durably admitted before successful transcription settles", async (t) => {
  const cleanupController = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => cleanupController.signal);
  let cleanupRequest;
  let resolvePersistence;
  const persistenceDeferred = new Promise((resolve) => {
    resolvePersistence = resolve;
  });
  const retryRecords = [];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        net: {
          fetch: async (url, init) => {
            if (url.endsWith("/interactions/")) {
              return { ok: true, json: async () => ({ interactionId: "interaction-timeout" }) };
            }
            if (url.endsWith("/recordings/")) {
              return { ok: true, json: async () => ({ recordingId: "recording-1" }) };
            }
            if (url.endsWith("/transcripts/")) {
              return {
                ok: true,
                json: async () => ({ transcripts: [{ text: "transcribed" }] }),
              };
            }
            if (url.endsWith("/interactions/interaction-timeout")) {
              cleanupRequest = { init };
              return new Promise((_resolve, reject) => {
                init.signal.addEventListener(
                  "abort",
                  () => reject(Object.assign(new Error("cleanup timed out"), { name: "AbortError" })),
                  { once: true }
                );
              });
            }
            throw new Error(`Unexpected Corti request: ${url}`);
          },
        },
      };
    }
    if (request === "./cortiAuth") return { getCortiToken: async () => "token" };
    if (request === "./debugLogger") return { debug() {}, error() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[transcriptionModulePath];
  const { transcribeAudio } = require(transcriptionModulePath);
  Module._load = originalLoad;

  const transcription = transcribeAudio({
    environment: "us",
    tenant: "base",
    clientId: "client-id",
    clientSecret: "client-secret",
    audioBuffer: Buffer.from("audio"),
    language: "en",
    onCleanupFailure: async (record) => {
      retryRecords.push(record);
      await persistenceDeferred;
    },
  });
  let settled = false;
  void transcription.then(() => {
    settled = true;
  });
  while (!cleanupRequest) await new Promise((resolve) => setImmediate(resolve));
  cleanupController.abort();
  while (retryRecords.length === 0) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.notEqual(cleanupRequest.init.signal, undefined);
  assert.deepEqual(retryRecords, [
    { environment: "us", tenant: "base", interactionId: "interaction-timeout" },
  ]);
  resolvePersistence();
  assert.deepEqual(await transcription, { text: "transcribed" });
});

test("an already-deleted interaction is treated as successful idempotent cleanup", async () => {
  let cleanupQueued = false;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        net: {
          fetch: async (url) => {
            if (url.endsWith("/interactions/")) {
              return { ok: true, json: async () => ({ interactionId: "interaction-gone" }) };
            }
            if (url.endsWith("/recordings/")) {
              return { ok: true, json: async () => ({ recordingId: "recording-1" }) };
            }
            if (url.endsWith("/transcripts/")) {
              return { ok: true, json: async () => ({ transcripts: [{ text: "done" }] }) };
            }
            if (url.endsWith("/interactions/interaction-gone")) {
              return { ok: false, status: 404, text: async () => "not found" };
            }
            throw new Error(`Unexpected Corti request: ${url}`);
          },
        },
      };
    }
    if (request === "./cortiAuth") return { getCortiToken: async () => "token" };
    if (request === "./debugLogger") return { debug() {}, error() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[transcriptionModulePath];
  const { transcribeAudio } = require(transcriptionModulePath);
  Module._load = originalLoad;

  assert.deepEqual(
    await transcribeAudio({
      environment: "us",
      tenant: "base",
      clientId: "client-id",
      clientSecret: "client-secret",
      audioBuffer: Buffer.from("audio"),
      language: "en",
      onCleanupFailure: async () => {
        cleanupQueued = true;
      },
    }),
    { text: "done" }
  );
  assert.equal(cleanupQueued, false);
});
