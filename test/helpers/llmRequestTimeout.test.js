const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/llmRequestTimeout.js");

test("uses the configured value when it's within range", async () => {
  const { resolveLlmRequestTimeoutSeconds } = await load();
  assert.equal(resolveLlmRequestTimeoutSeconds(90), 90);
});

test("falls back to the 30s default when unset or invalid", async () => {
  const { resolveLlmRequestTimeoutSeconds } = await load();
  assert.equal(resolveLlmRequestTimeoutSeconds(undefined), 30);
  assert.equal(resolveLlmRequestTimeoutSeconds(NaN), 30);
});

test("clamps below the 10s floor", async () => {
  const { resolveLlmRequestTimeoutSeconds } = await load();
  assert.equal(resolveLlmRequestTimeoutSeconds(1), 10);
});

test("clamps 0 and negative values to the 10s floor rather than disabling", async () => {
  const { resolveLlmRequestTimeoutSeconds } = await load();
  assert.equal(resolveLlmRequestTimeoutSeconds(0), 10);
  assert.equal(resolveLlmRequestTimeoutSeconds(-5), 10);
});

test("clamps above the 600s ceiling", async () => {
  const { resolveLlmRequestTimeoutSeconds } = await load();
  assert.equal(resolveLlmRequestTimeoutSeconds(9999), 600);
});

test("exposes the 60s streaming timeout floor", async () => {
  const { LLM_STREAMING_TIMEOUT_FLOOR_SECONDS } = await load();
  assert.equal(LLM_STREAMING_TIMEOUT_FLOOR_SECONDS, 60);
});

test("streaming's floor keeps a low configured value at 60s", async () => {
  const { resolveLlmRequestTimeoutSeconds, LLM_STREAMING_TIMEOUT_FLOOR_SECONDS } = await load();
  const streamingTimeout = Math.max(
    resolveLlmRequestTimeoutSeconds(30),
    LLM_STREAMING_TIMEOUT_FLOOR_SECONDS
  );
  assert.equal(streamingTimeout, 60);
});

test("streaming's floor lets a high configured value raise it above 60s", async () => {
  const { resolveLlmRequestTimeoutSeconds, LLM_STREAMING_TIMEOUT_FLOOR_SECONDS } = await load();
  const streamingTimeout = Math.max(
    resolveLlmRequestTimeoutSeconds(120),
    LLM_STREAMING_TIMEOUT_FLOOR_SECONDS
  );
  assert.equal(streamingTimeout, 120);
});

test("millisecond conversion for SDK timeouts (tinfoil) honors default and override", async () => {
  const { resolveLlmRequestTimeoutSeconds } = await load();
  // The Tinfoil provider passes resolveLlmRequestTimeoutSeconds(x) * 1000 as the
  // SDK per-attempt timeout; pin the arithmetic for the default and an override.
  assert.equal(resolveLlmRequestTimeoutSeconds(undefined) * 1000, 30_000);
  assert.equal(resolveLlmRequestTimeoutSeconds(90) * 1000, 90_000);
});
