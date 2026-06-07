const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveIdleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS } = require("../../src/helpers/idleTimeout");

test("defaults to five minutes when unset", () => {
  assert.equal(resolveIdleTimeoutMs({}), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 5 * 60 * 1000);
});

test("uses the configured milliseconds", () => {
  assert.equal(resolveIdleTimeoutMs({ CLEANUP_IDLE_TIMEOUT_MS: "1800000" }), 1800000);
});

test("zero means never (returns 0)", () => {
  assert.equal(resolveIdleTimeoutMs({ CLEANUP_IDLE_TIMEOUT_MS: "0" }), 0);
});

test("invalid or negative values fall back to the default", () => {
  assert.equal(resolveIdleTimeoutMs({ CLEANUP_IDLE_TIMEOUT_MS: "abc" }), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(resolveIdleTimeoutMs({ CLEANUP_IDLE_TIMEOUT_MS: "-1" }), DEFAULT_IDLE_TIMEOUT_MS);
});
