const test = require("node:test");
const assert = require("node:assert/strict");
const { transcribeWithAssemblyAiDictation } = require("../../src/helpers/assemblyAiDictation");

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

const sentConfig = async (calls) => JSON.parse(await calls[0].init.body.get("config").text());

test("posts the recording and its config with the raw key, and returns both texts", async () => {
  const { fetchImpl, calls } = makeFetch({ text: "um hello", llm_response: "Hello." });

  const result = await transcribeWithAssemblyAiDictation(
    {
      audioBuffer: AUDIO,
      contentType: "audio/webm;codecs=opus",
      language: "es",
      keyterms: ["Piha"],
      apiKey: "aai-key",
    },
    fetchImpl
  );

  assert.equal(calls[0].url, "https://dictation.assemblyai.com/v1/transcribe");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { Authorization: "aai-key" });
  assert.deepEqual(await sentConfig(calls), { language_codes: ["es"], keyterms_prompt: ["Piha"] });
  const audio = calls[0].init.body.get("audio");
  assert.equal(audio.type, "audio/webm");
  assert.equal(audio.name, "audio.webm");
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), AUDIO);
  assert.deepEqual(result, { text: "um hello", cleanedText: "Hello." });
});

test("a language outside the API's list is left out, since it answers 400 to one", async () => {
  const { fetchImpl, calls } = makeFetch({ text: "hi", llm_response: "Hi." });

  await transcribeWithAssemblyAiDictation(
    { audioBuffer: AUDIO, language: "pl", apiKey: "aai-key" },
    fetchImpl
  );

  assert.deepEqual(await sentConfig(calls), {});
});

test("a failed rewrite still returns the transcript, with no cleaned text", async () => {
  const { fetchImpl } = makeFetch({ text: "um hello", llm_response: null, llm_error: "timeout" });

  const result = await transcribeWithAssemblyAiDictation(
    { audioBuffer: AUDIO, apiKey: "aai-key" },
    fetchImpl
  );

  assert.deepEqual(result, { text: "um hello", cleanedText: undefined });
});

test("a missing key is a classified error and sends nothing", async () => {
  const { fetchImpl, calls } = makeFetch({});

  await assert.rejects(
    transcribeWithAssemblyAiDictation({ audioBuffer: AUDIO, apiKey: "" }, fetchImpl),
    (error) => error.code === "API_KEY_MISSING" && error.messageParams.provider === "AssemblyAI"
  );
  assert.equal(calls.length, 0);
});

test("an HTTP failure is classified for AssemblyAI", async () => {
  const { fetchImpl } = makeFetch({ error: "unauthorized" }, { ok: false, status: 401 });

  await assert.rejects(
    transcribeWithAssemblyAiDictation({ audioBuffer: AUDIO, apiKey: "bad" }, fetchImpl),
    (error) =>
      error.code === "PROVIDER_AUTH_FAILED" && error.messageParams.provider === "AssemblyAI"
  );
});

test("the caller's cancel reaches the request, and stays an abort", async () => {
  const controller = new AbortController();
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
      controller.abort();
    });

  await assert.rejects(
    transcribeWithAssemblyAiDictation(
      { audioBuffer: AUDIO, apiKey: "aai-key", signal: controller.signal },
      fetchImpl
    ),
    { name: "AbortError" }
  );
});

test("a request that outlives the deadline is reported as a timeout", async (t) => {
  t.mock.method(AbortSignal, "timeout", () =>
    AbortSignal.abort(new DOMException("", "TimeoutError"))
  );
  const fetchImpl = async (_url, init) => {
    throw init.signal.reason;
  };

  await assert.rejects(
    transcribeWithAssemblyAiDictation({ audioBuffer: AUDIO, apiKey: "aai-key" }, fetchImpl),
    { code: "PROVIDER_TIMEOUT" }
  );
});
