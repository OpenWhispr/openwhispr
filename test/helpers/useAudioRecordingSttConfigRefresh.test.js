const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The STT config lives in the AudioManager for the life of the window; without
// a refresh, a server-side rollout change (Orukeet switched on, or rolled
// back) never reaches a long-running app.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = null;
    globalThis.__sttRefreshManager = this;
  }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  getState() { return { isRecording: false, isProcessing: false, isStreaming: false }; }
  isSttConfigStale() { return globalThis.__sttRefreshStale; }
  setSttConfig(config) { this.sttConfig = config; }
  shouldUseStreaming() { return false; }
  prepareMicCapture() {}
  setVoiceAgentRequested() {}
  setAssistantSelectionContext() {}
  setTranslationRequested() {}
  async startRecording() { globalThis.__sttRefreshStarts.push(globalThis.__sttRefreshFetches); return true; }
  cleanup() {}
}
`;

test("a recording start refreshes a stale STT config in the background", async (t) => {
  let root = null;
  let start = null;
  globalThis.__sttRefreshFetches = 0;
  globalThis.__sttRefreshStarts = [];
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__sttRefreshManager;
    delete globalThis.__sttRefreshStale;
    delete globalThis.__sttRefreshFetches;
    delete globalThis.__sttRefreshStarts;
  });

  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        // The start handler skips toggle semantics, so the hook's own
        // recording state from the previous start does not turn it into a stop.
        onStartDictation: (handler) => {
          start = handler;
          return () => {};
        },
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        getSttConfig: async () => {
          globalThis.__sttRefreshFetches += 1;
          return {
            success: true,
            dictation: { mode: "batch" },
            fetch: globalThis.__sttRefreshFetches,
          };
        },
        captureDictationTarget: async () => {},
        completeDictationPreview: async () => {},
        hideDictationPreview: async () => {},
        dictationLifecycleStateChanged: () => {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-stt-config-refresh-hook-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  function Harness() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }

  globalThis.__sttRefreshStale = true;
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  // The hook re-creates its AudioManager when its effect re-runs, so the fake
  // records starts on globalThis and the config is read from the live instance.
  const manager = () => globalThis.__sttRefreshManager;
  assert.ok(manager().sttConfig, "the mount fetch populated the config");

  // The hook's mount effect can re-run on later renders, so the assertions
  // below count fetches issued on the start path itself: before startRecording.
  const startRecording = async () => {
    const fetchesBefore = globalThis.__sttRefreshFetches;
    await React.act(async () => {
      start();
      // Two bounded visual-frame waits precede the mic open in the start path.
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    return globalThis.__sttRefreshStarts.at(-1) - fetchesBefore;
  };

  // A fresh config is not refetched on every hotkey press.
  globalThis.__sttRefreshStale = false;
  assert.equal(await startRecording(), 0);

  // A stale one is refreshed in the background, and the recording still starts.
  globalThis.__sttRefreshStale = true;
  const configBefore = manager().sttConfig;
  assert.equal(await startRecording(), 1);
  assert.equal(globalThis.__sttRefreshStarts.length, 2);
  assert.notEqual(manager().sttConfig, configBefore);
});
