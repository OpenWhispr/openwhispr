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

test("a tuned model's part that lost words is cleaned again in one batch request", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cleanup-drop-guard-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { trackRequest, cancelRequest } = await vite.ssrLoadModule(
    "/services/ai/requestCancellation.ts"
  );
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState({ customPrompts: { cleanup: "" } });

  const TUNED = "openwhispr-cleanup-qwen3.5-0.8b-q4_k_m";
  // Ten-word sentences of distinct words, so a 4-word phrase of an answer
  // matches only where it was said. say(0, 15) is the first 150 words.
  const say = (from, to) =>
    Array.from(
      { length: to - from },
      (_, s) => `${Array.from({ length: 10 }, (_, w) => `w${(from + s) * 10 + w}`).join(" ")}.`
    ).join(" ");
  const wrap = (text) => `<transcript>\n${text}\n</transcript>`;
  const unwrap = (user) => user.slice("<transcript>\n".length, -"\n</transcript>".length);
  const LOST_30 = `${say(0, 10)} ${say(13, 30)}`;

  let answers = [];
  let parts = [];
  let batches = [];
  let answerBatch;
  window.electronAPI.processLocalReasoning = async (userContent, model, agentName, config) => {
    parts.push({ userContent, model, agentName, config });
    return { success: true, text: answers.shift() };
  };
  window.electronAPI.processLocalReasoningBatch = async (texts, model, agentName, config) => {
    batches.push({ texts, model, agentName, config });
    return answerBatch(texts);
  };
  const shoutAll = (texts) => ({
    success: true,
    results: texts.map((text) => ({ success: true, text: unwrap(text).toUpperCase() })),
  });
  const cleanup = (text, model, config = {}) => {
    parts = [];
    batches = [];
    return service.processText(text, model, null, {
      provider: "local",
      inferenceScope: "dictationCleanup",
      temperature: 0.4,
      disableThinking: false,
      ...config,
    });
  };

  await t.test("the pieces go to the main process in one call, set up like the part", async () => {
    answers = [LOST_30];
    answerBatch = shoutAll;
    assert.equal(await cleanup(say(0, 30), TUNED), say(0, 30).toUpperCase());
    assert.equal(parts.length, 1);
    assert.equal(batches.length, 1);
    const [batch] = batches;
    assert.deepEqual(batch.texts, [wrap(say(0, 15)), wrap(say(15, 30))]);
    assert.equal(batch.model, TUNED);
    assert.equal(batch.agentName, null);
    assert.deepEqual(batch.config, parts[0].config);
    assert.ok(batch.config.systemPrompt.startsWith("Clean up this dictated transcript."));
    assert.equal(batch.config.temperature, 0);
    assert.equal(batch.config.disableThinking, true);
  });

  await t.test("a piece the main process could not clean is kept as spoken", async () => {
    answers = [LOST_30];
    answerBatch = (texts) => ({
      success: true,
      results: [
        { success: false, error: "boom", code: "LOCAL_MODEL_BUSY" },
        { success: true, text: unwrap(texts[1]).toUpperCase() },
      ],
    });
    assert.equal(await cleanup(say(0, 30), TUNED), `${say(0, 15)} ${say(15, 30).toUpperCase()}`);
  });

  await t.test("a failed batch keeps its part as spoken and the cleanup goes on", async () => {
    answers = [`${say(0, 10)} ${say(13, 60)}`, say(60, 90).toUpperCase()];
    answerBatch = () => ({ success: false, error: "boom", code: "LOCAL_MODEL_BUSY" });
    assert.equal(await cleanup(say(0, 90), TUNED), `${say(0, 60)} ${say(60, 90).toUpperCase()}`);
    assert.equal(parts.length, 2);
  });

  await t.test("a cancelled cleanup stops at a failed batch, as at a failed part", async () => {
    const requestId = "drop-guard-cancel";
    const release = trackRequest(requestId);
    t.after(release);
    answers = [`${say(0, 10)} ${say(13, 60)}`, say(60, 90)];
    answerBatch = () => {
      cancelRequest(requestId);
      return { success: false, error: "cancelled", code: "LOCAL_MODEL_CANCELLED" };
    };
    await assert.rejects(cleanup(say(0, 90), TUNED, { requestId }), {
      code: "LOCAL_MODEL_CANCELLED",
    });
    assert.equal(parts.length, 1);
  });

  await t.test("S1-mini and models without a profile never send a batch", async () => {
    answerBatch = shoutAll;
    for (const model of ["s1-mini-q4_k_m", "qwen3.5-0.8b-q4_k_m"]) {
      answers = [LOST_30];
      assert.equal(await cleanup(say(0, 30), model), LOST_30, model);
      assert.equal(batches.length, 0, model);
    }
  });
});
