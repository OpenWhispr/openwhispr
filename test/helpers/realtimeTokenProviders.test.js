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
    getGeminiKey: () => "gm-key",
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

test("gemini byok duplicates the raw key; cloud mints one token per stream", async () => {
  const { fetchRealtimeTokenForProvider } = await load();
  // The raw key opens the Live socket itself and survives any number of
  // handshakes, so both streams share it.
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "gemini-realtime",
      deps(),
      { mode: "byok" },
      { streams: 2 }
    ),
    ["gm-key", "gm-key"]
  );
  // Managed tokens are minted with uses:1 — a shared token would be rejected
  // at the second handshake with close code 1011.
  let mints = 0;
  const cloudDeps = deps({ postServerToken: async () => ({ token: `gm-${++mints}` }) });
  assert.deepEqual(
    await fetchRealtimeTokenForProvider(
      "gemini-realtime",
      cloudDeps,
      { mode: "openwhispr" },
      { streams: 2 }
    ),
    ["gm-1", "gm-2"]
  );
  await assert.rejects(
    fetchRealtimeTokenForProvider("gemini-realtime", deps({ postServerToken: async () => ({}) }), {
      mode: "openwhispr",
    }),
    /No Gemini token received/
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
  const empty = {
    getOpenAIKey: () => "",
    getDeepgramKey: () => "",
    getAssemblyAIKey: () => "",
    getGeminiKey: () => "",
  };
  for (const provider of [
    "openai-realtime",
    "deepgram-realtime",
    "assemblyai-realtime",
    "gemini-realtime",
  ]) {
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
    // `body = {}` mirrors ipcHandlers' postServerToken default, so an entry that
    // posts no body at all is recorded as the `{}` it really sends.
    postServerToken: async (path, body = {}) => {
      // JSON.stringify drops undefined keys exactly like the real fetch does.
      wire.push({ path, json: JSON.stringify(body) });
      return { clientSecret: "cs-single", clientSecrets: ["cs-a", "cs-b"], token: "gm-token" };
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

  // Gemini's endpoint reads nothing from the request; it must post a bare body.
  await fetchRealtimeTokenForProvider("gemini-realtime", cloudDeps, { mode: "openwhispr" });

  assert.deepEqual(wire, [
    { path: "/api/openai-realtime-token", json: '{"streams":1}' },
    {
      path: "/api/openai-realtime-token",
      json: '{"model":"gpt-4o-mini-transcribe","language":"en","streams":2}',
    },
    { path: "/api/openai-realtime-token", json: '{"model":"gpt-4o-mini-transcribe","streams":1}' },
    { path: "/api/gemini-live-token", json: "{}" },
  ]);
});

// A Cloud note recording whose token request is refused used to toast the API's
// bare "Invalid session" / "Not authenticated"; these codes let it offer sign-in (#2427).
const serverTokenPoster = async (overrides = {}) => {
  const { createServerTokenPoster } = await load();
  return createServerTokenPoster({
    getApiUrl: () => "https://api.example",
    getAuthHeader: async () => ({ Authorization: "Bearer stale" }),
    proxyFetch: async () => jsonResponse(200, { clientSecret: "secret" }),
    withPolicyHeaders: (headers) => headers,
    classifyAndLog: () => ({ isNetworkError: false }),
    ...overrides,
  });
};

test("server tokens: a code-less 401 is AUTH_EXPIRED and keeps the server's message", async () => {
  const post = await serverTokenPoster({
    proxyFetch: async () => jsonResponse(401, { error: "Invalid session" }),
  });
  await assert.rejects(post("/api/openai-realtime-token"), {
    message: "Invalid session",
    code: "AUTH_EXPIRED",
    status: 401,
  });
});

test("server tokens: a missing credential is AUTH_REQUIRED and never reaches the API", async () => {
  let fetched = false;
  const post = await serverTokenPoster({
    getAuthHeader: async () => ({}),
    proxyFetch: async () => {
      fetched = true;
      return jsonResponse(200, {});
    },
  });
  await assert.rejects(post("/api/openai-realtime-token"), {
    message: "Not authenticated",
    code: "AUTH_REQUIRED",
  });
  assert.equal(fetched, false);
});

test("server tokens: codes the API sends are kept, and other refusals stay untagged", async () => {
  const refuse = async (status, body) =>
    (await serverTokenPoster({ proxyFetch: async () => jsonResponse(status, body) }))(
      "/api/openai-realtime-token"
    );
  await assert.rejects(refuse(401, { error: "Session expired", code: "SESSION_REVOKED" }), {
    code: "SESSION_REVOKED",
  });
  await assert.rejects(refuse(403, { error: "Blocked", code: "POLICY_BLOCKED" }), {
    code: "POLICY_BLOCKED",
  });
  await assert.rejects(refuse(500, null), (error) => {
    assert.equal(error.message, "Token request failed: 500");
    assert.equal(error.code, undefined);
    return true;
  });
});

test("server tokens: a network failure is NETWORK_ERROR, not a sign-in prompt", async () => {
  const post = await serverTokenPoster({
    proxyFetch: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    },
    classifyAndLog: () => ({
      isNetworkError: true,
      code: "ENOTFOUND",
      messageKey: "streaming.errors.cloudUnreachable.dnsBlocked",
    }),
  });
  await assert.rejects(post("/api/openai-realtime-token"), {
    code: "NETWORK_ERROR",
    networkCode: "ENOTFOUND",
  });
});

test("server tokens: a success posts the body with credential and policy headers", async () => {
  const requests = [];
  const post = await serverTokenPoster({
    proxyFetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, { clientSecret: "secret" });
    },
    withPolicyHeaders: (headers) => ({ ...headers, "x-policy": "applied" }),
  });
  assert.deepEqual(await post("/api/openai-realtime-token", { streams: 1 }), {
    clientSecret: "secret",
  });
  assert.equal(requests[0].url, "https://api.example/api/openai-realtime-token");
  assert.equal(requests[0].init.headers.Authorization, "Bearer stale");
  assert.equal(requests[0].init.headers["x-policy"], "applied");
  assert.equal(requests[0].init.body, '{"streams":1}');
});

test("server tokens: only session refusals count as sign-in refusals", async () => {
  const { isSignInRefusal } = await load();
  const refusal = async (overrides) => {
    try {
      await (
        await serverTokenPoster(overrides)
      )("/api/openai-realtime-token");
    } catch (error) {
      return error;
    }
    assert.fail("expected the token request to be refused");
  };
  assert.equal(
    isSignInRefusal(await refusal({ proxyFetch: async () => jsonResponse(401, {}) })),
    true
  );
  assert.equal(isSignInRefusal(await refusal({ getAuthHeader: async () => ({}) })), true);
  assert.equal(
    isSignInRefusal(
      await refusal({ proxyFetch: async () => jsonResponse(403, { code: "POLICY_BLOCKED" }) })
    ),
    false
  );
  assert.equal(
    isSignInRefusal(await refusal({ proxyFetch: async () => jsonResponse(500, null) })),
    false
  );
});
