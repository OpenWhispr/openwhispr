const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Recovery has to run when the dictation window mounts: that also opens the
// recording spool, which a main process hung by a later dictation would block (#2073).
const FAKE_AUDIO_MANAGER_SOURCE = `
export const recoveries = [];
export default class FakeAudioManager {
  getState() {
    return {};
  }
  setCallbacks() {}
  recoverInterruptedRecordings(message) {
    recoveries.push(message);
  }
  cancelPreparedMicCapture() {}
  cleanup() {}
}
`;

test("the mount effect recovers interrupted recordings with the translated message", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
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
        dictationLifecycleStateChanged: () => {},
      },
    },
  });
  const container = installHookDom(t);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-interrupted-recovery-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { recoveries } = await vite.ssrLoadModule("/helpers/audioManager");

  function Harness() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  assert.deepEqual(recoveries, ["Recovered after OpenWhispr closed before this dictation finished."]);
});
