const test = require("node:test");
const assert = require("node:assert/strict");
const { createActionNoteCommitRegistry } = require("../../src/helpers/actionNoteCommitRegistry");

const updates = {
  enhanced_content: "enhanced",
  enhancement_prompt: "summarize",
  enhanced_at_content_hash: "hash-a",
};

function createHarness(overrides = {}) {
  let current = true;
  const commits = [];
  const registry = createActionNoteCommitRegistry({
    isBindingCurrent: () => current,
    isSameOwner: (left, right) => left?.id === right?.id,
    commit: (grant, payload) => {
      commits.push({ grant, payload });
      return { success: true };
    },
    createToken: () => "action-token",
    scheduleExpiry: () => ({ unref() {} }),
    ...overrides,
  });
  return { registry, commits, revoke: () => (current = false) };
}

test("a capability is one-time and bound to owner, note, signature, and action fields", () => {
  const { registry, commits } = createHarness();
  registry.issue({
    authorizationBinding: { epoch: 1 },
    ownerWebContents: { id: 7 },
    noteId: 42,
    reasoningSignature: "signature-a",
  });
  const payload = {
    commitToken: "action-token",
    noteId: 42,
    reasoningSignature: "signature-a",
    updates,
  };

  assert.equal(registry.commitAuthorized({ id: 8 }, payload).success, false);
  assert.equal(
    registry.commitAuthorized({ id: 7 }, { ...payload, updates: { ...updates, content: "x" } })
      .success,
    false
  );
  assert.deepEqual(registry.commitAuthorized({ id: 7 }, payload), { success: true });
  assert.equal(registry.commitAuthorized({ id: 7 }, payload).success, false);
  assert.equal(commits.length, 1);
});

test("a binding change at the final synchronous check performs no commit", () => {
  let current = true;
  let commitCalls = 0;
  const { registry } = createHarness({
    isSameOwner: () => {
      current = false;
      return true;
    },
    isBindingCurrent: () => current,
    commit: () => {
      commitCalls += 1;
      return { success: true };
    },
  });
  registry.issue({
    authorizationBinding: { epoch: 1 },
    ownerWebContents: { id: 7 },
    noteId: 42,
    reasoningSignature: "signature-a",
  });

  const result = registry.commitAuthorized(
    { id: 7 },
    {
      commitToken: "action-token",
      noteId: 42,
      reasoningSignature: "signature-a",
      updates,
    }
  );
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(commitCalls, 0);
});

test("revocation removes every outstanding action-note capability", () => {
  const { registry, commits } = createHarness();
  registry.issue({
    authorizationBinding: { epoch: 1 },
    ownerWebContents: { id: 7 },
    noteId: 42,
    reasoningSignature: "signature-a",
  });
  registry.revoke();

  const result = registry.commitAuthorized(
    { id: 7 },
    {
      commitToken: "action-token",
      noteId: 42,
      reasoningSignature: "signature-a",
      updates,
    }
  );
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(commits.length, 0);
});
