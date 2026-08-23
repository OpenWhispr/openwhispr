const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createMeetingTranscriptCommitRegistry,
} = require("../../src/helpers/meetingTranscriptCommitRegistry");

const ownerMatches = (left, right) => left === right || left?.id === right?.id;

function createHarness() {
  let current = true;
  const commits = [];
  let tokenIndex = 0;
  const registry = createMeetingTranscriptCommitRegistry({
    isBindingCurrent: () => current,
    isSameOwner: ownerMatches,
    commit: (grant, payload) => {
      commits.push({ grant, payload });
      return { success: true };
    },
    createToken: () => `commit-${++tokenIndex}`,
    scheduleExpiry: () => ({ unref() {} }),
  });
  return { registry, commits, revokeBinding: () => (current = false) };
}

test("the exact owner and live binding can commit final and diarized transcripts", () => {
  const { registry, commits } = createHarness();
  const owner = { id: 7 };
  const commitToken = registry.issue({
    authorizationBinding: { identityKey: "account-a" },
    ownerWebContents: owner,
    sessionId: "meeting-a",
    noteId: 42,
  });

  assert.deepEqual(
    registry.commitAuthorized(owner, {
      commitToken,
      noteId: 42,
      transcript: "final",
      kind: "final",
    }),
    { success: true }
  );
  assert.deepEqual(
    registry.commitAuthorized(owner, {
      commitToken,
      noteId: 42,
      transcript: "diarized",
      kind: "diarization",
      speakerEmbeddings: { speaker_0: [0.1] },
    }),
    { success: true }
  );
  assert.equal(commits.length, 2);
});

test("revocation at the final boundary rejects without invoking the database commit", () => {
  const { registry, commits, revokeBinding } = createHarness();
  const owner = { id: 7 };
  const commitToken = registry.issue({
    authorizationBinding: { identityKey: "account-a" },
    ownerWebContents: owner,
    sessionId: "meeting-a",
    noteId: 42,
  });
  revokeBinding();

  const result = registry.commitAuthorized(owner, {
    commitToken,
    noteId: 42,
    transcript: "stale",
    kind: "final",
  });
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(commits.length, 0);
});

test("revocation after dispatch but before the final binding check cannot reach the database", () => {
  let current = true;
  let commitCalls = 0;
  const owner = { id: 7 };
  const registry = createMeetingTranscriptCommitRegistry({
    isBindingCurrent: () => current,
    isSameOwner: () => {
      current = false;
      return true;
    },
    commit: () => {
      commitCalls += 1;
      return { success: true };
    },
    createToken: () => "commit-token",
    scheduleExpiry: () => ({ unref() {} }),
  });
  registry.issue({
    authorizationBinding: { identityKey: "account-a" },
    ownerWebContents: owner,
    sessionId: "meeting-a",
    noteId: 42,
  });

  const result = registry.commitAuthorized(owner, {
    commitToken: "commit-token",
    noteId: 42,
    transcript: "stale",
    kind: "final",
  });
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(commitCalls, 0);
});

test("old tokens, other renderers, and another note are rejected", () => {
  const { registry, commits } = createHarness();
  const commitToken = registry.issue({
    authorizationBinding: { identityKey: "account-a" },
    ownerWebContents: { id: 7 },
    sessionId: "meeting-a",
    noteId: 42,
  });

  for (const payload of [
    { commitToken: "old", noteId: 42, transcript: "x", kind: "final" },
    { commitToken, noteId: 43, transcript: "x", kind: "final" },
  ]) {
    assert.equal(registry.commitAuthorized({ id: 7 }, payload).success, false);
  }
  assert.equal(
    registry.commitAuthorized(
      { id: 8 },
      { commitToken, noteId: 42, transcript: "x", kind: "final" }
    ).success,
    false
  );
  assert.equal(commits.length, 0);
});

test("identity-scoped revocation leaves another workspace grant usable", () => {
  const { registry, commits } = createHarness();
  const owner = { id: 7 };
  const stale = registry.issue({
    authorizationBinding: { identityKey: "account-a" },
    ownerWebContents: owner,
    sessionId: "meeting-a",
    noteId: 41,
  });
  const current = registry.issue({
    authorizationBinding: { identityKey: "account-b" },
    ownerWebContents: owner,
    sessionId: "meeting-b",
    noteId: 42,
  });
  registry.revoke("account-a");

  assert.equal(
    registry.commitAuthorized(owner, {
      commitToken: stale,
      noteId: 41,
      transcript: "stale",
      kind: "final",
    }).success,
    false
  );
  assert.equal(
    registry.commitAuthorized(owner, {
      commitToken: current,
      noteId: 42,
      transcript: "current",
      kind: "final",
    }).success,
    true
  );
  assert.equal(commits.length, 1);
});

test("workspace-policy revocation leaves another account grant usable", () => {
  const { registry, commits } = createHarness();
  const owner = { id: 7 };
  const stale = registry.issue({
    authorizationBinding: { workspacePolicyIdentityKey: "account-a\n7" },
    ownerWebContents: owner,
    sessionId: "meeting-a",
    noteId: 41,
  });
  const current = registry.issue({
    authorizationBinding: { workspacePolicyIdentityKey: "account-b\n7" },
    ownerWebContents: owner,
    sessionId: "meeting-b",
    noteId: 42,
  });
  registry.revokeWorkspacePolicy("account-a\n7");

  assert.equal(
    registry.commitAuthorized(owner, {
      commitToken: stale,
      noteId: 41,
      transcript: "stale",
      kind: "final",
    }).success,
    false
  );
  assert.equal(
    registry.commitAuthorized(owner, {
      commitToken: current,
      noteId: 42,
      transcript: "current",
      kind: "final",
    }).success,
    true
  );
  assert.equal(commits.length, 1);
});
