const test = require("node:test");
const assert = require("node:assert/strict");
const { transcribeWithGemini } = require("../../src/helpers/geminiTranscription");

const AUDIO = Buffer.from("fake-audio-bytes");

function makeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  return { fetchImpl, calls };
}

function requestBody(calls) {
  return JSON.parse(calls[0].init.body);
}

test("posts JSON with the key header to the Interactions endpoint", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "hello" });

  const result = await transcribeWithGemini(
    { audioBuffer: AUDIO, model: "gemini-3.5-transcribe", contentType: "audio/mp3", apiKey: "k1" },
    fetchImpl
  );

  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "application/json",
    "x-goog-api-key": "k1",
  });
  const body = requestBody(calls);
  assert.equal(body.model, "gemini-3.5-transcribe");
  assert.deepEqual(body.input, [
    { type: "audio", data: AUDIO.toString("base64"), mime_type: "audio/mp3" },
  ]);
  assert.equal(result.text, "hello");
  assert.equal(result.model, "gemini-3.5-transcribe");
});

test("defaults the model and omits generation_config when empty", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "ok" });

  await transcribeWithGemini(
    { audioBuffer: AUDIO, contentType: "audio/webm", language: "auto", apiKey: "k" },
    fetchImpl
  );

  const body = requestBody(calls);
  assert.equal(body.model, "gemini-3.5-transcribe");
  assert.equal(body.input[0].mime_type, "audio/webm");
  assert.equal("generation_config" in body, false, "auto language must not send a config");
});

test("language and keyterms land in transcription_config", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "ok" });

  await transcribeWithGemini(
    { audioBuffer: AUDIO, language: "de", keyterms: ["OpenWhispr", "Gizmo"], apiKey: "k" },
    fetchImpl
  );

  assert.deepEqual(requestBody(calls).generation_config, {
    transcription_config: {
      language_codes: ["de"],
      custom_vocabulary: ["OpenWhispr", "Gizmo"],
    },
  });
});

test("falls back to joining step text when output_text is absent", async () => {
  const { fetchImpl } = makeFetch({
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          { type: "text", text: "Hello" },
          { type: "word_info", text: "ignored" },
          { type: "text", text: "world" },
        ],
      },
    ],
  });

  const { text } = await transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl);
  assert.equal(text, "Hello world");
});

test("a missing key fails before any request is made", async () => {
  const { fetchImpl, calls } = makeFetch({});
  await assert.rejects(
    transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "  " }, fetchImpl),
    (error) => error.code === "API_KEY_MISSING"
  );
  assert.equal(calls.length, 0);
});

test("HTTP statuses map to coded errors without leaking the key", async () => {
  const statusError = async (status, body = "denied") => {
    const fetchImpl = async () => ({
      ok: false,
      status,
      text: async () => body,
    });
    return transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "sk-secret" }, fetchImpl).then(
      () => assert.fail(`status ${status} must reject`),
      (error) => error
    );
  };

  const unauthorized = await statusError(401);
  assert.equal(unauthorized.code, "PROVIDER_AUTH_FAILED");
  assert.equal(unauthorized.message.includes("sk-secret"), false);

  // A bare 403 with no key-signal body is access-denied, not an auth failure —
  // the shared classifier only promotes 403 to PROVIDER_AUTH_FAILED when the
  // body itself names an invalid/incorrect key.
  const forbidden = await statusError(403);
  assert.equal(forbidden.code, "PROVIDER_ACCESS_DENIED");
  assert.equal(forbidden.message.includes("sk-secret"), false);

  assert.equal((await statusError(429)).code, "PROVIDER_RATE_LIMITED");
  assert.equal((await statusError(500)).code, "PROVIDER_UNAVAILABLE");

  // Google's real answer to a bad key, captured from the live API.
  const badKey = await statusError(400, '{"error":{"reason":"API_KEY_INVALID"}}');
  assert.equal(badKey.code, "PROVIDER_AUTH_FAILED");
  assert.equal(badKey.message.includes("sk-secret"), false);

  assert.equal((await statusError(400, "unsupported mime")).code, "PROVIDER_BAD_REQUEST");
});

test("failures carry the classified key and Gemini as provider", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":{"details":[{"reason":"API_KEY_INVALID"}]}}',
  });
  await assert.rejects(
    () =>
      transcribeWithGemini(
        { audioBuffer: AUDIO, model: "m", contentType: "audio/mp3", apiKey: "k" },
        fetchImpl
      ),
    (error) => {
      assert.equal(error.messageKey, "providerErrors.authFailed");
      assert.deepEqual(error.messageParams, { provider: "Gemini" });
      assert.equal(error.settingsTarget, "speechToText");
      assert.equal(error.technicalDetails.status, 400);
      return true;
    }
  );
});

test("a failed interaction status rejects even on HTTP 200", async () => {
  const { fetchImpl } = makeFetch({
    status: "failed",
    error: { code: "api_error", message: "decode error" },
  });
  await assert.rejects(
    transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl),
    /Gemini transcription failed: decode error/
  );
});

test("any non-completed status rejects instead of returning empty text", async () => {
  const { fetchImpl } = makeFetch({ status: "budget_exceeded", steps: [] });
  await assert.rejects(
    transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl),
    /did not complete \(status: budget_exceeded\)/
  );
});

test("an HTTP failure logs its status and a redacted body", async (t) => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const warnings = [];
  t.mock.method(debugLogger, "warn", (message, meta) => warnings.push({ message, meta }));
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":{"message":"API key not valid: AIzaSyLeakedKey123"}}',
  });

  await assert.rejects(transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl));

  const failure = warnings.find(({ message }) => message === "Gemini transcription failed");
  assert.ok(failure, "the failure must be logged");
  assert.equal(failure.meta.status, 400);
  assert.match(failure.meta.body, /API key not valid/);
  assert.equal(failure.meta.body.includes("AIzaSyLeakedKey123"), false);
});

test("canonical mime types map onto Gemini's documented ones", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "ok" });

  await transcribeWithGemini(
    { audioBuffer: AUDIO, contentType: "audio/mpeg", apiKey: "k" },
    fetchImpl
  );

  assert.equal(requestBody(calls).input[0].mime_type, "audio/mp3");
});
