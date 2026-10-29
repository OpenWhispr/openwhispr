const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const ENDPOINT = `${BASE}/chat/completions`;

async function setup(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-custom-gemini-" });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.4", policy: null });
  return vite;
}

for (const baseUrl of [BASE, `${BASE}/`, ENDPOINT]) {
  test(`Custom Gemini routes actual raw cleanup through the documented endpoint: ${baseUrl}`, async (t) => {
    const vite = await setup(t);
    const { openaiProvider } = await vite.ssrLoadModule(
      "/services/ai/inferenceProviders/openai.ts"
    );
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      requests.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      return Response.json({
        choices: [{ message: { content: "Clean text." }, finish_reason: "stop" }],
      });
    });
    const result = await openaiProvider.call({
      text: "Synthetic transcript",
      model: "gemini-3.8-flash",
      agentName: null,
      config: {
        provider: "custom",
        baseUrl,
        customApiKey: "synthetic-key",
        disableThinking: false,
      },
      ctx: {
        getApiKey: async () => {
          throw new Error("must use explicit synthetic key");
        },
        getSystemPrompt: () => "Clean the transcript.",
        calculateMaxTokens: () => 4096,
      },
    });
    assert.equal(result, "Clean text.");
    assert.equal(requests.length, 1, "no models probe or Responses request");
    assert.equal(requests[0].url, ENDPOINT);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].body.model, "gemini-3.8-flash");
    assert.ok(requests[0].body.messages[1].content.includes("Synthetic transcript"));
  });

  test(`Custom Gemini reaches the real AI SDK chat transport: ${baseUrl}`, async (t) => {
    const vite = await setup(t);
    const reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
    t.after(() => reasoning.destroy());
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const chunk = (delta, finish_reason) =>
        `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "gemini-3.8-flash", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk({ content: "Offline answer." }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    });
    const output = [];
    for await (const event of reasoning.processTextStreamingAI(
      [{ role: "user", content: "Synthetic chat question" }],
      "gemini-3.8-flash",
      "custom",
      { systemPrompt: "Answer.", baseUrl, customApiKey: "synthetic-key", disableThinking: false }
    ))
      output.push(event);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, ENDPOINT);
    assert.equal(requests[0].body.model, "gemini-3.8-flash");
    assert.ok(output.some((event) => event.type === "content" && event.text === "Offline answer."));
  });
}

test("only the exact Gemini compatibility host/path bypasses the extra v1 suffix", async () => {
  const { ensureV1Suffix, buildApiUrl } = await import("../../src/config/constants.ts");
  assert.equal(ensureV1Suffix(`${BASE}?alt=json#synthetic`), `${BASE}?alt=json#synthetic`);
  assert.equal(
    buildApiUrl(ensureV1Suffix(`${BASE}?alt=json`), "/chat/completions"),
    `${ENDPOINT}?alt=json`
  );
  assert.equal(
    ensureV1Suffix("https://gateway.example/openai"),
    "https://gateway.example/openai/v1"
  );
  assert.equal(
    ensureV1Suffix("https://generativelanguage.googleapis.com.example/openai"),
    "https://generativelanguage.googleapis.com.example/openai/v1"
  );
});

test("Custom still rejects native Gemini URLs and other non-compatible provider routes", async (t) => {
  const vite = await setup(t);
  const { resolveConfiguredOpenAIBase } = await vite.ssrLoadModule("/services/ai/openaiBase.ts");
  for (const url of [
    "https://generativelanguage.googleapis.com/v1beta",
    "https://generativelanguage.googleapis.com/v1beta/models",
    "https://generativelanguage.googleapis.com/v1beta/openai-evil",
    "https://GENERATIVELANGUAGE.GOOGLEAPIS.COM/v1beta",
    "http://generativelanguage.googleapis.com/v1beta/openai",
    "https://generativelanguage.googleapis.com:8443/v1beta/openai",
    "https://generativelanguage.googleapis.com.example/v1beta/openai",
    "https://api.anthropic.com/v1",
    "https://api.groq.com/openai/v1",
    "https://inference.tinfoil.sh/v1",
  ]) {
    assert.throws(() => resolveConfiguredOpenAIBase("custom", url), {
      code: "CUSTOM_ENDPOINT_INVALID",
    });
  }
});
