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
