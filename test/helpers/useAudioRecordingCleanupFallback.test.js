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
    globalThis.__cleanupFallbackManager = this;
  }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  getState() { return {}; }
  shouldUseStreaming() { return false; }
  async safePaste() {
    this.pasteCalls += 1;
    return globalThis.__cleanupFallbackPasteOutcome?.pasted === true;
  }
  async saveTranscription() { return true; }
  cleanup() {}
}
`;

test("raw cleanup fallback is reported only after the original dictation is pasted", async (t) => {
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
        hideDictationPreview: async () => {},
        dictationLifecycleStateChanged: () => {},
      },
    },
  });
  const container = installHookDom(t);
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

  globalThis.__cleanupFallbackPasteOutcome = { success: true, pasted: true };
  await React.act(async () => manager.callbacks.onTranscriptionComplete({ ...result }));
  assert.equal(manager.pasteCalls, 1);
  assert.equal(useCleanupFailureStore.getState().pending, 1);
  assert.deepEqual(useCleanupFailureStore.getState().lastFailure, cleanupFailure);

  useCleanupFailureStore.setState({ pending: 0, lastFailure: null });
  globalThis.__cleanupFallbackPasteOutcome = { success: true, pasted: false };
  await React.act(async () => manager.callbacks.onTranscriptionComplete({ ...result }));
  assert.equal(useCleanupFailureStore.getState().pending, 0);

  useSettingsStore.setState({ autoPasteEnabled: false, keepTranscriptionInClipboard: false });
  globalThis.__cleanupFallbackPasteOutcome = { success: true, pasted: true };
  await React.act(async () => manager.callbacks.onTranscriptionComplete({ ...result }));
  assert.equal(useCleanupFailureStore.getState().pending, 0);
});
