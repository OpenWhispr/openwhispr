const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The dictation panel is its own renderer and hydrates secrets once at startup,
// so its store copy of the cleanup key is empty, or an older key, when the user
// saves a key in the control panel afterwards. The self-hosted provider must ask
// for the key at call time instead of trusting that copy (#2351).
test("self-hosted cleanup sends the current cleanup key, not the store's stale copy", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-lan-cleanup-key-test-",
  });

  const { lanProvider } = await vite.ssrLoadModule("/services/ai/inferenceProviders/lan.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");

  useSettingsStore.setState({
    cleanupRemoteUrl: "http://10.10.10.121:8317/v1",
    cleanupCustomApiKey: "sk-stale",
  });

  const call = async (config) => {
    const seen = { keyRequests: [], apiKey: undefined, endpoint: undefined };
    const ctx = {
      getApiKey: async (provider) => {
        seen.keyRequests.push(provider);
        return provider === "custom" ? "sk-fresh" : "";
      },
      callChatCompletionsApi: async (endpoint, apiKey) => {
        seen.endpoint = endpoint;
        seen.apiKey = apiKey;
        return "cleaned";
      },
    };
    const result = await lanProvider.call({
      text: "hello",
      model: "some-model",
      agentName: null,
      config,
      ctx,
    });
    assert.equal(result, "cleaned");
    return seen;
  };

  await t.test("implicit cleanup fetches the cleanup key", async () => {
    const seen = await call({ inferenceScope: "dictationCleanup", provider: "lan" });
    assert.equal(seen.endpoint, "http://10.10.10.121:8317/v1/chat/completions");
    assert.equal(seen.apiKey, "sk-fresh");
  });

  await t.test("a per-call key still wins", async () => {
    const seen = await call({ provider: "lan", customApiKey: "sk-scope" });
    assert.equal(seen.apiKey, "sk-scope");
    assert.deepEqual(seen.keyRequests, []);
  });

  await t.test("a scope with its own endpoint never borrows the cleanup key", async () => {
    const seen = await call({ lanUrl: "http://192.168.1.20:9090" });
    assert.equal(seen.apiKey, "");
    assert.deepEqual(seen.keyRequests, []);
  });
});
