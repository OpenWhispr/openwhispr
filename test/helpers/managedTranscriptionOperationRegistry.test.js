const test = require("node:test");
const assert = require("node:assert/strict");

const modulePath = "../../src/helpers/managedTranscriptionOperationRegistry";

const binding = (identityKey = "account-a\nworkspace-a\n7") => ({
  identityKey,
  tokenGeneration: 7,
  authGeneration: 7,
  configGeneration: 11,
  provider: "whisper",
  model: "small",
  managed: true,
});

for (const family of [
  "cloud",
  "byok",
  "self-hosted",
  "local",
  "proxy",
  "file",
  "diarization",
  "dictation",
]) {
  test(`${family} operation revocation aborts transport and blocks result publication`, () => {
    const { createManagedTranscriptionOperationRegistry } = require(modulePath);
    const revoked = [];
    const registry = createManagedTranscriptionOperationRegistry({
      isBindingCurrent: () => true,
    });
    const operation = registry.begin({
      family,
      binding: binding(),
      ownerWebContents: null,
      onRevoke: () => revoked.push(family),
    });

    registry.revoke({ identityKey: binding().identityKey });

    assert.equal(operation.signal.aborted, true);
    assert.deepEqual(revoked, [family]);
    assert.throws(() => operation.assertCurrent(), {
      code: "AUTHORIZATION_BOUNDARY_CHANGED",
    });
    assert.equal(operation.isCurrent(), false);
  });
}

test("identity-scoped revocation leaves another workspace operation active", () => {
  const { createManagedTranscriptionOperationRegistry } = require(modulePath);
  const registry = createManagedTranscriptionOperationRegistry({
    isBindingCurrent: () => true,
  });
  const first = registry.begin({ family: "file", binding: binding("identity-a") });
  const second = registry.begin({ family: "file", binding: binding("identity-b") });

  registry.revoke({ identityKey: "identity-a" });

  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  second.assertCurrent();
});

test("owner loss revokes the operation and release detaches the owner listener", () => {
  const { EventEmitter } = require("node:events");
  const { createManagedTranscriptionOperationRegistry } = require(modulePath);
  const owner = new EventEmitter();
  const registry = createManagedTranscriptionOperationRegistry({
    isBindingCurrent: () => true,
  });
  const operation = registry.begin({
    family: "dictation",
    binding: binding(),
    ownerWebContents: owner,
  });

  assert.equal(owner.listenerCount("destroyed"), 1);
  owner.emit("destroyed");
  assert.equal(operation.signal.aborted, true);
  operation.release();
  assert.equal(owner.listenerCount("destroyed"), 0);
});
