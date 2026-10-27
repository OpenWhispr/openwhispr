const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = { success: true };
    this.pasteCalls = 0;
    this.shownNotices = [];
    globalThis.__cleanupFallbackManager = this;
  }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  getState() { return {}; }
  shouldUseStreaming() { return false; }
  async safePaste() {
    this.pasteCalls += 1;
    const outcome = globalThis.__cleanupFallbackPasteOutcome || {};
    return { pasted: outcome.pasted === true, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  markCleanupNoticeShown(failure) { this.shownNotices.push(failure); }
  async saveTranscription() { return true; }
  cleanup() {}
}
`;

test("a raw cleanup fallback is reported with whether the dictation was pasted", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__cleanupFallbackManager;
    delete globalThis.__cleanupFallbackPasteOutcome;
  });

  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        completeDictationPreview: async () => {},
        writeClipboard: async () => ({ success: true }),
        hideDictationPreview: async () => {},
        dictationLifecycleStateChanged: () => {},
      },
    },
  });
  const container = installHookDom(t);
  localStorage.setItem("onboardingCompleted", "true");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-fallback-hook-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/logger": `
        export default { debug() {}, info() {}, warn() {}, error() {} };
      `,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useCleanupFailureStore } = await vite.ssrLoadModule("/stores/cleanupFailureStore.ts");
  useSettingsStore.setState({
    autoPasteEnabled: true,
    keepTranscriptionInClipboard: false,
    snippets: [],
  });
  useCleanupFailureStore.setState({ pending: 0, lastFailure: null });

  function Harness() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const manager = globalThis.__cleanupFallbackManager;
  const cleanupFailure = {
    message: "AWS Bedrock is temporarily unavailable.",
    technicalDetails: { status: 503, requestId: "request-503" },
  };
  const result = {
    success: true,
    text: "original dictation",
    rawText: "original dictation",
    source: "local",
    cleanupFailure,
  };

  const recorded = async (pasteOutcome) => {
    useCleanupFailureStore.setState({ pending: 0, lastFailure: null });
    manager.shownNotices = [];
    globalThis.__cleanupFallbackPasteOutcome = pasteOutcome;
    await React.act(async () => manager.callbacks.onTranscriptionComplete({ ...result }));
    const { pending, lastFailure } = useCleanupFailureStore.getState();
    return { pending, lastFailure, shown: manager.shownNotices };
  };

  let report = await recorded({ success: true, pasted: true });
  assert.equal(manager.pasteCalls, 1);
  assert.equal(report.pending, 1);
  assert.deepEqual(report.lastFailure, { ...cleanupFailure, pasted: true });
  assert.deepEqual(report.shown, [cleanupFailure]);

  // A paste that did not land still reports the cause, without claiming the paste.
  report = await recorded({ success: true, pasted: false });
  assert.equal(report.pending, 1);
  assert.equal(report.lastFailure.pasted, false);

  // Held back for still-held modifiers: the pill shows and the cause is reported too.
  report = await recorded({ success: true, pasted: false, reason: "modifiers-held" });
  assert.equal(report.pending, 1);
  assert.equal(report.lastFailure.pasted, false);

  useSettingsStore.setState({ autoPasteEnabled: false, keepTranscriptionInClipboard: false });
  report = await recorded({ success: true, pasted: true });
  assert.equal(report.pending, 1);
  assert.equal(report.lastFailure.pasted, false);

  // The onboarding demo's paste is a no-op into its own text box: nothing is
  // reported, and an unconfigured-cleanup warning is not used up.
  useSettingsStore.setState({ autoPasteEnabled: true });
  localStorage.setItem("onboardingCompleted", "false");
  report = await recorded({ success: true, pasted: false });
  assert.equal(report.pending, 0);
  assert.deepEqual(report.shown, []);
});
