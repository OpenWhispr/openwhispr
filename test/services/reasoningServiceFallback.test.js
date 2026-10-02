const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("cleanup fallbacks use independent keys and leave the primary selection unchanged", async (t) => {
  const { window } = installBrowserGlobals(t);
  Object.assign(window.electronAPI, {
    getOpenrouterKey: async () => "router-key",
    getGroqKey: async () => "groq-key",
  });
  const vite = await createRendererServer(t, { cachePrefix: "cleanup-model-fallback-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { modelRegistry } = await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const groqModel = modelRegistry.getCloudProviders().find((provider) => provider.id === "groq")
    .models[0].id;
  const settings = {
    cleanupMode: "providers",
    cleanupProvider: "openrouter",
    cleanupModel: "example/primary",
    cleanupFallbackEnabled: true,
    cleanupFallbackModels: [{ provider: "groq", model: groqModel }],
    enterpriseSetupMode: "manual",
  };
  useSettingsStore.setState(settings);
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, key: init.headers.Authorization, body: JSON.parse(init.body) });
    return requests.length === 1
      ? new Response("quota", { status: 429 })
      : Response.json({
          choices: [{ message: { content: "Hello world." }, finish_reason: "stop" }],
        });
  };
  assert.equal(
    await service.processText("hello world", settings.cleanupModel, null, {
      inferenceScope: "dictationCleanup",
    }),
    "Hello world."
  );
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /openrouter/);
  assert.match(requests[1].url, /groq/);
  assert.equal(requests[0].key, "Bearer router-key");
  assert.equal(requests[1].key, "Bearer groq-key");
  assert.equal(requests[1].body.model, groqModel);
  assert.deepEqual(requests[0].body.messages, requests[1].body.messages);
  assert.equal(useSettingsStore.getState().cleanupProvider, "openrouter");

  await t.test("same provider and model can use another named key", async () => {
    const profile = { id: "router-backup", provider: "openrouter", label: "Backup" };
    window.electronAPI.listFallbackKeys = async () => ({ success: true, profiles: [profile] });
    window.electronAPI.getFallbackKey = async (id, provider) =>
      id === profile.id && provider === profile.provider ? "backup-router-key" : null;
    useSettingsStore.setState({
      cleanupFallbackModels: [
        { provider: "openrouter", model: settings.cleanupModel, keyId: profile.id },
      ],
    });
    const keys = [];
    globalThis.fetch = async (_url, init) => {
      keys.push(init.headers.Authorization);
      return keys.length === 1
        ? new Response("quota", { status: 429 })
        : Response.json({ choices: [{ message: { content: "Hello." }, finish_reason: "stop" }] });
    };
    assert.equal(await service.processText("hello", settings.cleanupModel), "Hello.");
    assert.deepEqual(keys, ["Bearer router-key", "Bearer backup-router-key"]);
    assert.equal(await service.getApiKey("openrouter"), "router-key");
    window.electronAPI.listFallbackKeys = async () => ({ success: true, profiles: [] });
    keys.length = 0;
    globalThis.fetch = async (_url, init) => {
      keys.push(init.headers.Authorization);
      return new Response("quota", { status: 429 });
    };
    await assert.rejects(service.processText("hello", settings.cleanupModel), { status: 429 });
    assert.deepEqual(keys, ["Bearer router-key"]);
    useSettingsStore.setState({ cleanupFallbackModels: settings.cleanupFallbackModels });
  });
  await t.test("cancelling during a named key lookup prevents the backup request", async () => {
    window.electronAPI.listFallbackKeys = async () => ({
      success: true,
      profiles: [{ id: "backup", provider: "openrouter", label: "Backup" }],
    });
    window.electronAPI.getFallbackKey = async () => {
      service.cancelAllRequests();
      return "backup-key";
    };
    useSettingsStore.setState({
      cleanupFallbackModels: [
        { provider: "openrouter", model: settings.cleanupModel, keyId: "backup" },
      ],
    });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("quota", { status: 429 });
    };
    await assert.rejects(service.processText("hello", settings.cleanupModel), {
      name: "AbortError",
    });
    assert.equal(calls, 1);
    useSettingsStore.setState({ cleanupFallbackModels: settings.cleanupFallbackModels });
  });
  await t.test("unrelated scopes never use cleanup fallbacks", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response("bad input", { status: 400 });
    };
    await assert.rejects(
      service.processText("hi", "example/primary", null, {
        provider: "openrouter",
        inferenceScope: "chatIntelligence",
      })
    );
    assert.equal(called, true);
  });
  await t.test("invalid input does not advance the chain", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("bad input", { status: 400 });
    };
    await assert.rejects(service.processText("hi", settings.cleanupModel), { status: 400 });
    assert.equal(calls, 1);
  });
  await t.test("cancellation discards late success and starts no fallback", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      service.cancelAllRequests();
      return new Response("quota", { status: 429 });
    };
    await assert.rejects(service.processText("hi", settings.cleanupModel), { name: "AbortError" });
    assert.equal(calls, 1);
  });
  await t.test("cloud cleanup callback preserves the primary request and falls back", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({
        choices: [{ message: { content: "Hello." }, finish_reason: "stop" }],
      });
    };
    let cloudCalls = 0;
    const output = await service.processText(
      "hello",
      "",
      null,
      { provider: "openwhispr" },
      async () => {
        cloudCalls++;
        throw Object.assign(new Error("quota"), { status: 429 });
      }
    );
    assert.equal(output, "Hello.");
    assert.equal(cloudCalls, 1);
    assert.equal(calls, 1);
  });
});
