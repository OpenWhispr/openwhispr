const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/retry.ts");

test("errors without a status retry, since they mean the request never got an answer", async () => {
  const { createApiRetryStrategy } = await load();
  const { shouldRetry } = createApiRetryStrategy();

  assert.equal(shouldRetry(new Error("fetch failed")), true);
  assert.equal(shouldRetry(new Error("Request timed out after 30s")), true);
});

test("4xx rejections do not retry, because the same request will be refused again", async () => {
  const { createApiRetryStrategy } = await load();
  const { shouldRetry } = createApiRetryStrategy();

  assert.equal(shouldRetry(Object.assign(new Error("bad request"), { status: 400 })), false);
  assert.equal(shouldRetry(Object.assign(new Error("not found"), { status: 404 })), false);
});

test("429 retries, since rate limits clear on their own", async () => {
  const { createApiRetryStrategy } = await load();
  const { shouldRetry } = createApiRetryStrategy();

  assert.equal(shouldRetry(Object.assign(new Error("rate limited"), { status: 429 })), true);
});

test("5xx server faults retry", async () => {
  const { createApiRetryStrategy } = await load();
  const { shouldRetry } = createApiRetryStrategy();

  assert.equal(shouldRetry(Object.assign(new Error("server error"), { status: 500 })), true);
  assert.equal(shouldRetry(Object.assign(new Error("unavailable"), { status: 503 })), true);
});

test("a status above the 5xx range does not retry", async () => {
  const { createApiRetryStrategy } = await load();
  const { shouldRetry } = createApiRetryStrategy();

  assert.equal(shouldRetry(Object.assign(new Error("nonsense"), { status: 600 })), false);
});

test("a status nested under response is honored", async () => {
  const { createApiRetryStrategy } = await load();
  const { shouldRetry } = createApiRetryStrategy();

  assert.equal(shouldRetry({ response: { status: 502 } }), true);
  assert.equal(shouldRetry({ response: { status: 403 } }), false);
});

test("a response carrying a non-numeric status is treated as a network failure and retries", async () => {
  const { createApiRetryStrategy } = await load();
  const { shouldRetry } = createApiRetryStrategy();

  assert.equal(shouldRetry({ response: { status: undefined } }), true);
  assert.equal(shouldRetry({ response: {} }), true);
});

test("withRetry stops after one attempt when the strategy refuses to retry", async () => {
  const { withRetry, createApiRetryStrategy } = await load();

  let attempts = 0;
  const failWith400 = async () => {
    attempts += 1;
    throw Object.assign(new Error("groq rejected the request"), { status: 400 });
  };

  await assert.rejects(
    () => withRetry(failWith400, { ...createApiRetryStrategy(), initialDelay: 1 }),
    /groq rejected the request/
  );
  assert.equal(attempts, 1, "a 400 must fail fast instead of burning the backoff ladder");
});

test("withRetry keeps retrying a 5xx up to maxRetries", async () => {
  const { withRetry, createApiRetryStrategy } = await load();

  let attempts = 0;
  const failWith503 = async () => {
    attempts += 1;
    throw Object.assign(new Error("unavailable"), { status: 503 });
  };

  await assert.rejects(() =>
    withRetry(failWith503, { ...createApiRetryStrategy(), maxRetries: 2, initialDelay: 1 })
  );
  assert.equal(attempts, 3, "initial attempt plus two retries");
});
