const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";
const DUPLICATE = `**Cleaned transcript:**\n${CLEAN}\n\n${CLEAN}`;

test("cleanup validates completed provider output using the request's prompt settings", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cleanup-output-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const setCustomPrompt = (cleanup) => useSettingsStore.setState({ customPrompts: { cleanup } });
  setCustomPrompt("");
  window.electronAPI.processLocalReasoning = async () => ({ success: true, text: DUPLICATE });
  const process = (config = {}) =>
    service.processText(RAW, "test-model", null, {
      provider: "local",
      ...config,
    });

  await t.test("a complete but duplicated local answer fails cleanup", async () => {
    await assert.rejects(process(), { code: "CLEANUP_OUTPUT_INVALID" });
  });

  await t.test("custom and explicit non-cleanup prompts remain unmodified", async () => {
    for (const config of [
      { systemPrompt: "Repeat the text twice" },
      { inferenceScope: "noteFormatting" },
      { requiresAgent: true },
    ]) {
      assert.equal(await process(config), DUPLICATE);
    }
    // Prompt Studio installs its edited prompt temporarily before calling processText.
    setCustomPrompt("Repeat the text twice");
    assert.equal(await process({ inferenceScope: "dictationCleanup" }), DUPLICATE);
    setCustomPrompt("");
    await assert.rejects(process({ inferenceScope: "dictationCleanup" }), {
      code: "CLEANUP_OUTPUT_INVALID",
    });
  });

  await t.test(
    "settings changes during inference do not change validation eligibility",
    async () => {
      for (const customAtStart of ["", "Repeat the text twice"]) {
        setCustomPrompt(customAtStart);
        window.electronAPI.processLocalReasoning = async () => {
          setCustomPrompt(customAtStart ? "" : "Repeat the text twice");
          return { success: true, text: DUPLICATE };
        };
        if (customAtStart) assert.equal(await process(), DUPLICATE);
        else await assert.rejects(process(), { code: "CLEANUP_OUTPUT_INVALID" });
      }
    }
  );

  await t.test(
    "Cloud, Anthropic, enterprise, Gemini and Custom providers share validation",
    async () => {
      setCustomPrompt("");
      window.electronAPI.cloudReason = async () => ({ success: true, text: DUPLICATE });
      window.electronAPI.processAnthropicReasoning = async () => ({
        success: true,
        text: DUPLICATE,
      });
      window.electronAPI.processEnterpriseReasoning = async () => ({
        success: true,
        text: DUPLICATE,
      });
      window.electronAPI.getGeminiKey = async () => "synthetic-key";
      const originalFetch = globalThis.fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: DUPLICATE }, finish_reason: "stop" }],
            candidates: [{ content: { parts: [{ text: DUPLICATE }] }, finishReason: "STOP" }],
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      for (const config of [
        { provider: "openwhispr" },
        { provider: "anthropic" },
        { provider: "bedrock" },
        { provider: "gemini" },
        {
          provider: "custom",
          baseUrl: "https://cleanup.example.test/v1/chat/completions",
          customApiKey: "synthetic-key",
        },
      ]) {
        await assert.rejects(process(config), { code: "CLEANUP_OUTPUT_INVALID" }, config.provider);
      }
    }
  );

  await t.test("history retry keeps the raw row and reports rejected cleanup", async () => {
    setCustomPrompt("");
    useSettingsStore.setState({
      cleanupMode: "local",
      cleanupProvider: "local",
      cleanupModel: "test-model",
    });
    window.electronAPI.processLocalReasoning = async () => ({ success: true, text: DUPLICATE });
    const row = { id: 123, text: RAW, raw_text: RAW };
    window.electronAPI.retryTranscription = async () => ({ success: true, transcription: row });
    window.electronAPI.updateTranscriptionText = async () =>
      assert.fail("rejected cleanup must not overwrite the row");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/components/ControlPanel.tsx"),
      "utf8"
    );
    const parsed = ts.createSourceFile(
      "ControlPanel.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    let callback;
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "retryTranscription") {
        callback = node.initializer.arguments[0].getText(parsed);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    assert.ok(callback, "the history retry callback must be present");
    // Execute the real callback without mounting the whole application shell.
    const code = ts.transpileModule(`const retry = ${callback};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const settingsModule = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const toasts = [];
    let displayedRow;
    const retry = vm.runInNewContext(`${code}\nretry`, {
      require: (id) => {
        if (id === "../services/ReasoningService") return { __esModule: true, default: service };
        if (id === "../stores/settingsStore") return settingsModule;
        throw new Error(`Unexpected history retry import: ${id}`);
      },
      window,
      getSettings: settingsModule.getSettings,
      getManagedTranscriptionResolution: () => null,
      isTranscriptionContextAllowed: () => true,
      usePolicyStore,
      useCleanupModel: true,
      getAgentName: () => "OpenWhispr",
      hasTextContent: (text) => typeof text === "string" && text.trim().length > 0,
      applyChineseScript: async (text) => text,
      resolveChineseScriptTarget: () => null,
      updateInStore: (value) => {
        displayedRow = value;
      },
      toast: (value) => toasts.push(value),
      t: (key) => key,
    });
    await retry(row.id);
    assert.strictEqual(displayedRow, row);
    assert.ok(
      toasts.some(
        (toast) => toast.description === "hooks.audioRecording.errorDescriptions.cleanupDuplicated"
      ),
      JSON.stringify(toasts)
    );
  });
});
