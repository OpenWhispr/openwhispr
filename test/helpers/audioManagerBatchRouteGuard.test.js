const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// A realtime-only BYOK provider reaches the batch path only when streaming was
// skipped (no key) — the route guard must speak first, because the key read
// that used to run ahead of it falls into the OpenAI branch and blames a key
// the provider never uses.

async function loadManager(t) {
  const harness = await loadAudioManager(t, {
    cachePrefix: "openwhispr-batch-route-guard-test-",
    settingsKey: "__batchRouteGuardSettings",
  });
  const { usePolicyStore } = await harness.vite.ssrLoadModule("/stores/policyStore.ts");
  return { ...harness, usePolicyStore };
}

function setSettings(overrides = {}) {
  globalThis.__batchRouteGuardSettings = {
    useLocalWhisper: false,
    transcriptionMode: "providers",
    remoteTranscriptionUrl: "",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "deepgram",
    cloudTranscriptionModel: "nova-3",
    deepgramApiKey: "",
    openaiApiKey: "",
    allowLocalFallback: false,
    preferredLanguage: "en",
    customDictionary: [],
    ...overrides,
  };
}

const audioBlob = () => new Blob([new Uint8Array(1600)], { type: "audio/webm" });

test("batch dictation on a keyless realtime-only provider reports the missing key, not OpenAI's", async (t) => {
  const { createManager } = await loadManager(t);
  const manager = createManager();
  setSettings();
  let openAiKeyReads = 0;
  globalThis.window.electronAPI.getOpenAIKey = async () => {
    openAiKeyReads += 1;
    return "";
  };

  await assert.rejects(manager.processWithOpenAIAPI(audioBlob()), (error) => {
    assert.equal(error.code, "API_KEY_MISSING");
    assert.equal(error.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.doesNotMatch(error.message, /OpenAI/);
    return true;
  });
  assert.equal(openAiKeyReads, 0, "the route guard runs before any key read");
});

test("batch dictation on a keyed realtime-only provider fails closed on the transport", async (t) => {
  const { createManager } = await loadManager(t);
  const manager = createManager();
  setSettings({ deepgramApiKey: "dg-test" });
  globalThis.window.electronAPI.getOpenAIKey = async () => {
    throw new Error("must not read the OpenAI key");
  };

  await assert.rejects(manager.processWithOpenAIAPI(audioBlob()), (error) => {
    assert.equal(error.code, "STREAMING_ONLY_PROVIDER");
    assert.equal(error.messageKey, "hooks.audioRecording.errorDescriptions.streamingOnlyProvider");
    return true;
  });
});

for (const provider of ["openai", "groq"]) {
  for (const restriction of ["mode", "provider"]) {
    for (const stage of ["key loading", "request", "response body", "postprocessing"]) {
      test(`batch policy revocation during ${stage} stops ${provider} ${restriction}`, async (t) => {
        const { createManager, usePolicyStore, window } = await loadManager(t);
        setSettings({
          cloudTranscriptionProvider: provider,
          cloudTranscriptionModel: provider === "groq" ? "whisper-large-v3-turbo" : "whisper-1",
          allowLocalFallback: true,
        });
        const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
        usePolicyStore.setState({ status: "managed", policy, appVersion: "1.11.1" });
        const revoke = () => {
          const next = structuredClone(policy);
          if (restriction === "mode") next.transcription.allowedModes = ["local"];
          else next.transcription.allowedByokProviders = [];
          usePolicyStore.setState({ policy: next });
        };
        let fallbackCalls = 0;
        window.electronAPI.transcribeLocalWhisper = async () => {
          fallbackCalls++;
          return { success: true, text: "fallback output" };
        };
        const manager = createManager({
          getWhisperPrompt: () => null,
          shouldStreamTranscription: () => false,
          isDictionaryEcho: () => false,
          isReasoningAvailable: async () => false,
          getAPIKey: async () => {
            if (stage === "key loading") revoke();
            return "saved-key";
          },
          processTranscription: async (text) => {
            if (stage === "postprocessing") revoke();
            return text;
          },
        });
        let requestSignal;
        const request = t.mock.method(globalThis, "fetch", async (_url, init) => {
          requestSignal = init.signal;
          if (stage === "request") {
            await Promise.resolve();
            revoke();
          }
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "Content-Type": "application/json" }),
            text: async () => {
              if (stage === "response body") revoke();
              return JSON.stringify({ text: "revoked output" });
            },
          };
        });
        await assert.rejects(manager.processWithOpenAIAPI(audioBlob()), { name: "AbortError" });
        assert.equal(request.mock.callCount(), stage === "key loading" ? 0 : 1);
        if (requestSignal) assert.equal(requestSignal.aborted, true);
        assert.equal(fallbackCalls, 0);
      });
    }
  }

  test(`batch policy updates retain permitted ${provider} requests`, async (t) => {
    const { createManager, usePolicyStore } = await loadManager(t);
    setSettings({
      cloudTranscriptionProvider: provider,
      cloudTranscriptionModel: provider === "groq" ? "whisper-large-v3-turbo" : "whisper-1",
    });
    const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
    usePolicyStore.setState({ status: "managed", policy, appVersion: "1.11.1" });
    const manager = createManager({
      getAPIKey: async () => "saved-key",
      getWhisperPrompt: () => null,
      shouldStreamTranscription: () => false,
      isDictionaryEcho: () => false,
      processTranscription: async (text) => text,
      isReasoningAvailable: async () => false,
    });
    let requestSignal;
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requestSignal = init.signal;
      usePolicyStore.setState({
        policy: { ...policy, features: { ...policy.features, webSearchEnabled: false } },
      });
      return Response.json({ text: "permitted output" });
    });
    assert.equal((await manager.processWithOpenAIAPI(audioBlob())).text, "permitted output");
    assert.equal(requestSignal.aborted, false);
  });
}

for (const restriction of ["mode", "provider", "unrelated"]) {
  test(`proxied batch policy ${restriction} update during postprocessing fences xAI output`, async (t) => {
    const { createManager, usePolicyStore, window } = await loadManager(t);
    setSettings({
      cloudTranscriptionProvider: "xai",
      cloudTranscriptionModel: "grok-stt",
      allowLocalFallback: true,
    });
    const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
    usePolicyStore.setState({ status: "managed", policy, appVersion: "1.11.1" });
    const proxy = t.mock.fn(async () => ({ success: true, text: "provider output" }));
    window.electronAPI.proxyXaiTranscription = proxy;
    const fallback = t.mock.fn(async () => ({ success: true, text: "fallback output" }));
    window.electronAPI.transcribeLocalWhisper = fallback;
    const manager = createManager({
      getAPIKey: async () => "saved-key",
      getWhisperPrompt: () => null,
      getCustomDictionaryPromptTiers: () => [],
      getKeyterms: () => [],
      stripTrailingDictionaryEcho: (text) => text,
      isDictionaryEcho: () => false,
      isReasoningAvailable: async () => false,
      processTranscription: async (text) => {
        const next = structuredClone(policy);
        if (restriction === "mode") next.transcription.allowedModes = ["local"];
        else if (restriction === "provider") next.transcription.allowedByokProviders = [];
        else next.features.webSearchEnabled = false;
        usePolicyStore.setState({ policy: next });
        return text;
      },
    });
    const result = manager.processWithOpenAIAPI(audioBlob());
    if (restriction === "unrelated") assert.equal((await result).text, "provider output");
    else await assert.rejects(result, { name: "AbortError" });
    assert.equal(proxy.mock.callCount(), 1);
    assert.equal(fallback.mock.callCount(), 0);
  });
}
