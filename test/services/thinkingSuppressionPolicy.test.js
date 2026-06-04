const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyThinkingSuppressionFields,
  getGroqProviderOptions,
} = require("../../src/services/ai/thinkingSuppressionPolicy.js");

test("Groq thinking suppression does not send unsupported reasoning_effort none", () => {
  const body = {};

  applyThinkingSuppressionFields(body, "groq");

  assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test("AI SDK Groq provider options omit unsupported reasoningEffort none", () => {
  assert.equal(getGroqProviderOptions(true), undefined);
});

test("Ollama thinking suppression uses native think flag", () => {
  const body = {};

  applyThinkingSuppressionFields(body, "local");

  assert.equal(body.think, false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});
