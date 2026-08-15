const test = require("node:test");
const assert = require("node:assert/strict");

// #1479: the non-streaming reasoning timeout was hardcoded to 30s, aborting
// note formatting / cleanup / translation on local models that need 35-46s.
// resolveReasoningTimeoutMs makes it configurable via the reasoningTimeoutMs
// setting while keeping a safe default.

test("falls back to the 30s default when the setting is unset", async () => {
  const { resolveReasoningTimeoutMs } = await import("../../src/utils/reasoningTimeout.ts");
  const { REQUEST_TIMEOUTS } = await import("../../src/config/constants.ts");
  assert.equal(resolveReasoningTimeoutMs(undefined), REQUEST_TIMEOUTS.REASONING);
  assert.equal(REQUEST_TIMEOUTS.REASONING, 30000);
});

test("falls back to the default for 0, negative, and non-numeric values", async () => {
  const { resolveReasoningTimeoutMs } = await import("../../src/utils/reasoningTimeout.ts");
  const { REQUEST_TIMEOUTS } = await import("../../src/config/constants.ts");
  for (const value of [0, -1, NaN, Infinity, "abc", null]) {
    assert.equal(resolveReasoningTimeoutMs(value), REQUEST_TIMEOUTS.REASONING);
  }
});

test("honors a positive override so local-model formatting can exceed 30s", async () => {
  const { resolveReasoningTimeoutMs } = await import("../../src/utils/reasoningTimeout.ts");
  assert.equal(resolveReasoningTimeoutMs(120000), 120000);
  assert.equal(resolveReasoningTimeoutMs("90000"), 90000);
});
