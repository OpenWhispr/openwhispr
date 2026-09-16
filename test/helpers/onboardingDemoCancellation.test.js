const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Cancellation ends AudioManager with an idle state and no transcription
// result. Match that callback contract while mounting the real recording hook.
const AUDIO_MANAGER = `
export default class AudioManager {
  constructor() {
    this.state = { isRecording: false, isProcessing: false, isStreaming: false };
    this.sttConfig = { success: true };
    globalThis.__onboardingCancellationManager = this;
  }
  getState() { return this.state; }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  setState(state) {
    this.state = state;
    this.callbacks.onStateChange(state);
  }
  cancelPreparedMicCapture() {}
  cancelRecording() {
    this.setState({ isRecording: false, isProcessing: false, isStreaming: false });
    return true;
  }
  async cancelStreamingRecording() {
    this.setState({ isRecording: false, isProcessing: true, isStreaming: false });
    await Promise.resolve();
    return this.cancelRecording();
  }
  cancelProcessing() {
    return this.deferProcessingCancellation ? true : this.cancelRecording();
  }
  shouldUseStreaming() { return false; }
  getRecordingAudioLevel() { return null; }
  cleanup() {}
}
`;

test("an informational fallback preserves the current demo status and auth failures retain their code", async (t) => {
  const { events, manager } = await mountRecording(t);
  await React.act(async () => {
    manager.setState({ isRecording: false, isProcessing: true, isStreaming: false });
    manager.callbacks.onError({
      title: "Screen Context Skipped",
      code: "SCREEN_CONTEXT_SKIPPED",
      variant: "default",
    });
  });
  assert.deepEqual(
    events.map((event) => event.status),
    ["processing"]
  );
  await React.act(async () => {
    manager.callbacks.onError({ title: "Sign in required", code: "AUTH_REQUIRED" });
  });
  assert.equal(events.at(-1).status, "error");
  assert.equal(events.at(-1).code, "AUTH_REQUIRED");
});

test("streaming cancellation clears the demo only once the pending provider work settles", async (t) => {
  const { events, getControls, manager } = await mountRecording(t);
  manager.deferProcessingCancellation = true;
  await React.act(async () => {
    manager.setState({ isRecording: false, isProcessing: true, isStreaming: false });
  });
  await React.act(async () => getControls().cancelProcessing());
  assert.equal(events.at(-1).status, "processing", "another recording cannot start yet");
  await React.act(async () => {
    manager.setState({ isRecording: false, isProcessing: false, isStreaming: false });
  });
  assert.equal(events.at(-1).status, "cancelled");
});

test("ordinary idle waits for the transcription result instead of cancelling the demo", async (t) => {
  const { events, manager } = await mountRecording(t);
  await React.act(async () => {
    manager.setState({ isRecording: false, isProcessing: true, isStreaming: false });
    manager.setState({ isRecording: false, isProcessing: false, isStreaming: false });
  });
  assert.deepEqual(
    events.map((event) => event.status),
    ["processing"]
  );
});

async function mountRecording(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__onboardingCancellationManager;
  });
  const dispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      clearInterval() {},
      electronAPI: {
        onToggleDictation: dispose,
        onToggleVoiceAgent: dispose,
        onToggleTranslation: dispose,
        onStartDictation: dispose,
        onPrepareDictation: dispose,
        onCancelDictationPreparation: dispose,
        onStopDictation: dispose,
        dictationLifecycleStateChanged() {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-onboarding-cancellation-",
    mockModules: { "/helpers/audioManager": AUDIO_MANAGER },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const events = [];
  const toast = () => {};
  const onDemoEvent = (event) => events.push(event);
  let controls;
  function Harness() {
    controls = useAudioRecording(toast, { onDemoEvent });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return {
    events,
    getControls: () => controls,
    manager: globalThis.__onboardingCancellationManager,
  };
}

for (const scenario of [
  { name: "batch recording", isRecording: true, isStreaming: false },
  { name: "streaming recording", isRecording: true, isStreaming: true },
  { name: "transcription processing", isRecording: false, isStreaming: false },
]) {
  test(`cancelling ${scenario.name} clears the onboarding demo's active status`, async (t) => {
    const { events, getControls, manager } = await mountRecording(t);
    await React.act(async () => {
      manager.setState({
        isRecording: scenario.isRecording,
        isProcessing: !scenario.isRecording,
        isStreaming: scenario.isStreaming,
      });
    });
    assert.equal(events.at(-1).status, scenario.isRecording ? "listening" : "processing");

    await React.act(async () => {
      if (scenario.isRecording) await getControls().cancelRecording();
      else getControls().cancelProcessing();
    });

    assert.equal(getControls().isRecording, false, "the microphone has stopped");
    assert.equal(getControls().isProcessing, false, "the audio pipeline has settled");
    assert.equal(
      ["listening", "partial", "processing", "replying"].includes(events.at(-1).status),
      false,
      `the demo still displays ${events.at(-1).status} after the pipeline became idle`
    );
  });
}
