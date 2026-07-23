const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HTTP_VALIDATORS,
  SUPPORTED_LLM_KEY_PROVIDERS,
  TINFOIL_VALIDATION_MODEL,
  TINFOIL_VALIDATION_INPUT,
  resolveCustomModelsUrl,
  validateLlmApiKey,
  validateAndSaveLlmApiKey,
} = require("../../src/helpers/llmKeyValidation");
const { BYOK_API_KEYS } = require("../../src/config/secretKeys");

function response(status, body = "") {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("every persisted BYOK provider has an API-key validator", () => {
  assert.deepEqual(
    [...SUPPORTED_LLM_KEY_PROVIDERS].sort(),
    BYOK_API_KEYS.map((entry) => entry.base).sort()
  );
});

test("HTTP validators use fixed provider endpoints and keep keys in auth headers", async () => {
  for (const [provider, expected] of Object.entries(HTTP_VALIDATORS)) {
    let captured;
    const result = await validateLlmApiKey(
      { provider, key: "  secret-key  " },
      {
        fetchImpl: async (url, init) => {
          captured = { url, init };
          return response(200, "{}");
        },
      }
    );

    assert.equal(result.success, true, `${provider} succeeds`);
    assert.equal(captured.url, expected.url, `${provider} uses its fixed endpoint`);
    assert.equal(captured.init.method, "GET");
    assert.equal(captured.init.redirect, "manual");
    assert.ok(
      Object.values(captured.init.headers).some((value) => value.includes("secret-key")),
      `${provider} sends the normalized key in an authentication header`
    );
    assert.ok(
      !captured.url.includes("secret-key"),
      `${provider} does not place the key in the URL`
    );
  }
});

test("Gemini uses x-goog-api-key instead of a query-string credential", async () => {
  let captured;
  await validateLlmApiKey(
    { provider: "gemini", key: "gemini-secret" },
    {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return response(200);
      },
    }
  );

  assert.equal(captured.init.headers["x-goog-api-key"], "gemini-secret");
  assert.equal(new URL(captured.url).searchParams.has("key"), false);
});

test("Tinfoil validation uses an authenticated embedding instead of the public model catalog", async () => {
  let clientOptions;
  let embeddingRequest;
  const result = await validateLlmApiKey(
    { provider: "tinfoil", key: " tinfoil-secret " },
    {
      createTinfoilClient: async (options) => {
        clientOptions = options;
        return {
          embeddings: {
            create: async (request) => {
              embeddingRequest = request;
            },
          },
          models: {
            list: async () => {
              throw new Error("the public model catalog must not be used for authentication");
            },
          },
        };
      },
      timeoutMs: 1234,
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.deepEqual(clientOptions, {
    apiKey: "tinfoil-secret",
    maxRetries: 0,
    timeout: 1234,
  });
  assert.deepEqual(embeddingRequest, {
    model: TINFOIL_VALIDATION_MODEL,
    input: TINFOIL_VALIDATION_INPUT,
  });
});

test("Tinfoil rejects a key when its authenticated SDK request returns 401", async () => {
  const result = await validateLlmApiKey(
    { provider: "tinfoil", key: "wrong-key" },
    {
      validateTinfoil: async () => {
        throw Object.assign(new Error("Incorrect API key provided"), { status: 401 });
      },
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(result.code, "INVALID_KEY");
});

test("custom validation accepts only credential-free HTTP(S) base URLs", () => {
  assert.equal(resolveCustomModelsUrl("https://example.com/v1/"), "https://example.com/v1/models");
  assert.equal(
    resolveCustomModelsUrl("http://127.0.0.1:11434/v1?ignored=true#fragment"),
    "http://127.0.0.1:11434/v1/models"
  );
  assert.equal(resolveCustomModelsUrl("file:///tmp/server"), null);
  assert.equal(resolveCustomModelsUrl("https://user:pass@example.com/v1"), null);
  assert.equal(resolveCustomModelsUrl("not a URL"), null);
});

test("custom validation tests the configured models endpoint without following redirects", async () => {
  let captured;
  const result = await validateLlmApiKey(
    {
      provider: "custom",
      key: "custom-secret",
      baseUrl: "https://llm.example/v1",
    },
    {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return response(200);
      },
    }
  );

  assert.equal(result.success, true);
  assert.equal(captured.url, "https://llm.example/v1/models");
  assert.equal(captured.init.headers.Authorization, "Bearer custom-secret");
  assert.equal(captured.init.redirect, "manual");
});

test("only definitive authentication failures block setup", async () => {
  const cases = [
    [401, "INVALID_KEY", false, false],
    [402, "BILLING_REQUIRED", false, true],
    [403, "PERMISSION_DENIED", false, true],
    [408, "TIMEOUT", true, true],
    [429, "RATE_LIMITED", true, true],
    [503, "PROVIDER_UNAVAILABLE", true, true],
  ];

  for (const [status, code, retryable, success] of cases) {
    const result = await validateLlmApiKey(
      { provider: "openai", key: "secret-key" },
      { fetchImpl: async () => response(status, '{"error":{"message":"provider detail"}}') }
    );
    assert.equal(result.success, success, `${status} setup outcome`);
    assert.equal(result.verified, false, `${status} is not verified`);
    assert.equal(result.code, code, `${status} maps to ${code}`);
    assert.equal(result.retryable, retryable, `${status} retryability`);
  }
});

test("Gemini's structured API_KEY_INVALID response remains a definitive rejection", async () => {
  const result = await validateLlmApiKey(
    { provider: "gemini", key: "wrong-key" },
    {
      fetchImpl: async () =>
        response(
          400,
          JSON.stringify({
            error: {
              status: "INVALID_ARGUMENT",
              details: [{ reason: "API_KEY_INVALID" }],
            },
          })
        ),
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "INVALID_KEY");
});

test("xAI's structured incorrect-key response remains a definitive rejection", async () => {
  const result = await validateLlmApiKey(
    { provider: "xai", key: "wrong-key" },
    {
      fetchImpl: async () =>
        response(
          400,
          JSON.stringify({
            code: "invalid-argument",
            error: "Incorrect API key provided. You can obtain an API key from the xAI console.",
          })
        ),
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "INVALID_KEY");
});

test("provider errors never expose response bodies that may contain the submitted key", async () => {
  const result = await validateLlmApiKey(
    { provider: "openai", key: "secret-key" },
    {
      fetchImpl: async () =>
        response(400, '{"error":{"message":"request included secret-key and failed"}}'),
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.verified, false);
  assert.equal(result.warning.includes("secret-key"), false);
  assert.equal(result.warning, "The API key could not be validated.");
});

test("network and timeout failures remain retryable without blocking setup", async () => {
  const network = await validateLlmApiKey(
    { provider: "openai", key: "secret-key" },
    {
      fetchImpl: async () => {
        throw new Error("socket closed");
      },
    }
  );
  assert.equal(network.success, true);
  assert.equal(network.verified, false);
  assert.equal(network.code, "NETWORK_ERROR");
  assert.equal(network.retryable, true);

  const timeout = await validateLlmApiKey(
    { provider: "openai", key: "secret-key" },
    {
      fetchImpl: async () => {
        const error = new Error("request timeout");
        error.name = "TimeoutError";
        throw error;
      },
    }
  );
  assert.equal(timeout.success, true);
  assert.equal(timeout.verified, false);
  assert.equal(timeout.code, "TIMEOUT");
  assert.equal(timeout.retryable, true);
});

test("validate-and-save never persists a rejected key", async () => {
  let saves = 0;
  const result = await validateAndSaveLlmApiKey(
    { provider: "openai", key: "bad-key" },
    {
      fetchImpl: async () => response(401),
      saveKey: async () => {
        saves += 1;
      },
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "INVALID_KEY");
  assert.equal(saves, 0);
});

test("validate-and-save persists exactly once after successful validation", async () => {
  const saved = [];
  const result = await validateAndSaveLlmApiKey(
    { provider: "openai", key: "  good-key  " },
    {
      fetchImpl: async () => response(200),
      saveKey: async (key) => saved.push(key),
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.deepEqual(saved, ["good-key"]);
});

test("validate-and-save persists an unverified key when the provider test is inconclusive", async () => {
  const saved = [];
  const result = await validateAndSaveLlmApiKey(
    { provider: "openai", key: "possibly-good-key" },
    {
      fetchImpl: async () => response(503),
      saveKey: async (key) => saved.push(key),
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.verified, false);
  assert.equal(result.code, "PROVIDER_UNAVAILABLE");
  assert.deepEqual(saved, ["possibly-good-key"]);
});

test("key removal skips network validation and awaits deletion", async () => {
  let fetches = 0;
  const saved = [];
  const result = await validateAndSaveLlmApiKey(
    { provider: "openai", key: "  " },
    {
      fetchImpl: async () => {
        fetches += 1;
        return response(500);
      },
      saveKey: async (key) => saved.push(key),
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.removed, true);
  assert.equal(fetches, 0);
  assert.deepEqual(saved, [""]);
});

test("a secure-storage failure is reported after validation", async () => {
  const result = await validateAndSaveLlmApiKey(
    { provider: "openai", key: "good-key" },
    {
      fetchImpl: async () => response(200),
      saveKey: async () => {
        throw new Error("disk full");
      },
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "PERSISTENCE_FAILED");
  assert.equal(result.retryable, true);
});
