const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Captures the callbacks the hook registers on mount so the test can fire
// onNoAudio directly — the real path needs a microphone and a cloud round trip.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = { success: true };
  }
  getState() { return {}; }
  setCallbacks(callbacks) { globalThis.__owAudioCallbacks = callbacks; }
  setVoiceAgentRequested(value) { this.voiceAgentRequested = value; }
  setAssistantSelectionContext() {}
  setTranslationRequested(value) { this.translationRequested = value; }
  shouldUseStreaming() { return false; }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  cleanup() {}
  async startRecording() { return false; }
}
`;

async function renderHook(t, suppressRef) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__owAudioCallbacks;
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
    cachePrefix: "openwhispr-no-audio-migration-card-",
    mockModules: { "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  const toasts = [];
  function Harness() {
    useAudioRecording((props) => toasts.push(props), {
      onDemoEvent: () => {},
      suppressNoAudioErrorRef: suppressRef,
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return toasts;
}

const noAudioToasts = (toasts) =>
  toasts.filter((toast) => toast.presentation === "dictation-error");

test("a run that caught no speech tells the user so", async (t) => {
  const toasts = await renderHook(t, { current: false });
  await React.act(async () => globalThis.__owAudioCallbacks.onNoAudio());
  assert.equal(noAudioToasts(toasts).length, 1);
  assert.equal(noAudioToasts(toasts)[0].variant, "destructive");
});

test("the Hold migration card's own press stays quiet", async (t) => {
  const toasts = await renderHook(t, { current: true });
  await React.act(async () => globalThis.__owAudioCallbacks.onNoAudio());
  assert.equal(noAudioToasts(toasts).length, 0);
});

test("the very next run is loud again — the card suppresses one press, not a mode", async (t) => {
  const suppressRef = { current: true };
  const toasts = await renderHook(t, suppressRef);
  await React.act(async () => globalThis.__owAudioCallbacks.onNoAudio());
  assert.equal(noAudioToasts(toasts).length, 0);

  suppressRef.current = false; // the card dismissed
  await React.act(async () => globalThis.__owAudioCallbacks.onNoAudio());
  assert.equal(noAudioToasts(toasts).length, 1);
});
