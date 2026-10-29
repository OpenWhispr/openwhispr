const test = require("node:test");
const assert = require("node:assert/strict");
const {
  transcribeWithElevenLabs,
  sanitizeKeyterms,
  ELEVENLABS_STT_URL,
} = require("../../src/helpers/elevenLabsTranscription");

const AUDIO = Buffer.from("fake-audio-bytes");

function makeFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetchImpl, calls };
}

test("posts multipart audio with the xi-api-key header to the Scribe endpoint", async () => {
  const { fetchImpl, calls } = makeFetch(200, { text: "hello", language_code: "eng" });

  const result = await transcribeWithElevenLabs(
    {
      audioBuffer: AUDIO,
      model: "scribe_v2",
      fileName: "memo.mp3",
      contentType: "audio/mpeg",
      language: "de",
      apiKey: "k1",
    },
    fetchImpl
  );

  assert.equal(calls[0].url, ELEVENLABS_STT_URL);
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "xi-api-key": "k1" });
  const form = calls[0].init.body;
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("language_code"), "de");
  assert.equal(form.get("tag_audio_events"), "false", "sound tags must never reach the caret");
  const file = form.get("file");
  assert.equal(file.name, "memo.mp3");
  assert.equal(file.type, "audio/mpeg");
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "fake-audio-bytes");
  assert.deepEqual(result, { text: "hello", model: "scribe_v2" });
});

test("auto language sends no language_code, and the model defaults to scribe_v2", async () => {
  const { fetchImpl, calls } = makeFetch(200, { text: "ok" });

  await transcribeWithElevenLabs({ audioBuffer: AUDIO, language: "auto", apiKey: "k" }, fetchImpl);

  const form = calls[0].init.body;
  assert.equal(form.has("language_code"), false);
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("file").name, "audio.webm");
  assert.equal(form.has("keyterms"), false, "no dictionary means no keyterms surcharge");
});

test("dictionary words go out as repeated keyterms parts after sanitising", async () => {
  const { fetchImpl, calls } = makeFetch(200, { text: "ok" });

  await transcribeWithElevenLabs(
    { audioBuffer: AUDIO, keyterms: ["OpenWhispr", " Kubernetes  cluster "], apiKey: "k" },
    fetchImpl
  );

  assert.deepEqual(calls[0].init.body.getAll("keyterms"), ["OpenWhispr", "Kubernetes cluster"]);
});

test("sanitizeKeyterms drops terms ElevenLabs would reject the whole request for", () => {
  assert.deepEqual(
    sanitizeKeyterms([
      "ok",
      "OK",
      "x".repeat(50),
      "one two three four five six",
      "a <tag>",
      "{brace}",
      "back\\slash",
      "",
      42,
      "  spaced   out  ",
    ]),
    ["ok", "spaced out"]
  );
  assert.deepEqual(sanitizeKeyterms(undefined), []);
  assert.equal(sanitizeKeyterms(Array.from({ length: 1200 }, (_, i) => `term${i}`)).length, 1000);
});

test("a missing key fails before any request", async () => {
  const { fetchImpl, calls } = makeFetch(200, { text: "never" });
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "  " }, fetchImpl),
    (error) => error.code === "API_KEY_MISSING"
  );
  assert.equal(calls.length, 0);
});

test("a refused key is an auth failure; an exhausted quota is not", async () => {
  const invalid = makeFetch(401, {
    detail: { type: "authentication_error", status: "invalid_api_key", message: "Invalid API key" },
  });
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "bad" }, invalid.fetchImpl),
    (error) => error.code === "PROVIDER_AUTH_FAILED" && error.settingsTarget === "speechToText"
  );

  const quota = makeFetch(401, {
    detail: { status: "quota_exceeded", message: "This request exceeds your quota." },
  });
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, quota.fetchImpl),
    (error) => error.code === "PROVIDER_QUOTA_EXHAUSTED"
  );
});

test("a 422 validation error is a bad request", async () => {
  const { fetchImpl } = makeFetch(422, { detail: [{ msg: "invalid keyterms" }] });
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl),
    (error) => error.code === "PROVIDER_BAD_REQUEST"
  );
});

test("a response without text yields an empty transcript", async () => {
  const { fetchImpl } = makeFetch(200, { language_code: "eng" });
  const result = await transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl);
  assert.equal(result.text, "");
});
