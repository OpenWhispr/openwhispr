const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function setup(t) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-local-selection-test-",
    settingsKey: "__localSelectionSettings",
    settings: {
      preferredLanguage: "zh-CN",
      chineseScriptPreference: "simplified",
      customPrompts: {},
      snippets: [],
    },
  });
  loaded.window.electronAPI.captureSelectedText = async () => ({
    status: "selected",
    text: "  原來的文字\n",
    sessionId: "captured-session",
  });
  return loaded;
}
const config = {
  provider: "local",
  selectionEditReachable: true,
  systemPrompt: "GENERIC DICTATION PROMPT",
};

test("local edits use a dedicated request and preserve the replacement through final script handling", async (t) => {
  const { createManager } = await setup(t);
  const calls = [];
  const replacement = "  繁體字 <think>literal</think>\n";
  const manager = createManager({
    voiceAgentRequested: true,
    processWithReasoningModel: async (...args) => {
      calls.push(args);
      return JSON.stringify({ replacement });
    },
  });
  const result = await manager.processAgentCommand(
    "Keep this traditional Chinese text.",
    "local-model",
    "Agent",
    config
  );
  assert.equal(result, replacement);
  assert.deepEqual(manager.pendingSelectionEdit, { sessionId: "captured-session" });
  assert.equal(await manager.finalizeChineseScript(result), replacement);
  const [user, , , options] = calls[0];
  assert.ok(user.includes(JSON.stringify("  原來的文字\n")));
  assert.ok(!options.systemPrompt.includes("GENERIC DICTATION"));
  assert.equal(options.responseFormat.type, "json_object");
  assert.equal(options.requireCompleteOutput, true);
  assert.equal(options.disableThinking, true);
  assert.equal(options.maxTokens, 8192);
  assert.equal(options.contextSize, 16384);
});

test("wake address is removed from local instructions and custom preferences are subordinate", async (t) => {
  const { createManager, setSettings } = await setup(t);
  setSettings({
    preferredLanguage: "en",
    uiLanguage: "en",
    customPrompts: { dictationAgent: "{{agentName}} prefers brief prose." },
    customDictionary: ["Zentara"],
    snippets: [],
  });
  let request;
  const manager = createManager({
    voiceAgentRequested: false,
    processWithReasoningModel: async (...args) => {
      request = args;
      return '{"replacement":"OK"}';
    },
  });
  await manager.processAgentCommand(
    "Hey OpenWhispr, replace this with OK",
    "local-model",
    "OpenWhispr",
    config
  );
  assert.ok(!request[0].includes("Hey OpenWhispr"));
  assert.match(request[0], /replace this with OK/);
  assert.match(request[3].systemPrompt, /OpenWhispr prefers brief prose/);
  assert.match(request[3].systemPrompt, /only when compatible/);
  assert.match(request[3].systemPrompt, /Zentara/);
});

test("invalid, empty and truncated local edits fail before banking the captured session", async (t) => {
  const { createManager } = await setup(t);
  const cases = [
    ['{"replacement":"x","replacement":"y"}', "SELECTION_EDIT_INVALID_RESPONSE", "invalidResponse"],
    ['{"replacement":" "}', "SELECTION_EDIT_EMPTY_RESPONSE", "emptyResponse"],
    [
      Object.assign(new Error("truncated"), { code: "OUTPUT_TRUNCATED" }),
      "SELECTION_EDIT_OUTPUT_TRUNCATED",
      "truncatedResponse",
    ],
    [
      Object.assign(new Error("unknown finish"), { code: "OUTPUT_COMPLETION_UNVERIFIED" }),
      "SELECTION_EDIT_OUTPUT_COMPLETION_UNVERIFIED",
      "invalidResponse",
    ],
  ];
  for (const [response, code, message] of cases) {
    const manager = createManager({
      processWithReasoningModel: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    });
    await assert.rejects(
      manager.processAgentCommand("edit", "local-model", "Agent", config),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.messageKey, `hooks.audioRecording.selectionEditing.${message}`);
        assert.equal(error.selectionEditFatal, true);
        return true;
      }
    );
    assert.equal(manager.pendingSelectionEdit, undefined);
    assert.equal(manager.pendingAssistantConversation, undefined);
  }
});

test("selection failures retain translated provider recovery details", async (t) => {
  const { createManager } = await setup(t);
  const cause = Object.assign(new Error("busy"), {
    code: "LOCAL_MODEL_BUSY",
    messageKey: "models.errors.localModelBusy",
    messageParams: { model: "test" },
  });
  const manager = createManager({
    processWithReasoningModel: async () => {
      throw cause;
    },
  });
  await assert.rejects(
    manager.processAgentCommand("edit", "local-model", "Agent", config),
    (error) => {
      assert.equal(error.code, cause.code);
      assert.equal(error.messageKey, cause.messageKey);
      assert.equal(error.messageParams, cause.messageParams);
      assert.equal(error.selectionEditFatal, true);
      return true;
    }
  );
});

test("a late local result after cancellation cannot bank an edit, and legitimate no-ops are allowed", async (t) => {
  const { createManager } = await setup(t);
  let cancelled = false;
  const manager = createManager({
    processWithReasoningModel: async () => {
      cancelled = true;
      return '{"replacement":"late"}';
    },
  });
  assert.equal(
    await manager.processAgentCommand("edit", "local-model", "Agent", config, () => cancelled),
    "edit"
  );
  assert.equal(manager.pendingSelectionEdit, undefined);
  manager.processWithReasoningModel = async () => JSON.stringify({ replacement: "  原來的文字\n" });
  assert.equal(
    await manager.processAgentCommand("Keep it as it is", "local-model", "Agent", config),
    "  原來的文字\n"
  );
  assert.equal(manager.pendingSelectionEdit.sessionId, "captured-session");
});
