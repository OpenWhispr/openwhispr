const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CLOUD_UPLOAD_TIMEOUT_MS,
  CLOUD_CHUNK_MAX_ATTEMPTS,
  CLOUD_CHUNK_GLOBAL_CONCURRENCY,
  CLOUD_POOL_TEARDOWN_COOLDOWN_MS,
  CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS,
  CLOUD_CHUNK_MAX_LOSS_RATIO,
  SILENT_CHUNK,
  FATAL_CHUNK_CODES,
  isTransientChunkError,
  isNetworkLevelFailure,
  isConnectionPoisoningFailure,
  isTeardownCollateral,
  summarizeChunkResults,
  assembleChunkTranscript,
  chunkRetryDelayMs,
  abortableSleep,
  createTeardownGate,
  createUploadSlots,
} = require("../../src/helpers/cloudChunkPolicy");
const { changeLanguage } = require("../../src/helpers/i18nMain");
const { createAbortError } = require("../../src/helpers/abortError");

// The numbers are the #1326 contract: a dead upload fails within 2 minutes and
// three attempts, and chunk bodies are capped across ALL jobs so a user retry
// can't run ~6 concurrent ~4MB bodies. The cap matches the old per-job limit, so
// a lone job uploads exactly as fast as before the fix.
test("policy constants match the issue-1326 contract", () => {
  assert.equal(CLOUD_UPLOAD_TIMEOUT_MS, 120_000);
  assert.equal(CLOUD_CHUNK_MAX_ATTEMPTS, 3);
  assert.equal(CLOUD_CHUNK_GLOBAL_CONCURRENCY, 5);
});

// A wedge fails every in-flight chunk at once, and closeAllConnections is
// session-wide, so an ungated teardown would let each failure abort its healthy
// siblings — and their retries in turn.
test("teardown gate admits one drop per cooldown window", () => {
  let now = 0;
  const gate = createTeardownGate(CLOUD_POOL_TEARDOWN_COOLDOWN_MS, () => now);

  assert.equal(gate(), true, "first failure must drop the wedged pool");
  assert.equal(gate(), false, "a simultaneous sibling failure must not drop it again");

  now += CLOUD_POOL_TEARDOWN_COOLDOWN_MS - 1;
  assert.equal(gate(), false);

  now += 1;
  assert.equal(gate(), true, "a later wedge must still be recoverable");
});

test("auth and quota doom the job; a no-speech chunk is nonfatal", () => {
  assert.equal(FATAL_CHUNK_CODES.has("AUTH_EXPIRED"), true);
  assert.equal(FATAL_CHUNK_CODES.has("LIMIT_REACHED"), true);
  // Silence in one segment says nothing about the rest, so the siblings must
  // keep uploading.
  assert.equal(FATAL_CHUNK_CODES.has("NO_SPEECH_DETECTED"), false);
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

test("terminal business codes are not transient", () => {
  for (const code of ["AUTH_EXPIRED", "LIMIT_REACHED", "NO_SPEECH_DETECTED"]) {
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

// A fatal TLS alert (Nat Molina's net::ERR_SSL_BAD_RECORD_MAC_ALERT) kills the
// HTTP/2 connection and every stream on it; waiting out the 30s cooldown just
// feeds retries back into the same sick pool until their budgets are gone.
test("fatal TLS/protocol errors are recognized as connection-poisoning", () => {
  for (const msg of [
    "net::ERR_SSL_BAD_RECORD_MAC_ALERT",
    "Failed to fetch: net::ERR_SSL_PROTOCOL_ERROR",
    "net::ERR_HTTP2_PROTOCOL_ERROR",
    "net::ERR_QUIC_PROTOCOL_ERROR",
  ]) {
    assert.equal(isConnectionPoisoningFailure(new Error(msg)), true, msg);
  }
});

test("ordinary failures are not connection-poisoning", () => {
  assert.equal(isConnectionPoisoningFailure(new Error("net::ERR_CONNECTION_CLOSED")), false);
  assert.equal(isConnectionPoisoningFailure(new Error("aborted")), false);
  assert.equal(
    isConnectionPoisoningFailure(Object.assign(new Error("x"), { statusCode: 502 })),
    false
  );
  assert.equal(isConnectionPoisoningFailure({}), false);
  assert.equal(isConnectionPoisoningFailure(null), false);
});

test("a forced teardown bypasses the cooldown and restarts the window", () => {
  let now = 0;
  const gate = createTeardownGate(CLOUD_POOL_TEARDOWN_COOLDOWN_MS, () => now);

  assert.equal(gate(), true);
  assert.equal(gate(true), true, "poisoned connection must be droppable inside the cooldown");
  now += CLOUD_POOL_TEARDOWN_COOLDOWN_MS - 1;
  assert.equal(gate(), false, "the forced drop restarts the cooldown window");
  now += 1;
  assert.equal(gate(), true);
});

// closeAllConnections() aborts every sibling still on the wire. Those failures
// are self-inflicted — the sibling's connection wasn't sick — so their attempts
// are refunded instead of charged.
test("teardown collateral: network-level failure during a teardown is refunded", () => {
  const abortLike = new Error("net::ERR_ABORTED");
  assert.equal(
    isTeardownCollateral(abortLike, { timedOut: false, teardownsDuringAttempt: 1 }),
    true
  );
});

test("teardown collateral requires a teardown during the attempt", () => {
  const abortLike = new Error("net::ERR_ABORTED");
  assert.equal(
    isTeardownCollateral(abortLike, { timedOut: false, teardownsDuringAttempt: 0 }),
    false
  );
});

test("a timeout or an answered request is never teardown collateral", () => {
  assert.equal(
    isTeardownCollateral(new Error("aborted"), { timedOut: true, teardownsDuringAttempt: 1 }),
    false,
    "a stalled upload is the chunk's own failure"
  );
  assert.equal(
    isTeardownCollateral(Object.assign(new Error("x"), { statusCode: 502 }), {
      timedOut: false,
      teardownsDuringAttempt: 1,
    }),
    false,
    "an HTTP answer proves the request outlived the teardown"
  );
  assert.equal(
    isTeardownCollateral(Object.assign(new Error("x"), { code: "AUTH_EXPIRED" }), {
      timedOut: false,
      teardownsDuringAttempt: 1,
    }),
    false
  );
});

test("refunds are bounded and the loss ceiling is a real fraction", () => {
  assert.ok(
    Number.isInteger(CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS) && CLOUD_CHUNK_MAX_TEARDOWN_REFUNDS > 0
  );
  assert.ok(CLOUD_CHUNK_MAX_LOSS_RATIO > 0 && CLOUD_CHUNK_MAX_LOSS_RATIO < 1);
});

// Survivors used to be joined with a bare space — a 16-minute fragment of a
// 73-minute file read as a seamless transcript.
test("assembleChunkTranscript marks failed spans and collapses consecutive holes", () => {
  const results = [{ text: "one" }, null, null, { text: "four" }, null];
  assert.equal(
    assembleChunkTranscript(results, 240),
    "one [missing audio 4:00-12:00] four [missing audio 16:00-20:00]"
  );
});

test("assembleChunkTranscript handles a hole at the start and hour-long offsets", () => {
  const results = [null, { text: "later" }];
  assert.equal(assembleChunkTranscript(results, 3600), "[missing audio 0:00-1:00:00] later");
});

test("assembleChunkTranscript with no holes matches the plain join", () => {
  const results = [{ text: " a " }, { text: "b\n\nc" }];
  assert.equal(assembleChunkTranscript(results, 240), "a b c");
});

test("silent chunks are omitted without consuming the failure budget", () => {
  const results = [{ text: "one" }, SILENT_CHUNK, null, { text: "four" }];
  assert.deepEqual(summarizeChunkResults(results), {
    responses: [{ text: "one" }, { text: "four" }],
    failedChunks: 1,
    silentChunks: 1,
  });
  assert.equal(assembleChunkTranscript(results, 240), "one [missing audio 8:00-12:00] four");
});

test("the final missing-audio marker ends at the real input duration", () => {
  const results = new Array(19).fill(SILENT_CHUNK);
  results[18] = null;
  assert.equal(assembleChunkTranscript(results, 240, 73 * 60), "[missing audio 1:12:00-1:13:00]");
});

// The marker is persisted into notes and pasted by dictation, so it belongs to
// the UI language like the [Speaker N] labels do.
test("the missing-audio marker follows the UI language", (t) => {
  changeLanguage("de");
  t.after(() => changeLanguage("en"));

  assert.equal(
    assembleChunkTranscript([{ text: "eins" }, null], 240),
    "eins [fehlendes Audio 4:00-8:00]"
  );
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
