const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const RAW = "um so can you uh send me the report by friday";
const S1_SYSTEM =
  "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";
const S1_CONTROL = "[Styling: semi-formal] [Structure: prose] [Context: general]";

test("local dictation cleanup uses a model's prompt profile and leaves other models alone", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cleanup-profile-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState({ customPrompts: { cleanup: "" } });

  let calls = [];
  window.electronAPI.processLocalReasoning = async (userContent, model, _agent, config) => {
    calls.push({ userContent, model, config });
    return { success: true, text: `cleaned ${calls.length}` };
  };
  const cleanup = (text, model, config = {}) => {
    calls = [];
    return service.processText(text, model, null, {
      provider: "local",
      inferenceScope: "dictationCleanup",
      temperature: 0.4,
      disableThinking: false,
      ...config,
    });
  };

  await t.test(
    "S1-mini gets its own instructions, no wrapper, thinking off, temperature 0",
    async () => {
      assert.equal(await cleanup(RAW, "s1-mini-q4_k_m"), "cleaned 1");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].userContent, `${S1_CONTROL}\n${RAW}`);
      assert.equal(calls[0].config.systemPrompt, S1_SYSTEM);
      assert.equal(calls[0].config.temperature, 0);
      assert.equal(calls[0].config.disableThinking, true);
    }
  );

  await t.test("a long S1-mini dictation is cleaned in parts and re-joined in order", async () => {
    const sentence = (i) => `Sentence number ${i} has exactly seven words.`;
    const long = Array.from({ length: 200 }, (_, i) => sentence(i)).join(" ");
    assert.equal(await cleanup(long, "s1-mini-q4_k_m"), "cleaned 1 cleaned 2 cleaned 3");
    assert.equal(calls.length, 3);
    const sent = calls.map((call) => call.userContent.replace(`${S1_CONTROL}\n`, ""));
    assert.equal(sent.join(" "), long);
    for (const part of sent) assert.ok(part.split(" ").length <= 600);
  });

  await t.test("a failed part fails the whole cleanup", async () => {
    const original = window.electronAPI.processLocalReasoning;
    window.electronAPI.processLocalReasoning = async () => ({
      success: false,
      error: "boom",
      code: "LOCAL_MODEL_BUSY",
    });
    await assert.rejects(cleanup(RAW, "s1-mini-q4_k_m"));
    window.electronAPI.processLocalReasoning = original;
  });

  await t.test("every other local model keeps the shared prompt and wrapper", async () => {
    await cleanup(RAW, "qwen3.5-0.8b-q4_k_m");
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].userContent,
      `<transcript>\n${RAW}\n</transcript>\n\nOutput only the cleaned transcript.`
    );
    assert.notEqual(calls[0].config.systemPrompt, S1_SYSTEM);
    assert.equal(calls[0].config.temperature, 0.4);
    assert.equal(calls[0].config.disableThinking, false);
  });

  await t.test("S1-mini outside default dictation cleanup is sent as before", async () => {
    await cleanup(RAW, "s1-mini-q4_k_m", { systemPrompt: "Translate to French" });
    assert.equal(calls[0].userContent, RAW);
    assert.equal(calls[0].config.systemPrompt, "Translate to French");

    await cleanup(RAW, "s1-mini-q4_k_m", { inferenceScope: "noteFormatting" });
    assert.match(calls[0].userContent, /^<transcript>/);

    useSettingsStore.setState({ customPrompts: { cleanup: "Make it formal" } });
    await cleanup(RAW, "s1-mini-q4_k_m");
    assert.match(calls[0].userContent, /^<transcript>/);
    assert.notEqual(calls[0].config.systemPrompt, S1_SYSTEM);
    useSettingsStore.setState({ customPrompts: { cleanup: "" } });
  });
});
