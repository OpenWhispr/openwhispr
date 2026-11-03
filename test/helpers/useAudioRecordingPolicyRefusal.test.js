const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { managedPolicy } = require("./harness/policyFixtures");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.sttConfig = { success: true };
    FakeAudioManager.instance = this;
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
  shouldUseStreaming() {
    return false;
  }
  isSttConfigStale() {
    return false;
  }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  cleanup() {}
  async startRecording() {
    return false;
  }
}
`;

async function setup(t) {
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
        dictationLifecycleStateChanged() {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-policy-refusal-",
    mockModules: { "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE },
  });
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { default: FakeAudioManager } = await vite.ssrLoadModule("/helpers/audioManager");
  useSettingsStore.setState({
    transcriptionMode: "local",
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    whisperModel: "small",
  });
  const toasts = [];
  let api;
  function Harness() {
    api = useAudioRecording((config) => toasts.push(config), { onDemoEvent: () => {} });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return { api, toasts, usePolicyStore, manager: FakeAudioManager.instance };
}

const policyState = (transcription) => ({
  status: "managed",
  appVersion: "1.11.1",
  policy: { ...managedPolicy({ transcription }), features: { agentEnabled: true } },
});

for (const [label, transcription, title] of [
  [
    "an unapproved model",
    { allowedModes: ["local"], allowedLocalModels: ["base"] },
    "Your organization does not approve this local model. Choose an approved model.",
  ],
  [
    "Local off with nowhere to move",
    { allowedModes: [], allowedLocalModels: null },
    "Your organization has disabled local processing.",
  ],
]) {
  test(`a dictation refused for ${label} says why and offers Settings`, async (t) => {
    const { api, toasts, usePolicyStore } = await setup(t);
    usePolicyStore.setState(policyState(transcription));
    await React.act(async () => {
      assert.equal(await api.startRecording(), false);
    });
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].title, title);
    assert.deepEqual(
      toasts[0].actions.map((action) => action.icon),
      ["settings"]
    );
  });
}

test("refusals another model wouldn't fix stay generic, without a Settings link", async (t) => {
  const { api, toasts, usePolicyStore } = await setup(t);
  usePolicyStore.setState({ status: "loading", policy: null, appVersion: null });
  await React.act(async () => {
    assert.equal(await api.startRecording(), false);
  });
  assert.equal(toasts[0].title, "Managed by your organization");
  assert.equal(toasts[0].actions, undefined);
});

test("a refusal from main keeps its message and gains the Settings link on the error card", async (t) => {
  const { toasts, manager } = await setup(t);
  await React.act(async () => {
    manager.callbacks.onError({
      title: "Transcription Error",
      description: "Transcription failed: refused",
      code: "POLICY_MODEL_BLOCKED",
    });
  });
  const card = toasts.at(-1);
  assert.equal(card.presentation, "dictation-error");
  assert.ok(card.actions.some((action) => action.icon === "settings"));
});
