const test = require("node:test");
const assert = require("node:assert/strict");

const HELPER = "../../src/services/ai/geminiThinking.ts";

// Gemma 4 declares an explicit two-way mapping: the "Disable thinking" toggle
// chooses between "minimal" (off) and "high" (on).
const GEMMA_4 = {
  supportsThinking: true,
  thinkingLevels: { disabled: "minimal", enabled: "high" },
};
// Gemini 3.5 Flash only declares supportsThinking (no levels) — it can only be
// pushed down to "minimal" when thinking is disabled, otherwise left at default.
const GEMINI_3_5 = { supportsThinking: true };
// Gemini 2.5 Flash Lite has no thinking support at all.
const NON_THINKING = {};

test("Gemma 4 maps disabled -> minimal", async () => {
  const { resolveGeminiThinkingConfig } = await import(HELPER);
  assert.deepEqual(resolveGeminiThinkingConfig(GEMMA_4, true), {
    thinkingLevel: "minimal",
    includeThoughts: false,
  });
});

test("Gemma 4 maps enabled -> high", async () => {
  const { resolveGeminiThinkingConfig } = await import(HELPER);
  assert.deepEqual(resolveGeminiThinkingConfig(GEMMA_4, false), {
    thinkingLevel: "high",
    includeThoughts: false,
  });
});

test("Gemma 4 defaults to enabled (high) when disableThinking is undefined", async () => {
  const { resolveGeminiThinkingConfig } = await import(HELPER);
  assert.deepEqual(resolveGeminiThinkingConfig(GEMMA_4, undefined), {
    thinkingLevel: "high",
    includeThoughts: false,
  });
});

test("supportsThinking-only model maps disabled -> minimal", async () => {
  const { resolveGeminiThinkingConfig } = await import(HELPER);
  assert.deepEqual(resolveGeminiThinkingConfig(GEMINI_3_5, true), {
    thinkingLevel: "minimal",
    includeThoughts: false,
  });
});

test("supportsThinking-only model leaves thinking untouched when enabled", async () => {
  const { resolveGeminiThinkingConfig } = await import(HELPER);
  assert.equal(resolveGeminiThinkingConfig(GEMINI_3_5, false), undefined);
  assert.equal(resolveGeminiThinkingConfig(GEMINI_3_5, undefined), undefined);
});

test("non-thinking model is never given a thinkingConfig", async () => {
  const { resolveGeminiThinkingConfig } = await import(HELPER);
  assert.equal(resolveGeminiThinkingConfig(NON_THINKING, true), undefined);
  assert.equal(resolveGeminiThinkingConfig(NON_THINKING, false), undefined);
});

test("unknown model (undefined def) is never given a thinkingConfig", async () => {
  const { resolveGeminiThinkingConfig } = await import(HELPER);
  assert.equal(resolveGeminiThinkingConfig(undefined, true), undefined);
});
