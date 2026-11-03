const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A streaming voice-assistant recording in progress. Its stop and cancel
// report state the way the real AudioManager does: a stop stays processing
// until the transcript is handled, and a cancel reports a transient
// processing state while it tears the stream down, then idle even when the
// teardown fails.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = true;
    this.translationRequested = false;
    this.sttConfig = { success: true };
    this.callbacks = {};
    this.state = { isRecording: true, isStreaming: true };
    this.cancelError = null;
    globalThis.__streamingCancelAudioManager = this;
  }
  getState() {
    return this.state;
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  setVoiceAgentRequested(value) {
    this.voiceAgentRequested = value;
  }
  setAssistantSelectionContext() {}
  setTranslationRequested(value) {
    this.translationRequested = value;
  }
  shouldUseStreaming() {
    return true;
  }
  isSttConfigStale() {
    return false;
  }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  cleanup() {}
  getRecordingAudioLevel() {
    return null;
  }
  report(state) {
    this.callbacks.onStateChange?.(state);
  }
  warmupStreamingConnection() {}
  async saveTranscription() {
    return true;
  }
  // Held open the way a paste waiting on held modifier keys stays pending.
  safePaste() {
    return new Promise((resolve) => {
      this.finishPaste = () => resolve({ pasted: true });
    });
  }
  async stopStreamingRecording() {
    this.report({ isRecording: false, isProcessing: true, isStreaming: false });
    return true;
  }
  async cancelStreamingRecording() {
    this.report({ isRecording: false, isProcessing: true, isStreaming: false });
    try {
      // Held open the way a real provider disconnect keeps the cancel pending.
      await new Promise((resolve) => {
        this.finishCancel = resolve;
      });
      if (this.cancelError) throw this.cancelError;
      return true;
    } finally {
      this.state = { isRecording: false, isStreaming: false };
      this.report({ isRecording: false, isProcessing: false, isStreaming: false });
    }
  }
}
`;

// Renders the recording hook, the assistant panel and the follow-up wiring
// App.jsx uses, with the panel already open.
async function renderOpenPanelWithStreamingFollowUp(t) {
  // Registered before the DOM helpers so it runs while window/document exist.
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
      },
    },
  });
  const container = installHookDom(t);
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  t.after(() => {
    delete globalThis.__streamingCancelAudioManager;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-streaming-cancel-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { useAssistantFollowUpThinking, useAssistantPanel } = await vite.ssrLoadModule(
    "/hooks/useAssistantPanel.js"
  );

  const api = {};
  const panel = {};
  // Stable, or every render would rebuild the AudioManager in the mount effect.
  const toast = () => {};
  const options = { onDemoEvent: () => {} };
  const panelOptions = {
    requestMainWindowSize: async () => {},
    dictationErrorActionCount: 0,
    recordingControlsRef: { current: null },
  };
  function Harness() {
    const assistant = useAssistantPanel(panelOptions);
    const recording = useAudioRecording(toast, options);
    useAssistantFollowUpThinking(recording, assistant);
    // As App.jsx does, so closing the panel cancels the follow-up.
    React.useLayoutEffect(() => {
      panelOptions.recordingControlsRef.current = recording;
    });
    Object.assign(api, recording);
    Object.assign(panel, assistant);
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  await React.act(async () => {
    await panel.openPanel();
  });
  const manager = globalThis.__streamingCancelAudioManager;
  await startFollowUp(manager);
  assert.equal(panel.openRef.current, true);
  assert.equal(api.isRecording, true);
  assert.equal(api.isAssistantVoice, true);
  assert.equal(panel.thinking, false);

  return { api, panel, manager };
}

async function startFollowUp(manager) {
  manager.state = { isRecording: true, isStreaming: true };
  await React.act(async () => {
    manager.report({ isRecording: true, isProcessing: false, isStreaming: true });
  });
}

test("cancelling a streaming voice-assistant follow-up never starts the open panel's thinking", async (t) => {
  const { api, panel, manager } = await renderOpenPanelWithStreamingFollowUp(t);

  let cancelled;
  await React.act(async () => {
    // A discrete event (Esc, the panel's close button) flushes its updates
    // before any microtask, so the cancel flag must land in the same batch as
    // the teardown's processing report.
    flushSync(() => {
      cancelled = api.cancelRecording();
    });
  });
  assert.equal(api.isProcessing, true);
  assert.equal(api.cancellingRef.current, true);
  assert.equal(panel.thinking, false);

  await React.act(async () => {
    manager.finishCancel();
    await cancelled;
  });

  assert.equal(panel.thinking, false);
  assert.equal(api.isProcessing, false);
  assert.equal(api.cancellingRef.current, false);
});

test("cancelling a streaming follow-up while its stream is still starting never starts thinking", async (t) => {
  const { api, panel, manager } = await renderOpenPanelWithStreamingFollowUp(t);
  manager.state = { isRecording: true, isStreaming: false, isStreamingStartInProgress: true };

  let cancelled;
  await React.act(async () => {
    cancelled = api.cancelRecording();
  });
  assert.equal(api.isProcessing, true);
  assert.equal(panel.thinking, false);

  await React.act(async () => {
    manager.finishCancel();
    await cancelled;
  });
  assert.equal(panel.thinking, false);
});

test("stopping a streaming voice-assistant follow-up still starts the open panel's thinking", async (t) => {
  const { api, panel } = await renderOpenPanelWithStreamingFollowUp(t);

  await React.act(async () => {
    await api.stopRecording();
  });

  assert.equal(panel.thinking, true);
  assert.equal(api.isProcessing, true);
  assert.equal(api.cancellingRef.current, false);
});

test("the next follow-up still thinks after a cancelled one", async (t) => {
  const { api, panel, manager } = await renderOpenPanelWithStreamingFollowUp(t);

  let cancelled;
  await React.act(async () => {
    cancelled = api.cancelRecording();
  });
  await React.act(async () => {
    manager.finishCancel();
    await cancelled;
  });

  await startFollowUp(manager);
  await React.act(async () => {
    await api.stopRecording();
  });

  assert.equal(panel.thinking, true);
});

test("a streaming cancel that fails still lets the next follow-up think", async (t) => {
  const { api, panel, manager } = await renderOpenPanelWithStreamingFollowUp(t);
  manager.cancelError = new Error("preview cleanup failed");

  let cancelled;
  await React.act(async () => {
    cancelled = api.cancelRecording();
  });
  await React.act(async () => {
    manager.finishCancel();
    await assert.rejects(cancelled, /preview cleanup failed/);
  });
  assert.equal(api.cancellingRef.current, false);
  assert.equal(panel.thinking, false);

  manager.cancelError = null;
  await startFollowUp(manager);
  await React.act(async () => {
    await api.stopRecording();
  });

  assert.equal(panel.thinking, true);
});

test("closing the panel mid follow-up cancels it and the panel stays closed", async (t) => {
  const { api, panel, manager } = await renderOpenPanelWithStreamingFollowUp(t);

  await React.act(async () => {
    flushSync(() => {
      panel.handleClose();
    });
  });
  assert.equal(api.isProcessing, true);
  assert.equal(panel.closing, true);
  assert.equal(panel.thinking, false);

  await React.act(async () => {
    manager.finishCancel();
    // Past the panel's content-fade fallback.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.equal(api.isProcessing, false);
  assert.equal(panel.openRef.current, false);
  assert.equal(panel.thinking, false);
});

test("a paste still in flight when a follow-up is cancelled never starts thinking", async (t) => {
  const { api, panel, manager } = await renderOpenPanelWithStreamingFollowUp(t);

  // The previous dictation's paste is still waiting when the follow-up is cancelled.
  let completed;
  await React.act(async () => {
    completed = manager.callbacks.onTranscriptionComplete({
      success: true,
      text: "earlier dictation",
      source: "deepgram-streaming",
    });
  });
  assert.equal(typeof manager.finishPaste, "function");

  let cancelled;
  await React.act(async () => {
    cancelled = api.cancelRecording();
  });
  await React.act(async () => {
    manager.finishCancel();
    await cancelled;
  });
  // The pending paste still reports processing once the cancel is done.
  assert.equal(api.isProcessing, true);
  assert.equal(panel.thinking, false);

  await React.act(async () => {
    manager.finishPaste();
    await completed;
  });
  assert.equal(api.isProcessing, false);
  assert.equal(panel.thinking, false);
});

test("a cancel whose teardown ends before the processing commit's passive effects never starts thinking", async (t) => {
  const { api, panel, manager } = await renderOpenPanelWithStreamingFollowUp(t);
  // Outside act, as the cancel hotkey's IPC runs: React yields to paint after
  // the processing commit, before its passive effects.
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;

  const cancelled = api.cancelRecording();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.isProcessing, true);
  manager.finishCancel();
  await cancelled;
  await new Promise((resolve) => setTimeout(resolve, 20));
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  assert.equal(api.isProcessing, false);
  assert.equal(panel.thinking, false);
});
