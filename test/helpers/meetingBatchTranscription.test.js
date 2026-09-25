const test = require("node:test");
const assert = require("node:assert/strict");

const { transcribeMeetingChunkBatch } = require("../../src/helpers/meetingBatchTranscription");

const ENDPOINT = "https://gateway.example.com/v1/audio/transcriptions";
const wav = Buffer.from([1, 2, 3, 4]);

test("posts the wav chunk as multipart form data with a bearer key and returns the text", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ text: " hello " }) };
  };

  const result = await transcribeMeetingChunkBatch({
    endpoint: ENDPOINT,
    model: "whisper-large-v3",
    language: "en",
    wav,
    apiKey: "  sk-test  ",
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  // FormData must own the Content-Type so the multipart boundary is set.
  assert.equal(calls[0].init.headers["Content-Type"], undefined);

  const body = calls[0].init.body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get("file").name, "chunk.wav");
  assert.equal(body.get("file").type, "audio/wav");
  assert.equal(body.get("model"), "whisper-large-v3");
  assert.equal(body.get("language"), "en");
  assert.deepEqual(result, { success: true, text: " hello " });
});

test("uses the api-key header for Azure and omits model/language when unset", async () => {
  let init = null;
  const fetchImpl = async (_url, requestInit) => {
    init = requestInit;
    return { ok: true, json: async () => ({}) };
  };

  const result = await transcribeMeetingChunkBatch({
    endpoint: ENDPOINT,
    model: null,
    language: null,
    wav,
    apiKey: "azure-key",
    authScheme: "azure-api-key",
    fetchImpl,
  });

  assert.deepEqual(init.headers, { "api-key": "azure-key" });
  assert.equal(init.body.has("model"), false);
  assert.equal(init.body.has("language"), false);
  assert.deepEqual(result, { success: true, text: "" });
});

test("sends no auth header when the key is missing or blank", async () => {
  const seen = [];
  const fetchImpl = async (_url, requestInit) => {
    seen.push(requestInit.headers);
    return { ok: true, json: async () => ({ text: "ok" }) };
  };

  for (const apiKey of [undefined, null, "", "   "]) {
    await transcribeMeetingChunkBatch({
      endpoint: ENDPOINT,
      model: "m",
      language: "en",
      wav,
      apiKey,
      fetchImpl,
    });
  }

  assert.equal(seen.length, 4);
  for (const headers of seen) assert.deepEqual(headers, {});
});

test("throws with the status and response body on a failed request", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => "Authentication Error",
  });

  await assert.rejects(
    () =>
      transcribeMeetingChunkBatch({
        endpoint: ENDPOINT,
        model: "m",
        language: "en",
        wav,
        fetchImpl,
      }),
    /401 Authentication Error/
  );
});
