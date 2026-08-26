const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/realtimeTokenProviders.js");

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const deps = (overrides = {}) => ({
  environmentManager: {
    getOpenAIKey: () => "sk-openai",
    getTinfoilKey: () => "tk-tinfoil",
    getDeepgramKey: () => "dg-key",
    getAssemblyAIKey: () => "aai-key",
    ...overrides.environmentManager,
  },
  proxyFetch: overrides.proxyFetch || (async () => jsonResponse(200, { token: "aai-token" })),
  postServerToken: overrides.postServerToken || (async () => ({ token: "server-token" })),
  mintCortiToken: overrides.mintCortiToken || (async () => ({ token: "corti-token" })),
});

test("provider-less and unknown providers fail closed with the exact #1480 message", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  for (const provider of [undefined, "grok-realtime", "openai"]) {
    await assert.rejects(
      fetchRealtimeTokenForProvider(provider, deps(), { mode: "byok" }),
      new Error(`Unsupported realtime token provider: ${provider}`)
    );
  }
});

test("openai byok returns the key; dual-stream duplicates it", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  assert.equal(
    await fetchRealtimeTokenForProvider("openai-realtime", deps(), { mode: "byok" }),
    "sk-openai"
  );
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "openai-realtime",
      deps(),
      { mode: "byok" },
      { streams: 2 }
    ),
    ["sk-openai", "sk-openai"]
  );
});

test("openai cloud mints per-stream client secrets and validates the dual pair", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  const calls = [];
  const cloudDeps = deps({
    postServerToken: async (path, body) => {
      calls.push({ path, body });
      return { clientSecret: "cs-single", clientSecrets: ["cs-a", "cs-b"] };
    },
  });
  const options = { mode: "openwhispr", model: "gpt-4o-mini-transcribe", language: "en" };

  assert.equal(
    await fetchRealtimeTokenForProvider("openai-realtime", cloudDeps, options),
    "cs-single"
  );
  assert.deepEqual(
    await fetchRealtimeTokenForProvider("openai-realtime", cloudDeps, options, { streams: 2 }),
    ["cs-a", "cs-b"]
  );
  assert.deepEqual(calls[0], {
    path: "/api/openai-realtime-token",
    body: { model: "gpt-4o-mini-transcribe", language: "en", streams: 1 },
  });
  assert.equal(calls[1].body.streams, 2);

  await assert.rejects(
    fetchRealtimeTokenForProvider(
      "openai-realtime",
      deps({ postServerToken: async () => ({ clientSecrets: ["only-one"] }) }),
      options,
      { streams: 2 }
    ),
    /Expected two client secrets/
  );
});

test("tinfoil missing key carries the NO_API code the renderer's fallback keys on", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  const noKey = deps({ environmentManager: { getTinfoilKey: () => "" } });
  await assert.rejects(
    fetchRealtimeTokenForProvider("tinfoil-realtime", noKey, { mode: "byok" }),
    (err) => err.code === "NO_API"
  );
});

test("assemblyai byok mints one live token per stream", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  let mints = 0;
  const liveDeps = deps({
    proxyFetch: async () => jsonResponse(200, { token: `aai-${++mints}` }),
  });
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "assemblyai-realtime",
      liveDeps,
      { mode: "byok" },
      { streams: 2 }
    ),
    ["aai-1", "aai-2"]
  );
});

test("deepgram byok duplicates the key; cloud mints per stream", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "deepgram-realtime",
      deps(),
      { mode: "byok" },
      { streams: 2 }
    ),
    ["dg-key", "dg-key"]
  );
  let mints = 0;
  const cloudDeps = deps({ postServerToken: async () => ({ token: `dg-${++mints}` }) });
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "deepgram-realtime",
      cloudDeps,
      { mode: "openwhispr" },
      { streams: 2 }
    ),
    ["dg-1", "dg-2"]
  );
});

test("corti mints one token and shares it across both streams", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  let mints = 0;
  const cortiDeps = deps({ mintCortiToken: async () => ({ token: `corti-${++mints}` }) });
  assert.deepEqual(
    await fetchRealtimeTokenForProvider("corti-realtime", cortiDeps, {}, { streams: 2 }),
    ["corti-1", "corti-1"]
  );
  assert.equal(mints, 1);
});

test("missing byok keys throw configuration errors, not token errors", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  const empty = { getOpenAIKey: () => "", getDeepgramKey: () => "", getAssemblyAIKey: () => "" };
  for (const provider of ["openai-realtime", "deepgram-realtime", "assemblyai-realtime"]) {
    await assert.rejects(
      fetchRealtimeTokenForProvider(provider, deps({ environmentManager: empty }), {
        mode: "byok",
      }),
      /key configured/
    );
  }
});

test('wire bodies: dictation posts the bare {"streams":1}; meetings post model+language+streams', async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  const wire = [];
  const cloudDeps = deps({
    postServerToken: async (path, body) => {
      // JSON.stringify drops undefined keys exactly like the real fetch does.
      wire.push({ path, json: JSON.stringify(body) });
      return { clientSecret: "cs-single", clientSecrets: ["cs-a", "cs-b"] };
    },
  });

  // Dictation: ipcHandlers' connectDictationStreaming passes only { mode, provider }.
  await fetchRealtimeTokenForProvider("openai-realtime", cloudDeps, { mode: "openwhispr" });
  // Meeting with system audio.
  await fetchRealtimeTokenForProvider(
    "openai-realtime",
    cloudDeps,
    { mode: "openwhispr", model: "gpt-4o-mini-transcribe", language: "en" },
    { streams: 2 }
  );
  // Meeting whose system audio is unsupported (connectRealtimeStreaming's single-stream
  // branch) — still carries model+language; streams defaults to 1.
  await fetchRealtimeTokenForProvider(
    "openai-realtime",
    cloudDeps,
    { mode: "openwhispr", model: "gpt-4o-mini-transcribe", language: undefined },
    { streams: 1 }
  );

  assert.deepEqual(wire, [
    { path: "/api/openai-realtime-token", json: '{"streams":1}' },
    {
      path: "/api/openai-realtime-token",
      json: '{"model":"gpt-4o-mini-transcribe","language":"en","streams":2}',
    },
    { path: "/api/openai-realtime-token", json: '{"model":"gpt-4o-mini-transcribe","streams":1}' },
  ]);
});
