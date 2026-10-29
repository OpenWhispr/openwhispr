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
    this.pastes = [];
    globalThis.__clipboardPersistenceAudioManager = this;
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
  saveTranscription(...args) {
    return globalThis.__saveClipboardPersistenceTranscription(...args);
  }
  async safePaste(text) {
    this.pastes.push(text);
    return { pasted: true };
  }
  shouldUseStreaming() {
    return false;
  }
  cleanup() {}
}
`;

const SETTINGS_STORE_SOURCE = `
export const getSettings = () => globalThis.__clipboardPersistenceSettings;
`;

const POLICY_STORE_SOURCE = `
export const usePolicyStore = {
  getState: () => ({}),
  subscribe: () => () => {},
};
`;

const LOGGER_SOURCE = `
const record = (level, message, meta, scope) => {
  globalThis.__clipboardPersistenceLogs.push({ level, message, meta, scope });
};
export default {
  trace: (message, meta, scope) => record("trace", message, meta, scope),
  debug: (message, meta, scope) => record("debug", message, meta, scope),
  info: (message, meta, scope) => record("info", message, meta, scope),
  warn: (message, meta, scope) => record("warn", message, meta, scope),
  error: (message, meta, scope) => record("error", message, meta, scope),
  fatal: (message, meta, scope) => record("fatal", message, meta, scope),
  logReasoning: (message, meta) => record("debug", message, meta, "reasoning"),
};
`;

const TRANSLATION_SOURCE = `
const translate = (key) => key;
export const useTranslation = () => ({ t: translate });
`;

const NOOP = () => {};

async function mountCompletionHarness(
  t,
  {
    settings,
    writeClipboard = async () => ({ success: true }),
    replaceSelectedText = async () => ({ success: true }),
    saveTranscription = async () => true,
  }
) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const navigatorWrites = [];
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        async writeText(text) {
          navigatorWrites.push(text);
          throw new Error("renderer clipboard should not be used");
        },
      },
    },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });

  const bridgeWrites = [];
  const saves = [];
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
        async writeClipboard(text) {
          bridgeWrites.push(text);
          return writeClipboard(text);
        },
        replaceSelectedText,
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__clipboardPersistenceSettings = {
    autoPasteEnabled: false,
    keepTranscriptionInClipboard: true,
    showTranscriptionPreview: false,
    snippets: [],
    useLocalWhisper: false,
    pauseMediaOnDictation: false,
    voiceAgentScreenContext: false,
    ...settings,
  };
  globalThis.__clipboardPersistenceLogs = [];
  globalThis.__saveClipboardPersistenceTranscription = async (...args) => {
    saves.push(args);
    return saveTranscription(...args);
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-clipboard-persistence-",
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

  function Harness() {
    useAudioRecording(NOOP, { onDemoEvent: NOOP });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  return {
    bridgeWrites,
    complete: async (result) => {
      await React.act(async () => {
        await globalThis.__clipboardPersistenceAudioManager.complete(result);
      });
    },
    logs: globalThis.__clipboardPersistenceLogs,
    navigatorWrites,
    pastes: globalThis.__clipboardPersistenceAudioManager.pastes,
    saves,
  };
}

test("clipboard-only rejection cannot cancel non-preview transcription persistence", async (t) => {
  const harness = await mountCompletionHarness(t, {
    writeClipboard: async () => {
      throw new Error("main-process clipboard rejected");
    },
  });

  await harness.complete({
    success: true,
    text: "Final non-preview text",
    rawText: "Raw non-preview text",
    clientTranscriptionId: "client-non-preview",
    source: "openai",
  });

  assert.deepEqual(harness.saves, [
    [
      "Final non-preview text",
      "Raw non-preview text",
      { clientTranscriptionId: "client-non-preview" },
    ],
  ]);
  assert.ok(
    harness.logs.some(
      ({ level, message, meta, scope }) =>
        level === "warn" &&
        message === "Failed to keep transcription in clipboard" &&
        meta.delivery === "clipboard-only" &&
        scope === "clipboard"
    )
  );
  assert.deepEqual(harness.navigatorWrites, []);
});

test("paragraph-only output survives completion, clipboard delivery and persistence", async (t) => {
  const harness = await mountCompletionHarness(t, { settings: { preferredLanguage: "en-GB" } });
  await harness.complete({
    success: true,
    text: "\n\n",
    rawText: "  New paragraph. \n",
    source: "openai",
  });
  assert.deepEqual(harness.bridgeWrites, ["\n\n"]);
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0][0], "\n\n");
  assert.equal(harness.saves[0][1], "  New paragraph. \n");
});

test("explicit newlines reach automatic paste unchanged", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { preferredLanguage: "en", autoPasteEnabled: true },
  });
  for (const [text, rawText] of [
    ["\n\n", "New paragraph."],
    ["One.\n\nTwo.", "One. New paragraph. Two."],
    ["\n\n\n\n", "New paragraph. New paragraph."],
  ]) {
    await harness.complete({ success: true, text, rawText, source: "openai" });
  }
  assert.deepEqual(harness.pastes, ["\n\n", "One.\n\nTwo.", "\n\n\n\n"]);
  assert.deepEqual(
    harness.saves.map((args) => args[0]),
    harness.pastes
  );
});

test("the paragraph exception does not deliver arbitrary blank or assistant/selection output", async (t) => {
  const harness = await mountCompletionHarness(t, { settings: { preferredLanguage: "en" } });
  for (const result of [
    { text: "\n\n", rawText: "ordinary text" },
    { text: "\n\n", rawText: '"new paragraph"' },
    { text: "\n", rawText: "New paragraph." },
    { text: "\n\n", rawText: "New paragraph.", selectionEdit: { sessionId: "synthetic-session" } },
    {
      text: "\n\n",
      rawText: "New paragraph.",
      assistantConversation: { transcript: "synthetic request" },
    },
  ])
    await harness.complete({ success: true, source: "openai", ...result });
  assert.deepEqual(harness.bridgeWrites, []);
  assert.deepEqual(harness.saves, []);
  assert.deepEqual(harness.pastes, []);
});

test("clipboard-only unsuccessful bridge response is logged without cancelling persistence", async (t) => {
  const harness = await mountCompletionHarness(t, {
    writeClipboard: async () => ({ success: false }),
  });

  await harness.complete({
    success: true,
    text: "Text with an unsuccessful clipboard response",
    rawText: "Raw text with an unsuccessful clipboard response",
    clientTranscriptionId: "client-clipboard-unsuccessful",
    source: "openai",
  });

  assert.deepEqual(harness.saves, [
    [
      "Text with an unsuccessful clipboard response",
      "Raw text with an unsuccessful clipboard response",
      { clientTranscriptionId: "client-clipboard-unsuccessful" },
    ],
  ]);
  assert.ok(
    harness.logs.some(
      ({ level, message, meta, scope }) =>
        level === "warn" &&
        message === "Failed to keep transcription in clipboard" &&
        meta.delivery === "clipboard-only" &&
        scope === "clipboard"
    )
  );
  assert.deepEqual(harness.navigatorWrites, []);
});

test("clipboard-only delivery uses the main-process bridge for a streaming-capable result", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { showTranscriptionPreview: true },
  });

  await harness.complete({
    success: true,
    text: "Final streaming text",
    rawText: "Raw streaming text",
    clientTranscriptionId: "client-streaming",
    source: "deepgram-streaming",
  });

  assert.deepEqual(harness.bridgeWrites, ["Final streaming text"]);
  assert.deepEqual(harness.saves, [
    ["Final streaming text", "Raw streaming text", { clientTranscriptionId: "client-streaming" }],
  ]);
  assert.deepEqual(harness.navigatorWrites, []);
});

test("failed selection-edit clipboard rejection cannot cancel persistence", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { autoPasteEnabled: true },
    replaceSelectedText: async () => ({ success: false, code: "paste_failed" }),
    writeClipboard: async () => {
      throw new Error("main-process clipboard rejected");
    },
  });

  await harness.complete({
    success: true,
    text: "Edited selection text",
    rawText: "Raw selection instruction",
    clientTranscriptionId: "client-selection",
    source: "openai",
    selectionEdit: { sessionId: "selection-session" },
  });

  assert.deepEqual(harness.bridgeWrites, ["Edited selection text"]);
  assert.deepEqual(harness.saves, [
    [
      "Edited selection text",
      "Raw selection instruction",
      { clientTranscriptionId: "client-selection" },
    ],
  ]);
  assert.ok(
    harness.logs.some(
      ({ level, message, meta, scope }) =>
        level === "warn" &&
        message === "Failed to keep transcription in clipboard" &&
        meta.delivery === "selection-edit-fallback" &&
        scope === "clipboard"
    )
  );
  assert.deepEqual(harness.navigatorWrites, []);
});

test("a false persistence result is logged instead of silently ignored", async (t) => {
  const harness = await mountCompletionHarness(t, {
    saveTranscription: async () => false,
  });

  await harness.complete({
    success: true,
    text: "Text with a storage failure",
    rawText: "Raw text with a storage failure",
    clientTranscriptionId: "client-storage-failure",
    source: "openai",
  });

  assert.equal(harness.saves.length, 1);
  assert.ok(
    harness.logs.some(
      ({ level, message, scope }) =>
        level === "error" && message === "Failed to persist transcription" && scope === "audio"
    )
  );
  assert.deepEqual(harness.navigatorWrites, []);
});

test("the Insights timestamp rides along on the persistence call", async (t) => {
  // Persistence moved ahead of the paste so history survives a failed
  // clipboard delivery (#1979). The analytics timestamp has to travel with it:
  // recordAnalyticsEvent reads it from these options, and losing it here would
  // silently backdate every counter to the write time instead of the moment
  // the recording started.
  const harness = await mountCompletionHarness(t, {});

  await harness.complete({
    success: true,
    text: "Final text",
    rawText: "Raw text",
    clientTranscriptionId: "client-analytics",
    analyticsOccurredAt: "2026-09-04T09:00:00.000Z",
    source: "openai",
  });

  assert.deepEqual(harness.saves, [
    [
      "Final text",
      "Raw text",
      {
        clientTranscriptionId: "client-analytics",
        analyticsOccurredAt: "2026-09-04T09:00:00.000Z",
      },
    ],
  ]);
});
