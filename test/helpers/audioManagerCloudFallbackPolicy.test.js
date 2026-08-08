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
