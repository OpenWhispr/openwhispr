const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager: loadAudioManagerHarness } = require("./harness/audioManager");

// The shared harness supplies the renderer-graph stubs; this wrapper adds the
// no-op instance surface every manager in this suite needs.
async function loadAudioManager(t, { cachePrefix, settingsKey, mockModules }) {
  const { window, vite, setSettings, createManager } = await loadAudioManagerHarness(t, {
    cachePrefix,
    settingsKey,
    mockModules,
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

test("managed local transcription failures never escape to the OpenAI fallback", async (t) => {
  globalThis.__managedLocalTranscriptionRequired = true;
  t.after(() => {
    delete globalThis.__managedLocalTranscriptionRequired;
  });
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-managed-local-fallback-test-",
    settingsKey: "__managedLocalFallbackSettings",
    mockModules: {
      "/stores/enterpriseIdentityStore": `
        export const isManagedLocalModelCategoryRequired = () =>
          globalThis.__managedLocalTranscriptionRequired === true;
      `,
    },
  });
  setSettings({
    allowOpenAIFallback: true,
    cloudTranscriptionProvider: "openai",
    useLocalWhisper: true,
  });
  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  let cloudFallbackCalls = 0;
  const manager = createManager({
    processWithOpenAIAPI: async () => {
      cloudFallbackCalls += 1;
      return { success: true, text: "cloud text" };
    },
  });
  window.electronAPI.transcribeLocalWhisper = async () => ({
    success: false,
    error: "local whisper failed",
  });
  window.electronAPI.transcribeLocalParakeet = async () => ({
    success: false,
    error: "local parakeet failed",
  });

  await assert.rejects(manager.processWithLocalWhisper(audioBlob, "base"), /Local Whisper failed/);
  await assert.rejects(
    manager.processWithLocalParakeet(audioBlob, "parakeet-tdt-0.6b-v3"),
    /Parakeet failed/
  );
  assert.equal(cloudFallbackCalls, 0);

  globalThis.__managedLocalTranscriptionRequired = false;
  const unmanagedResult = await manager.processWithLocalWhisper(audioBlob, "base");
  assert.equal(unmanagedResult.source, "openai-fallback");
  assert.equal(cloudFallbackCalls, 1);
});

test("local Whisper does not dispatch after authorization changes while reading audio", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-local-whisper-auth-boundary-test-",
    settingsKey: "__localWhisperAuthBoundarySettings",
  });
  setSettings({ allowOpenAIFallback: false, useLocalWhisper: true });
  let cancelled = false;
  let ipcCalls = 0;
  window.electronAPI.transcribeLocalWhisper = async () => {
    ipcCalls += 1;
    return { success: true, text: "must not run" };
  };
  const manager = createManager();

  await assert.rejects(
    manager.processWithLocalWhisper(
      {
        type: "audio/webm",
        size: 4,
        async arrayBuffer() {
          cancelled = true;
          return new ArrayBuffer(4);
        },
      },
      "base",
      {},
      () => cancelled
    ),
    (error) => error.name === "AbortError"
  );
  assert.equal(ipcCalls, 0);
});

test("local Whisper does not retry a dictionary echo after authorization changes", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-local-whisper-retry-auth-boundary-test-",
    settingsKey: "__localWhisperRetryAuthBoundarySettings",
  });
  setSettings({ allowOpenAIFallback: false, useLocalWhisper: true });
  let cancelled = false;
  let ipcCalls = 0;
  window.electronAPI.transcribeLocalWhisper = async () => {
    ipcCalls += 1;
    cancelled = true;
    return { success: true, text: "dictionary echo" };
  };
  const manager = createManager({ isDictionaryEcho: () => true });

  await assert.rejects(
    manager.processWithLocalWhisper(
      new Blob([new Uint8Array([1])], { type: "audio/webm" }),
      "base",
      {},
      () => cancelled
    ),
    (error) => error.name === "AbortError"
  );
  assert.equal(ipcCalls, 1);
});

test("local Parakeet does not dispatch after authorization changes while reading audio", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-local-parakeet-auth-boundary-test-",
    settingsKey: "__localParakeetAuthBoundarySettings",
  });
  setSettings({ allowOpenAIFallback: false, useLocalWhisper: true });
  let cancelled = false;
  let ipcCalls = 0;
  window.electronAPI.transcribeLocalParakeet = async () => {
    ipcCalls += 1;
    return { success: true, text: "must not run" };
  };
  const manager = createManager();

  await assert.rejects(
    manager.processWithLocalParakeet(
      {
        type: "audio/webm",
        size: 4,
        async arrayBuffer() {
          cancelled = true;
          return new ArrayBuffer(4);
        },
      },
      "parakeet-tdt-0.6b-v3",
      {},
      () => cancelled
    ),
    (error) => error.name === "AbortError"
  );
  assert.equal(ipcCalls, 0);
});

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

function captureMainBatch(window, respond = async () => ({ success: true, text: "main text" })) {
  const calls = [];
  const deletedPaths = [];
  let tempIndex = 0;
  window.electronAPI.saveTempAudio = async () => ({
    success: true,
    path: `/tmp/dictation-test-${++tempIndex}.webm`,
  });
  window.electronAPI.deleteTempAudio = async (tempPath) => {
    deletedPaths.push(tempPath);
    return { success: true };
  };
  window.electronAPI.transcribeAudioFileByok = async (options, context) => {
    calls.push({ options, context });
    return respond(options, context);
  };
  return { calls, deletedPaths };
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
  const { window, vite, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-custom-endpoint-guard-test-",
    settingsKey: "__customGuardSettings",
  });
  const { API_ENDPOINTS } = await vite.ssrLoadModule("/config/constants.ts");
  const fetched = captureFetch(t, rejectFetch("custom transcription must run in main"));
  const { calls } = captureMainBatch(window, async () => ({
    success: true,
    text: "custom text",
  }));

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
      assert.equal(calls.length, 0, "no misconfigured request may reach the main executor");
    }
  );

  await t.test("a configured custom URL still routes to that URL", async () => {
    useBaseUrl("https://stt.parasail.example.com/v1");
    const result = await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(result.success, true);
    assert.equal(calls.at(-1).options.baseUrl, "https://stt.parasail.example.com/v1");
    assert.equal(calls.at(-1).options.provider, "custom");
    assert.equal(calls.at(-1).context.provider, "custom");
    assert.equal(fetched.length, 0);
  });

  await t.test("error after a valid resolve does not cache the OpenAI default", async () => {
    useBaseUrl("https://stt.parasail.example.com/v1");
    window.electronAPI.transcribeAudioFileByok = async (options, context) => {
      calls.push({ options, context });
      return { success: false, error: "network down" };
    };
    await assert.rejects(manager.processWithOpenAIAPI(audioBlob));
    useBaseUrl("");
    await assert.rejects(manager.processWithOpenAIAPI(audioBlob), (error) => {
      assert.equal(error.code, "CUSTOM_ENDPOINT_INVALID");
      return true;
    });
    assert.equal(calls.at(-1).options.baseUrl, "https://stt.parasail.example.com/v1");
    assert.equal(fetched.length, 0);
  });

  await t.test("an Azure custom endpoint keeps its deployment URL and api-key auth", async () => {
    window.electronAPI.transcribeAudioFileByok = async (options, context) => {
      calls.push({ options, context });
      return { success: true, text: "azure text" };
    };
    useBaseUrl("https://myorg.openai.azure.com");
    const result = await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(result.success, true);
    assert.equal(calls.at(-1).options.baseUrl, "https://myorg.openai.azure.com");
    assert.equal(calls.at(-1).options.apiKey, "custom-key");
    assert.equal(calls.at(-1).context.provider, "custom");
    assert.equal(fetched.length, 0);
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
  const { calls } = captureMainBatch(window, async () => ({
    success: true,
    text: "self-hosted text",
  }));
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
  assert.equal(fetched.length, 0);
  assert.equal(calls.length, 3);
  assert.equal(
    calls.every(({ context }) => context.provider === "self-hosted"),
    true
  );
  assert.equal(
    calls.every(
      ({ options }) => options.remoteTranscriptionUrl === "https://stt.internal.example.com"
    ),
    true
  );
});

// A self-hosted URL on an Azure host is a real population: migrateProviderSettings
// files every legacy `custom + byok` user under transcriptionMode "self-hosted"
// and copies their base URL across.
test("self-hosted Azure endpoints keep their deployment URL", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-selfhosted-azure-test-",
    settingsKey: "__selfHostedAzureSettings",
  });
  const fetched = captureFetch(t, rejectFetch("self-hosted transcription must run in main"));
  const { calls } = captureMainBatch(window, async () => ({
    success: true,
    text: "azure text",
  }));
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
    assert.equal(calls.at(-1).options.remoteTranscriptionUrl, "https://myorg.openai.azure.com");
    assert.equal(calls.at(-1).options.remoteTranscriptionModel, "my-deployment");
    assert.equal(calls.at(-1).context.provider, "self-hosted");
  });

  await t.test("a pinned deployment URL is preserved verbatim", async () => {
    const pinned =
      "https://myorg.openai.azure.com/openai/deployments/pinned/audio/transcriptions?api-version=2024-06-01";
    useRemote(pinned, "my-deployment");
    await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(calls.at(-1).options.remoteTranscriptionUrl, pinned);
  });

  await t.test("a non-Azure self-hosted host is untouched", async () => {
    useRemote("https://stt.internal.example.com", "tiny");
    await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(calls.at(-1).options.remoteTranscriptionUrl, "https://stt.internal.example.com");
  });
  assert.equal(fetched.length, 0);
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

test("batch BYOK and self-hosted dictation dispatch through main with the resolved route", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-batch-main-routing-test-",
    settingsKey: "__batchMainRoutingSettings",
  });
  const fetched = captureFetch(t, rejectFetch("batch transcription must not fetch in renderer"));
  const calls = [];
  const deletedPaths = [];
  let tempIndex = 0;
  window.electronAPI.saveTempAudio = async () => ({
    success: true,
    path: `/tmp/dictation-${++tempIndex}.webm`,
  });
  window.electronAPI.deleteTempAudio = async (tempPath) => {
    deletedPaths.push(tempPath);
    return { success: true };
  };
  window.electronAPI.transcribeAudioFileByok = async (options, context) => {
    calls.push({ options, context });
    return { success: true, text: "main transcript" };
  };

  let selectedModel = "gpt-4o-mini-transcribe";
  const manager = createManager({
    getTranscriptionModel: () => selectedModel,
    getEffectiveSttLanguage: () => "en-US",
    getAPIKey: async () => "route-key",
    getWhisperPrompt: () => "Alpha, Beta",
  });
  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  const routes = [
    {
      settings: {
        cloudTranscriptionProvider: "openai",
        cloudTranscriptionModel: "gpt-4o-mini-transcribe",
        transcriptionMode: "providers",
      },
      expected: { provider: "openai", model: "gpt-4o-mini-transcribe" },
    },
    {
      settings: {
        cloudTranscriptionProvider: "groq",
        cloudTranscriptionModel: "whisper-large-v3-turbo",
        transcriptionMode: "providers",
      },
      expected: { provider: "groq", model: "whisper-large-v3-turbo" },
    },
    {
      settings: {
        cloudTranscriptionProvider: "custom",
        cloudTranscriptionBaseUrl: "https://stt.example.test/v1",
        cloudTranscriptionModel: "custom-whisper",
        transcriptionMode: "providers",
      },
      expected: { provider: "custom", model: "custom-whisper" },
    },
    {
      settings: {
        cloudTranscriptionProvider: "openai",
        transcriptionMode: "self-hosted",
        remoteTranscriptionUrl: "https://stt.internal.example.test",
        remoteTranscriptionModel: "private-whisper",
      },
      expected: { provider: "self-hosted", model: "private-whisper" },
    },
  ];

  for (const { settings, expected } of routes) {
    selectedModel = expected.model;
    setSettings({
      allowLocalFallback: false,
      preferredLanguage: "en-US",
      useLocalWhisper: false,
      ...settings,
    });
    const result = await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(result.text, "main transcript");
    assert.deepEqual(
      {
        provider: calls.at(-1).context.provider,
        model: calls.at(-1).context.model,
        managed: calls.at(-1).context.managed,
      },
      { ...expected, managed: false }
    );
    assert.equal(calls.at(-1).options.provider, settings.cloudTranscriptionProvider);
    assert.equal(calls.at(-1).options.apiKey, "route-key");
    assert.equal(calls.at(-1).options.model, expected.model);
    assert.equal(calls.at(-1).options.language, "en");
    assert.equal(calls.at(-1).options.useLanguageHint, true);
    assert.equal(calls.at(-1).options.prompt, "Alpha, Beta");
  }

  assert.equal(fetched.length, 0);
  assert.equal(calls.length, routes.length);
  assert.deepEqual(
    deletedPaths,
    calls.map(({ options }) => options.filePath)
  );
});

test("cancelling migrated BYOK dictation cancels its main request and ignores late text", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-batch-main-cancel-test-",
    settingsKey: "__batchMainCancelSettings",
  });
  setSettings({
    allowLocalFallback: false,
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "whisper-1",
    transcriptionMode: "providers",
    useLocalWhisper: false,
  });
  window.electronAPI.saveTempAudio = async () => ({
    success: true,
    path: "/tmp/dictation-cancel.webm",
  });
  const deletedPaths = [];
  window.electronAPI.deleteTempAudio = async (tempPath) => {
    deletedPaths.push(tempPath);
    return { success: true };
  };
  let resolveTranscription;
  let seenRequestId;
  window.electronAPI.transcribeAudioFileByok = async (options) => {
    seenRequestId = options.requestId;
    return new Promise((resolve) => {
      resolveTranscription = resolve;
    });
  };
  const cancelledRequestIds = [];
  window.electronAPI.cancelUploadTranscription = async (requestId) => {
    cancelledRequestIds.push(requestId);
    return { success: true };
  };
  let processingCalls = 0;
  const manager = createManager({
    getAPIKey: async () => "openai-key",
    processTranscription: async () => {
      processingCalls += 1;
      return "must not process";
    },
  });

  const operation = manager.processWithOpenAIAPI(
    new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" })
  );
  while (!resolveTranscription) await new Promise((resolve) => setImmediate(resolve));
  manager._activeTranscriptionAbortController.abort();
  await new Promise((resolve) => setImmediate(resolve));
  resolveTranscription({ success: true, text: "late text must be ignored" });

  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(typeof seenRequestId, "string");
  assert.notEqual(seenRequestId, "");
  assert.deepEqual(cancelledRequestIds, [seenRequestId]);
  assert.equal(processingCalls, 0);
  assert.deepEqual(deletedPaths, ["/tmp/dictation-cancel.webm"]);
});

test("Tinfoil dictation context uses the resolver-normalized null model", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-tinfoil-context-route-test-",
    settingsKey: "__tinfoilContextRouteSettings",
  });
  setSettings({
    allowLocalFallback: false,
    cloudTranscriptionProvider: "tinfoil",
    cloudTranscriptionModel: "voxtral-small-24b",
    transcriptionMode: "providers",
    useLocalWhisper: false,
  });
  let seenContext;
  window.electronAPI.proxyTinfoilTranscription = async (_payload, context) => {
    seenContext = context;
    return { text: "tinfoil transcript" };
  };
  const manager = createManager({
    getTranscriptionModel: () => "voxtral-small-24b",
    getAPIKey: async () => "tinfoil-key",
  });

  await manager.processWithOpenAIAPI(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }));

  assert.deepEqual(
    { provider: seenContext.provider, model: seenContext.model, managed: seenContext.managed },
    { provider: "tinfoil", model: null, managed: false }
  );
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

test("BYOK transcription never dispatches after cancellation during key lookup", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-byok-auth-key-race-test-",
    settingsKey: "__byokAuthKeyRaceSettings",
  });
  setSettings({
    allowLocalFallback: false,
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionModel: "whisper-1",
    transcriptionMode: "providers",
    useLocalWhisper: false,
  });
  let resolveKey;
  let cancelled = false;
  const key = new Promise((resolve) => {
    resolveKey = resolve;
  });
  const manager = createManager({ getAPIKey: () => key });
  const fetched = captureFetch(t, rejectFetch("cancelled audio must not be uploaded"));

  const operation = manager.processWithOpenAIAPI(
    new Blob([new Uint8Array([1])], { type: "audio/webm" }),
    {},
    () => cancelled
  );
  await new Promise((resolve) => setImmediate(resolve));
  cancelled = true;
  resolveKey("old-identity-key");

  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(fetched.length, 0);
});
