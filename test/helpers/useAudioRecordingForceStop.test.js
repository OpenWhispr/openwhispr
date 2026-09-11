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
    this.sttConfig = {};
    globalThis.__forceStopAudioManager = this;
  }
  getState() {
    return {};
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  setVoiceAgentRequested() {}
  setAssistantSelectionContext() {}
  setTranslationRequested() {}
  startRecording() {
    return Promise.resolve(true);
  }
  complete(result) {
    return this.callbacks.onTranscriptionComplete(result);
  }
  async safePaste(text, options) {
    globalThis.__forceStopPastes.push({ text, options });
    return true;
  }
  saveTranscription() {
    return Promise.resolve(true);
  }
  shouldUseStreaming() {
    return false;
  }
  cleanup() {}
}
`;

const SETTINGS_STORE_SOURCE = `
export const getSettings = () => globalThis.__forceStopSettings;
`;

const POLICY_STORE_SOURCE = `
export const usePolicyStore = {
  // An unknown status fails closed at the policy gate, which would make the
  // second dictation bail before it reaches AudioManager at all.
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

async function mountHarness(t, { settings, writeClipboard } = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const clipboardWrites = [];
  const toasts = [];
  let forceStopListener = null;
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
        onDictationForceStopped: (callback) => {
          forceStopListener = callback;
          return () => {};
        },
        dictationLifecycleStateChanged: NOOP,
        completeDictationPreview: NOOP,
        hideDictationPreview: NOOP,
        setScreenContextEnabled: NOOP,
        async writeClipboard(text) {
          clipboardWrites.push(text);
          return writeClipboard ? writeClipboard(text) : { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__forceStopSettings = {
    autoPasteEnabled: true,
    keepTranscriptionInClipboard: false,
    showTranscriptionPreview: false,
    snippets: [],
    useLocalWhisper: false,
    pauseMediaOnDictation: false,
    voiceAgentScreenContext: false,
    ...settings,
  };
  globalThis.__forceStopPastes = [];

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-force-stop-",
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
  function Harness() {
    Object.assign(
      api,
      useAudioRecording((entry) => toasts.push(entry), { onDemoEvent: NOOP })
    );
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  return {
    clipboardWrites,
    pastes: globalThis.__forceStopPastes,
    toasts,
    forceStop: async (reason) => {
      assert.ok(forceStopListener, "the hook must subscribe to dictation-force-stopped");
      await React.act(async () => forceStopListener({ reason }));
    },
    startRecording: async () => {
      await React.act(async () => api.startRecording());
    },
    complete: async (result) => {
      await React.act(async () => {
        await globalThis.__forceStopAudioManager.complete({
          success: true,
          text: "held too long",
          rawText: "held too long",
          clientTranscriptionId: "force-stop",
          source: "openai",
          ...result,
        });
      });
    },
  };
}

const errorToasts = (harness) =>
  harness.toasts.filter((entry) => entry.presentation === "dictation-error");

// The whole point of the fix: the trigger keys are still down, so the paste
// shortcut must not be injected, and the transcript must stay recoverable.
for (const reason of ["timeout", "reset"]) {
  test(`a push force-stopped by "${reason}" keeps the transcript instead of pasting it`, async (t) => {
    const harness = await mountHarness(t);

    await harness.forceStop(reason);
    await harness.complete();

    assert.deepEqual(harness.pastes, [], "nothing may be injected into held keys");
    assert.deepEqual(harness.clipboardWrites, ["held too long"]);
    const [toast] = errorToasts(harness);
    assert.ok(toast, "the transcript is surfaced, not dropped");
    assert.equal(toast.description, "hooks.audioRecording.pushForceStopped.description");
    // A batch transcription has no streaming text, so the pill's transcript
    // argument is the only thing that can produce this action — and it is the
    // sole in-app recovery when the clipboard write is the part that failed.
    assert.ok(
      toast.actions.some(
        (action) => action.label === "hooks.audioRecording.errorActions.viewTranscript"
      ),
      "the pill must carry the transcript so it stays recoverable"
    );
  });
}

test("an ordinary dictation still pastes", async (t) => {
  const harness = await mountHarness(t);

  await harness.complete();

  assert.equal(harness.pastes.length, 1);
  assert.deepEqual(harness.clipboardWrites, []);
  assert.deepEqual(errorToasts(harness), []);
});

// With auto-paste off nothing was going to be injected, so there is no loss to
// report — and overriding keepTranscriptionInClipboard would clobber a clipboard
// the user asked to leave alone.
test("a force stop is inert when auto-paste is disabled", async (t) => {
  const harness = await mountHarness(t, { settings: { autoPasteEnabled: false } });

  await harness.forceStop("timeout");
  await harness.complete();

  assert.deepEqual(harness.pastes, []);
  assert.deepEqual(harness.clipboardWrites, [], "keepTranscriptionInClipboard is off");
  assert.deepEqual(errorToasts(harness), [], "no paste was lost, so no error");
});

// The latch is per-recording. If it survived, every later dictation in the
// session would stop pasting and dump onto the clipboard instead.
test("the latch does not leak into the next dictation", async (t) => {
  const harness = await mountHarness(t);

  await harness.forceStop("timeout");
  await harness.complete();
  assert.deepEqual(harness.pastes, [], "the force-stopped one is held back");

  await harness.startRecording();
  await harness.complete();

  assert.equal(harness.pastes.length, 1, "the next dictation pastes normally");
  assert.equal(errorToasts(harness).length, 1, "no second error pill");
});

// Only reasons that leave the keys down may suppress a paste. A stop the
// renderer asked for itself must not be swept in.
test("a reason that is not a forced key-down stop does not latch", async (t) => {
  const harness = await mountHarness(t);

  await harness.forceStop("manual");
  await harness.complete();

  assert.equal(harness.pastes.length, 1, "a manual stop still pastes");
  assert.deepEqual(harness.clipboardWrites, []);
  assert.deepEqual(errorToasts(harness), []);
});

// The pill must not promise a clipboard that rejected the write — the transcript
// action on it is the recovery path either way.
for (const [label, writeClipboard] of [
  ["reports failure", async () => ({ success: false })],
  [
    "throws",
    async () => {
      throw new Error("clipboard unavailable");
    },
  ],
]) {
  test(`a clipboard write that ${label} is not described as a success`, async (t) => {
    const harness = await mountHarness(t, { writeClipboard });

    await harness.forceStop("timeout");
    await harness.complete();

    assert.deepEqual(harness.pastes, [], "still nothing injected into held keys");
    const [toast] = errorToasts(harness);
    assert.ok(toast, "the transcript is still surfaced");
    assert.equal(
      toast.description,
      "hooks.audioRecording.pushForceStopped.descriptionClipboardFailed"
    );
  });
}
