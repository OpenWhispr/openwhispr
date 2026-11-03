const test = require("node:test");
const assert = require("node:assert/strict");
const { attemptSummary, remainingAfter } = require("../../src/lib/addSpaceMembersFlow.ts");

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
  skippedInvites: [],
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
