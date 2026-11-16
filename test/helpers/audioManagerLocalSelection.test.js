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
      Object.assign(new Error("truncated"), {
        code: "OUTPUT_TRUNCATED",
        messageKey: "hooks.audioRecording.errorDescriptions.cleanupTruncated",
      }),
      "OUTPUT_TRUNCATED",
      "truncatedResponse",
    ],
    [
      Object.assign(new Error("unknown finish"), { code: "OUTPUT_COMPLETION_UNVERIFIED" }),
      "OUTPUT_COMPLETION_UNVERIFIED",
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

test("wake removal preserves literal operands, spacing and original Unicode in local edit requests", async (t) => {
  const { createManager } = await setup(t);
  for (const [language, instruction, expected] of [
    [
      "ja",
      "ねぇ、OpenWhispr、「こんにちは。」を「こんばんは。」に置き換えて。",
      "「こんにちは。」を「こんばんは。」に置き換えて。",
    ],
    [
      "en",
      "OpenWhisp, R. Replace the selection with the letter after your name.",
      "R. Replace the selection with the letter after your name.",
    ],
    ["en", 'Hey OpenWhispr, replace "a  b" with "c\n\td".', 'replace "a  b" with "c\n\td".'],
    [
      "ja",
      "Cafe\u0301.  OpenWhispr、「か\u3099」を「き」に置き換えて。",
      "Cafe\u0301.  「か\u3099」を「き」に置き換えて。",
    ],
  ]) {
    let request;
    const manager = createManager({
      voiceAgentRequested: false,
      processWithReasoningModel: async (prompt) => {
        request = prompt;
        return '{"replacement":"OK"}';
      },
    });
    await manager.processAgentCommand(instruction, "local-model", "OpenWhispr", {
      ...config,
      wakeWordLanguage: language,
    });
    assert.ok(
      request.includes(
        `\nEditing instruction:\n${expected}\n\nReturn the replacement JSON object.`
      ),
      request
    );
  }
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

test("wake removal keeps short operands before exact and fuzzy names, including hotkey instructions", async (t) => {
  const { createManager } = await setup(t);
  for (const prefix of ["A.", "B.", "10.", "123.", "🙂."]) {
    for (const name of ["OpenWhispr", "OpenWhisper", "Open Whispr", "Open Whisper"]) {
      for (const voiceAgentRequested of [false, true]) {
        const instruction = `${prefix}  ${name}, replace the entire selection with the operand before your name.`;
        const expected = voiceAgentRequested
          ? instruction
          : `${prefix}  replace the entire selection with the operand before your name.`;
        let request;
        const manager = createManager({
          voiceAgentRequested,
          processWithReasoningModel: async (prompt) => {
            request = prompt;
            return '{"replacement":"synthetic"}';
          },
        });
        await manager.processAgentCommand(instruction, "local-model", "OpenWhispr", {
          ...config,
          wakeWordLanguage: "en",
        });
        assert.ok(request.includes(`Editing instruction:\n${expected}\n\nReturn`), request);
        assert.equal(manager.pendingSelectionEdit.sessionId, "captured-session");
      }
    }
  }
});

test("non-local empty and truncated failures use selection recovery and retain provider metadata", async (t) => {
  const { createManager, vite } = await setup(t);
  const { emptyOutputError, truncatedOutputError } = await vite.ssrLoadModule(
    "/services/ai/chatRequestBody.ts"
  );
  const causes = [
    [
      emptyOutputError(),
      "SELECTION_EDIT_REASONING_FAILED",
      "hooks.audioRecording.selectionEditing.emptyResponse",
    ],
    [
      truncatedOutputError(),
      "SELECTION_EDIT_REASONING_FAILED",
      "hooks.audioRecording.selectionEditing.truncatedResponse",
    ],
    [
      Object.assign(new Error("auth"), {
        code: "PROVIDER_AUTH_FAILED",
        messageKey: "providerErrors.auth",
        messageParams: { provider: "OpenAI" },
        settingsTarget: "llms",
        technicalDetails: "HTTP 401",
      }),
      "PROVIDER_AUTH_FAILED",
      "providerErrors.auth",
    ],
    [
      Object.assign(new Error("network"), {
        code: "PROVIDER_NETWORK_ERROR",
        messageKey: "providerErrors.network",
        messageParams: { provider: "OpenAI" },
        technicalDetails: "connection refused",
      }),
      "PROVIDER_NETWORK_ERROR",
      "providerErrors.network",
    ],
  ];
  for (const [cause, code, messageKey] of causes) {
    const originalKey = cause.messageKey;
    const manager = createManager({
      processWithReasoningModel: async () => {
        throw cause;
      },
    });
    await assert.rejects(
      manager.processAgentCommand("edit", "cloud-model", "Agent", {
        ...config,
        provider: "openai",
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.messageKey, messageKey);
        assert.equal(error.selectionEditFatal, true);
        assert.equal(error.cause, cause);
        for (const key of ["messageParams", "settingsTarget", "technicalDetails"])
          assert.equal(error[key], cause[key]);
        return true;
      }
    );
    assert.equal(cause.messageKey, originalKey, "ordinary cleanup's error is unchanged");
    assert.equal(manager.pendingSelectionEdit, undefined);
    assert.equal(manager.pendingAssistantConversation, undefined);
  }
});
