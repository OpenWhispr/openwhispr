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
    this.saves = [];
    this.discards = 0;
    globalThis.__assistantHistoryAudioManager = this;
  }
  getState() {
    return {};
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  complete(result) {
    return this.callbacks.onTranscriptionComplete(result);
  }
  async saveTranscription(...args) {
    this.saves.push(args);
    return true;
  }
  discardCapturedAudio() {
    this.discards += 1;
  }
  async safePaste() {
    return { pasted: true };
  }
  shouldUseStreaming() {
    return false;
  }
  cleanup() {}
}
`;

const SETTINGS_STORE_SOURCE = `
export const getSettings = () => ({
  autoPasteEnabled: true,
  keepTranscriptionInClipboard: true,
  showTranscriptionPreview: false,
  snippets: [],
  useLocalWhisper: false,
  pauseMediaOnDictation: false,
  voiceAgentScreenContext: false,
});
`;

const POLICY_STORE_SOURCE = `
export const usePolicyStore = {
  getState: () => ({}),
  subscribe: () => () => {},
};
`;

const TRANSLATION_SOURCE = `
export const useTranslation = () => ({ t: (key) => key });
`;

const NOOP = () => {};

async function mountCompletionHarness(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__assistantHistoryAudioManager;
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
        dictationLifecycleStateChanged: NOOP,
        completeDictationPreview: NOOP,
        hideDictationPreview: NOOP,
        setScreenContextEnabled: NOOP,
        async writeClipboard() {
          return { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);
  localStorage.setItem("onboardingCompleted", "true");

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-assistant-history-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/stores/settingsStore": SETTINGS_STORE_SOURCE,
      "/stores/policyStore": POLICY_STORE_SOURCE,
      "/utils/logger": `export default { debug() {}, info() {}, warn() {}, error() {} };`,
      "react-i18next": TRANSLATION_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  const assistantCommands = [];
  function Harness() {
    useAudioRecording(NOOP, {
      onDemoEvent: NOOP,
      onAssistantCommand: (command) => assistantCommands.push(command),
    });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  const manager = globalThis.__assistantHistoryAudioManager;
  return {
    manager,
    assistantCommands,
    complete: async (result) => {
      await React.act(async () => {
        await manager.complete(result);
      });
    },
  };
}

test("a voice-assistant command reaches the panel without a dictation history row", async (t) => {
  const harness = await mountCompletionHarness(t);

  await harness.complete({
    success: true,
    text: "what's on my calendar tomorrow",
    rawText: "what's on my calendar tomorrow",
    clientTranscriptionId: "client-assistant",
    source: "openai",
    assistantConversation: { transcript: "what's on my calendar tomorrow", screenContext: null },
  });

  assert.deepEqual(harness.manager.saves, []);
  assert.equal(harness.manager.discards, 1);
  assert.equal(harness.assistantCommands.length, 1);
  assert.equal(harness.assistantCommands[0].text, "what's on my calendar tomorrow");
});

test("an ordinary dictation still saves to history", async (t) => {
  const harness = await mountCompletionHarness(t);

  await harness.complete({
    success: true,
    text: "Final dictation",
    rawText: "Raw dictation",
    clientTranscriptionId: "client-dictation",
    source: "openai",
  });

  assert.deepEqual(harness.manager.saves, [
    ["Final dictation", "Raw dictation", { clientTranscriptionId: "client-dictation" }],
  ]);
  assert.equal(harness.manager.discards, 0);
  assert.deepEqual(harness.assistantCommands, []);
});
