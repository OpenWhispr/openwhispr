const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CLOUD_UPLOAD_TIMEOUT_MS,
  CLOUD_CHUNK_MAX_ATTEMPTS,
  CLOUD_CHUNK_GLOBAL_CONCURRENCY,
  isTransientChunkError,
  isNetworkLevelFailure,
  chunkRetryDelayMs,
  abortableSleep,
  createUploadSlots,
} = require("../../src/helpers/cloudChunkPolicy");
const { createAbortError } = require("../../src/helpers/abortError");

// The numbers are the #1326 contract: a dead upload fails within 2 minutes, three
// attempts total, and at most 2 chunk bodies in flight across ALL jobs so a user
// retry cannot wedge the shared HTTP/2 connection with 6 concurrent ~4MB bodies.
test("policy constants match the issue-1326 contract", () => {
  assert.equal(CLOUD_UPLOAD_TIMEOUT_MS, 120_000);
  assert.equal(CLOUD_CHUNK_MAX_ATTEMPTS, 3);
  assert.equal(CLOUD_CHUNK_GLOBAL_CONCURRENCY, 2);
});

test("createAbortError mirrors the DOMException shape fetch rejects with", () => {
  const err = createAbortError();
  assert.equal(err.name, "AbortError");
  assert.ok(err instanceof Error);
});

test("errors that never got an HTTP answer are transient", () => {
  assert.equal(isTransientChunkError(new Error("net::ERR_CONNECTION_CLOSED")), true);
  assert.equal(isTransientChunkError(Object.assign(new Error("x"), { statusCode: 502 })), true);
});

test("deterministic HTTP rejections are not transient", () => {
  assert.equal(isTransientChunkError(Object.assign(new Error("x"), { statusCode: 413 })), false);
  assert.equal(isTransientChunkError(Object.assign(new Error("x"), { statusCode: 404 })), false);
});

test("terminal business codes are not transient, including a user cancel", () => {
  for (const code of ["AUTH_EXPIRED", "LIMIT_REACHED", "NO_SPEECH_DETECTED", "UPLOAD_CANCELLED"]) {
    assert.equal(isTransientChunkError(Object.assign(new Error("x"), { code })), false);
  }
});

test("network-level failures are those where no HTTP answer arrived", () => {
  // Timeout: the upload stalled — network-level even if the error carries extras.
  assert.equal(isNetworkLevelFailure(new Error("aborted"), { timedOut: true }), true);
  // Pure transport rejection: no statusCode, no business code.
  assert.equal(isNetworkLevelFailure(new Error("net::ERR_CONNECTION_CLOSED"), {}), true);
  // An HTTP answer arrived (5xx) — the connection works; don't tear down the pool.
  assert.equal(
    isNetworkLevelFailure(Object.assign(new Error("x"), { statusCode: 502 }), {}),
    false
  );
  // Business rejection (401→AUTH_EXPIRED) — the server answered.
  assert.equal(
    isNetworkLevelFailure(Object.assign(new Error("x"), { code: "AUTH_EXPIRED" }), {}),
    false
  );
});

test("backoff is ~5s/15s/45s exponential, capped, with up to 1s jitter", () => {
  const noJitter = () => 0;
  assert.equal(chunkRetryDelayMs(1, noJitter), 5_000);
  assert.equal(chunkRetryDelayMs(2, noJitter), 15_000);
  assert.equal(chunkRetryDelayMs(3, noJitter), 45_000);
  assert.equal(chunkRetryDelayMs(4, noJitter), 45_000); // capped

  const fullJitter = () => 0.9999;
  const jittered = chunkRetryDelayMs(1, fullJitter);
  assert.ok(jittered > 5_000 && jittered <= 6_000, `jitter out of range: ${jittered}`);
});

test("abortableSleep resolves normally without a signal", async () => {
  const start = Date.now();
  await abortableSleep(10);
  assert.ok(Date.now() - start >= 5);
});

test("abortableSleep rejects immediately on an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(abortableSleep(10_000, controller.signal), { name: "AbortError" });
});

test("abortableSleep rejects promptly when aborted mid-wait", async () => {
  const controller = new AbortController();
  const start = Date.now();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(abortableSleep(10_000, controller.signal), { name: "AbortError" });
  assert.ok(Date.now() - start < 5_000, "abort did not interrupt the sleep");
});

test("upload slots cap concurrent holders across independent acquirers", async () => {
  const slots = createUploadSlots(2);
  const r1 = await slots.acquire();
  const r2 = await slots.acquire();
  assert.equal(slots.activeCount, 2);

  let thirdAdmitted = false;
  const third = slots.acquire().then((release) => {
    thirdAdmitted = true;
    return release;
  });
  await abortableSleep(10);
  assert.equal(thirdAdmitted, false, "third acquire ran while both slots were held");

  r1();
  const r3 = await third;
  assert.equal(thirdAdmitted, true);
  assert.equal(slots.activeCount, 2);

  r2();
  r3();
  assert.equal(slots.activeCount, 0);
});

test("a queued acquire rejects on abort and never takes a slot afterwards", async () => {
  const slots = createUploadSlots(1);
  const r1 = await slots.acquire();

  const abortedWaiter = new AbortController();
  const waiting = slots.acquire(abortedWaiter.signal);
  const successor = slots.acquire();

  abortedWaiter.abort();
  await assert.rejects(waiting, { name: "AbortError" });

  r1();
  const r2 = await successor; // the aborted waiter must not have consumed the freed slot
  assert.equal(slots.activeCount, 1);
  r2();
  assert.equal(slots.activeCount, 0);
});

test("acquire with a pre-aborted signal rejects without queueing", async () => {
  const slots = createUploadSlots(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(slots.acquire(controller.signal), { name: "AbortError" });
  assert.equal(slots.activeCount, 0);
});

test("double-release does not mint extra capacity", async () => {
  const slots = createUploadSlots(1);
  const release = await slots.acquire();
  release();
  release(); // second call must be a no-op

  const r1 = await slots.acquire();
  let secondAdmitted = false;
  const second = slots.acquire().then((rel) => {
    secondAdmitted = true;
    return rel;
  });
  await abortableSleep(10);
  assert.equal(secondAdmitted, false, "double-release created a phantom slot");
  r1();
  (await second)();
});
