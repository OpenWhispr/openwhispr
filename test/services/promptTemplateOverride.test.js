const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("request-local cleanup templates preserve provider contracts and normal inference", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-prompt-template-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { getCleanupSystemPrompt, resolvePrompt, wrapCleanupTranscript } =
    await vite.ssrLoadModule("/config/prompts.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState({
    preferredLanguage: "fr",
    uiLanguage: "en",
    customDictionary: ["OpenWhispr"],
    customPrompts: { cleanup: "Saved {{agentName}}" },
  });
  const savedPrompt = () => useSettingsStore.getState().customPrompts.cleanup;
  const template = "Draft {{agentName}}";
  const expected = getCleanupSystemPrompt("Whisper", ["OpenWhispr"], "fr", "en", template);
  assert.match(expected, /^Draft Whisper/);
  assert.match(expected, /French|français/i);
  assert.match(expected, /OpenWhispr/);
  const text = "please send the report by Friday";
  const localCalls = [];
  let finish;
  window.electronAPI.processLocalReasoning = async (...args) => {
    localCalls.push(args);
    if (localCalls.length === 1) {
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return { success: true, text };
  };
  const pending = service.processText(text, "test-model", "Whisper", {
    provider: "local",
    cleanupPrompt: template,
  });
  assert.equal(localCalls[0][0], wrapCleanupTranscript(text));
  assert.equal(localCalls[0][3].systemPrompt, expected);
  assert.equal(savedPrompt(), "Saved {{agentName}}");
  await service.processText(text, "test-model", "Whisper", { provider: "local" });
  assert.match(localCalls[1][3].systemPrompt, /^Saved Whisper/);
  useSettingsStore.setState({ customPrompts: { cleanup: "New save" } });
  finish({ success: true, text });
  await pending;
  assert.equal(savedPrompt(), "New save");

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
  };
  await service.processText(text, "test-model", "Whisper", {
    provider: "lan",
    lanUrl: "http://127.0.0.1:1234/v1",
    cleanupPrompt: template,
  });
  assert.equal(body.messages[0].content, expected);
  assert.equal(body.messages[1].content, wrapCleanupTranscript(text));
  assert.equal(body.temperature, 0, "the override keeps deterministic cleanup sampling");

  let cloud;
  window.electronAPI.cloudReason = async (_text, options) => {
    cloud = options;
    return { success: true, text };
  };
  await service.processText(text, "auto", "Whisper", {
    provider: "openwhispr",
    cleanupPrompt: template,
  });
  assert.equal(
    cloud.customPrompt,
    template,
    "cloud receives its existing raw customPrompt contract"
  );
  assert.equal(cloud.systemPrompt, undefined);
  assert.equal(cloud.promptMode, "cleanup");
  assert.equal(cloud.purpose, "cleanup");
  assert.equal(cloud.requestPurpose, undefined);
  assert.deepEqual(cloud.customDictionary, ["OpenWhispr"]);
  assert.equal(cloud.language, "fr");
  assert.equal(cloud.locale, "en");
  await service.processText(text, "auto", "Whisper", {
    provider: "openwhispr",
    cleanupPrompt: "",
  });
  assert.equal(
    cloud.customPrompt,
    undefined,
    "empty override uses the server default, not saved text"
  );

  // Empty templates deliberately choose the shipped default; omitted templates use saved text.
  const options = {
    agentName: "Whisper",
    uiLanguage: "en",
    language: "fr",
    customDictionary: ["OpenWhispr"],
  };
  const shipped = resolvePrompt("cleanup", { ...options, promptTemplate: "" });
  assert.doesNotMatch(shipped, /New save/);
  assert.match(resolvePrompt("cleanup", options), /^New save/);
  await service.processText(text, "test-model", "Whisper", {
    provider: "local",
    cleanupPrompt: "",
  });
  assert.equal(localCalls.at(-1)[3].systemPrompt, shipped);

  const duplicated = "Please send the report by Friday.\n\nPlease send the report by Friday.";
  window.electronAPI.processLocalReasoning = async () => ({ success: true, text: duplicated });
  useSettingsStore.setState({ customPrompts: { cleanup: "" } });
  assert.equal(
    await service.processText(text, "test-model", null, {
      provider: "local",
      cleanupPrompt: "Repeat twice",
    }),
    duplicated,
    "a customized test retains custom-output semantics"
  );
  useSettingsStore.setState({ customPrompts: { cleanup: "Repeat twice" } });
  await assert.rejects(
    service.processText(text, "test-model", null, {
      provider: "local",
      cleanupPrompt: "",
    }),
    { code: "CLEANUP_OUTPUT_INVALID" },
    "testing the default still validates output despite a saved customization"
  );
});
