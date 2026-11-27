const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/inferenceProviders/openai.ts");

const providerContext = {
  getApiKey: async () => "test-key",
  getSystemPrompt: () => "Clean the transcript",
  getCustomDictionary: () => [],
  getPreferredLanguage: () => "en",
  getUiLanguage: () => "en",
  callChatCompletionsApi: async () => {
    throw new Error("Unexpected chat completions delegation");
  },
  calculateMaxTokens: () => 4096,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const chatReply = (text) => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] });

// `serves(url)` returns a Response for a POST the fake server handles, or
// undefined for a 404. Model discovery (GET /models) always 404s here.
function installFetch(t, serves) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requested = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    requested.push(`${method} ${url}`);
    if (method === "GET") return json({}, 404);
    return serves(url) ?? json({ error: { message: "Not Found" } }, 404);
  };
  return requested;
}

// openai.ts caches per base URL at module scope, so every test uses its own host.
function callCustom(baseUrl) {
  return load().then(({ openaiProvider }) =>
    openaiProvider.call({
      text: "raw transcript",
      model: "openai/gpt-4o-mini",
      agentName: null,
      config: { provider: "custom", baseUrl, customApiKey: "test-key" },
      ctx: providerContext,
    })
  );
}

test("a gateway base without /v1 falls back to the base as typed when /v1 404s", async (t) => {
  const requested = installFetch(t, (url) =>
    url === "https://gateway.example/model/v1/openai/chat/completions"
      ? json(chatReply("Cleaned"))
      : undefined
  );

  const result = await callCustom("https://gateway.example/model/v1/openai");

  assert.equal(result, "Cleaned");
  assert.deepEqual(
    requested.filter((r) => r.startsWith("POST")),
    [
      "POST https://gateway.example/model/v1/openai/v1/responses",
      "POST https://gateway.example/model/v1/openai/v1/chat/completions",
      "POST https://gateway.example/model/v1/openai/responses",
      "POST https://gateway.example/model/v1/openai/chat/completions",
    ]
  );
});

test("the typed base that answered is reused without retrying /v1", async (t) => {
  const base = "https://gateway-reuse.example/openai";
  const requested = installFetch(t, (url) =>
    url === `${base}/chat/completions` ? json(chatReply("Cleaned")) : undefined
  );

  await callCustom(base);
  requested.length = 0;
  const result = await callCustom(base);

  assert.equal(result, "Cleaned");
  assert.deepEqual(requested, [`POST ${base}/chat/completions`]);
});

test("a cached typed base can recover through /v1 when the typed route disappears", async (t) => {
  const base = "https://gateway-recover.example/openai";
  let servingBase = base;
  const requested = installFetch(t, (url) =>
    url === `${servingBase}/chat/completions` ? json(chatReply("Cleaned")) : undefined
  );

  assert.equal(await callCustom(base), "Cleaned");
  servingBase = `${base}/v1`;
  requested.length = 0;
  assert.equal(await callCustom(base), "Cleaned");
  assert.deepEqual(requested, [
    `POST ${base}/chat/completions`,
    `POST ${base}/v1/chat/completions`,
  ]);

  requested.length = 0;
  assert.equal(await callCustom(base), "Cleaned");
  assert.deepEqual(requested, [`POST ${base}/v1/chat/completions`]);
});

test("a cached direct Responses route that returns 404 prefers /v1 after recovery", async (t) => {
  const endpoint = "https://gateway-direct-responses.example/openai/responses";
  let servingVersionedRoute = false;
  const requested = installFetch(t, (url) => {
    if (!servingVersionedRoute && url === endpoint) return json({ output_text: "Cleaned" });
    if (servingVersionedRoute && url === `${endpoint}/v1/chat/completions`) {
      return json(chatReply("Cleaned"));
    }
  });

  assert.equal(await callCustom(`${endpoint}/`), "Cleaned");
  servingVersionedRoute = true;
  requested.length = 0;
  assert.equal(await callCustom(`${endpoint}/`), "Cleaned");
  assert.deepEqual(requested, [`POST ${endpoint}`, `POST ${endpoint}/v1/chat/completions`]);

  requested.length = 0;
  assert.equal(await callCustom(`${endpoint}/`), "Cleaned");
  assert.deepEqual(requested, [`POST ${endpoint}/v1/chat/completions`]);
});

test("a cached direct Responses route does not switch bases on an authentication error", async (t) => {
  const endpoint = "https://gateway-direct-auth.example/openai/responses";
  let credentialsAccepted = true;
  const requested = installFetch(t, (url) => {
    if (url === endpoint) {
      return credentialsAccepted
        ? json({ output_text: "Cleaned" })
        : json({ error: { message: "Unauthorized" } }, 401);
    }
  });

  assert.equal(await callCustom(`${endpoint}/`), "Cleaned");
  credentialsAccepted = false;
  requested.length = 0;
  await assert.rejects(callCustom(`${endpoint}/`), { code: "PROVIDER_AUTH_FAILED" });
  assert.deepEqual(requested, [`POST ${endpoint}`]);
});

test("an unusable typed-base response does not pin later requests to that base", async (t) => {
  const base = "https://gateway-invalid-reply.example/openai";
  let versionedRouteReady = false;
  const requested = installFetch(t, (url) => {
    if (versionedRouteReady && url === `${base}/v1/chat/completions`) {
      return json(chatReply("Cleaned"));
    }
    if (url === `${base}/chat/completions`) {
      return new Response("<html>Gateway landing page</html>", {
        headers: { "Content-Type": "text/html" },
      });
    }
  });

  await assert.rejects(callCustom(base), SyntaxError);
  versionedRouteReady = true;
  requested.length = 0;
  assert.equal(await callCustom(base), "Cleaned");
  assert.deepEqual(requested, [`POST ${base}/v1/chat/completions`]);
});

test("an empty typed-base completion does not establish a preferred base", async (t) => {
  const base = "https://gateway-empty-reply.example/openai";
  let versionedRouteReady = false;
  const requested = installFetch(t, (url) => {
    if (versionedRouteReady && url === `${base}/v1/chat/completions`) {
      return json(chatReply("Cleaned"));
    }
    if (url === `${base}/chat/completions`) return json(chatReply(""));
  });

  assert.equal(await callCustom(base), "raw transcript");
  versionedRouteReady = true;
  requested.length = 0;
  assert.equal(await callCustom(base), "Cleaned");
  assert.deepEqual(requested, [`POST ${base}/v1/chat/completions`]);
});

test("a bare origin still resolves to /v1 first and never tries the typed base", async (t) => {
  const requested = installFetch(t, (url) =>
    url === "http://localhost:11434/v1/chat/completions" ? json(chatReply("Local")) : undefined
  );

  const result = await callCustom("http://localhost:11434");

  assert.equal(result, "Local");
  assert.deepEqual(requested, [
    "GET http://localhost:11434/v1/models",
    "POST http://localhost:11434/v1/responses",
    "POST http://localhost:11434/v1/chat/completions",
  ]);
});

test("a missing model on a bare origin reports the /v1 error without root requests", async (t) => {
  const base = "http://localhost:12345";
  const requested = installFetch(t, (url) => {
    if (url === `${base}/v1/chat/completions`) {
      return json({ error: { message: "model not found" } }, 404);
    }
    if (url === `${base}/chat/completions`) {
      return json({ error: { message: "Unauthorized" } }, 401);
    }
  });

  await assert.rejects(callCustom(base), { code: "PROVIDER_MODEL_NOT_FOUND" });
  assert.deepEqual(requested, [
    `GET ${base}/v1/models`,
    `POST ${base}/v1/responses`,
    `POST ${base}/v1/chat/completions`,
  ]);
});

test("a base already ending in /v1 has no typed-base fallback", async (t) => {
  const requested = installFetch(t, () => undefined);

  await assert.rejects(callCustom("https://no-fallback.example/v1"));

  assert.deepEqual(
    requested.filter((r) => r.startsWith("POST")),
    [
      "POST https://no-fallback.example/v1/responses",
      "POST https://no-fallback.example/v1/chat/completions",
    ]
  );
});

test("when both bases 404, the /v1 base's error is surfaced", async (t) => {
  installFetch(t, (url) =>
    url === "https://unknown-model.example/api/v1/chat/completions"
      ? json({ error: { message: "model 'openai/gpt-4o-mini' not found" } }, 404)
      : undefined
  );

  await assert.rejects(callCustom("https://unknown-model.example/api"), (error) => {
    assert.equal(error.code, "PROVIDER_MODEL_NOT_FOUND");
    return true;
  });
});

test("a generic 404 on a final direct Responses route preserves the /v1 model error", async (t) => {
  const endpoint = "https://gateway-direct-model.example/openai/responses";
  installFetch(t, (url) =>
    url === `${endpoint}/v1/chat/completions`
      ? json({ error: { message: "model not found" } }, 404)
      : undefined
  );

  await assert.rejects(callCustom(`${endpoint}/`), { code: "PROVIDER_MODEL_NOT_FOUND" });
});

for (const endpoint of ["responses", "chat/completions"]) {
  test(`a typed-base ${endpoint} model error takes precedence over a generic /v1 404`, async (t) => {
    const base = `https://gateway-missing-model.example/${endpoint.split("/")[0]}/openai`;
    installFetch(t, (url) =>
      url === `${base}/${endpoint}`
        ? json({ error: { message: "model not found" } }, 404)
        : undefined
    );

    await assert.rejects(callCustom(base), {
      code: "PROVIDER_MODEL_NOT_FOUND",
      settingsTarget: "llms",
    });
  });
}
