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
  setCallbacks() {}
  getState() { return {}; }
  shouldUseStreaming() { return false; }
  cleanup() {}
}
`;

// An error boundary unmounts the dictation app mid-recording; cleanup() stops
// the recording without reporting it, so the hook must release Escape itself.
test("unmounting the dictation hook releases the cancel hotkey", async (t) => {
  let cancelReleases = 0;
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
        dictationLifecycleStateChanged: () => {},
        unregisterCancelHotkey: async () => {
          cancelReleases += 1;
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-unmount-cancel-hook-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/logger": `
        export default { debug() {}, info() {}, warn() {}, error() {} };
      `,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  function Harness() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }

  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const releasesWhileMounted = cancelReleases;

  await React.act(async () => root.unmount());
  assert.equal(cancelReleases, releasesWhileMounted + 1);
});
