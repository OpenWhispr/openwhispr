const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const ENDPOINT = `${BASE}/chat/completions`;

const GEMINI_4_MODELS = ["gemini-4-neon", "gemini-4-hydrogen"];

async function setup(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-custom-gemini-" });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.4", policy: null });
  // The native catalog advertises fewer effort levels than Google's compatibility endpoint.
  const store = await vite.ssrLoadModule("/models/registryData.js");
  const data = structuredClone(store.getRegistrySnapshot().data);
  const gemini = data.cloudProviders.find((provider) => provider.id === "gemini");
  gemini.models = [
    ...gemini.models.filter((model) => !GEMINI_4_MODELS.includes(model.id)),
    ...GEMINI_4_MODELS.map((id) => ({
      id,
      name: id,
      description: id,
      supportsThinking: true,
      reasoningEffort: { options: ["low", "medium", "high"], defaultValue: "high" },
    })),
  ];
  store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
  return vite;
}

const cases = [
  ...[BASE, `${BASE}/`, ENDPOINT].map((baseUrl) => ({ baseUrl, model: "gemini-3.8-flash" })),
  ...GEMINI_4_MODELS.flatMap((model) =>
    ["minimal", "xhigh"].map((reasoningEffort) => ({ baseUrl: ENDPOINT, model, reasoningEffort }))
  ),
];

for (const { baseUrl, model, reasoningEffort } of cases) {
  const scenario = `${baseUrl} (${model}, ${reasoningEffort ?? "Auto"})`;
  test(`Custom Gemini routes actual raw cleanup through the documented endpoint: ${scenario}`, async (t) => {
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
      model,
      agentName: null,
      config: {
        provider: "custom",
        baseUrl,
        customApiKey: "synthetic-key",
        disableThinking: false,
        reasoningEffort,
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
    assert.equal(requests[0].body.model, model);
    assert.equal(requests[0].body.reasoning_effort, reasoningEffort);
    assert.ok(requests[0].body.messages[1].content.includes("Synthetic transcript"));
  });

  test(`Custom Gemini reaches the real AI SDK chat transport: ${scenario}`, async (t) => {
    const vite = await setup(t);
    const reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
    t.after(() => reasoning.destroy());
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const chunk = (delta, finish_reason) =>
        `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk({ content: "Offline answer." }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    });
    const output = [];
    for await (const event of reasoning.processTextStreamingAI(
      [{ role: "user", content: "Synthetic chat question" }],
      model,
      "custom",
      {
        systemPrompt: "Answer.",
        baseUrl,
        customApiKey: "synthetic-key",
        disableThinking: false,
        reasoningEffort,
      }
    ))
      output.push(event);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, ENDPOINT);
    assert.equal(requests[0].body.model, model);
    assert.equal(requests[0].body.reasoning_effort, reasoningEffort);
    assert.ok(output.some((event) => event.type === "content" && event.text === "Offline answer."));
  });
}

test("Gemini Custom effort choices stay scoped to the endpoint and model", async (t) => {
  const model = "gemini-4-neon";
  const vite = await setup(t);
  const { selectableReasoningEffort } = await vite.ssrLoadModule("/services/ai/chatRequestBody.ts");
  const offered = (provider, id, url) =>
    selectableReasoningEffort(provider, id, { disableThinking: false }, url).options;

  assert.deepEqual(offered("custom", model, ENDPOINT), [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(offered("gemini", model), ["low", "medium", "high"]);
  assert.deepEqual(offered("custom", model, "https://proxy.example/v1"), ["low", "medium", "high"]);
  assert.deepEqual(offered("custom", "gemini-4-argon", BASE), ["low", "medium", "high"]);
});

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
