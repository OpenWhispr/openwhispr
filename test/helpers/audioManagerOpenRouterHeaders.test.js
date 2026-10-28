const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("dictation attributes OpenRouter requests and leaves other endpoints unattributed", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-dictation-attribution-" });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ text: "Hello world." }), {
      headers: { "content-type": "application/json" },
    });
  };

  for (const [provider, endpoint] of [
    ["custom", "https://openrouter.ai/api/v1/audio/transcriptions"],
    ["openai", "https://api.openai.com/v1/audio/transcriptions"],
  ]) {
    useSettingsStore.setState({ cloudTranscriptionProvider: provider });
    const manager = Object.assign(Object.create(AudioManager.prototype), {
      getEffectiveSttLanguage: () => "en",
      getTranscriptionModel: () => "openai/gpt-4o-mini-transcribe",
      resolveBatchRoute: () => ({ provider, endpoint }),
      getAPIKey: async () => "test-key",
      getTranscriptionEndpoint: () => endpoint,
      getCustomDictionaryPrompt: () => "",
      getWhisperPrompt: () => "",
      shouldStreamTranscription: () => false,
      isDictionaryEcho: () => false,
      stripTrailingDictionaryEcho: (text) => text,
      processTranscription: async (text) => text,
      isReasoningAvailable: async () => false,
    });
    const result = await manager.processWithOpenAIAPI(new Blob(["audio"], { type: "audio/wav" }));
    assert.equal(result.success, true, result.error);
    const headers = sent.at(-1).headers;
    assert.equal(headers.get("Authorization"), "Bearer test-key");
    assert.equal(
      headers.get("HTTP-Referer"),
      provider === "openai" ? null : "https://openwhispr.com"
    );
    assert.equal(headers.get("X-OpenRouter-Title"), provider === "openai" ? null : "OpenWhispr");
  }
  assert.equal(sent.length, 2);
});
