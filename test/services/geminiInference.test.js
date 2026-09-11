const test = require("node:test");
const assert = require("node:assert/strict");

async function setup(
  t,
  response = {
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Clean text." }] } }],
  }
) {
  const { geminiProvider } = await import("../../src/services/ai/inferenceProviders/gemini.ts");
  const { default: logger } = require("../../src/utils/logger.ts");
  const requests = [];
  const logs = [];
  t.mock.method(logger, "logReasoning", (event, data) => logs.push({ event, data }));
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(response);
  });
  return {
    requests,
    logs,
    call: (overrides = {}) =>
      geminiProvider.call({
        text: "private transcript",
        model: "gemini-3-flash-preview",
        agentName: null,
        config: { disableThinking: true },
        ctx: {
          getApiKey: async () => "test-key",
          getSystemPrompt: () => "Clean without omitting content.",
        },
        ...overrides,
      }),
  };
}

test("Gemini cleanup uses native instructions, headroom, and metadata-only logs", async (t) => {
  const usageMetadata = {
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 10,
    totalTokenCount: 130,
  };
  const { call, requests, logs } = await setup(t, {
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Clean text." }] } }],
    usageMetadata,
  });
  assert.equal(await call(), "Clean text.");
  assert.deepEqual(requests[0].generationConfig, {
    temperature: 1,
    maxOutputTokens: 8192,
    thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false },
  });
  assert.deepEqual(requests[0].systemInstruction, {
    parts: [{ text: "Clean without omitting content." }],
  });
  assert.equal(
    requests[0].contents[0].parts[0].text,
    "<transcript>\nprivate transcript\n</transcript>\n\nOutput only the cleaned transcript."
  );
  assert.equal(JSON.stringify(logs).includes("private transcript"), false);
  assert.deepEqual(
    logs.find(({ event }) => event === "GEMINI_RAW_RESPONSE").data.usageMetadata,
    usageMetadata
  );
  assert.equal(logs.find(({ event }) => event === "GEMINI_RAW_RESPONSE").data.finishReason, "STOP");
  assert.deepEqual(
    logs.find(({ event }) => event === "GEMINI_REQUEST").data.generationConfig,
    requests[0].generationConfig
  );
});

test("thinking suppression uses controls supported by each registered Gemini model", async (t) => {
  const { call, requests } = await setup(t);
  for (const [model, control] of [
    ["gemini-3.5-flash", { thinkingLevel: "minimal" }],
    ["gemini-3.5-flash-lite", { thinkingLevel: "minimal" }],
    ["gemini-3.1-flash-lite", { thinkingLevel: "minimal" }],
    ["gemini-3.1-pro-preview", { thinkingLevel: "low" }],
    ["gemini-2.5-flash", { thinkingBudget: 0 }],
    ["gemini-2.5-flash-lite", { thinkingBudget: 0 }],
    ["gemini-2.5-pro", { thinkingBudget: 128 }],
  ]) {
    await call({ model });
    assert.equal(
      requests.at(-1).generationConfig.temperature,
      model.startsWith("gemini-3") ? 1 : 0
    );
    assert.deepEqual(
      requests.at(-1).generationConfig.thinkingConfig,
      { ...control, includeThoughts: false },
      model
    );
  }
  await call({ config: { disableThinking: false } });
  assert.equal(requests.at(-1).generationConfig.thinkingConfig, undefined);
});

test("long inputs scale to a bounded budget; explicit settings remain authoritative", async (t) => {
  const { call, requests } = await setup(t);
  await call({ text: "x".repeat(10000) });
  assert.equal(requests.at(-1).generationConfig.maxOutputTokens, 24096);
  await call({ text: "x".repeat(100000) });
  assert.equal(requests.at(-1).generationConfig.maxOutputTokens, 65536);
  await call({ config: { temperature: 0, maxTokens: 1234, systemPrompt: "Custom prompt" } });
  assert.equal(requests.at(-1).generationConfig.temperature, 0);
  assert.equal(requests.at(-1).generationConfig.maxOutputTokens, 1234);
  assert.equal(requests.at(-1).systemInstruction.parts[0].text, "Custom prompt");
  assert.equal(requests.at(-1).contents[0].parts[0].text, "private transcript");
});

test("Gemma retains inline instructions and receives no unsupported thinking controls", async (t) => {
  const { call, requests } = await setup(t);
  await call({ model: "gemma-4-31b-it" });
  assert.equal(requests[0].systemInstruction, undefined);
  assert.ok(
    requests[0].contents[0].parts[0].text.startsWith("Clean without omitting content.\n\n")
  );
  assert.equal(requests[0].generationConfig.thinkingConfig, undefined);
  assert.equal(requests[0].generationConfig.temperature, 0);
});

test("cleanup rejects incomplete responses without retrying", async (t) => {
  for (const [name, candidate] of [
    ["partial cutoff", { finishReason: "MAX_TOKENS", content: { parts: [{ text: "Partial" }] } }],
    ["empty cutoff", { finishReason: "MAX_TOKENS" }],
    ["blocked partial", { finishReason: "SAFETY", content: { parts: [{ text: "Partial" }] } }],
    ["missing finish reason", { content: { parts: [{ text: "Partial" }] } }],
    ["missing candidate", undefined],
  ]) {
    await t.test(name, async (t) => {
      const { call, requests } = await setup(t, { candidates: candidate ? [candidate] : [] });
      await assert.rejects(call(), /Gemini returned incomplete output/);
      assert.equal(requests.length, 1);
    });
  }
});

test("screenshots remain attached but are never included in request logs", async (t) => {
  const { call, requests, logs } = await setup(t);
  await call({ config: { screenContext: { mediaType: "image/jpeg", data: "private-base64" } } });
  assert.deepEqual(requests[0].contents[0].parts[1], {
    inlineData: { mimeType: "image/jpeg", data: "private-base64" },
  });
  assert.equal(JSON.stringify(logs).includes("private-base64"), false);
});
