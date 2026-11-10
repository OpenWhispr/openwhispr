const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const en = require("../../src/locales/en/translation.json");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const FAKE_AUDIO_MANAGER_SOURCE = `
export const managers = [];
export default class FakeAudioManager {
  constructor() {
    managers.push(this);
  }
  getState() {
    return {};
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  recoverInterruptedRecordings() {}
  shouldUseStreaming() {
    return false;
  }
  cancelPreparedMicCapture() {}
  cleanup() {}
  async saveTranscription() {
    return true;
  }
}
`;

// A command goes to the agent window through main, or during onboarding to
// the headless responder; both sit behind the account check.
async function renderHook(t, accountChanged, { onboarded = true, keepHistory = true } = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const noopDispose = () => () => {};
  const checkedTimes = [];
  const commands = [];
  const toasts = [];
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
        accountChangedSince: async (occurredAt) => {
          checkedTimes.push(occurredAt);
          return accountChanged;
        },
        submitAgentCommand: (command) => commands.push(command),
      },
    },
  });
  if (onboarded) localStorage.setItem("onboardingCompleted", "true");
  if (!keepHistory) localStorage.setItem("dataRetentionEnabled", "false");
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-account-change-",
    mockModules: { "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { managers } = await vite.ssrLoadModule("/helpers/audioManager");

  function Harness() {
    useAudioRecording((toast) => toasts.push(toast), {
      onDemoEvent: () => {},
      onOnboardingAssistantCommand: (command) => commands.push(command),
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  return { manager: managers.at(-1), commands, checkedTimes, toasts };
}

const voiceCommandResult = {
  success: true,
  text: "what's on my calendar",
  rawText: "what's on my calendar",
  source: "local",
  analyticsOccurredAt: "2026-11-03T10:00:00.000Z",
  assistantConversation: { transcript: "what's on my calendar" },
};

for (const [surface, onboarded] of [
  ["agent window", true],
  ["onboarding demo", false],
]) {
  test(`a voice command spoken before an account switch never reaches the next account's ${surface}`, async (t) => {
    const { manager, commands, checkedTimes } = await renderHook(t, true, { onboarded });

    await React.act(async () => {
      await manager.callbacks.onTranscriptionComplete({ ...voiceCommandResult });
    });

    assert.deepEqual(checkedTimes, [voiceCommandResult.analyticsOccurredAt]);
    assert.deepEqual(commands, []);
  });

  test(`a voice command dropped from the ${surface} says so in the dictation pill`, async (t) => {
    const { manager, toasts } = await renderHook(t, true, { onboarded });
    // What a streamed command leaves behind, which other pills offer as the transcript.
    manager.streamingFinalText = voiceCommandResult.text;

    await React.act(async () => {
      await manager.callbacks.onTranscriptionComplete({ ...voiceCommandResult });
    });

    const copy = en.hooks.audioRecording.commandAccountChanged;
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].presentation, "dictation-error");
    assert.equal(toasts[0].title, copy.title);
    assert.equal(toasts[0].description, copy.description, "it points to that account's history");
    assert.deepEqual(
      toasts[0].actions.map((action) => action.label),
      [en.common.retry],
      "the departed account's transcript isn't offered to the one signed in now"
    );
  });

  test(`a voice command reaching the ${surface} shows no account notice`, async (t) => {
    const { manager, toasts } = await renderHook(t, false, { onboarded });

    await React.act(async () => {
      await manager.callbacks.onTranscriptionComplete({ ...voiceCommandResult });
    });

    assert.deepEqual(toasts, []);
  });

  test(`a voice command reaches the ${surface} when the account is unchanged`, async (t) => {
    const { manager, commands } = await renderHook(t, false, { onboarded });

    await React.act(async () => {
      await manager.callbacks.onTranscriptionComplete({ ...voiceCommandResult });
    });

    assert.equal(commands.length, 1);
    assert.equal(commands[0].text, "what's on my calendar");
  });
}

test("with local history off, the dropped command's notice doesn't promise a saved transcript", async (t) => {
  const { manager, toasts } = await renderHook(t, true, { keepHistory: false });

  await React.act(async () => {
    await manager.callbacks.onTranscriptionComplete({ ...voiceCommandResult });
  });

  assert.equal(toasts.length, 1);
  assert.equal(
    toasts[0].description,
    en.hooks.audioRecording.commandAccountChanged.descriptionNotSaved
  );
});
