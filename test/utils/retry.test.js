const test = require("node:test");
const assert = require("node:assert/strict");

const {
  withRetry,
  httpError,
  timeoutError,
  createApiRetryStrategy,
} = require("../../src/utils/retry.ts");

// #1759-adjacent history note: the status-less-retryable rule shipped for
// network drops (#1183). #1761 measured what it does to client-side timeouts:
// 4 attempts x 30 s + 7 s backoff = 127 s before the raw-paste fallback.

test("status-less plain errors stay retryable (network drop path, #1183)", () => {
  const { shouldRetry } = createApiRetryStrategy();
  assert.equal(shouldRetry(new Error("fetch failed")), true);
  assert.equal(shouldRetry(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })), true);
});

test("timeoutError-marked aborts are not retryable (#1761)", () => {
  const { shouldRetry } = createApiRetryStrategy();
  assert.equal(shouldRetry(timeoutError("Request timed out after 30s")), false);
});

test("OpenAI SDK timeout class name is not retryable (Tinfoil path, #1761)", () => {
  const { shouldRetry } = createApiRetryStrategy();
  const sdkTimeout = new Error("Request timed out.");
  sdkTimeout.name = "APIConnectionTimeoutError";
  assert.equal(shouldRetry(sdkTimeout), false);
});

test("HTTP status classes keep their existing retry split", () => {
  const { shouldRetry } = createApiRetryStrategy();
  assert.equal(shouldRetry(httpError("timeout", 408)), true);
  assert.equal(shouldRetry(httpError("rate limited", 429)), true);
  assert.equal(shouldRetry(httpError("bad gateway", 502)), true);
  assert.equal(shouldRetry(httpError("bad request", 400)), false);
  assert.equal(shouldRetry(httpError("cancelled", 499)), false);
});

test("timeoutError carries the message and the timedOut marker", () => {
  const err = timeoutError("Request timed out after 30s");
  assert.equal(err.message, "Request timed out after 30s");
  assert.equal(err.timedOut, true);
  assert.ok(err instanceof Error);
});

test("withRetry gives a timed-out attempt no second budget (#1761)", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts++;
        throw timeoutError("Request timed out after 30s");
      },
      { ...createApiRetryStrategy(), initialDelay: 1 }
    ),
    /timed out/
  );
  assert.equal(attempts, 1);
});

test("withRetry still retries a genuine network fault to exhaustion", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts++;
        throw new Error("socket hang up");
      },
      { ...createApiRetryStrategy(), maxRetries: 3, initialDelay: 1, maxDelay: 2 }
    ),
    /socket hang up/
  );
  // MAX_RETRIES semantics: 1 initial + 3 retries
  assert.equal(attempts, 4);
});

test("withRetry recovers when a fault clears mid-ladder", async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw httpError("bad gateway", 502);
      return "ok";
    },
    { ...createApiRetryStrategy(), initialDelay: 1 }
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});
