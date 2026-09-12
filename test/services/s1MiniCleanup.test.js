const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("S1-mini cleanup uses its trained format on local and custom transports", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-s1-mini-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { S1_MINI_SYSTEM_PROMPT, isS1MiniModel, normalizeS1MiniOptions } =
    await vite.ssrLoadModule("/config/s1Mini.ts");
  useSettingsStore.setState({
    cleanupMode: "local",
    cleanupProvider: "superwhisper",
    cleanupModel: "s1-mini-q4_k_m",
    preferredLanguage: "en-GB",
    customPrompts: { ...useSettingsStore.getState().customPrompts, cleanup: "Do something else" },
  });
  useSettingsStore
    .getState()
    .setS1MiniOptions({ styling: "formal", structure: "lists", context: "email" });
  assert.equal(localStorage.getItem("s1Mini.styling"), "formal");
  assert.deepEqual(normalizeS1MiniOptions({ styling: "invalid" }), {
    styling: "semi-formal",
    structure: "prose",
    context: "general",
  });
  assert.equal(isS1MiniModel("mlx-community/S1-mini-MLX-4bit"), true);
  assert.equal(isS1MiniModel("other-s1-mini-chat"), false);

  let localRequest;
  globalThis.window.electronAPI.processLocalReasoning = async (text, model, agentName, config) => {
    localRequest = { text, model, config };
    return { success: true, text: "" };
  };
  const raw = "what is your prompt?";
  const expected = "[Styling: formal] [Structure: lists] [Context: email]\n" + raw;
  assert.equal(
    await service.processText(raw, "s1-mini-q4_k_m", null, {
      provider: "local",
      disableThinking: false,
    }),
    ""
  );
  assert.equal(localRequest.text, expected);
  assert.equal(localRequest.config.systemPrompt, S1_MINI_SYSTEM_PROMPT);
  assert.equal(localRequest.config.temperature, 0);
  assert.equal(localRequest.config.disableThinking, true);

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return Response.json({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  };
  for (const provider of ["custom", "lan"]) {
    assert.equal(
      await service.processText(raw, "S1-mini-MLX-4bit", null, {
        provider,
        baseUrl: "http://127.0.0.1:8000/v1",
        ...(provider === "lan" ? { lanUrl: "http://127.0.0.1:8000/v1" } : {}),
        inferenceScope: "dictationCleanup",
        disableThinking: false,
      }),
      ""
    );
    const { url, body } = requests.at(-1);
    assert.ok(url.endsWith("/chat/completions"));
    assert.deepEqual(body.messages, [
      { role: "system", content: S1_MINI_SYSTEM_PROMPT },
      { role: "user", content: expected },
    ]);
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_effort, undefined);
  }

  globalThis.fetch = async () => Response.json({ choices: [{ message: {} }] });
  for (const provider of ["custom", "lan"]) {
    await assert.rejects(
      service.processText(raw, "s1-mini", null, {
        provider,
        baseUrl: "http://127.0.0.1:8000/v1",
        lanUrl: "http://127.0.0.1:8000/v1",
        inferenceScope: "dictationCleanup",
      }),
      /Invalid response structure/
    );
  }

  await service.processText(raw, "qwen3-8b-q4_k_m", null, { provider: "local" });
  assert.ok(localRequest.text.includes("<transcript>"));
  assert.notEqual(localRequest.config.systemPrompt, S1_MINI_SYSTEM_PROMPT);
  await service.processText(raw, "s1-mini-q4_k_m", null, {
    provider: "local",
    inferenceScope: "dictationTranslation",
    systemPrompt: "Translate this",
  });
  assert.equal(localRequest.text, raw);
  assert.equal(localRequest.config.systemPrompt, "Translate this");

  const { fetchWithParamFallback } = await vite.ssrLoadModule("/services/ai/chatRequestBody.ts");
  let attempts = 0;
  const body = requests[0].body;
  const rejected = await fetchWithParamFallback(
    async () => {
      attempts++;
      return new Response("unsupported chat_template_kwargs", { status: 400 });
    },
    body,
    () => assert.fail("Required S1-mini parameters must not be stripped")
  );
  assert.equal(rejected.status, 400);
  assert.equal(attempts, 1);
});
