const assert = require("node:assert/strict");
const test = require("node:test");

const AgentStreamRequestRegistry = require("../../src/helpers/agentStreamRequestRegistry");

test("cancel aborts only the matching sender request", () => {
  const registry = new AgentStreamRequestRegistry();
  const first = registry.begin(10, "request-a");
  const second = registry.begin(11, "request-a");

  assert.equal(registry.cancel(10, "request-a"), true);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
});

test("completing an old controller does not remove its replacement", () => {
  const registry = new AgentStreamRequestRegistry();
  const first = registry.begin(10, "request-a");
  const replacement = registry.begin(10, "request-a");

  registry.complete(10, "request-a", first);

  assert.equal(registry.cancel(10, "request-a"), true);
  assert.equal(replacement.signal.aborted, true);
});

test("cancelling an unknown request is an idempotent no-op", () => {
  const registry = new AgentStreamRequestRegistry();

  assert.equal(registry.cancel(10, "missing"), false);
  assert.equal(registry.cancel(10, "missing"), false);
});

test("begin aborts an existing controller before replacing the same request", () => {
  const registry = new AgentStreamRequestRegistry();
  const first = registry.begin(10, "request-a");

  const replacement = registry.begin(10, "request-a");

  assert.equal(first.signal.aborted, true);
  assert.equal(replacement.signal.aborted, false);
});

test("sender teardown cancels only that sender and reports the cancelled count", () => {
  const registry = new AgentStreamRequestRegistry();
  const first = registry.begin(10, "request-a");
  const second = registry.begin(10, "request-b");
  const otherSender = registry.begin(11, "request-a");

  assert.equal(registry.cancelSender(10), 2);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(otherSender.signal.aborted, false);
  assert.equal(registry.cancelSender(10), 0);
});
