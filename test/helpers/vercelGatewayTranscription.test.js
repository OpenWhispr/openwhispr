const test = require("node:test");
const assert = require("node:assert/strict");
const { transcribeWithVercelGateway } = require("../../src/helpers/vercelGatewayTranscription");

const AUDIO = Buffer.from("fake-audio-bytes");

function makeFetch(response, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      headers: new Headers(),
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  return { fetchImpl, calls };
}

test("posts base64 JSON to the gateway's transcription route with the model in a header", async () => {
  const { fetchImpl, calls } = makeFetch({ text: "hello", segments: [], warnings: [] });

  const result = await transcribeWithVercelGateway(
    {
      audioBuffer: AUDIO,
      model: "mistral/voxtral-mini-transcribe-3",
      contentType: "audio/webm;codecs=opus",
      apiKey: " vck_1 ",
    },
    fetchImpl
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ai-gateway.vercel.sh/v4/ai/transcription-model");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, {
    Authorization: "Bearer vck_1",
    "Content-Type": "application/json",
    "ai-gateway-protocol-version": "0.0.1",
    "ai-transcription-model-specification-version": "4",
    "ai-model-id": "mistral/voxtral-mini-transcribe-3",
  });
  // The route takes no multipart upload, and the media type goes out without its codec.
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    audio: AUDIO.toString("base64"),
    mediaType: "audio/webm",
  });
  assert.deepEqual(result, { text: "hello", model: "mistral/voxtral-mini-transcribe-3" });
});

test("defaults the model and the media type, and accepts an ArrayBuffer", async () => {
  const { fetchImpl, calls } = makeFetch({ text: "ok" });
  const arrayBuffer = AUDIO.buffer.slice(AUDIO.byteOffset, AUDIO.byteOffset + AUDIO.byteLength);

  const result = await transcribeWithVercelGateway(
    { audioBuffer: arrayBuffer, apiKey: "k" },
    fetchImpl
  );

  assert.equal(calls[0].init.headers["ai-model-id"], "openai/gpt-transcribe");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    audio: AUDIO.toString("base64"),
    mediaType: "audio/webm",
  });
  assert.equal(result.model, "openai/gpt-transcribe");
});

test("a redirect fails the request instead of carrying the key to another host", async () => {
  const { fetchImpl, calls } = makeFetch({ text: "ok" });
  await transcribeWithVercelGateway({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl);
  assert.equal(calls[0].init.redirect, "error");
});

test("a missing key is refused before any request", async () => {
  const { fetchImpl, calls } = makeFetch({ text: "ok" });
  await assert.rejects(
    transcribeWithVercelGateway({ audioBuffer: AUDIO, apiKey: "  " }, fetchImpl),
    (error) => error.code === "API_KEY_MISSING"
  );
  assert.equal(calls.length, 0);
});

test("silence comes back as an empty text", async () => {
  for (const text of ["", "  \n"]) {
    const { fetchImpl } = makeFetch({ text, segments: [] });
    const result = await transcribeWithVercelGateway(
      { audioBuffer: AUDIO, apiKey: "k" },
      fetchImpl
    );
    assert.equal(result.text, "");
  }
});

test("a rejected key is classified as an auth failure without leaking the body", async () => {
  const { fetchImpl } = makeFetch(
    {
      error: {
        message: "Authentication failed. Check that your Vercel credential is valid.",
        type: "authentication_error",
      },
    },
    { ok: false, status: 401 }
  );
  await assert.rejects(
    transcribeWithVercelGateway({ audioBuffer: AUDIO, apiKey: "vck_bad" }, fetchImpl),
    (error) => {
      assert.equal(error.code, "PROVIDER_AUTH_FAILED");
      assert.equal(error.messageParams.provider, "Vercel AI Gateway");
      return true;
    }
  );
});

test("an unknown model is a provider error naming the model", async () => {
  const { fetchImpl } = makeFetch(
    { error: { message: "Model 'openai/nope' not found", type: "model_not_found" } },
    { ok: false, status: 404 }
  );
  await assert.rejects(
    transcribeWithVercelGateway(
      { audioBuffer: AUDIO, model: "openai/nope", apiKey: "k" },
      fetchImpl
    ),
    (error) => typeof error.code === "string" && error.code.startsWith("PROVIDER_")
  );
});

test("a 200 without a text field is an error, not an empty transcript", async () => {
  const { fetchImpl } = makeFetch({ segments: [] });
  await assert.rejects(
    transcribeWithVercelGateway({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl),
    (error) => error.code === "PROVIDER_ERROR"
  );
});

test("an aborted signal stops before the upload", async () => {
  const { fetchImpl, calls } = makeFetch({ text: "ok" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    transcribeWithVercelGateway(
      { audioBuffer: AUDIO, apiKey: "k", signal: controller.signal },
      fetchImpl
    ),
    (error) => error.name === "AbortError"
  );
  assert.equal(calls.length, 0);
});
