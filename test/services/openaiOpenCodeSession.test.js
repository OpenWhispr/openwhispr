const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/inferenceProviders/openai.ts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

test("OpenCode Go requests carry one stable x-opencode-session id per call", async (t) => {
  const requests = [];
  installFetchRecorder(t, requests);

  const result = await callWithBase("https://opencode.ai/zen/go/v1");
  assert.equal(result, "Cleaned");

  const posts = requests.filter((r) => r.method === "POST");
  assert.deepEqual(
    posts.map((r) => r.endpoint),
    ["https://opencode.ai/zen/go/v1/responses", "https://opencode.ai/zen/go/v1/chat/completions"]
  );
  const ids = posts.map((r) => r.headers["x-opencode-session"]);
  assert.match(ids[0], UUID_RE);
  // The endpoint fallback belongs to the same conversation, so the id is reused.
  assert.equal(ids[1], ids[0]);
  assert.equal(posts[0].headers.Authorization, "Bearer test-key");
});

test("a second call is a new conversation with a different session id", async (t) => {
  const requests = [];
  installFetchRecorder(t, requests);

  await callWithBase("https://opencode.ai/zen/go/v1");
  const firstIds = new Set(requests.filter((r) => r.method === "POST").map((r) => r.headers["x-opencode-session"]));
  requests.length = 0;
  await callWithBase("https://opencode.ai/zen/go/v1");
  const secondIds = new Set(requests.filter((r) => r.method === "POST").map((r) => r.headers["x-opencode-session"]));

  assert.equal(firstIds.size, 1);
  assert.equal(secondIds.size, 1);
  assert.notDeepEqual([...firstIds], [...secondIds]);
});

test("other custom endpoints do not get the OpenCode header", async (t) => {
  const requests = [];
  installFetchRecorder(t, requests);

  await callWithBase("https://responses-only.example/v1");

  for (const r of requests.filter((r) => r.method === "POST")) {
    assert.equal("x-opencode-session" in r.headers, false, `${r.endpoint} carried the header`);
  }
});
