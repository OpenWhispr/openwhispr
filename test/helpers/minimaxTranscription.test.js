const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const modulePath = require.resolve("../../src/helpers/minimaxTranscription.js");
const originalLoad = Module._load;
const conversions = [];

function load() {
  delete require.cache[modulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./ffmpegUtils") {
      return {
        isWavFormat: (buf) => buf.subarray(0, 4).toString() === "RIFF",
        convertBufferToWav: async (buf) => {
          conversions.push(buf);
          return Buffer.from("RIFFwav");
        },
      };
    }
    if (request === "./debugLogger") return { debug() {}, warn() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const ok = (data) => ({ ok: true, status: 200, json: async () => data });

test("dictation webm is re-encoded to wav and the language goes in a header", async () => {
  conversions.length = 0;
  const calls = [];
  const { transcribeWithMinimax } = load();

  const result = await transcribeWithMinimax({
    audioBuffer: Buffer.from("webm-bytes"),
    fileName: "audio.webm",
    contentType: "audio/webm",
    language: "fr",
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return ok({ text: "bonjour" });
    },
  });

  assert.deepEqual(result, { text: "bonjour", model: "asr-1.0" });
  assert.equal(conversions.length, 1);
  assert.equal(calls[0].url, "https://api.minimax.io/v1/speech_to_text");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].init.headers.language, "fr");
  const form = calls[0].init.body;
  assert.equal(form.get("model"), "asr-1.0");
  assert.equal(form.get("response_format"), "json");
  assert.equal(form.get("file").type, "audio/wav");
  assert.equal(form.get("language"), null, "never a form field");
});

test("auto language sends no header and supported containers go out untouched", async () => {
  conversions.length = 0;
  let init;
  const { transcribeWithMinimax } = load();

  await transcribeWithMinimax({
    audioBuffer: Buffer.from("mp3-bytes"),
    fileName: "a.mp3",
    contentType: "audio/mpeg",
    language: "auto",
    apiKey: "sk-test",
    fetchImpl: async (_, i) => ((init = i), ok({ text: "" })),
  });

  assert.equal(conversions.length, 0);
  assert.equal(init.headers.language, undefined);
  assert.equal(init.body.get("file").type, "audio/mpeg");
});

test("diarize asks for verbose_json and maps speaker segments", async () => {
  let init;
  const { transcribeWithMinimax } = load();

  const result = await transcribeWithMinimax({
    audioBuffer: Buffer.from("ogg"),
    fileName: "a.ogg",
    contentType: "audio/ogg",
    diarize: true,
    apiKey: "sk-test",
    fetchImpl: async (_, i) => (
      (init = i),
      ok({ text: "a b", segments: [{ id: 0, start: 1.08, end: 8.14, speaker: "S1", text: "a b" }] })
    ),
  });

  assert.equal(init.body.get("response_format"), "verbose_json");
  assert.deepEqual(result.segments, [{ speaker: "S1", text: "a b", start: 1.08, end: 8.14 }]);
});

test("a missing key fails before any request", async () => {
  const { transcribeWithMinimax } = load();
  await assert.rejects(
    transcribeWithMinimax({
      audioBuffer: Buffer.from("x"),
      contentType: "audio/ogg",
      apiKey: " ",
      fetchImpl: async () => assert.fail("must not fetch"),
    }),
    (err) => err.code === "API_KEY_MISSING"
  );
});

test("provider errors are classified, never the raw body", async () => {
  const { transcribeWithMinimax } = load();
  const body = JSON.stringify({ type: "error", error: { message: "login fail (1004)" } });
  await assert.rejects(
    transcribeWithMinimax({
      audioBuffer: Buffer.from("x"),
      contentType: "audio/ogg",
      apiKey: "sk-test",
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => body,
        headers: new Headers(),
      }),
    }),
    (err) => {
      assert.equal(err.code, "PROVIDER_AUTH_FAILED");
      assert.doesNotMatch(err.message, /login fail/);
      return true;
    }
  );
});
