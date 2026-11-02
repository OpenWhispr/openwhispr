const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";

// Every /api/reason cleanup the dictation pipeline sends carries personal words
// and snippet triggers in customDictionary as before, and teammates' words in
// sharedDictionary, left out when there are none.
test("Cloud cleanup sends shared words in sharedDictionary on every dictation route", async (t) => {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete navigator.onLine);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-cloud-shared-dictionary-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const base = {
    isSignedIn: true,
    useCleanupModel: true,
    cleanupMode: "openwhispr",
    cleanupCloudMode: "openwhispr",
    useDictationAgent: false,
    customPrompts: { cleanup: "" },
    preferredLanguage: "en",
    dataRetentionEnabled: true,
    customDictionary: ["Piha"],
    snippets: [{ trigger: "my sig", replacement: "Chad" }],
  };
  window.electronAPI.cloudTranscribe = async () => ({ success: true, text: RAW });
  window.electronAPI.cloudStreamingUsage = async () => ({ success: true });
  const requests = [];
  window.electronAPI.cloudReason = async (_text, config) => {
    requests.push(config);
    return { success: true, text: CLEAN };
  };
  const createManager = () =>
    Object.assign(Object.create(AudioManager.prototype), {
      voiceAgentRequested: false,
      translationRequested: false,
      pendingCleanupFailure: null,
      getEffectiveSttLanguage: () => "en",
      getWhisperPrompt: () => null,
      isDictionaryEcho: () => false,
      isReasoningAvailable: async () => true,
      finalizeChineseScript: async (text) => text,
    });

  const runRoute = async (route) => {
    const manager = createManager();
    if (route === "batch") {
      await manager.processWithOpenWhisprCloud(new Blob(["synthetic audio"]));
      return;
    }
    if (route === "streaming") {
      Object.assign(manager, {
        _streamingMeteredByCloud: true,
        streamingFinalText: RAW,
        streamingCleanupFns: [],
        micRecovery: { stop() {} },
        finishStreamingFallbackSegment: async () => {},
        mergeRecordedSegments: async () => null,
        awaitStreamingTextSettled: async () => {},
        getStreamingProvider: () => ({
          awaitsFinalTranscript: true,
          stop: async () => ({ success: true }),
        }),
        getStreamingProviderName: () => "openwhispr",
        shouldUseStreaming: () => false,
        onTranscriptionComplete: () => {},
      });
      await manager._finalizeStreamingRecording(null);
      await new Promise(setImmediate);
      return;
    }
    manager.processWithReasoningModel = async () => "Traduction.";
    await manager.runTranslationChain({
      text: RAW,
      settings: {
        ...useSettingsStore.getState(),
        translationSourceLanguage: "en",
        translationTargetLanguage: "fr",
      },
      route: {
        cleanupReachable: true,
        model: "translate-model",
        config: { systemPrompt: "Translate" },
      },
      cleanup: { mode: "cloudReason" },
    });
  };

  for (const route of ["batch", "streaming", "translation"]) {
    await t.test(route, async () => {
      useSettingsStore.setState({
        ...base,
        sharedDictionaryHints: { space: ["Kube"], workspace: ["piha", "Acme"] },
      });
      requests.length = 0;
      await runRoute(route);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].customDictionary, ["Piha", "my sig"]);
      assert.deepEqual(requests[0].sharedDictionary, ["Kube", "Acme"]);

      useSettingsStore.setState({ ...base, sharedDictionaryHints: { space: [], workspace: [] } });
      requests.length = 0;
      await runRoute(route);
      assert.deepEqual(requests[0].customDictionary, ["Piha", "my sig"]);
      assert.equal(Object.hasOwn(requests[0], "sharedDictionary"), false);
    });
  }
});
