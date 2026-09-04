const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager: loadAudioManagerHarness } = require("./harness/audioManager");

// The shared harness supplies the renderer-graph stubs; this wrapper adds the
// no-op instance surface every manager in this suite needs.
async function loadAudioManager(t, { cachePrefix, settingsKey }) {
  const { window, vite, setSettings, createManager } = await loadAudioManagerHarness(t, {
    cachePrefix,
    settingsKey,
  });
  return {
    window,
    vite,
    setSettings,
    createManager: (overrides = {}) =>
      createManager({
        getEffectiveSttLanguage: () => "auto",
        getTranscriptionModel: () => "whisper-1",
        getAPIKey: async () => "test-key",
        getWhisperPrompt: () => null,
        getKeyterms: () => [],
        shouldStreamTranscription: () => false,
        isDictionaryEcho: () => false,
        processTranscription: async (text) => text,
        isReasoningAvailable: async () => false,
        ...overrides,
      }),
  };
}

// Replaces globalThis.fetch for the test and records every endpoint it saw.
function captureFetch(t, respond) {
  const originalFetch = globalThis.fetch;
  const endpoints = [];
  globalThis.fetch = async (endpoint, init) => {
    endpoints.push(String(endpoint));
    return respond(String(endpoint), init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return endpoints;
}

const okJson = (body) => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  text: async () => JSON.stringify(body),
});

const rejectFetch = (message) => () => {
  throw new Error(message);
};

function buildManagedPolicy(allowedTranscriptionModes) {
  return {
    version: 1,
    transcription: {
      allowedModes: allowedTranscriptionModes,
      allowedByokProviders: ["openai"],
    },
    llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
    features: { agentEnabled: false, webSearchEnabled: false },
    sharing: { externalLinkSharing: "disabled" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: false,
    },
    minAppVersion: null,
  };
}

test("cloud->local fallback under org policy", async (t) => {
  const { window, vite, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-cloud-fallback-test-",
    settingsKey: "__cloudFallbackSettings",
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");

  const audioBlob = {
    type: "audio/webm",
    size: 1024,
    arrayBuffer: async () => new ArrayBuffer(8),
  };
  setSettings({
    useLocalWhisper: false,
    allowLocalFallback: true,
    fallbackWhisperModel: "base",
    cloudTranscriptionProvider: "openai",
  });

  let localWhisperCalls = 0;
  window.electronAPI.transcribeLocalWhisper = async () => {
    localWhisperCalls += 1;
    return { success: true, text: "local text" };
  };

  const failingCloudManager = () =>
    createManager({
      getAPIKey: async () => {
        throw new Error("cloud transcription unavailable");
      },
    });

  const setManagedPolicy = (allowedTranscriptionModes) => {
    usePolicyStore.setState({
      accountId: "org-user",
      authGeneration: 1,
      revision: 1,
      status: "managed",
      managed: true,
      policy: buildManagedPolicy(allowedTranscriptionModes),
      appVersion: "1.8.1",
    });
  };

  await t.test(
    "policy-blocked fallback surfaces the cloud failure, not a policy error",
    async () => {
      setManagedPolicy(["providers"]);
      localWhisperCalls = 0;

      await assert.rejects(failingCloudManager().processWithOpenAIAPI(audioBlob, {}), (error) => {
        assert.notEqual(error.code, "POLICY_RESTRICTED");
        assert.match(error.message, /cloud transcription unavailable/);
        return true;
      });
      assert.equal(localWhisperCalls, 0, "blocked fallback must not run local transcription");
    }
  );

  await t.test("policy-allowed fallback still transcribes locally", async () => {
    setManagedPolicy(["providers", "local"]);
    localWhisperCalls = 0;

    const result = await failingCloudManager().processWithOpenAIAPI(audioBlob, {});
    assert.equal(result.success, true);
    assert.equal(result.text, "local text");
    assert.equal(result.source, "local-fallback");
    assert.equal(localWhisperCalls, 1);
  });
});

test("managed custom transcription never falls through to OpenAI", async (t) => {
  const { vite, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-managed-custom-endpoint-test-",
    settingsKey: "__managedCustomSettings",
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const fetched = captureFetch(t, rejectFetch("fetch must not run"));

  usePolicyStore.setState({
    accountId: "org-user",
    authGeneration: 1,
    revision: 1,
    status: "managed",
    managed: true,
    policy: {
      ...buildManagedPolicy(["providers"]),
      transcription: {
        allowedModes: ["providers"],
        allowedByokProviders: ["custom"],
      },
    },
    appVersion: "1.8.1",
  });

  const manager = createManager({ getAPIKey: async () => "should-not-leak" });

  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  for (const baseUrl of ["", "http://public.example.com/v1", "ftp://192.168.1.20/v1"]) {
    setSettings({
      allowLocalFallback: false,
      cloudTranscriptionBaseUrl: baseUrl,
      cloudTranscriptionProvider: "custom",
      transcriptionMode: "providers",
      useLocalWhisper: false,
    });

    await assert.rejects(manager.processWithOpenAIAPI(audioBlob), (error) => {
      assert.equal(error.code, "POLICY_RESTRICTED");
      assert.equal(error.messageKey, "common.policyTranscriptionRestricted");
      return true;
    });
  }

  assert.equal(fetched.length, 0);
});

test("unmanaged custom transcription fails closed instead of defaulting to OpenAI", async (t) => {
  const { vite, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-custom-endpoint-guard-test-",
    settingsKey: "__customGuardSettings",
  });
  const { API_ENDPOINTS } = await vite.ssrLoadModule("/config/constants.ts");
  const fetched = captureFetch(t, okJson({ text: "custom text" }));

  const manager = createManager({ getAPIKey: async () => "custom-key" });
  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  const useBaseUrl = (cloudTranscriptionBaseUrl) =>
    setSettings({
      allowLocalFallback: false,
      cloudTranscriptionBaseUrl,
      cloudTranscriptionProvider: "custom",
      transcriptionMode: "providers",
      useLocalWhisper: false,
    });

  await t.test(
    "empty, default-sentinel, and invalid URLs throw CUSTOM_ENDPOINT_INVALID",
    async () => {
      for (const baseUrl of [
        "",
        "   ",
        API_ENDPOINTS.TRANSCRIPTION_BASE,
        "not a url",
        "http://public.example.com/v1",
        "ftp://192.168.1.20/v1",
      ]) {
        useBaseUrl(baseUrl);
        await assert.rejects(manager.processWithOpenAIAPI(audioBlob), (error) => {
          assert.equal(
            error.code,
            "CUSTOM_ENDPOINT_INVALID",
            `baseUrl: ${JSON.stringify(baseUrl)}`
          );
          assert.equal(
            error.messageKey,
            "hooks.audioRecording.errorDescriptions.customEndpointInvalid"
          );
          return true;
        });
      }
      assert.equal(fetched.length, 0, "no misconfigured request may leave the app");
    }
  );

  await t.test("a configured custom URL still routes to that URL", async () => {
    useBaseUrl("https://stt.parasail.example.com/v1");
    const result = await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(result.success, true);
    assert.deepEqual(fetched, ["https://stt.parasail.example.com/v1/audio/transcriptions"]);
  });

  await t.test("error after a valid resolve does not cache the OpenAI default", async () => {
    fetched.length = 0;
    useBaseUrl("https://stt.parasail.example.com/v1");
    globalThis.fetch = async (endpoint) => {
      fetched.push(String(endpoint));
      throw new Error("network down");
    };
    await assert.rejects(manager.processWithOpenAIAPI(audioBlob));
    useBaseUrl("");
    await assert.rejects(manager.processWithOpenAIAPI(audioBlob), (error) => {
      assert.equal(error.code, "CUSTOM_ENDPOINT_INVALID");
      return true;
    });
    assert.deepEqual(fetched, ["https://stt.parasail.example.com/v1/audio/transcriptions"]);
  });

  await t.test("an Azure custom endpoint keeps its deployment URL and api-key auth", async () => {
    fetched.length = 0;
    let seenHeaders;
    globalThis.fetch = async (endpoint, init) => {
      fetched.push(String(endpoint));
      seenHeaders = init?.headers;
      return okJson({ text: "azure text" })();
    };
    useBaseUrl("https://myorg.openai.azure.com");
    const result = await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(result.success, true);
    assert.deepEqual(fetched, [
      "https://myorg.openai.azure.com/openai/deployments/whisper-1/audio/transcriptions?api-version=2025-03-01-preview",
    ]);
    assert.equal(seenHeaders["api-key"], "custom-key");
    assert.equal(seenHeaders.Authorization, undefined);
  });
});

test("self-hosted mode is never hijacked by a leftover proxied provider", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-selfhosted-hijack-test-",
    settingsKey: "__hijackSettings",
  });

  const proxyCalls = { mistral: 0, xai: 0, corti: 0 };
  for (const [provider, channel] of [
    ["mistral", "proxyMistralTranscription"],
    ["xai", "proxyXaiTranscription"],
    ["corti", "proxyCortiTranscription"],
  ]) {
    window.electronAPI[channel] = async () => {
      proxyCalls[provider] += 1;
      throw new Error("must not be called in self-hosted mode");
    };
  }
  const fetched = captureFetch(t, okJson({ text: "self-hosted text" }));
  const manager = createManager({
    getTranscriptionModel: () => "self-hosted-model",
    getAPIKey: async () => null,
  });

  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  for (const provider of ["mistral", "xai", "corti"]) {
    setSettings({
      allowLocalFallback: false,
      cloudTranscriptionProvider: provider,
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://stt.internal.example.com",
      useLocalWhisper: false,
    });
    const result = await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(result.success, true);
  }

  assert.deepEqual(proxyCalls, { mistral: 0, xai: 0, corti: 0 });
  assert.equal(
    fetched.every((e) => e.startsWith("https://stt.internal.example.com")),
    true,
    `unexpected endpoints: ${fetched.join(", ")}`
  );
});

// A self-hosted URL on an Azure host is a real population: migrateProviderSettings
// files every legacy `custom + byok` user under transcriptionMode "self-hosted"
// and copies their base URL across.
test("self-hosted Azure endpoints keep their deployment URL", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-selfhosted-azure-test-",
    settingsKey: "__selfHostedAzureSettings",
  });
  const fetched = captureFetch(t, okJson({ text: "azure text" }));
  const manager = createManager({
    getTranscriptionModel: () => "my-deployment",
    getAPIKey: async () => "azure-key",
  });
  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });

  const useRemote = (remoteTranscriptionUrl, remoteTranscriptionModel) =>
    setSettings({
      allowLocalFallback: false,
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl,
      remoteTranscriptionModel,
      useLocalWhisper: false,
    });

  await t.test("a bare Azure origin gains the deployment path and api-version", async () => {
    useRemote("https://myorg.openai.azure.com", "my-deployment");
    await manager.processWithOpenAIAPI(audioBlob);
    assert.deepEqual(fetched, [
      "https://myorg.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview",
    ]);
  });

  await t.test("a pinned deployment URL is preserved verbatim", async () => {
    fetched.length = 0;
    const pinned =
      "https://myorg.openai.azure.com/openai/deployments/pinned/audio/transcriptions?api-version=2024-06-01";
    useRemote(pinned, "my-deployment");
    await manager.processWithOpenAIAPI(audioBlob);
    assert.deepEqual(fetched, [pinned]);
  });

  await t.test("a non-Azure self-hosted host is untouched", async () => {
    fetched.length = 0;
    useRemote("https://stt.internal.example.com", "tiny");
    await manager.processWithOpenAIAPI(audioBlob);
    assert.deepEqual(fetched, ["https://stt.internal.example.com/audio/transcriptions"]);
  });
});

test("corti without a preload bridge throws instead of falling through to OpenAI", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-corti-preload-test-",
    settingsKey: "__cortiPreloadSettings",
  });
  delete window.electronAPI.proxyCortiTranscription;
  const fetched = captureFetch(t, rejectFetch("fetch must not run"));

  setSettings({
    allowLocalFallback: false,
    cloudTranscriptionProvider: "corti",
    transcriptionMode: "providers",
    useLocalWhisper: false,
  });

  const manager = createManager({
    getTranscriptionModel: () => "corti-transcribe",
    getAPIKey: async () => null,
  });
  await assert.rejects(
    manager.processWithOpenAIAPI(new Blob([new Uint8Array([1])], { type: "audio/webm" })),
    /Corti transcription is unavailable in this window/
  );
  assert.equal(fetched.length, 0);
});

test("proxied providers dispatch through the registry", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-proxy-registry-test-",
    settingsKey: "__proxyRegistrySettings",
  });
  const fetched = captureFetch(
    t,
    rejectFetch("proxied providers must not fetch from the renderer")
  );

  const payloads = {};
  for (const [provider, channel] of [
    ["tinfoil", "proxyTinfoilTranscription"],
    ["mistral", "proxyMistralTranscription"],
    ["xai", "proxyXaiTranscription"],
    ["corti", "proxyCortiTranscription"],
  ]) {
    window.electronAPI[channel] = async (payload) => {
      payloads[provider] = payload;
      return { text: "proxied text" };
    };
  }

  const dictionary = Array.from({ length: 30 }, (_, i) => `term${i}`.padEnd(40, "x")).join(", ");
  const manager = createManager({
    getTranscriptionModel: () => "voxtral-mini-latest",
    getAPIKey: async () => "key",
    getWhisperPrompt: () => dictionary,
    getKeyterms: () => ["Alpha", "  Beta  ", ""],
  });

  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  const settingsFor = (provider) => ({
    allowLocalFallback: false,
    cloudTranscriptionProvider: provider,
    transcriptionMode: "providers",
    useLocalWhisper: false,
    cortiEnvironment: "eu",
    cortiTenant: " acme ",
  });

  await t.test("each provider gets its own payload shape and source label", async () => {
    for (const provider of ["tinfoil", "mistral", "xai", "corti"]) {
      setSettings(settingsFor(provider));
      const result = await manager.processWithOpenAIAPI(audioBlob);
      assert.equal(result.success, true);
      assert.equal(result.source, provider);
    }
    assert.equal(payloads.tinfoil.prompt, dictionary);
    // contextBias is built from the untruncated dictionary: all 30 terms survive.
    assert.equal(payloads.mistral.contextBias.length, 30);
    assert.equal(payloads.mistral.model, "voxtral-mini-latest");
    assert.deepEqual(payloads.xai.keyterms, ["Alpha", "Beta"]);
    assert.equal(payloads.xai.language, undefined);
    assert.equal(payloads.corti.language, "en");
    assert.equal(payloads.corti.environment, "eu");
    assert.equal(payloads.corti.tenant, "acme");
    assert.equal(fetched.length, 0);
  });

  await t.test("structured proxy errors are rebuilt with code and messageKey", async () => {
    setSettings(settingsFor("mistral"));
    window.electronAPI.proxyMistralTranscription = async () => ({
      error: "Mistral API Error: 401 unauthorized",
      code: "INVALID_KEY",
      messageKey: "some.key",
    });
    await assert.rejects(manager.processWithOpenAIAPI(audioBlob), (error) => {
      assert.equal(error.code, "INVALID_KEY");
      assert.equal(error.messageKey, "some.key");
      return true;
    });
  });

  await t.test("empty responses name the provider", async () => {
    setSettings(settingsFor("xai"));
    window.electronAPI.proxyXaiTranscription = async () => ({ text: "   " });
    await assert.rejects(
      manager.processWithOpenAIAPI(audioBlob),
      /No text transcribed - xAI response was empty/
    );
  });

  await t.test("a missing preload bridge throws for every proxied provider", async () => {
    for (const [provider, channel, name] of [
      ["tinfoil", "proxyTinfoilTranscription", "Tinfoil"],
      ["mistral", "proxyMistralTranscription", "Mistral"],
      ["xai", "proxyXaiTranscription", "xAI"],
      ["corti", "proxyCortiTranscription", "Corti"],
    ]) {
      delete window.electronAPI[channel];
      setSettings(settingsFor(provider));
      await assert.rejects(
        manager.processWithOpenAIAPI(audioBlob),
        new RegExp(`${name} transcription is unavailable in this window`)
      );
    }
    assert.equal(fetched.length, 0);
  });
});

test("proxied providers only run the dictionary-echo check when they sent bias", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-proxy-echo-gate-test-",
    settingsKey: "__proxyEchoGateSettings",
  });
  captureFetch(t, rejectFetch("proxied providers must not fetch from the renderer"));

  // [provider, preload channel, whether buildPayload carries dictionary bias]
  const proxied = [
    ["tinfoil", "proxyTinfoilTranscription", true],
    ["mistral", "proxyMistralTranscription", true],
    ["gemini", "proxyGeminiTranscription", true],
    ["xai", "proxyXaiTranscription", true],
    ["corti", "proxyCortiTranscription", false],
  ];
  for (const [, channel] of proxied) {
    window.electronAPI[channel] = async () => ({ text: "Ozempic" });
  }

  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  const settingsFor = (provider) => ({
    allowLocalFallback: false,
    cloudTranscriptionProvider: provider,
    transcriptionMode: "providers",
    useLocalWhisper: false,
  });
  // The matcher's verdict is not under test; forcing it leaves only the gate
  // (#1759) to decide whether the transcript is discarded.
  const managerWith = (dictionary) =>
    createManager({
      getTranscriptionModel: () => "voxtral-mini-latest",
      getWhisperPrompt: () => dictionary.join(", ") || null,
      getKeyterms: () => dictionary,
      isDictionaryEcho: () => true,
    });

  await t.test("providers that received the dictionary still discard an echo", async () => {
    const manager = managerWith(["Ozempic"]);
    for (const [provider, , sendsBias] of proxied) {
      if (!sendsBias) continue;
      setSettings(settingsFor(provider));
      await assert.rejects(
        manager.processWithOpenAIAPI(audioBlob),
        (error) => error.code === "DICTIONARY_ECHO",
        provider
      );
    }
  });

  await t.test("a provider that never received the dictionary keeps the transcript", async () => {
    setSettings(settingsFor("corti"));
    const result = await managerWith(["Ozempic"]).processWithOpenAIAPI(audioBlob);
    assert.equal(result.rawText, "Ozempic");
  });

  await t.test("an empty dictionary sends no bias, so no provider can discard", async () => {
    const manager = managerWith([]);
    for (const [provider] of proxied) {
      setSettings(settingsFor(provider));
      const result = await manager.processWithOpenAIAPI(audioBlob);
      assert.equal(result.rawText, "Ozempic", provider);
    }
  });
});

test("config-error code survives a failed local fallback", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-fallback-wrap-test-",
    settingsKey: "__fallbackWrapSettings",
  });
  window.electronAPI.transcribeLocalWhisper = async () => {
    throw new Error("local model missing");
  };

  const manager = createManager({ getAPIKey: async () => "custom-key" });
  setSettings({
    allowLocalFallback: true,
    fallbackWhisperModel: "base",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionProvider: "custom",
    transcriptionMode: "providers",
    useLocalWhisper: false,
  });

  await assert.rejects(
    manager.processWithOpenAIAPI(new Blob([new Uint8Array([1])], { type: "audio/webm" })),
    (error) => {
      assert.equal(error.code, "CUSTOM_ENDPOINT_INVALID");
      assert.equal(
        error.messageKey,
        "hooks.audioRecording.errorDescriptions.customEndpointInvalid"
      );
      return true;
    }
  );
});
