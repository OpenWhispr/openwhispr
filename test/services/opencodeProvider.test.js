const test = require("node:test");
const assert = require("node:assert/strict");

function installBridge(handler) {
  globalThis.window = { electronAPI: { processOpencodeReasoning: handler } };
}

test.afterEach(() => {
  delete globalThis.window;
});

test("note formatting gets the long deadline, not the cleanup one", async () => {
  let call;
  installBridge(async (...args) => {
    call = args;
    return { success: true, text: "summary" };
  });
  const { opencodeGoProvider } =
    await import("../../src/services/ai/inferenceProviders/opencode.ts");

  const result = await opencodeGoProvider.call({
    text: "meeting transcript",
    model: "glm-5.3",
    agentName: null,
    config: { inferenceScope: "noteFormatting", systemPrompt: "Summarize the meeting." },
    ctx: { getSystemPrompt: () => "Summarize." },
  });

  assert.equal(result, "summary");
  const [providerId, userContent, model, , config] = call;
  assert.equal(providerId, "opencode-go");
  assert.equal(model, "glm-5.3");
  assert.equal(userContent, "meeting transcript");
  assert.equal(config.systemPrompt, "Summarize the meeting.");
  assert.equal(config.timeoutMs, 600000, "LLM_LONG_TASK_TIMEOUT_SECONDS");
  assert.equal(config.supportsTemperature, true);
});

test("a cleanup keeps the short deadline and wraps the transcript", async () => {
  let call;
  installBridge(async (...args) => {
    call = args;
    return { success: true, text: "cleaned" };
  });
  const { opencodeZenProvider } =
    await import("../../src/services/ai/inferenceProviders/opencode.ts");

  await opencodeZenProvider.call({
    text: "um hello",
    model: "glm-5.3",
    agentName: null,
    config: {},
    ctx: { getSystemPrompt: () => "Clean this." },
  });

  const [, userContent, , , config] = call;
  assert.match(String(userContent), /um hello/);
  assert.notEqual(userContent, "um hello", "a cleanup wraps the transcript");
  assert.equal(config.timeoutMs, 30000, "LLM_REQUEST_TIMEOUT_SECONDS");
});

test("a registry entry without a temperature flag is not read as accepting it", async () => {
  let call;
  installBridge(async (...args) => {
    call = args;
    return { success: true, text: "ok" };
  });
  const { opencodeGoProvider } =
    await import("../../src/services/ai/inferenceProviders/opencode.ts");

  // Gemini 4 Argon's native registry entry carries no supportsTemperature.
  await opencodeGoProvider.call({
    text: "raw",
    model: "gemini-4-argon",
    agentName: null,
    config: { systemPrompt: "Clean this." },
    ctx: { getSystemPrompt: () => "unused" },
  });

  assert.equal(call[4].supportsTemperature, false);
});

test("a temperature-rejecting model resolves the registry flag", async () => {
  let call;
  installBridge(async (...args) => {
    call = args;
    return { success: true, text: "ok" };
  });
  const { opencodeZenProvider } =
    await import("../../src/services/ai/inferenceProviders/opencode.ts");

  await opencodeZenProvider.call({
    text: "raw",
    model: "kimi-k3",
    agentName: null,
    config: { systemPrompt: "Clean this." },
    ctx: { getSystemPrompt: () => "unused" },
  });

  assert.equal(call[4].supportsTemperature, false);
});

test("an IPC failure keeps its code and message key", async () => {
  installBridge(async () => ({
    success: false,
    error: "The provider rejected these credentials.",
    code: "PROVIDER_AUTH_FAILED",
    messageKey: "providerErrors.authFailed",
    settingsTarget: "llms",
  }));
  const { opencodeGoProvider } =
    await import("../../src/services/ai/inferenceProviders/opencode.ts");

  await assert.rejects(
    opencodeGoProvider.call({
      text: "raw",
      model: "glm-5.3",
      agentName: null,
      config: { systemPrompt: "Clean this." },
      ctx: { getSystemPrompt: () => "unused" },
    }),
    (error) => {
      assert.equal(error.message, "The provider rejected these credentials.");
      assert.equal(error.code, "PROVIDER_AUTH_FAILED");
      assert.equal(error.messageKey, "providerErrors.authFailed");
      assert.equal(error.settingsTarget, "llms");
      return true;
    }
  );
});
