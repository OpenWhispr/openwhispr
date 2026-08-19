const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Standalone voice-assistant commands never run the dictation-agent model:
// processAgentCommand banks a pendingAssistantConversation directive (the
// side-channel the emission sites attach to the result) and returns the raw
// transcript. Selection edits keep the in-place path.
async function loadAudioManager(t, { cachePrefix, settingsKey }) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix,
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.${settingsKey};
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": 'export default { processText: async () => "" };',
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  t.after(() => {
    delete globalThis[settingsKey];
  });
  globalThis[settingsKey] = {};

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return {
    createManager: (overrides = {}) =>
      Object.assign(Object.create(AudioManager.prototype), overrides),
  };
}

function managerWithCapture(createManager, capture) {
  const modelCalls = [];
  return {
    modelCalls,
    manager: createManager({
      consumeSelectionCapture: async () => capture,
      processWithReasoningModel: async (...args) => {
        modelCalls.push(args);
        return "MODEL_RESULT";
      },
    }),
  };
}

test("a standalone command banks a panel directive and returns the transcript", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-standalone-",
    settingsKey: "__assistantStandaloneSettings",
  });
  const { manager, modelCalls } = managerWithCapture(createManager, null);

  const result = await manager.processAgentCommand("draft a reply", "gpt", "Aria", {
    selectionEditReachable: true,
  });

  assert.equal(result, "draft a reply");
  assert.deepEqual(manager.pendingAssistantConversation, {
    transcript: "draft a reply",
    screenContext: null,
  });
  assert.equal(modelCalls.length, 0, "the dictation-agent model must not run");
});

test("the directive carries the raw screenshot past the attach gate", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-screenshot-",
    settingsKey: "__assistantScreenshotSettings",
  });
  const { manager } = managerWithCapture(createManager, null);
  const screenshot = { mediaType: "image/jpeg", data: "b64" };

  await manager.processAgentCommand("what is on screen", "gpt", "Aria", {
    selectionEditReachable: true,
    rawScreenContext: screenshot,
  });

  assert.equal(manager.pendingAssistantConversation.screenContext, screenshot);
});

test("an attached screenshot is preferred over the raw carry", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-attached-",
    settingsKey: "__assistantAttachedSettings",
  });
  const { manager } = managerWithCapture(createManager, null);
  const attached = { mediaType: "image/jpeg", data: "attached" };

  await manager.processAgentCommand("read this", "gpt", "Aria", {
    selectionEditReachable: true,
    screenContext: attached,
    rawScreenContext: { mediaType: "image/jpeg", data: "raw" },
  });

  assert.equal(manager.pendingAssistantConversation.screenContext, attached);
});

test("an Agent-panel selection stays on the panel route without touching external selection editing", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-internal-selection-",
    settingsKey: "__assistantInternalSelectionSettings",
  });
  let externalCaptureCalls = 0;
  const manager = createManager({
    consumeSelectionCapture: async () => {
      externalCaptureCalls += 1;
      throw new Error("external selection should not be read");
    },
  });
  manager.setAssistantSelectionContext({
    text: "the selected Agent response",
    sourceMessageId: "assistant-1",
  });

  const result = await manager.processAgentCommand("make this friendlier", "gpt", "Aria", {
    selectionEditReachable: true,
  });

  assert.equal(result, "make this friendlier");
  assert.deepEqual(manager.pendingAssistantConversation, {
    transcript: "make this friendlier",
    screenContext: null,
    selectedContext: {
      text: "the selected Agent response",
      sourceMessageId: "assistant-1",
    },
  });
  assert.equal(externalCaptureCalls, 0);
  assert.equal(manager.assistantSelectionContext, null, "the context must be one-shot");
  assert.ok(!manager.pendingSelectionEdit, "no in-place replacement session may be armed");
});

test("a selection without a reachable dictation agent routes to the panel with the selection quoted", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-sel-unreachable-",
    settingsKey: "__assistantSelUnreachableSettings",
  });
  const capture = { status: "selected", text: "the selected paragraph", sessionId: "s1" };
  const { manager, modelCalls } = managerWithCapture(createManager, capture);

  const result = await manager.processAgentCommand("make this shorter", "gpt", "Aria", {
    selectionEditReachable: false,
  });

  assert.equal(result, "make this shorter");
  assert.equal(
    manager.pendingAssistantConversation.transcript,
    'make this shorter\n\n"the selected paragraph"'
  );
  assert.equal(modelCalls.length, 0);
  assert.ok(!manager.pendingSelectionEdit, "no in-place replacement session may be armed");
});

test("a selection with the dictation agent reachable keeps the in-place edit path", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-sel-reachable-",
    settingsKey: "__assistantSelReachableSettings",
  });
  const capture = { status: "selected", text: "the selected paragraph", sessionId: "s1" };
  const { manager, modelCalls } = managerWithCapture(createManager, capture);

  try {
    await manager.processAgentCommand("make this shorter", "gpt", "Aria", {
      selectionEditReachable: true,
      systemPrompt: "base prompt",
    });
  } catch {
    // The mocked model result carries no completion marker; the selection
    // pipeline may reject it. The routing assertion below is what matters.
  }

  assert.equal(modelCalls.length, 1, "the dictation-agent model runs the selection edit");
  assert.equal(manager.pendingAssistantConversation ?? null, null);
});
