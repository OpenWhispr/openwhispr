const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// "Explain this" over a selection banks the command with the selection quoted,
// and the hook hands it to the assistant panel. Snippets expand what the user
// said, never the quoted document text.
test("a question about a selection expands snippets in the command but quotes the selection verbatim", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__assistantCommandManager;
  });
  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    initialStorage: { onboardingCompleted: "true" },
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onStopDictation: noopDispose,
        hideDictationPreview: async () => {},
        completeDictationPreview: async () => {},
        dictationLifecycleStateChanged: () => {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-command-hook-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/utils/visualFrame": "export async function waitForVisualFrames() {}",
      // Only the hook's import gets this fake; "/helpers/audioManager.js" below
      // still loads the real manager that banks the command.
      "/helpers/audioManager": `export default class FakeAudioManager {
      constructor() { this.voiceAgentRequested=false; this.sttConfig={success:true}; globalThis.__assistantCommandManager=this; }
      setCallbacks(callbacks) { this.callbacks=callbacks; }
      getState() { return { isRecording:false, isProcessing:false }; }
      shouldUseStreaming() { return false; }
      isSttConfigStale() { return false; }
      setVoiceAgentRequested(value) { this.voiceAgentRequested=value; }
      setAssistantSelectionContext() {}
      setTranslationRequested() {}
      async startRecording() { return true; }
      async saveTranscription() { return true; }
      cleanup() {}
    }`,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { default: AudioManager } = await vite.ssrLoadModule("/helpers/audioManager.js");
  const { SELECTION_QUESTION_MARKER } = await vite.ssrLoadModule("/helpers/selectionEditing.js");
  useSettingsStore.setState({
    autoPasteEnabled: false,
    snippets: [{ trigger: "brb", replacement: "be right back" }],
    useLocalWhisper: true,
    pauseMediaOnDictation: false,
  });
  const commands = [];
  function Harness() {
    useAudioRecording(() => {}, { onAssistantCommand: (command) => commands.push(command) });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isProcessing: true,
    pendingAssistantConversation: null,
    voiceAgentRequested: false,
    consumeSelectionCapture: async () => ({ status: "selected", text: "ok brb", sessionId: "s1" }),
    processWithReasoningModel: async (_text, _model, _agentName, config) => {
      const marker = config.systemPrompt.match(/__OPENWHISPR_SELECTION_COMPLETE_[^\s]+__/);
      return `${SELECTION_QUESTION_MARKER}${marker[0]}`;
    },
  });
  const text = await manager.processAgentCommand("Hey Aria, what does brb mean?", "gpt", "Aria", {
    provider: "openai",
    selectionEditReachable: true,
    systemPrompt: "base prompt",
  });
  await React.act(async () =>
    globalThis.__assistantCommandManager.callbacks.onTranscriptionComplete({
      success: true,
      text,
      ...manager._takePendingResultExtras(),
    })
  );

  assert.deepEqual(
    commands.map((command) => command.text),
    ['what does be right back mean?\n\n"ok brb"']
  );
});
