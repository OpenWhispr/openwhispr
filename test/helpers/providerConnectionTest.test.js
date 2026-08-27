const assert = require("node:assert/strict");
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
  } finally {
    delete process.env.OPENAI_BASE_URL;
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
