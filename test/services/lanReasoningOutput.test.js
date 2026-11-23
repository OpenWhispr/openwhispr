const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("Sarvam batch recovery cleans an English translation without changing its Hindi input hint", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-sarvam-recovery-cleanup-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { getLanguageInstruction } = await vite.ssrLoadModule("/utils/languageSupport.ts");
  const reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoning.destroy());
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  useSettingsStore.setState({
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "sarvam",
    cloudTranscriptionModel: "saaras:v4",
    preferredLanguage: "hi",
    sarvamMode: "verbatim",
    useCleanupModel: true,
    cleanupMode: "self-hosted",
    cleanupRemoteUrl: "http://127.0.0.1:11434/v1",
    cleanupModel: "local-model",
  });
  const manager = Object.create(AudioManager.prototype);
  manager.isReasoningAvailable = async () => true;
  window.electronAPI.proxySarvamTranscription = async ({ language, sarvamMode }) => {
    assert.equal(language, "hi");
    assert.equal(sarvamMode, "translate");
    return { text: "Good morning." };
  };
  let systemPrompt;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    systemPrompt = JSON.parse(options.body).messages[0].content;
    return Response.json({
      choices: [{ message: { content: "Good morning." }, finish_reason: "stop" }],
    });
  });
  const result = await manager.processWithOpenAIAPI(new Blob(["audio"]), {
    sarvamMode: "translate",
  });
  assert.equal(result.text, "Good morning.");
  assert.ok(systemPrompt.includes(getLanguageInstruction("en")));
  assert.ok(!systemPrompt.includes(getLanguageInstruction("hi")));

  useSettingsStore.setState({
    isSignedIn: true,
    cleanupMode: "openwhispr",
    cleanupCloudMode: "openwhispr",
    useDictationTranslation: true,
    translationSourceLanguage: "hi",
    translationTargetLanguage: "hi",
    translationMode: "self-hosted",
    translationModel: "translation-model",
    translationRemoteUrl: "http://127.0.0.1:11434/v1",
  });
  manager.setTranslationRequested(true);
  const steps = [];
  window.electronAPI.cloudReason = async (text, { purpose, language }) => {
    steps.push([purpose, language]);
    return { success: true, text };
  };
  t.mock.method(reasoning, "processText", async (_text, _model, _agent, config) => {
    steps.push([config.inferenceScope, config.language]);
    return "सुप्रभात।";
  });
  const translated = await manager.processWithOpenAIAPI(new Blob(["audio"]), {
    sarvamMode: "translate",
  });
  assert.equal(translated.text, "सुप्रभात।");
  assert.deepEqual(steps, [
    ["cleanup", "en"],
    ["dictationTranslation", "hi"],
  ]);
  useSettingsStore.setState({
    translationSourceLanguage: "ja",
    translationTargetLanguage: "ja",
    preferredLanguage: "ja",
  });
  const hindi = "मेरा नाम राज है।";
  window.electronAPI.proxySarvamTranscription = async () => ({ text: hindi });
  const japanese = "私の名前はラージです。";
  steps.length = 0;
  t.mock.method(reasoning, "processText", async (_text, _model, _agent, config) => {
    steps.push([config.inferenceScope, config.language]);
    return japanese;
  });
  const detected = await manager.processWithOpenAIAPI(new Blob(["audio"]), {
    sarvamMode: "transcribe",
    sarvamInputLanguage: "ja",
  });
  assert.equal(detected.text, japanese);
  assert.deepEqual(steps, [
    ["cleanup", "auto"],
    ["dictationTranslation", "ja"],
  ]);
  useSettingsStore.setState({ allowLocalFallback: true });
  window.electronAPI.proxySarvamTranscription = async () => {
    throw new Error("Network unavailable");
  };
  window.electronAPI.transcribeLocalWhisper = async (_audio, options) => {
    assert.equal(options.language, undefined);
    return { success: true, text: hindi };
  };
  steps.length = 0;
  const localRecovery = await manager.processWithOpenAIAPI(new Blob(["audio"]), {
    sarvamMode: "translate",
    sarvamInputLanguage: "auto",
  });
  assert.equal(localRecovery.source, "local-fallback");
  assert.equal(localRecovery.text, japanese);
  assert.deepEqual(steps, [
    ["cleanup", "auto"],
    ["dictationTranslation", "ja"],
  ]);
});

test("hotkey cleanup follows the spoken language and English STT preserves names in their original script", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-hotkey-language-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { getLanguageInstruction } = await vite.ssrLoadModule("/utils/languageSupport.ts");
  const reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoning.destroy());
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const manager = Object.create(AudioManager.prototype);
  manager.isReasoningAvailable = async () => true;
  const raw = "मेरा नाम राज है।";
  useSettingsStore.setState({
    preferredLanguage: "ja",
    useCleanupModel: true,
    cleanupMode: "self-hosted",
    cleanupRemoteUrl: "http://127.0.0.1:11434/v1",
    cleanupModel: "local-model",
    useDictationTranslation: true,
    translationSourceLanguage: "hi",
    translationTargetLanguage: "hi",
    translationMode: "self-hosted",
    translationRemoteUrl: "http://127.0.0.1:11434/v1",
    translationModel: "translation-model",
  });
  const prompts = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return Response.json({
      choices: [{ message: { content: raw }, finish_reason: "stop" }],
    });
  });
  manager.setTranslationRequested(true);
  await manager.processTranscription(raw, "local");
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(getLanguageInstruction("hi")));
  useSettingsStore.setState({ preferredLanguage: "zh-TW", useCleanupModel: false });
  manager.setTranslationRequested(false);
  const english = "I work at 字节跳动.";
  assert.equal(
    await manager.processTranscription(english, "sarvam", undefined, { transcriptLanguage: "en" }),
    english
  );
});

// A self-hosted reasoning model (Ollama, vLLM, llama.cpp) can spend the whole
// output cap inside <think>, so nothing is left once the block is stripped.
// That cut-off carries the code note formatting retries with more room (#2008).
test("a self-hosted reply that only thought until the cap carries the cut-off code", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-lan-reasoning-test-" });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  t.after(() => reasoningService.destroy());

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { content: "<think>Let me read the transcript" }, finish_reason: "length" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  await assert.rejects(
    reasoningService.processText("## Meeting Transcript\nYou: ship on Friday.", "glm-5.3", null, {
      lanUrl: "http://127.0.0.1:11434/v1",
      systemPrompt: "Summarize",
      maxTokens: 4096,
    }),
    { message: /ran out of output tokens/, code: "OUTPUT_LIMIT_BEFORE_ANSWER" }
  );
});

test("a cancelled run aborts its self-hosted request and is not retried", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-lan-reasoning-test-" });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { cancelRequest, trackRequest } = await vite.ssrLoadModule(
    "/services/ai/requestCancellation.ts"
  );
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  t.after(() => reasoningService.destroy());
  t.after(trackRequest("run-1"));

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requests = 0;
  // A model still thinking: no reply until the request is aborted.
  globalThis.fetch = (_input, init = {}) => {
    requests += 1;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener("abort", abort);
    });
  };

  const call = reasoningService.processText(
    "## Meeting Transcript\nYou: ship on Friday.",
    "glm-5.3",
    null,
    {
      lanUrl: "http://127.0.0.1:11434/v1",
      systemPrompt: "Summarize",
      maxTokens: 25_000,
      requestId: "run-1",
    }
  );
  for (let attempt = 0; requests === 0 && attempt < 400; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  cancelRequest("run-1");

  // Promptly, not at the request deadline.
  const deadline = new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error("still waiting on the request")), 2_000).unref()
  );
  await assert.rejects(Promise.race([call, deadline]), { message: "Request cancelled" });
  assert.equal(requests, 1, "an aborted request is never sent again");
});
