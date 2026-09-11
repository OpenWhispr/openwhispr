const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Counts cacheMicrophoneDeviceId() calls and reports a non-streaming setup, so
// the assertion below cannot be satisfied by the streaming warm-up path that
// already calls it.
const FAKE_AUDIO_MANAGER_SOURCE = `
export const micPrecacheCalls = [];
export default class FakeAudioManager {
  getState() {
    return {};
  }
  setCallbacks() {}
  shouldUseStreaming() {
    return false;
  }
  cacheMicrophoneDeviceId() {
    micPrecacheCalls.push(Date.now());
  }
  cancelPreparedMicCapture() {}
  cleanup() {}
}
`;

test("the mount effect pre-caches the microphone device id when streaming is off", async (t) => {
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
    cachePrefix: "openwhispr-audio-recording-mic-precache-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { micPrecacheCalls } = await vite.ssrLoadModule("/helpers/audioManager");

  function Harness() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  assert.equal(micPrecacheCalls.length, 1);
});
