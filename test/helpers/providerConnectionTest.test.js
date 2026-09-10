const test = require("node:test");
const assert = require("node:assert/strict");
const providerTest = require("../../src/helpers/providerConnectionTest");

const { resolveProviderRequest, resolveXaiProviderTestConfig, testProviderConnection } =
  providerTest;

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
  } finally {
    delete process.env.OPENAI_BASE_URL;
  }
});

test("the realtime STT providers use their own auth schemes, not Bearer", () => {
  const deepgram = resolveProviderRequest({ provider: "deepgram", apiKey: "dg-secret" });
  assert.equal(deepgram.endpoint, "https://api.deepgram.com/v1/models");
  assert.equal(deepgram.endpoint.includes("dg-secret"), false);
  assert.equal(deepgram.headers.Authorization, "Token dg-secret");

  const assemblyai = resolveProviderRequest({ provider: "assemblyai", apiKey: "aai-secret" });
  assert.equal(assemblyai.endpoint, "https://api.assemblyai.com/v2/transcript?limit=1");
  assert.equal(assemblyai.endpoint.includes("aai-secret"), false);
  assert.equal(assemblyai.headers.Authorization, "aai-secret");
});

// Neither payload is OpenAI-shaped, so responseOffersModel would report
// modelNotFound for a perfectly valid key.
test("a 200 is the whole signal for providers with no OpenAI-shaped model list", async () => {
  for (const [provider, model, payload] of [
    ["deepgram", "nova-3", { stt: [{ name: "nova-3", canonical_name: "nova-3-general" }] }],
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

test("xAI SuperGrok session is a successful connection test", async () => {
  assert.deepEqual(await testProviderConnection({ provider: "xai", oauthSessionValid: true }), {
    success: true,
  });
});

test("xAI grok-stt does not have to appear on /v1/models", async () => {
  assert.deepEqual(
    await testProviderConnection(
      { provider: "xai", apiKey: "k", model: "grok-stt" },
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "grok-3" }] }),
      })
    ),
    { success: true }
  );
});

test("xAI resolver uses SuperGrok token when console key is empty", async () => {
  const resolved = await resolveXaiProviderTestConfig(
    { provider: "xai", apiKey: "  " },
    { getValidAccessToken: async () => "oauth-bearer" }
  );
  assert.equal(resolved.apiKey, "oauth-bearer");
  assert.equal(resolved.oauthSessionValid, true);
});

test("xAI resolver keeps a SuperGrok session if token refresh fails", async () => {
  const resolved = await resolveXaiProviderTestConfig(
    { provider: "xai", oauthConnected: true },
    {
      getValidAccessToken: async () => {
        const error = new Error("expired");
        error.name = "ReauthRequired";
        throw error;
      },
    }
  );
  assert.equal(resolved.apiKey, undefined);
  assert.equal(resolved.oauthSessionValid, true);
});

test("xAI resolver requires a key when SuperGrok is disconnected", async () => {
  assert.equal(
    await resolveXaiProviderTestConfig(
      { provider: "xai" },
      { getValidAccessToken: async () => null, status: async () => ({ connected: false }) }
    ),
    null
  );
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
