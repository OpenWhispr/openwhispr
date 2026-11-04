const test = require("node:test");
const assert = require("node:assert/strict");
const {
  attemptSummary,
  canRetry,
  remainingAfter,
  settleListedInvites,
  spaceAccessEnd,
} = require("../../src/lib/addSpaceMembersFlow.ts");

const ethan = { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" };
const maya = { kind: "member", userId: "maya", label: "Maya", email: "maya@openronnie.com" };
const sales = { kind: "group", teamId: "sales", label: "Sales", memberCount: 5 };
const design = { kind: "group", teamId: "design", label: "Design Team", memberCount: 2 };
const alex = { kind: "email", email: "alex@example.com", role: "member", valid: true };
const noor = { kind: "email", email: "noor@example.com", role: "admin", valid: true };

const outcome = (overrides = {}) => ({
  addedMembers: [],
  failedMembers: [],
  addedGroups: [],
  failedGroups: [],
  invited: [],
  failedInvites: [],
  refusedInvites: [],
  skippedInvites: [],
  leftMembers: [],
  ...overrides,
});

test("what stays staged is only what failed, in the order picked", () => {
  const picked = [noor, ethan, sales, alex, design, maya];

  const remaining = remainingAfter(
    picked,
    outcome({
      addedMembers: [ethan],
      failedMembers: [maya],
      addedGroups: [sales],
      failedGroups: [design],
      invited: [noor],
      failedInvites: [alex],
    })
  );

  assert.deepEqual(remaining, [alex, design, maya]);
});

test("nothing stays when everything went", () => {
  const picked = [ethan, sales, alex];

  assert.deepEqual(
    remainingAfter(
      picked,
      outcome({ addedMembers: [ethan], addedGroups: [sales], invited: [alex] })
    ),
    []
  );
});

test("an address that already has an invitation is dropped, since trying again can't change that", () => {
  const picked = [ethan, alex];

  assert.deepEqual(
    remainingAfter(picked, outcome({ addedMembers: [ethan], skippedInvites: [alex] })),
    []
  );
});

test("a chip the attempt never reported on is not kept", () => {
  assert.deepEqual(remainingAfter([ethan, alex], outcome({ failedInvites: [alex] })), [alex]);
});

test("nothing failed is all done, even when only an invitation was skipped", () => {
  assert.equal(attemptSummary(outcome({ addedMembers: [ethan], invited: [alex] })).kind, "allDone");
  assert.equal(attemptSummary(outcome({ skippedInvites: [alex] })).kind, "allDone");
});

test("nothing went is all failed", () => {
  assert.equal(
    attemptSummary(outcome({ failedMembers: [ethan], failedInvites: [alex] })).kind,
    "allFailed"
  );
  // An address that was skipped is not something that went.
  assert.equal(
    attemptSummary(outcome({ failedMembers: [ethan], skippedInvites: [alex] })).kind,
    "allFailed"
  );
});

test("some went and some failed is partial", () => {
  assert.equal(
    attemptSummary(outcome({ addedMembers: [ethan], failedInvites: [alex] })).kind,
    "partial"
  );
  assert.equal(
    attemptSummary(outcome({ addedGroups: [sales], failedGroups: [design] })).kind,
    "partial"
  );
  assert.equal(
    attemptSummary(outcome({ invited: [alex], failedMembers: [ethan] })).kind,
    "partial"
  );
});

test("someone who left the workspace is dropped, not kept for a retry", () => {
  const picked = [ethan, maya];

  assert.deepEqual(
    remainingAfter(picked, outcome({ failedMembers: [ethan], leftMembers: [maya] })),
    [ethan]
  );
  assert.equal(attemptSummary(outcome({ leftMembers: [maya] })).kind, "allDone");
  assert.equal(
    attemptSummary(outcome({ failedMembers: [ethan], leftMembers: [maya] })).kind,
    "allFailed"
  );
});

test("an address the teamspace lists as invited moves from skipped to invited", () => {
  const settled = settleListedInvites(
    outcome({ invited: [noor], skippedInvites: [alex, { ...noor, email: "kim@example.com" }] }),
    new Set(["alex@example.com"])
  );

  assert.deepEqual(settled.invited, [noor, alex]);
  assert.deepEqual(settled.skippedInvites, [{ ...noor, email: "kim@example.com" }]);
});

test("nothing is listed, nothing changes", () => {
  const before = outcome({ skippedInvites: [alex] });

  assert.deepEqual(settleListedInvites(before, new Set()), before);
});

const refused = (recipient, failure) => ({ recipient, failure });

test("a refused address stays staged only when a second try or a trim can get it through", () => {
  const picked = [alex, noor];
  const stays = (failure) =>
    remainingAfter(picked, outcome({ refusedInvites: [refused(alex, failure)] }));

  for (const failure of [
    { kind: "rateLimited" },
    { kind: "rateLimited", available: 1, limit: 5 },
    { kind: "sessionExpired" },
    { kind: "seatLimit", available: 1 },
  ]) {
    assert.deepEqual(stays(failure), [alex], failure.kind);
  }
  for (const failure of [
    { kind: "seatLimit" },
    { kind: "seatLimit", available: 0 },
    { kind: "notAllowed" },
    { kind: "ssoRequired" },
    { kind: "directoryRequired" },
    { kind: "invalid" },
    { kind: "refused", message: "Nope" },
  ]) {
    assert.deepEqual(stays(failure), [], failure.kind);
  }
});

test("Try again is offered only for what could go through as it stands", () => {
  assert.equal(canRetry(outcome()), false);
  assert.equal(canRetry(outcome({ failedMembers: [ethan] })), true);
  assert.equal(canRetry(outcome({ failedGroups: [sales] })), true);
  assert.equal(canRetry(outcome({ failedInvites: [alex] })), true);
  assert.equal(
    canRetry(outcome({ refusedInvites: [refused(alex, { kind: "rateLimited" })] })),
    true
  );
  assert.equal(
    canRetry(outcome({ refusedInvites: [refused(alex, { kind: "notAllowed" })] })),
    false
  );
  assert.equal(
    canRetry(outcome({ refusedInvites: [refused(alex, { kind: "seatLimit", available: 1 })] })),
    false,
    "the same addresses would be refused again until some are removed"
  );
});

test("a refusal beside nothing else doesn't read as a failure to add", () => {
  const alone = outcome({ refusedInvites: [refused(alex, { kind: "notAllowed" })] });
  assert.equal(attemptSummary(alone).kind, "allDone", "it has its own line");
  assert.equal(
    attemptSummary(
      outcome({
        failedMembers: [ethan],
        refusedInvites: [refused(alex, { kind: "notAllowed" })],
      })
    ).kind,
    "partial",
    "and beside a failure each is said on its own"
  );
});

test("a teamspace's own refusals end the attempt; anything else is about this try", () => {
  assert.equal(spaceAccessEnd({ kind: "archived" }), "deleted");
  assert.equal(spaceAccessEnd({ kind: "gone" }), "gone");
  assert.equal(spaceAccessEnd({ kind: "notAllowed" }), "notAllowed");
  assert.equal(spaceAccessEnd({ kind: "ssoRequired" }), "ssoRequired");
  for (const failure of [
    { kind: "failed" },
    { kind: "rateLimited" },
    { kind: "lastAdmin" },
    { kind: "refused", message: "Nope" },
    { kind: "notWorkspaceMembers", userIds: [] },
  ]) {
    assert.equal(spaceAccessEnd(failure), null, failure.kind);
  }
});
