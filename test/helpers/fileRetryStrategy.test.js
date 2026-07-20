const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/retry.ts");

test("transient filesystem errors retry — antivirus and indexers briefly lock temp audio files", async () => {
  const { createFileRetryStrategy } = await load();
  const { shouldRetry } = createFileRetryStrategy();

  assert.equal(shouldRetry({ code: "EBUSY" }), true);
  assert.equal(shouldRetry({ code: "ENOENT" }), true);
  assert.equal(shouldRetry({ code: "EPERM" }), true);
  assert.equal(shouldRetry({ code: "EAGAIN" }), true);
});

test("permanent filesystem errors do not retry", async () => {
  const { createFileRetryStrategy } = await load();
  const { shouldRetry } = createFileRetryStrategy();

  assert.equal(shouldRetry({ code: "EACCES" }), false);
  assert.equal(shouldRetry({ code: "EISDIR" }), false);
});

test("the strategy bounds its own retries and delay", async () => {
  const { createFileRetryStrategy } = await load();
  const strategy = createFileRetryStrategy();

  assert.equal(strategy.maxRetries, 2);
  assert.equal(strategy.initialDelay, 500);
});
