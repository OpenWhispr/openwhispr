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

  await t.test("history retry keeps the raw row on rejected cleanup, flags partials", async () => {
    setCustomPrompt("");
    useSettingsStore.setState({
      cleanupMode: "local",
      cleanupProvider: "local",
      cleanupModel: "test-model",
    });
    window.electronAPI.processLocalReasoning = async () => ({ success: true, text: DUPLICATE });
    const row = { id: 123, text: RAW, raw_text: RAW };
    useSettingsStore.setState({
      translationSourceLanguage: "es",
      preferredLanguage: "en",
      customDictionary: ["Amaya", "a".repeat(60)],
      sharedDictionaryHints: { space: ["Puebla"], workspace: ["Amaya"] },
    });
    let retrySettings;
    window.electronAPI.retryTranscription = async (_id, settings) => {
      retrySettings = settings;
      return { success: true, transcription: row };
    };
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
    const { getKeytermDictionaryWords, limitBatchKeyterms } =
      await vite.ssrLoadModule("/utils/snippets.ts");
    // Supply the real imports the callback closes over in the renderer.
    const { providerCleanupStandsIn } = await vite.ssrLoadModule("/helpers/dictationRouting.js");
    const { allowsPersonalDictationCleanup, canUseAssemblyAiRewrite } = await vite.ssrLoadModule(
      "/services/managedTranscription.ts"
    );
    const { providerErrorToastProps } = await vite.ssrLoadModule("/utils/describeProviderError.ts");
    const toasts = [];
    let displayedRow;
    const retry = vm.runInNewContext(`${code}\nretry`, {
      require: (id) => {
        if (id === "../services/ReasoningService") return { __esModule: true, default: service };
        if (id === "../stores/settingsStore") return settingsModule;
        throw new Error(`Unexpected history retry import: ${id}`);
      },
      window,
      getKeytermDictionaryWords,
      limitBatchKeyterms,
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
      providerErrorToastProps,
      providerCleanupStandsIn,
      allowsPersonalDictationCleanup,
      canUseAssemblyAiRewrite,
      assertValidCleanupOutput: (await vite.ssrLoadModule("/utils/cleanupOutput.ts"))
        .assertValidCleanupOutput,
    });
    await retry(row.id);
    assert.equal(retrySettings.translationSourceLanguage, "es");
    assert.equal(retrySettings.preferredLanguage, "en");
    assert.deepEqual(Array.from(retrySettings.keyterms), ["Amaya", "a".repeat(50), "Puebla"]);
    assert.strictEqual(displayedRow, row);
    assert.ok(
      toasts.some(
        (toast) => toast.description === "hooks.audioRecording.errorDescriptions.cleanupDuplicated"
      ),
      JSON.stringify(toasts)
    );

    // A clean retry confirms without a description.
    toasts.length = 0;
    window.electronAPI.processLocalReasoning = async () => ({ success: true, text: RAW });
    await retry(row.id);
    // Toasts are built in the vm's realm; copy them so deepEqual compares values.
    const shown = () => toasts.map((toast) => ({ ...toast }));
    assert.deepEqual(shown(), [{ title: "controlPanel.history.retrySuccess" }]);

    // A provider rewrite is saved with its verbatim source when workspace policy allows it.
    useSettingsStore.setState({ useCleanupModel: true, toneStyleEnabled: false });
    window.electronAPI.retryTranscription = async () => ({
      success: true,
      transcription: row,
      cleanedText: CLEAN,
    });
    window.electronAPI.updateTranscriptionText = async (id, text, rawText) => {
      assert.deepEqual([id, text, rawText], [row.id, CLEAN, RAW]);
      return { success: true, transcription: { ...row, text } };
    };
    await retry(row.id);
    assert.equal(displayedRow.text, CLEAN);

    // A bad provider rewrite must leave the retry's raw row intact.
    const validRetry = window.electronAPI.retryTranscription;
    window.electronAPI.retryTranscription = async () => ({
      success: true,
      transcription: row,
      cleanedText: DUPLICATE,
    });
    toasts.length = 0;
    await retry(row.id);
    assert.strictEqual(displayedRow, row);
    assert.ok(
      toasts.some(
        (toast) => toast.description === "hooks.audioRecording.errorDescriptions.cleanupDuplicated"
      )
    );
    window.electronAPI.retryTranscription = validRetry;

    // If policy changes after transcription, discard the returned rewrite.
    const { managedPolicy } = require("../helpers/harness/policyFixtures");
    usePolicyStore.setState({
      status: "managed",
      policy: managedPolicy({
        llm: { allowedModes: ["local", "providers"], allowedByokProviders: ["openai"] },
      }),
    });
    await retry(row.id);
    assert.strictEqual(displayedRow, row);
    usePolicyStore.setState({ status: "unmanaged", policy: null });

    // A partial result must say so, as dictation does, while still confirming the
    // retry or recovery the user asked for.
    window.electronAPI.retryTranscription = async () => ({
      success: true,
      transcription: row,
      warning: "truncated",
    });
    for (const [options, title] of [
      [undefined, "controlPanel.history.retrySuccess"],
      [{ isRecover: true }, "controlPanel.history.discarded.recovered"],
    ]) {
      toasts.length = 0;
      await retry(row.id, options);
      assert.deepEqual(
        shown(),
        [{ title, description: "hooks.audioRecording.partialTranscription.description" }],
        JSON.stringify(options)
      );
    }
  });
});
