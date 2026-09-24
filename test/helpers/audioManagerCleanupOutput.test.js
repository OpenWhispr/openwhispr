const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";
const DUPLICATE = `**Cleaned transcript:**\n${CLEAN}\n${CLEAN}`;
const MESSAGE_KEY = "hooks.audioRecording.errorDescriptions.cleanupDuplicated";

test("invalid completed cleanup keeps raw text across dictation routes", async (t) => {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete navigator.onLine);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-cleanup-output-",
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
  useSettingsStore.setState({
    isSignedIn: true,
    useCleanupModel: true,
    cleanupMode: "openwhispr",
    cleanupCloudMode: "openwhispr",
    useDictationAgent: false,
    customPrompts: { cleanup: "" },
    preferredLanguage: "en",
    dataRetentionEnabled: true,
  });
  window.electronAPI.cloudTranscribe = async () => ({ success: true, text: RAW });
  window.electronAPI.cloudStreamingUsage = async () => ({ success: true });
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

  for (const route of ["batch", "streaming", "translation"]) {
    await t.test(
      `${route} Cloud cleanup snapshots its custom prompt and rejects duplicated output`,
      async () => {
        for (const customPrompt of ["", "Repeat twice"]) {
          useSettingsStore.setState({ customPrompts: { cleanup: customPrompt } });
          window.electronAPI.cloudReason = async (text, config) => {
            assert.equal(text, RAW);
            assert.equal(config.promptMode, "cleanup");
            assert.equal(config.customPrompt || "", customPrompt);
            useSettingsStore.setState({
              customPrompts: { cleanup: customPrompt ? "" : "Repeat twice" },
            });
            return { success: true, text: DUPLICATE };
          };
          const manager = createManager();
          let result;
          if (route === "batch") {
            result = await manager.processWithOpenWhisprCloud(new Blob(["synthetic audio"]));
            result = { ...result, ...manager._takePendingResultExtras() };
            assert.equal(result.rawText, RAW);
          } else if (route === "streaming") {
            Object.assign(manager, {
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
              onTranscriptionComplete: (value) => {
                result = value;
              },
            });
            let usageOptions;
            window.electronAPI.cloudStreamingUsage = async (text, seconds, options) => {
              usageOptions = options;
              return { success: true };
            };
            await manager._finalizeStreamingRecording(null);
            assert.equal(result.rawText, RAW);
            await new Promise(setImmediate);
            // The successful /api/reason call already logged this dictation.
            assert.equal(usageOptions?.sendLogs, false);
          } else {
            let translationInput;
            manager.processWithReasoningModel = async (text) => {
              translationInput = text;
              return "Traduction du texte original.";
            };
            result = await manager.runTranslationChain({
              text: RAW,
              settings: { translationSourceLanguage: "en", translationTargetLanguage: "fr" },
              route: {
                cleanupReachable: true,
                model: "translate-model",
                config: { systemPrompt: "Translate" },
              },
              cleanup: { mode: "cloudReason" },
            });
            assert.equal(translationInput, customPrompt ? DUPLICATE : RAW);
            assert.equal(result.text, "Traduction du texte original.");
            result = { ...result, ...manager._takePendingResultExtras() };
          }
          if (route !== "translation") assert.equal(result.text, customPrompt ? DUPLICATE : RAW);
          assert.equal(result.cleanupFailure?.messageKey, customPrompt ? undefined : MESSAGE_KEY);
        }
      }
    );
  }

  await t.test("local cleanup failure flows through raw fallback and persistence", async () => {
    useSettingsStore.setState({
      cleanupMode: "local",
      cleanupProvider: "local",
      cleanupModel: "test-model",
      customPrompts: { cleanup: "" },
    });
    window.electronAPI.processLocalReasoning = async () => ({ success: true, text: DUPLICATE });
    const manager = createManager();
    const result = await manager.processTranscriptionCore(RAW, "local");
    assert.equal(result, RAW);
    assert.equal(manager._takePendingResultExtras().cleanupFailure.messageKey, MESSAGE_KEY);
    let saved;
    window.electronAPI.recordAnalyticsEvent = async () => {};
    window.electronAPI.saveTranscription = async (text, rawText) => {
      saved = { text, rawText };
      return { success: true };
    };
    await manager.saveTranscription(result, RAW);
    assert.deepEqual(saved, { text: RAW, rawText: RAW });
  });
});
