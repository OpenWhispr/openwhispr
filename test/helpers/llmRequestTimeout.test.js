const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/llmRequestTimeout.js");

test("non-streaming LLM requests use the fixed 30-second timeout", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(typeof getLlmRequestTimeoutSeconds, "function");
  assert.equal(getLlmRequestTimeoutSeconds(), 30);
  assert.equal(getLlmRequestTimeoutSeconds({ scope: "dictationCleanup" }), 30);
});

test("streaming LLM requests keep their fixed 60-second timeout", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(typeof getLlmRequestTimeoutSeconds, "function");
  assert.equal(getLlmRequestTimeoutSeconds({ streaming: true }), 60);
  // Streaming keeps its idle deadline whatever the scope: bytes are expected to flow.
  assert.equal(getLlmRequestTimeoutSeconds({ streaming: true, scope: "noteFormatting" }), 60);
});

test("note formatting gets a long deadline, since a whole transcript can take minutes to reason over", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(getLlmRequestTimeoutSeconds({ scope: "noteFormatting" }), 600);
});

test("a deadline error carries the timeout code and the seconds it waited", async () => {
  const { llmRequestTimeoutError, LLM_REQUEST_TIMEOUT_CODE } = await load();

  const error = llmRequestTimeoutError(30);
  assert.ok(error instanceof Error);
  assert.equal(error.message, "Request timed out after 30s");
  assert.equal(error.code, LLM_REQUEST_TIMEOUT_CODE);
});
