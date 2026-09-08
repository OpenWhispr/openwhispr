const test = require("node:test");
const assert = require("node:assert/strict");

const { createUploadCancelRegistry } = require("../../src/helpers/uploadCancelRegistry");

test("cancel aborts every operation registered under one requestId", () => {
  const registry = createUploadCancelRegistry();
  const transcribe = registry.register("req-1");
  const diarize = registry.register("req-1");

  const aborted = registry.cancel("req-1");

  assert.equal(aborted, 2);
  assert.equal(transcribe.signal.aborted, true);
  assert.equal(diarize.signal.aborted, true);
});

test("release removes only its own controller", () => {
  const registry = createUploadCancelRegistry();
  const first = registry.register("req-1");
  const second = registry.register("req-1");

  first.release();
  const aborted = registry.cancel("req-1");

  assert.equal(aborted, 1);
  assert.equal(first.signal.aborted, false);
  assert.equal(second.signal.aborted, true);
});

test("releasing every operation makes a later cancel a no-op", () => {
  const registry = createUploadCancelRegistry();
  const first = registry.register("req-1");
  const second = registry.register("req-1");

  first.release();
  second.release();

  assert.equal(registry.cancel("req-1"), 0);
  assert.equal(first.signal.aborted, false);
  assert.equal(second.signal.aborted, false);
});

test("cancel of an unknown id is a no-op", () => {
  const registry = createUploadCancelRegistry();
  assert.equal(registry.cancel("never-registered"), 0);
});

test("register without a requestId is inert", () => {
  const registry = createUploadCancelRegistry();

  for (const id of [undefined, null, "", 42]) {
    const { signal, release } = registry.register(id);
    assert.equal(signal, undefined);
    assert.doesNotThrow(release);
  }
  assert.equal(registry.cancel(undefined), 0);
});

test("double release is safe", () => {
  const registry = createUploadCancelRegistry();
  const first = registry.register("req-1");
  const second = registry.register("req-1");

  first.release();
  first.release();

  assert.equal(registry.cancel("req-1"), 1);
  assert.equal(second.signal.aborted, true);
});

test("a registration after cancel starts a fresh set for the same id", () => {
  const registry = createUploadCancelRegistry();
  const first = registry.register("req-1");
  registry.cancel("req-1");

  const second = registry.register("req-1");
  assert.equal(second.signal.aborted, false);

  assert.equal(registry.cancel("req-1"), 1);
  assert.equal(second.signal.aborted, true);

  // The pre-cancel registration's release must not disturb the successor set.
  assert.doesNotThrow(() => first.release());
});
