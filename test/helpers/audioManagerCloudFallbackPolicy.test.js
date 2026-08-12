const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

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
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cloud-fallback-test-",
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__cloudFallbackSettings;
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");

  const audioBlob = {
    type: "audio/webm",
    size: 1024,
    arrayBuffer: async () => new ArrayBuffer(8),
  };
  globalThis.__cloudFallbackSettings = {
    useLocalWhisper: false,
    allowLocalFallback: true,
    fallbackWhisperModel: "base",
    cloudTranscriptionProvider: "openai",
  };
  t.after(() => {
    delete globalThis.__cloudFallbackSettings;
  });

  let localWhisperCalls = 0;
  window.electronAPI.transcribeLocalWhisper = async () => {
    localWhisperCalls += 1;
    return { success: true, text: "local text" };
  };

  const createManager = () => {
    const manager = Object.create(AudioManager.prototype);
    manager.getEffectiveSttLanguage = () => "auto";
    manager.getTranscriptionModel = () => "whisper-1";
    manager.getAPIKey = async () => {
      throw new Error("cloud transcription unavailable");
    };
    manager.processTranscription = async (text) => text;
    return manager;
  };

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

      await assert.rejects(createManager().processWithOpenAIAPI(audioBlob, {}), (error) => {
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

    const result = await createManager().processWithOpenAIAPI(audioBlob, {});
    assert.equal(result.success, true);
    assert.equal(result.text, "local text");
    assert.equal(result.source, "local-fallback");
    assert.equal(localWhisperCalls, 1);
  });
});

test("managed custom transcription never falls through to OpenAI", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-custom-endpoint-test-",
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__managedCustomSettings;
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.__managedCustomSettings;
  });

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

  const manager = Object.create(AudioManager.prototype);
  manager.getEffectiveSttLanguage = () => "auto";
  manager.getTranscriptionModel = () => "whisper-1";
  manager.getAPIKey = async () => "should-not-leak";
  manager.getWhisperPrompt = () => null;
  manager.shouldStreamTranscription = () => false;

  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  for (const baseUrl of ["", "http://public.example.com/v1", "ftp://192.168.1.20/v1"]) {
    globalThis.__managedCustomSettings = {
      allowLocalFallback: false,
      cloudTranscriptionBaseUrl: baseUrl,
      cloudTranscriptionProvider: "custom",
      transcriptionMode: "providers",
      useLocalWhisper: false,
    };

    await assert.rejects(manager.processWithOpenAIAPI(audioBlob), (error) => {
      assert.equal(error.code, "POLICY_RESTRICTED");
      assert.equal(error.messageKey, "common.policyTranscriptionRestricted");
      return true;
    });
  }

  assert.equal(fetchCalls, 0);
});

test("unmanaged custom transcription fails closed instead of defaulting to OpenAI", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-custom-endpoint-guard-test-",
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__customGuardSettings;
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const { API_ENDPOINTS } = await vite.ssrLoadModule("/config/constants.ts");

  const originalFetch = globalThis.fetch;
  const fetchedEndpoints = [];
  globalThis.fetch = async (endpoint) => {
    fetchedEndpoints.push(String(endpoint));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ text: "custom text" }),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.__customGuardSettings;
  });

  const manager = Object.create(AudioManager.prototype);
  manager.getEffectiveSttLanguage = () => "auto";
  manager.getTranscriptionModel = () => "whisper-1";
  manager.getAPIKey = async () => "custom-key";
  manager.getWhisperPrompt = () => null;
  manager.shouldStreamTranscription = () => false;
  manager.isDictionaryEcho = () => false;
  manager.processTranscription = async (text) => text;
  manager.isReasoningAvailable = async () => false;

  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  const buildSettings = (cloudTranscriptionBaseUrl) => ({
    allowLocalFallback: false,
    cloudTranscriptionBaseUrl,
    cloudTranscriptionProvider: "custom",
    transcriptionMode: "providers",
    useLocalWhisper: false,
  });

  await t.test("empty, default-sentinel, and invalid URLs throw CUSTOM_ENDPOINT_INVALID", async () => {
    for (const baseUrl of [
      "",
      "   ",
      API_ENDPOINTS.TRANSCRIPTION_BASE,
      "not a url",
      "http://public.example.com/v1",
      "ftp://192.168.1.20/v1",
    ]) {
      globalThis.__customGuardSettings = buildSettings(baseUrl);
      await assert.rejects(manager.processWithOpenAIAPI(audioBlob), (error) => {
        assert.equal(error.code, "CUSTOM_ENDPOINT_INVALID", `baseUrl: ${JSON.stringify(baseUrl)}`);
        assert.equal(
          error.messageKey,
          "hooks.audioRecording.errorDescriptions.customEndpointInvalid"
        );
        return true;
      });
    }
    assert.equal(fetchedEndpoints.length, 0, "no misconfigured request may leave the app");
  });

  await t.test("a configured custom URL still routes to that URL", async () => {
    globalThis.__customGuardSettings = buildSettings("https://stt.parasail.example.com/v1");
    const result = await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(result.success, true);
    assert.deepEqual(fetchedEndpoints, [
      "https://stt.parasail.example.com/v1/audio/transcriptions",
    ]);
  });

  await t.test("error after a valid resolve does not cache the OpenAI default", async () => {
    fetchedEndpoints.length = 0;
    globalThis.__customGuardSettings = buildSettings("https://stt.parasail.example.com/v1");
    globalThis.fetch = async (endpoint) => {
      fetchedEndpoints.push(String(endpoint));
      throw new Error("network down");
    };
    await assert.rejects(manager.processWithOpenAIAPI(audioBlob));
    globalThis.__customGuardSettings = buildSettings("");
    await assert.rejects(manager.processWithOpenAIAPI(audioBlob), (error) => {
      assert.equal(error.code, "CUSTOM_ENDPOINT_INVALID");
      return true;
    });
    assert.deepEqual(fetchedEndpoints, [
      "https://stt.parasail.example.com/v1/audio/transcriptions",
    ]);
  });
});

test("self-hosted mode is never hijacked by a leftover proxied provider", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-selfhosted-hijack-test-",
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__hijackSettings;
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;

  const proxyCalls = { mistral: 0, xai: 0, corti: 0 };
  window.electronAPI.proxyMistralTranscription = async () => {
    proxyCalls.mistral += 1;
    throw new Error("must not be called in self-hosted mode");
  };
  window.electronAPI.proxyXaiTranscription = async () => {
    proxyCalls.xai += 1;
    throw new Error("must not be called in self-hosted mode");
  };
  window.electronAPI.proxyCortiTranscription = async () => {
    proxyCalls.corti += 1;
    throw new Error("must not be called in self-hosted mode");
  };

  const originalFetch = globalThis.fetch;
  const fetchedEndpoints = [];
  globalThis.fetch = async (endpoint) => {
    fetchedEndpoints.push(String(endpoint));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ text: "self-hosted text" }),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.__hijackSettings;
  });

  const manager = Object.create(AudioManager.prototype);
  manager.getEffectiveSttLanguage = () => "auto";
  manager.getTranscriptionModel = () => "self-hosted-model";
  manager.getAPIKey = async () => null;
  manager.getWhisperPrompt = () => null;
  manager.getKeyterms = () => [];
  manager.shouldStreamTranscription = () => false;
  manager.isDictionaryEcho = () => false;
  manager.processTranscription = async (text) => text;
  manager.isReasoningAvailable = async () => false;

  const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
  for (const provider of ["mistral", "xai", "corti"]) {
    globalThis.__hijackSettings = {
      allowLocalFallback: false,
      cloudTranscriptionProvider: provider,
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://stt.internal.example.com",
      useLocalWhisper: false,
    };
    const result = await manager.processWithOpenAIAPI(audioBlob);
    assert.equal(result.success, true);
  }

  assert.deepEqual(proxyCalls, { mistral: 0, xai: 0, corti: 0 });
  assert.equal(
    fetchedEndpoints.every((e) => e.startsWith("https://stt.internal.example.com")),
    true,
    `unexpected endpoints: ${fetchedEndpoints.join(", ")}`
  );
});

test("corti without a preload bridge throws instead of falling through to OpenAI", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-corti-preload-test-",
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__cortiPreloadSettings;
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  delete window.electronAPI.proxyCortiTranscription;

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.__cortiPreloadSettings;
  });

  const manager = Object.create(AudioManager.prototype);
  manager.getEffectiveSttLanguage = () => "auto";
  manager.getTranscriptionModel = () => "corti-transcribe";
  manager.getAPIKey = async () => null;
  manager.getWhisperPrompt = () => null;
  manager.shouldStreamTranscription = () => false;

  globalThis.__cortiPreloadSettings = {
    allowLocalFallback: false,
    cloudTranscriptionProvider: "corti",
    transcriptionMode: "providers",
    useLocalWhisper: false,
  };

  await assert.rejects(
    manager.processWithOpenAIAPI(new Blob([new Uint8Array([1])], { type: "audio/webm" })),
    /Corti transcription is unavailable in this window/
  );
  assert.equal(fetchCalls, 0);
});
