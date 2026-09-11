const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/inferenceProviders/openai.ts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// openai.ts caches the winning endpoint per base in a module-level Map, so a base
// shared between tests would make them order-dependent: the first test's fallback
// pins "chat" and the next one never attempts /responses. One base per test.
const APEX_BASE = "https://opencode.ai/zen/go/v1";
const SUBDOMAIN_BASE = "https://api.opencode.ai/zen/go/v1";
const OTHER_BASE = "https://responses-only.example/v1";

function makeCtx() {
  return {
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
}

/** Serve /models as unavailable, /responses as unsupported, /chat/completions as success. */
function installFetchRecorder(t, requests) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init = {}) => {
    const endpoint = String(input);
    const method = init.method || "GET";
    requests.push({ method, endpoint, headers: init.headers || {} });

    if (method === "GET" && endpoint.endsWith("/models")) {
      return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (endpoint.endsWith("/responses")) {
      return new Response(JSON.stringify({ error: { message: "not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (endpoint.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Cleaned" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  };
}

async function callWithBase(baseUrl) {
  const { openaiProvider } = await load();
  return openaiProvider.call({
    text: "Clean this transcript please",
    model: "kimi-k2.5",
    agentName: null,
    config: {
      provider: "custom",
      baseUrl,
      customApiKey: "test-key",
      systemPrompt: "Clean the transcript",
    },
    ctx: makeCtx(),
  });
}

const sessionIdsOf = (requests) =>
  requests.filter((r) => r.method === "POST").map((r) => r.headers["x-opencode-session"]);

test("OpenCode Go requests carry one stable x-opencode-session id per call", async (t) => {
  const requests = [];
  installFetchRecorder(t, requests);

  const result = await callWithBase(APEX_BASE);
  assert.equal(result, "Cleaned");

  const posts = requests.filter((r) => r.method === "POST");
  assert.deepEqual(
    posts.map((r) => r.endpoint),
    [`${APEX_BASE}/responses`, `${APEX_BASE}/chat/completions`]
  );
  const ids = sessionIdsOf(requests);
  assert.match(ids[0], UUID_RE);
  // The endpoint fallback belongs to the same conversation, so the id is reused.
  assert.equal(ids[1], ids[0]);
  assert.equal(posts[0].headers.Authorization, "Bearer test-key");
});

test("a second call is a new conversation with a different session id", async (t) => {
  const requests = [];
  installFetchRecorder(t, requests);

  await callWithBase(SUBDOMAIN_BASE);
  const firstCallIds = sessionIdsOf(requests);
  requests.length = 0;
  await callWithBase(SUBDOMAIN_BASE);
  const secondCallIds = sessionIdsOf(requests);

  // The first call pays the /responses fallback, so it proves per-call stability;
  // the second reuses the remembered endpoint and is a single request.
  assert.equal(firstCallIds.length, 2);
  assert.equal(new Set(firstCallIds).size, 1);
  assert.equal(new Set(secondCallIds).size, 1);
  assert.match(secondCallIds[0], UUID_RE);
  assert.notEqual(secondCallIds[0], firstCallIds[0]);
});

test("other custom endpoints do not get the OpenCode header", async (t) => {
  const requests = [];
  installFetchRecorder(t, requests);

  await callWithBase(OTHER_BASE);

  const posts = requests.filter((r) => r.method === "POST");
  assert.deepEqual(
    posts.map((r) => r.endpoint),
    [`${OTHER_BASE}/responses`, `${OTHER_BASE}/chat/completions`]
  );
  for (const r of posts) {
    assert.equal("x-opencode-session" in r.headers, false, `${r.endpoint} carried the header`);
  }
});
