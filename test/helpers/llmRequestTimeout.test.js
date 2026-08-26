const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/llmRequestTimeout.js");

test("non-streaming LLM requests use the fixed 30-second timeout", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(typeof getLlmRequestTimeoutSeconds, "function");
  assert.equal(getLlmRequestTimeoutSeconds(), 30);
});

test("streaming LLM requests keep their fixed 60-second timeout", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(typeof getLlmRequestTimeoutSeconds, "function");
  assert.equal(getLlmRequestTimeoutSeconds({ streaming: true }), 60);
});
