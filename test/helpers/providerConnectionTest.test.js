const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const providerTest = require("../../src/helpers/providerConnectionTest.js");

const { resolveProviderRequest, testProviderConnection } = providerTest;

test("builds provider tests without placing credentials in the URL", () => {
  const request = resolveProviderRequest({ provider: "openai", apiKey: "secret" });
  assert.equal(request.endpoint, "https://api.openai.com/v1/models");
  assert.equal(request.endpoint.includes("secret"), false);
  assert.equal(request.headers.Authorization, "Bearer secret");
});

test("honors OpenAI base URL overrides from the environment", () => {
  process.env.OPENAI_BASE_URL = "https://proxy.example.com/v1/";
  try {
    const request = resolveProviderRequest({ provider: "openai", apiKey: "secret" });
    assert.deepEqual(request.endpoints, ["https://proxy.example.com/v1/models"]);
    assert.equal(request.redirect, "follow");
  } finally {
    delete process.env.OPENAI_BASE_URL;
  }
});

test("the realtime STT providers use their own auth schemes, not Bearer", () => {
  const deepgram = resolveProviderRequest({ provider: "deepgram", apiKey: "dg-secret" });
  assert.equal(deepgram.endpoint, "https://api.deepgram.com/v1/auth/token");
  assert.equal(deepgram.endpoint.includes("dg-secret"), false);
  assert.equal(deepgram.headers.Authorization, "Token dg-secret");

  const assemblyai = resolveProviderRequest({ provider: "assemblyai", apiKey: "aai-secret" });
  assert.equal(assemblyai.endpoint, "https://api.assemblyai.com/v2/transcript?limit=1");
  assert.equal(assemblyai.endpoint.includes("aai-secret"), false);
  assert.equal(assemblyai.headers.Authorization, "aai-secret");
});

// AssemblyAI's payload is not OpenAI-shaped, so responseOffersModel would report
// modelNotFound for a perfectly valid key.
test("a 200 is the whole signal for providers with no OpenAI-shaped model list", async () => {
  for (const [provider, model, payload] of [
    ["assemblyai", "universal-streaming-english", { transcripts: [], page_details: {} }],
  ]) {
    assert.deepEqual(
      await testProviderConnection({ provider, apiKey: "k", model }, async () => ({
        ok: true,
        status: 200,
        json: async () => payload,
      })),
      { success: true },
      provider
    );

    assert.deepEqual(
      await testProviderConnection({ provider, apiKey: "bad", model }, async () => ({
        ok: false,
        status: 401,
      })),
      {
        success: false,
        errorCode: "credentialsRejected",
        error: "The provider rejected these credentials.",
        status: 401,
      },
      provider
    );
  }
});

test("normalizes custom compatible endpoints", () => {
  assert.equal(
    resolveProviderRequest({ provider: "custom", baseUrl: "localhost:11434/v1", apiKey: "" })
      .endpoint,
    "https://localhost:11434/v1/models"
  );
});

test("probes the /v1 sibling for bare custom origins", () => {
  assert.deepEqual(
    resolveProviderRequest({ provider: "custom", baseUrl: "http://localhost:1234", apiKey: "" })
      .endpoints,
    ["http://localhost:1234/models", "http://localhost:1234/v1/models"]
  );
  // LM Studio's native REST base maps to its OpenAI-compatible /v1 sibling.
  assert.deepEqual(
    resolveProviderRequest({ provider: "custom", baseUrl: "http://localhost:1234/api/v0" })
      .endpoints,
    ["http://localhost:1234/api/v0/models", "http://localhost:1234/v1/models"]
  );
});

// The runtime (isSecureHttpEndpoint in src/utils/urlUtils.ts) refuses plain
// HTTP on public hosts, so the test must refuse the same URLs — a passing test
// would otherwise commit a config every real request rejects.
test("rejects public HTTP endpoints but allows private hosts", async () => {
  assert.deepEqual(
    await testProviderConnection({ provider: "custom", baseUrl: "http://myserver.example.com/v1" }),
    {
      success: false,
      errorCode: "httpsRequired",
      error: "Public endpoints must use HTTPS. HTTP is only allowed on private addresses.",
    }
  );

  for (const baseUrl of [
    "http://localhost:1234",
    "http://192.168.1.10:8080/v1",
    "http://100.101.102.103/v1",
    "http://ollama.ts.net/v1",
  ]) {
    assert.equal(
      resolveProviderRequest({ provider: "custom", baseUrl }).endpoints.length > 0,
      true
    );
  }

  // A public DNS name that merely starts with a private prefix is still public.
  assert.equal(
    (await testProviderConnection({ provider: "custom", baseUrl: "http://10.example.com/v1" }))
      .errorCode,
    "httpsRequired"
  );
});

test("rejects invalid custom endpoints with error codes", async () => {
  assert.deepEqual(await testProviderConnection({ provider: "custom", baseUrl: "" }), {
    success: false,
    errorCode: "endpointRequired",
    error: "Enter an endpoint URL before testing.",
  });

  assert.deepEqual(await testProviderConnection({ provider: "custom", baseUrl: "ftp://x" }), {
    success: false,
    errorCode: "invalidUrl",
    error: "The endpoint must use HTTP or HTTPS.",
  });

  assert.deepEqual(await testProviderConnection({ provider: "unknown", apiKey: "k" }), {
    success: false,
    errorCode: "unsupportedProvider",
    error: "Connection testing is not available for this provider.",
  });

  assert.deepEqual(await testProviderConnection({ provider: "openai", apiKey: "" }), {
    success: false,
    errorCode: "apiKeyRequired",
    error: "Add an API key before testing.",
  });
});

test("maps authentication and transport failures to safe messages", async () => {
  assert.deepEqual(
    await testProviderConnection({ provider: "openai", apiKey: "bad" }, async () => ({
      ok: false,
      status: 401,
    })),
    {
      success: false,
      errorCode: "credentialsRejected",
      error: "The provider rejected these credentials.",
      status: 401,
    }
  );

  assert.deepEqual(
    await testProviderConnection({ provider: "openai", apiKey: "bad" }, async () => {
      throw new Error("secret upstream detail");
    }),
    { success: false, errorCode: "network", error: "The provider could not be reached." }
  );

  assert.deepEqual(
    await testProviderConnection({ provider: "openai", apiKey: "k" }, async () => ({
      ok: false,
      status: 500,
    })),
    {
      success: false,
      errorCode: "providerStatus",
      error: "The provider returned status 500.",
      status: 500,
    }
  );
});

test("succeeds when only the /v1 candidate responds", async () => {
  const attempted = [];
  const result = await testProviderConnection(
    { provider: "custom", baseUrl: "http://localhost:1234" },
    async (url) => {
      attempted.push(url);
      return url.includes("/v1/models") ? { ok: true, status: 200 } : { ok: false, status: 404 };
    }
  );
  assert.deepEqual(result, { success: true });
  assert.deepEqual(attempted, ["http://localhost:1234/models", "http://localhost:1234/v1/models"]);
});

test("rejects a successful model list that omits the selected model", async () => {
  assert.deepEqual(
    await testProviderConnection(
      { provider: "custom", baseUrl: "http://localhost:1234/v1", model: "typo-model" },
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "real-model" }] }),
      })
    ),
    {
      success: false,
      errorCode: "modelNotFound",
      error: "The selected model is not available from this provider.",
    }
  );
});

test("accepts selected models from OpenAI and Gemini model-list shapes", async () => {
  for (const payload of [
    { data: [{ id: "selected-model" }] },
    { models: [{ name: "models/selected-model" }] },
  ]) {
    assert.deepEqual(
      await testProviderConnection(
        { provider: "custom", baseUrl: "http://localhost:1234/v1", model: "selected-model" },
        async () => ({ ok: true, status: 200, json: async () => payload })
      ),
      { success: true }
    );
  }
});

// Anthropic's model list carries only dated snapshots of the aliases the registry uses.
test("accepts an Anthropic alias by its dated snapshot, but not a prefix", async () => {
  const check = (config, id) =>
    testProviderConnection({ apiKey: "k", ...config }, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id }] }),
    }));
  const snapshot = "claude-opus-4-5-20251101";
  assert.deepEqual(await check({ provider: "anthropic", model: "claude-opus-4-5" }, snapshot), {
    success: true,
  });
  assert.equal(
    (await check({ provider: "anthropic", model: "claude-opus-4" }, snapshot)).errorCode,
    "modelNotFound"
  );
  // A custom server matches ids exactly, so it would reject the undated id.
  const custom = { provider: "custom", baseUrl: "http://localhost:1234/v1", model: "foo" };
  assert.equal((await check(custom, "foo-20251001")).errorCode, "modelNotFound");
});

test("continues to a compatible candidate when an earlier model list omits the selection", async () => {
  const attempted = [];
  const result = await testProviderConnection(
    { provider: "custom", baseUrl: "http://localhost:1234", model: "selected-model" },
    async (url) => {
      attempted.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: url.includes("/v1/models") ? "selected-model" : "native-model" }],
        }),
      };
    }
  );

  assert.deepEqual(result, { success: true });
  assert.deepEqual(attempted, ["http://localhost:1234/models", "http://localhost:1234/v1/models"]);
});

test("reports endpointNotFound only after every candidate 404s", async () => {
  assert.deepEqual(
    await testProviderConnection(
      { provider: "custom", baseUrl: "http://localhost:1234" },
      async () => ({
        ok: false,
        status: 404,
      })
    ),
    {
      success: false,
      errorCode: "endpointNotFound",
      error: "The endpoint does not expose an OpenAI-compatible model list.",
      status: 404,
    }
  );

  // A credentials failure on any candidate outranks a 404 on another.
  assert.deepEqual(
    await testProviderConnection(
      { provider: "custom", baseUrl: "http://localhost:1234", apiKey: "bad" },
      async (url) => ({ ok: false, status: url.includes("/v1/models") ? 401 : 404 })
    ),
    {
      success: false,
      errorCode: "credentialsRejected",
      error: "The provider rejected these credentials.",
      status: 401,
    }
  );
});

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  // undefined is an empty body; a string is raw text (JSON.parse throws on non-JSON).
  json: async () => {
    if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
    return typeof body === "string" ? JSON.parse(body) : body;
  },
});

function recordingFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { calls, fetchImpl };
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const GEMINI_INVALID_KEY = {
  error: {
    code: 400,
    status: "INVALID_ARGUMENT",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "API_KEY_INVALID",
        domain: "googleapis.com",
      },
    ],
  },
};
const GEMINI_OTHER_REASON = {
  error: { code: 400, details: [{ reason: "API_KEY_SERVICE_BLOCKED" }] },
};
const XAI_BAD_KEY = { code: "invalid-argument", error: "Incorrect API key provided: xa***00." };
const CORTI_MALFORMED_HEADER = { message: "Missing or malformed Authorization header" };

test("any 2xx from Deepgram's key check passes, whatever the body or model", async () => {
  const { calls, fetchImpl } = recordingFetch(() => ({ ok: true, status: 200 }));
  const config = { provider: "deepgram", apiKey: "dg-key", model: "nova-3" };
  assert.deepEqual(await testProviderConnection(config, fetchImpl), { success: true });
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://api.deepgram.com/v1/auth/token"]
  );
});

test("Deepgram rejects a made-up key without trying the fallback", async () => {
  for (const status of [401, 403]) {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(status));
    const config = { provider: "deepgram", apiKey: "made-up" };
    const result = await testProviderConnection(config, fetchImpl);
    assert.equal(result.errorCode, "credentialsRejected");
    assert.equal(result.status, status);
    assert.deepEqual(
      calls.map((call) => call.url),
      ["https://api.deepgram.com/v1/auth/token"]
    );
  }
});

test("a retired Deepgram key route falls back to the key's project list", async () => {
  const { calls, fetchImpl } = recordingFetch((url) =>
    url.endsWith("/v1/auth/token") ? jsonResponse(404) : jsonResponse(200, { projects: [] })
  );
  const config = { provider: "deepgram", apiKey: "dg-key" };
  assert.deepEqual(await testProviderConnection(config, fetchImpl), { success: true });
  assert.deepEqual(
    calls.map((call) => [call.url, call.init.headers.Authorization, call.init.redirect]),
    [
      ["https://api.deepgram.com/v1/auth/token", "Token dg-key", "error"],
      ["https://api.deepgram.com/v1/projects", "Token dg-key", "error"],
    ]
  );
});

test("the project-list fallback passes only with its project list", async () => {
  const afterRetiredRoute = (answer) =>
    recordingFetch((url) => (url.endsWith("/v1/auth/token") ? jsonResponse(404) : answer))
      .fetchImpl;
  const config = { provider: "deepgram", apiKey: "dg-key" };
  assert.deepEqual(
    await testProviderConnection(config, afterRetiredRoute(jsonResponse(200, { data: [] }))),
    { success: false }
  );
  const rejected = await testProviderConnection(config, afterRetiredRoute(jsonResponse(401)));
  assert.equal(rejected.errorCode, "credentialsRejected");
});

test("a network failure on Deepgram's key check does not try the fallback", async () => {
  const { calls, fetchImpl } = recordingFetch(() => {
    throw new TypeError("fetch failed");
  });
  const result = await testProviderConnection({ provider: "deepgram", apiKey: "k" }, fetchImpl);
  assert.equal(result.errorCode, "network");
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://api.deepgram.com/v1/auth/token"]
  );
});

test("Deepgram's other failures keep their status and skip the fallback", async () => {
  for (const status of [400, 429, 500]) {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(status));
    const result = await testProviderConnection({ provider: "deepgram", apiKey: "k" }, fetchImpl);
    assert.equal(result.errorCode, "providerStatus", String(status));
    assert.equal(calls.length, 1, String(status));
  }
});

test("Anthropic and Gemini are asked for their largest page of models", () => {
  assert.equal(
    resolveProviderRequest({ provider: "anthropic", apiKey: "k" }).endpoint,
    "https://api.anthropic.com/v1/models?limit=1000"
  );
  assert.equal(
    resolveProviderRequest({ provider: "gemini", apiKey: "k" }).endpoint,
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
  );
});

test("Gemini, xAI and Corti rejections are read from the provider's error body", async () => {
  const cases = [
    ["gemini", 400, GEMINI_INVALID_KEY, "credentialsRejected"],
    ["gemini", 400, { error: { status: "FAILED_PRECONDITION" } }, "providerStatus"],
    ["gemini", 400, GEMINI_OTHER_REASON, "providerStatus"],
    ["gemini", 400, undefined, "providerStatus"],
    ["xai", 400, XAI_BAD_KEY, "credentialsRejected"],
    ["xai", 400, { error: "incorrect api KEY provided." }, "credentialsRejected"],
    ["xai", 400, { error: "Model grok-x does not exist" }, "providerStatus"],
    ["xai", 400, "Bad Request", "providerStatus"],
    ["xai", 500, XAI_BAD_KEY, "providerStatus"],
    ["corti", 400, undefined, "credentialsRejected"],
    ["corti", 400, "Bad Request", "credentialsRejected"],
    ["corti", 400, { message: "Unsupported model" }, "providerStatus"],
    ["corti", 401, CORTI_MALFORMED_HEADER, "credentialsRejected"],
    ["corti", 500, undefined, "providerStatus"],
  ];
  for (const [provider, status, body, errorCode] of cases) {
    const fetchImpl = async () => jsonResponse(status, body);
    const result = await testProviderConnection({ provider, apiKey: "made-up" }, fetchImpl);
    assert.equal(result.errorCode, errorCode, `${provider} ${status} ${JSON.stringify(body)}`);
    assert.equal(result.status, status);
  }
});

test("an error body that never arrives is a timeout or a network failure", async () => {
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  for (const [error, errorCode] of [
    [aborted, "timeout"],
    [new TypeError("terminated"), "network"],
  ]) {
    for (const provider of ["gemini", "xai", "corti"]) {
      const fetchImpl = async () => ({
        ok: false,
        status: 400,
        json: async () => {
          throw error;
        },
      });
      const result = await testProviderConnection({ provider, apiKey: "made-up" }, fetchImpl);
      assert.equal(result.errorCode, errorCode, `${provider} ${error.name}`);
    }
  }
});

test("a 401 or 403 is a rejection whatever its body does", async () => {
  let reads = 0;
  for (const provider of ["gemini", "xai", "corti"]) {
    for (const status of [401, 403]) {
      const fetchImpl = async () => ({
        ok: false,
        status,
        json: async () => {
          reads += 1;
          throw new TypeError("terminated");
        },
      });
      const result = await testProviderConnection({ provider, apiKey: "made-up" }, fetchImpl);
      assert.equal(result.errorCode, "credentialsRejected", `${provider} ${status}`);
    }
  }
  assert.equal(reads, 0, "the status alone decides");
});

test("the 12 s cap covers the whole answer, body included", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  // Like fetch's own promises, these settle only when the probe's signal aborts.
  const whenAborted = (signal) =>
    new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(aborted)));
  const stalls = {
    headers: (url, init) => whenAborted(init.signal),
    body: async (url, init) => ({ ok: false, status: 400, json: () => whenAborted(init.signal) }),
  };
  for (const [stage, fetchImpl] of Object.entries(stalls)) {
    const pending = testProviderConnection({ provider: "gemini", apiKey: "made-up" }, fetchImpl);
    await new Promise(setImmediate);
    t.mock.timers.tick(12000);
    const settled = await Promise.race([
      pending,
      new Promise((resolve) => setImmediate(resolve, { errorCode: "still pending" })),
    ]);
    assert.equal(settled.errorCode, "timeout", stage);
  }
});

test("other providers' error bodies are never read", async () => {
  let reads = 0;
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => {
      reads += 1;
      return { error: { message: "Incorrect API key provided: sk-ma****" } };
    },
  });
  for (const provider of ["openai", "groq", "mistral", "anthropic", "assemblyai", "deepgram"]) {
    const result = await testProviderConnection({ provider, apiKey: "k" }, fetchImpl);
    assert.equal(result.errorCode, "providerStatus", provider);
  }
  assert.equal(reads, 0);
});

test("a Corti key of only spaces is never sent", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
  };
  const result = await testProviderConnection({ provider: "corti", apiKey: "   " }, fetchImpl);
  assert.equal(result.errorCode, "apiKeyRequired");
  assert.equal(calls, 0);
});

test("hosted providers refuse redirects; custom servers keep following them", async () => {
  const hosted = [
    "openai",
    "groq",
    "xai",
    "mistral",
    "anthropic",
    "gemini",
    "openrouter",
    "corti",
    "tinfoil",
    "deepgram",
    "assemblyai",
  ];
  for (const provider of hosted) {
    assert.equal(resolveProviderRequest({ provider, apiKey: "k" }).redirect, "error", provider);
  }
  const custom = resolveProviderRequest({ provider: "custom", baseUrl: "http://localhost:1234" });
  assert.equal(custom.redirect, "follow");

  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, { data: [{ id: "m" }] }));
  await testProviderConnection({ provider: "openai", apiKey: "k", model: "m" }, fetchImpl);
  assert.equal(calls[0].init.redirect, "error");
});

test("a hosted provider's redirect fails before the key reaches another host", async (t) => {
  const received = [];
  const target = await listen(t, (request, response) => {
    received.push(request.headers["x-api-key"]);
    response.end("{}");
  });
  const origin = await listen(t, (request, response) => {
    response.writeHead(302, { location: `${target}/v1/models` }).end();
  });
  const inits = [];
  // Only the host changes: the real request, headers and redirect mode go to the local origin.
  const viaOrigin = (url, init) => {
    inits.push(init);
    return fetch(`${origin}${new URL(url).pathname}`, init);
  };
  const config = { provider: "anthropic", apiKey: "sk-ant-test", model: "claude-test" };
  assert.equal((await testProviderConnection(config, viaOrigin)).errorCode, "network");
  assert.deepEqual(received, []);
  // The same request allowed to follow would hand the key over, so this test can fail.
  await fetch(`${origin}/v1/models`, { ...inits[0], redirect: "follow", signal: undefined });
  assert.deepEqual(received, ["sk-ant-test"]);
});

test("a custom server can still redirect within itself", async (t) => {
  const base = await listen(t, (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(308, { location: "/v1/models/" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
  });
  const config = { provider: "custom", baseUrl: `${base}/v1`, model: "local-model" };
  assert.deepEqual(await testProviderConnection(config), { success: true });
});
