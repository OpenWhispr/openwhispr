const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager: loadAudioManagerHarness } = require("./harness/audioManager");

// Standalone voice-assistant commands never run the dictation-agent model:
// processAgentCommand banks a pendingAssistantConversation directive (the
// side-channel the emission sites attach to the result) and returns the raw
// transcript. Selection edits keep the in-place path.
async function loadAudioManager(t, { cachePrefix, settingsKey }) {
  const { createManager } = await loadAudioManagerHarness(t, {
    cachePrefix,
    settingsKey,
    mockModules: {
      // This suite exercises paths that call the ReasoningService default
      // export directly, so it stubs the object form rather than the class.
      "/services/ReasoningService": 'export default { processText: async () => "" };',
    },
  });
  return { createManager };
}

function managerWithCapture(createManager, capture) {
  const modelCalls = [];
  return {
    modelCalls,
    // _bankAssistantDirective only ever runs mid-pipeline, so it guards on
    // isProcessing — set it true here to match that real precondition.
    manager: createManager({
      isProcessing: true,
      pendingAssistantConversation: null,
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

test("a verified caret banks targeted response delivery when auto-paste is enabled", async (t) => {
  const { createManager } = await loadAudioManagerHarness(t, {
    cachePrefix: "openwhispr-assistant-caret-delivery-",
    settingsKey: "__assistantCaretDeliverySettings",
    settings: { autoPasteEnabled: true },
    mockModules: {
      "/services/ReasoningService": 'export default { processText: async () => "" };',
    },
  });
  const { manager, modelCalls } = managerWithCapture(createManager, {
    status: "editable",
    sessionId: "caret-session",
  });

  const result = await manager.processAgentCommand("draft a reply", "gpt", "Aria", {
    selectionEditReachable: true,
  });

  assert.equal(result, "draft a reply");
  assert.deepEqual(manager.pendingAssistantConversation, {
    transcript: "draft a reply",
    screenContext: null,
    deliverySessionId: "caret-session",
  });
  assert.equal(modelCalls.length, 0, "caret delivery must retain the chat Agent route");
});

test("a verified caret stays panel-first when auto-paste is disabled", async (t) => {
  const { createManager } = await loadAudioManagerHarness(t, {
    cachePrefix: "openwhispr-assistant-caret-panel-",
    settingsKey: "__assistantCaretPanelSettings",
    settings: { autoPasteEnabled: false },
    mockModules: {
      "/services/ReasoningService": 'export default { processText: async () => "" };',
    },
  });
  const { manager } = managerWithCapture(createManager, {
    status: "editable",
    sessionId: "caret-session",
  });

  await manager.processAgentCommand("draft a reply", "gpt", "Aria", {
    selectionEditReachable: true,
  });

  assert.deepEqual(manager.pendingAssistantConversation, {
    transcript: "draft a reply",
    screenContext: null,
  });
});

test("a wake-word command is banked without the address", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-wakeword-",
    settingsKey: "__assistantWakewordSettings",
  });
  const { manager } = managerWithCapture(createManager, null);
  manager.voiceAgentRequested = false;
  const result = await manager.processAgentCommand("Hey Aria, draft a reply", "gpt", "Aria", {
    selectionEditReachable: true,
  });
  assert.equal(result, "Hey Aria, draft a reply");
  assert.equal(manager.pendingAssistantConversation.transcript, "draft a reply");
});

test("a policy-restricted org never gets a panel command banked", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-policy-",
    settingsKey: "__assistantPolicySettings",
  });
  const { manager } = managerWithCapture(createManager, null);
  manager.assertAgentAllowedByPolicy = () => {
    const error = new Error("AI agent use is restricted by your organization.");
    error.code = "POLICY_RESTRICTED";
    throw error;
  };
  await assert.rejects(
    manager.processAgentCommand("Hey Aria, summarize this", "gpt", "Aria", {
      selectionEditReachable: true,
    }),
    /restricted/
  );
  assert.equal(manager.pendingAssistantConversation, null);
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

test("an attached screenshot still reaches the panel through the raw carry", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-attached-",
    settingsKey: "__assistantAttachedSettings",
  });
  const { manager } = managerWithCapture(createManager, null);
  // resolveReasoningRoute mirrors the attached screenContext into
  // rawScreenContext (same object), so the raw carry is the single source
  // the banking path reads.
  const screenshot = { mediaType: "image/jpeg", data: "attached" };

  await manager.processAgentCommand("read this", "gpt", "Aria", {
    selectionEditReachable: true,
    screenContext: screenshot,
    rawScreenContext: screenshot,
  });

  assert.equal(manager.pendingAssistantConversation.screenContext, screenshot);
});

test("an Agent-panel selection stays on the panel route without touching external selection editing", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-internal-selection-",
    settingsKey: "__assistantInternalSelectionSettings",
  });
  let externalCaptureCalls = 0;
  const manager = createManager({
    isProcessing: true,
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

test("a too-large selection with no dictation editor goes to the panel as a plain command", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-toolarge-",
    settingsKey: "__assistantTooLargeSettings",
  });
  const { manager } = managerWithCapture(createManager, {
    status: "too_large",
    maxCharacters: 6000,
  });
  const result = await manager.processAgentCommand("summarize this", "gpt", "Aria", {
    selectionEditReachable: false,
  });
  assert.equal(result, "summarize this");
  assert.equal(manager.pendingAssistantConversation.transcript, "summarize this");
});

test("an ambiguous capture with no dictation editor goes to the panel as a plain command", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-ambiguous-",
    settingsKey: "__assistantAmbiguousSettings",
  });
  const { manager } = managerWithCapture(createManager, { status: "target_changed" });
  await manager.processAgentCommand("summarize this", "gpt", "Aria", {
    selectionEditReachable: false,
  });
  assert.equal(manager.pendingAssistantConversation.transcript, "summarize this");
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
      rawScreenContext: { mediaType: "image/jpeg", data: "raw" },
      systemPrompt: "base prompt",
    });
  } catch {
    // The mocked model result carries no completion marker; the selection
    // pipeline may reject it. The routing assertion below is what matters.
  }

  assert.equal(modelCalls.length, 1, "the dictation-agent model runs the selection edit");
  assert.equal(manager.pendingAssistantConversation ?? null, null);
  // Routing-only directives must not leak into the reasoning layer.
  const selectionConfig = modelCalls[0][3];
  assert.ok(!("selectionEditReachable" in selectionConfig));
  assert.ok(!("rawScreenContext" in selectionConfig));
});
