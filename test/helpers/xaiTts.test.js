const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTtsBody, parseVoices, synthesizeXaiTts, MAX_TEXT_CHARS } = require("../../src/helpers/xaiTts");

test("buildTtsBody requires text and clamps speed", () => {
  assert.throws(() => buildTtsBody({ text: "  " }), { errorCode: "textRequired" });
  assert.throws(() => buildTtsBody({ text: "a".repeat(MAX_TEXT_CHARS + 1) }), {
    errorCode: "textTooLong",
  });

  const body = buildTtsBody({
    text: "Hello [pause] world",
    voiceId: "carina",
    speed: 9,
    optimizeStreamingLatency: 2,
    codec: "mp3",
    sampleRate: 44100,
    bitRate: 192000,
    textNormalization: true,
  });
  assert.equal(body.voice_id, "carina");
  assert.equal(body.speed, 1.5);
  assert.equal(body.optimize_streaming_latency, 2);
  assert.equal(body.language, "auto");
  assert.deepEqual(body.output_format, { codec: "mp3", sample_rate: 44100, bit_rate: 192000 });
  assert.equal(body.text_normalization, true);
});

test("buildTtsBody omits mp3 bit rate for wav", () => {
  const body = buildTtsBody({ text: "Hi", codec: "wav", sampleRate: 48000 });
  assert.deepEqual(body.output_format, { codec: "wav", sample_rate: 48000 });
});

test("parseVoices maps default and custom catalogs", () => {
  const voices = parseVoices(
    {
      voices: [
        { voice_id: "carina", name: "Carina", language: "en" },
        { voice_id: "  ", name: "skip" },
      ],
    },
    "default"
  );
  assert.deepEqual(voices, [
    { voiceId: "carina", name: "Carina", language: "en", gender: "", source: "default" },
  ]);
});

test("synthesizeXaiTts posts SuperGrok bearer and returns audio", async () => {
  const calls = [];
  const result = await synthesizeXaiTts({
    getBearer: async () => "oauth-bearer",
    input: { text: "Hello", voiceId: "eve" },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "audio/mpeg" },
        arrayBuffer: async () => Buffer.from("ID3fake"),
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.contentType, "audio/mpeg");
  assert.equal(Buffer.from(result.audioBase64, "base64").toString(), "ID3fake");
  assert.equal(calls[0].url, "https://api.x.ai/v1/tts");
  assert.equal(calls[0].init.headers.Authorization, "Bearer oauth-bearer");
  const posted = JSON.parse(calls[0].init.body);
  assert.equal(posted.text, "Hello");
  assert.equal(posted.voice_id, "eve");
});

test("synthesizeXaiTts fails closed without credentials", async () => {
  const result = await synthesizeXaiTts({
    getBearer: async () => "",
    input: { text: "Hello" },
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "credentialsRequired");
});
