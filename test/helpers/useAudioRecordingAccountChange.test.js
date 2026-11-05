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

async function renderHook(t, accountChanged) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const noopDispose = () => () => {};
  const checkedTimes = [];
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
      },
    },
  });
  localStorage.setItem("onboardingCompleted", "true");
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-account-change-",
    mockModules: { "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { managers } = await vite.ssrLoadModule("/helpers/audioManager");

  const commands = [];
  function Harness() {
    useAudioRecording(() => {}, {
      onDemoEvent: () => {},
      onAssistantCommand: (command) => commands.push(command),
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  return { manager: managers.at(-1), commands, checkedTimes };
}

const voiceCommandResult = {
  success: true,
  text: "what's on my calendar",
  rawText: "what's on my calendar",
  source: "local",
  analyticsOccurredAt: "2026-11-03T10:00:00.000Z",
  assistantConversation: { transcript: "what's on my calendar" },
};

test("a voice command spoken before an account switch never reaches the next account's panel", async (t) => {
  const { manager, commands, checkedTimes } = await renderHook(t, true);

  await React.act(async () => {
    await manager.callbacks.onTranscriptionComplete({ ...voiceCommandResult });
  });

  assert.deepEqual(checkedTimes, [voiceCommandResult.analyticsOccurredAt]);
  assert.deepEqual(commands, []);
});

test("a voice command runs when the account is unchanged", async (t) => {
  const { manager, commands } = await renderHook(t, false);

  await React.act(async () => {
    await manager.callbacks.onTranscriptionComplete({ ...voiceCommandResult });
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].text, "what's on my calendar");
});
