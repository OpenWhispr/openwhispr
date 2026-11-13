const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MARKER_RE = /__OPENWHISPR_SELECTION_COMPLETE_[0-9a-f-]+/;

// audioManager pulls in the whole renderer graph; ReasoningService is routed
// through a globalThis slot so each test can script its responses.
async function loadAudioManager(t, { cachePrefix, settingsKey, reasoningKey }) {
  const { window } = installBrowserGlobals(t);
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
      "/services/ReasoningService": `
        export default { processText: (...args) => globalThis.${reasoningKey}(...args) };
      `,
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  t.after(() => {
    delete globalThis[settingsKey];
    delete globalThis[reasoningKey];
  });
  globalThis[settingsKey] = {};

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return {
    window,
    setProcessText: (fn) => {
      globalThis[reasoningKey] = fn;
    },
    // Prototype-only instance: the constructor wires up media devices we don't need.
    createManager: (overrides = {}) =>
      Object.assign(Object.create(AudioManager.prototype), overrides),
  };
}

test("a selection edit survives a rejected screenshot via the text-only retry", async (t) => {
  const { window, setProcessText, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sc-retry-test-",
    settingsKey: "__scRetrySettings",
    reasoningKey: "__scRetryProcessText",
  });

  window.electronAPI.captureSelectedText = async () => ({
    status: "selected",
    text: "selected body",
    sessionId: "s1",
  });

  const processTextCalls = [];
  setProcessText(async (text, model, agentName, config) => {
    processTextCalls.push({ text, config });
    if (config.screenContext) {
      throw new Error("model rejected the image");
    }
    const marker = config.systemPrompt.match(MARKER_RE)?.[0] ?? "";
    return `shorter text${marker}`;
  });

  const notices = [];
  const manager = createManager({ onError: (notice) => notices.push(notice) });

  const replacement = await manager.processAgentCommand("make it shorter", "gpt-5", "Agent", {
    systemPrompt: "BASE PROMPT SCREEN_SUFFIX_SENTINEL",
    textOnlySystemPrompt: "BASE PROMPT",
    screenContext: { mediaType: "image/jpeg", data: "x" },
    selectionEditReachable: true,
  });

  assert.equal(replacement, "shorter text");
  assert.equal(processTextCalls.length, 2);

  const [first, retry] = processTextCalls;
  // Both calls carry the same selection-edit user payload and marker.
  assert.equal(retry.text, first.text);
  const firstMarker = first.config.systemPrompt.match(MARKER_RE)?.[0];
  const retryMarker = retry.config.systemPrompt.match(MARKER_RE)?.[0];
  assert.ok(firstMarker, "primary prompt must carry the completion marker");
  assert.equal(retryMarker, firstMarker);
  // The retry drops the image and its prompt suffix, nothing else.
  assert.equal(retry.config.screenContext, undefined);
  assert.equal(retry.config.textOnlySystemPrompt, undefined);
  assert.ok(retry.config.systemPrompt.includes("SELECTION EDITING MODE"));
  assert.ok(!retry.config.systemPrompt.includes("SCREEN_SUFFIX_SENTINEL"));
  assert.equal(retry.config.requireCompleteOutput, true);

  assert.deepEqual(
    notices.map((n) => n.code),
    ["SCREEN_CONTEXT_SKIPPED"]
  );
});

test("the text-only retry swaps in the pre-built prompt verbatim", async (t) => {
  const { setProcessText, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sc-retry-direct-test-",
    settingsKey: "__scRetryDirectSettings",
    reasoningKey: "__scRetryDirectProcessText",
  });

  const prompts = [];
  setProcessText(async (text, model, agentName, config) => {
    prompts.push(config.systemPrompt);
    if (config.screenContext) throw new Error("image too large");
    return "done";
  });

  const manager = createManager({ onError: () => {} });
  const result = await manager.processWithReasoningModel("hello", "gpt-5", "Agent", {
    systemPrompt: "BASE PROMPT WITH SUFFIX",
    textOnlySystemPrompt: "BASE PROMPT",
    screenContext: { mediaType: "image/jpeg", data: "x" },
  });

  assert.equal(result, "done");
  assert.deepEqual(prompts, ["BASE PROMPT WITH SUFFIX", "BASE PROMPT"]);
});

test("a Cloud selection screenshot retry validates the same JSON contract", async (t) => {
  const { setProcessText, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-cloud-selection-retry-",
    settingsKey: "__cloudSelectionRetrySettings",
    reasoningKey: "__cloudSelectionRetryProcessText",
  });
  for (const [name, response, expected] of [
    ["complete JSON", '{"replacement":"Complete replacement."}', "Complete replacement."],
    [
      "literal document formatting",
      '{"replacement":"  \\"quoted\\"\\n```ts\\nconst value = \\"literal\\";\\n```\\n"}',
      '  "quoted"\n```ts\nconst value = "literal";\n```\n',
    ],
    ["raw refusal", "I cannot see your screen. Please provide context.", null],
    ["partial JSON", '{"replacement":"Only the first paragraph', null],
    ["unclosed JSON object", '{"replacement":"Only the first paragraph"', null],
  ]) {
    await t.test(name, async () => {
      const calls = [];
      setProcessText(async (text, _model, _agent, config) => {
        calls.push({ text, config });
        if (config.screenContext) throw new Error("image rejected");
        return response;
      });
      const manager = createManager({
        isProcessing: true,
        consumeSelectionCapture: async () => ({
          status: "selected",
          text: "Two original paragraphs.",
          sessionId: "cloud-selection",
        }),
        onError: () => {},
      });
      const run = () =>
        manager.processAgentCommand("Elaborate this", "", "Assistant", {
          provider: "openwhispr",
          systemPrompt: "BASE SCREEN_SUFFIX_SENTINEL",
          textOnlySystemPrompt: "BASE",
          screenContext: { mediaType: "image/jpeg", data: "image" },
          selectionEditReachable: true,
        });
      if (expected) {
        assert.equal(await run(), expected);
        assert.deepEqual(manager.pendingSelectionEdit, { sessionId: "cloud-selection" });
      } else {
        await assert.rejects(run(), { code: "SELECTION_EDIT_INVALID_RESPONSE" });
        assert.ok(!manager.pendingSelectionEdit);
      }
      assert.equal(calls.length, 2);
      assert.equal(calls[1].config.screenContext, undefined);
      assert.doesNotMatch(calls[1].config.systemPrompt, /SCREEN_SUFFIX_SENTINEL/);
      assert.equal(calls[1].text, calls[0].text);
      assert.ok(calls[0].text.includes('"Two original paragraphs."'));
      for (const call of calls)
        assert.match(call.config.systemPrompt, /Return exactly one JSON object/);
    });
  }
  await t.test("a JSON question verdict after retry leaves the selection untouched", async () => {
    setProcessText(async (_text, _model, _agent, config) => {
      if (config.screenContext) throw new Error("image rejected");
      return '{"replacement":"__OPENWHISPR_SELECTION_QUESTION__"}';
    });
    const manager = createManager({
      isProcessing: true,
      consumeSelectionCapture: async () => ({
        status: "selected",
        text: "Two original paragraphs.",
        sessionId: "cloud-selection",
      }),
      onError: () => {},
    });
    assert.equal(
      await manager.processAgentCommand("Explain this", "", "Assistant", {
        provider: "openwhispr",
        systemPrompt: "BASE SCREEN_SUFFIX_SENTINEL",
        textOnlySystemPrompt: "BASE",
        screenContext: { mediaType: "image/jpeg", data: "image" },
        selectionEditReachable: true,
      }),
      "Explain this"
    );
    assert.ok(!manager.pendingSelectionEdit);
    assert.equal(
      manager.pendingAssistantConversation.selectedContext.text,
      "Two original paragraphs."
    );
  });
});

test("a non-voice-agent recording clears a stale screen capture", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sc-stale-test-",
    settingsKey: "__scStaleSettings",
    reasoningKey: "__scStaleProcessText",
  });

  const manager = createManager();
  const stale = Promise.resolve({ mediaType: "image/jpeg", data: "stale" });

  manager.screenContextPromise = stale;
  manager.setVoiceAgentRequested(false);
  assert.equal(manager.screenContextPromise, null);
  assert.equal(await manager.consumeScreenContext(), null);

  // A capture left by a cancelled recording never rides into the next
  // voice-agent start either — begin() re-captures after the reset.
  manager.screenContextPromise = stale;
  manager.setVoiceAgentRequested(true);
  assert.equal(manager.screenContextPromise, null);

  // A fresh capture set after the start (as beginScreenContextCapture does)
  // is consumed normally.
  manager.screenContextPromise = Promise.resolve({ mediaType: "image/jpeg", data: "fresh" });
  assert.deepEqual(await manager.consumeScreenContext(), {
    mediaType: "image/jpeg",
    data: "fresh",
  });

  // Guards the dead-code removal in getEffectiveSttLanguage.
  manager.translationRequested = false;
  assert.equal(manager.getEffectiveSttLanguage({ preferredLanguage: "en" }), "en");
});
