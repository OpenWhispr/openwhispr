const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A dictation shortcut carries its row's cleanup override in the toggle
// payload, and that recording runs in that mode. Every other start must clear
// the mode, and a retry must replay the mode its recording was made in.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.cleanupOverride = null;
    this.isRecording = false;
    this.sttConfig = {};
    globalThis.__cleanupModeAudioManager = this;
  }
  getState() {
    return { isRecording: this.isRecording };
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  setVoiceAgentRequested(requested) {
    this.voiceAgentRequested = requested;
  }
  setAssistantSelectionContext() {}
  beginScreenContextCapture() {}
  beginSelectionCapture() {}
  setTranslationRequested(requested) {
    this.translationRequested = requested;
  }
  setCleanupOverride(override) {
    this.cleanupOverride = override;
    globalThis.__cleanupModeSetterCalls.push(override);
  }
  startRecording() {
    globalThis.__cleanupModeStarts.push({
      voiceAgentRequested: this.voiceAgentRequested,
      translationRequested: this.translationRequested,
      cleanupOverride: this.cleanupOverride,
    });
    this.isRecording = true;
    return Promise.resolve(true);
  }
  stopRecording() {
    const wasRecording = this.isRecording;
    this.isRecording = false;
    globalThis.__cleanupModeStops += 1;
    return wasRecording;
  }
  complete(result) {
    return this.callbacks.onTranscriptionComplete(result);
  }
  async safePaste() {
    return { pasted: true };
  }
  saveTranscription() {
    return Promise.resolve(true);
  }
  shouldUseStreaming() {
    return false;
  }
  getRecordingAudioLevel() {
    return 0;
  }
  isSttConfigStale() {
    return false;
  }
  cleanup() {}
}
`;

const SETTINGS_STORE_SOURCE = `
export const getSettings = () => globalThis.__cleanupModeSettings;
`;

const POLICY_STORE_SOURCE = `
export const usePolicyStore = {
  getState: () => ({ status: "unmanaged" }),
  subscribe: () => () => {},
};
`;

const LOGGER_SOURCE = `
const noop = () => {};
export default {
  trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  logReasoning: noop,
};
`;

const TRANSLATION_SOURCE = `
const translate = (key) => key;
export const useTranslation = () => ({ t: translate });
`;

const NOOP = () => {};

async function mountHarness(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const toasts = [];
  const listeners = {};
  const listenerFor = (name) => (callback) => {
    listeners[name] = callback;
    return () => delete listeners[name];
  };
  const noopDispose = () => () => {};

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: listenerFor("dictation"),
        onToggleVoiceAgent: listenerFor("voiceAgent"),
        onToggleTranslation: listenerFor("translation"),
        onStartDictation: noopDispose,
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        onDictationForceStopped: noopDispose,
        dictationLifecycleStateChanged: NOOP,
        completeDictationPreview: NOOP,
        hideDictationPreview: NOOP,
        setScreenContextEnabled: NOOP,
        captureDictationTarget: async () => ({}),
        async writeClipboard() {
          return { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cleanupModeSettings = {
    autoPasteEnabled: true,
    keepTranscriptionInClipboard: false,
    showTranscriptionPreview: false,
    snippets: [],
    useLocalWhisper: false,
    pauseMediaOnDictation: false,
    voiceAgentScreenContext: false,
  };
  globalThis.__cleanupModeStarts = [];
  globalThis.__cleanupModeStops = 0;
  globalThis.__cleanupModeSetterCalls = [];

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-cleanup-mode-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/stores/settingsStore": SETTINGS_STORE_SOURCE,
      "/stores/policyStore": POLICY_STORE_SOURCE,
      "/utils/logger": LOGGER_SOURCE,
      "react-i18next": TRANSLATION_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  const api = {};
  const pushToast = (entry) => toasts.push(entry);
  function Harness() {
    Object.assign(api, useAudioRecording(pushToast, { onDemoEvent: NOOP }));
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  // The toggle listeners are fire-and-forget, and a start first awaits two
  // visual frames. installHookDom's requestAnimationFrame never fires, so each
  // frame falls back to its own timeout and a press settles in real time.
  const SETTLE_MS = 2 * 250 + 100;
  const flush = async () => {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });
  };

  return {
    api,
    toasts,
    flush,
    starts: () => globalThis.__cleanupModeStarts,
    stops: () => globalThis.__cleanupModeStops,
    setterCalls: () => globalThis.__cleanupModeSetterCalls,
    press: async (name, payload) => {
      assert.ok(listeners[name], `the hook must subscribe to the ${name} toggle`);
      await React.act(async () => listeners[name](payload));
      await flush();
    },
    setRecording: async (isRecording) => {
      await React.act(async () =>
        globalThis.__cleanupModeAudioManager.callbacks.onStateChange({
          isRecording,
          isProcessing: false,
          isStreaming: false,
        })
      );
    },
  };
}

test("each dictation row starts its recording in its own cleanup mode", async (t) => {
  const harness = await mountHarness(t);

  // The rows a user configured, plus the two other slots, which never pin a
  // mode of their own.
  const presses = [
    ["dictation", { cleanupOverride: "raw" }],
    ["dictation", { cleanupOverride: "cleaned" }],
    ["dictation", { cleanupOverride: null }],
    ["translation", undefined],
    ["voiceAgent", undefined],
  ];
  for (const [hotkey, payload] of presses) {
    await harness.press(hotkey, payload);
    // Toggle the recording off again so the next press starts a fresh one.
    await harness.press(hotkey, payload);
  }

  assert.deepEqual(harness.starts(), [
    { voiceAgentRequested: false, translationRequested: false, cleanupOverride: "raw" },
    { voiceAgentRequested: false, translationRequested: false, cleanupOverride: "cleaned" },
    { voiceAgentRequested: false, translationRequested: false, cleanupOverride: null },
    { voiceAgentRequested: false, translationRequested: true, cleanupOverride: null },
    { voiceAgentRequested: true, translationRequested: false, cleanupOverride: null },
  ]);
  // Set on every start, so no recording can inherit the previous row's mode.
  assert.deepEqual(harness.setterCalls(), ["raw", "cleaned", null, null, null]);
});

// Another row pressed during a recording is a stop, like any other dictation
// hotkey: it must not restart the recording in that row's mode.
test("another row pressed while recording stops instead of switching", async (t) => {
  const harness = await mountHarness(t);

  await harness.press("dictation", { cleanupOverride: "raw" });
  await harness.setRecording(true);
  await harness.press("dictation", { cleanupOverride: "cleaned" });

  assert.equal(harness.starts().length, 1, "no second recording may start");
  assert.equal(harness.starts()[0].cleanupOverride, "raw");
  assert.equal(harness.stops(), 1, "the other row's press stops the recording");
  assert.deepEqual(harness.setterCalls(), ["raw"]);
});

test("a repeated press of the same row while recording does not re-arm the mode", async (t) => {
  const harness = await mountHarness(t);

  await harness.press("dictation", { cleanupOverride: "cleaned" });
  await harness.setRecording(true);
  await harness.press("dictation", { cleanupOverride: "cleaned" });

  assert.equal(harness.starts().length, 1);
  assert.deepEqual(harness.setterCalls(), ["cleaned"]);
});

// A retry after a failure replays the mode the recording was made in, not the
// saved preference.
test("retrying a recording replays its cleanup mode", async (t) => {
  const harness = await mountHarness(t);

  await harness.press("dictation", { cleanupOverride: "raw" });
  await harness.press("dictation", { cleanupOverride: "raw" });

  // startRecording is the retry entry point the dictation-error pill uses: the
  // pill replays the mode its recording was made in.
  await React.act(async () => {
    await harness.api.startRecording({ cleanupOverride: "cleaned" });
  });
  assert.equal(harness.starts().at(-1).cleanupOverride, "cleaned");

  await harness.press("dictation", { cleanupOverride: "cleaned" });
  await React.act(async () => {
    await harness.api.startRecording();
  });
  assert.equal(harness.starts().at(-1).cleanupOverride, null);
});
