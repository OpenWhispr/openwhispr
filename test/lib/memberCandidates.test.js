const test = require("node:test");
const assert = require("node:assert/strict");
const {
  filterMemberCandidates,
  orderMemberCandidates,
} = require("../../src/lib/memberCandidates.ts");

const member = (userId) => ({ user_id: userId });

test("orderMemberCandidates: pins the current user first", () => {
  const members = [member("a"), member("b"), member("me"), member("c")];
  assert.deepEqual(
    orderMemberCandidates(members, "me").map((m) => m.user_id),
    ["me", "a", "b", "c"]
  );
});

test("orderMemberCandidates: keeps order when current user is absent or unknown", () => {
  const members = [member("a"), member("b")];
  assert.deepEqual(orderMemberCandidates(members, "me"), members);
  assert.deepEqual(orderMemberCandidates(members, undefined), members);
  assert.deepEqual(orderMemberCandidates([], "me"), []);
});

test("filterMemberCandidates: matches names and emails case-insensitively", () => {
  const members = [
    { user_id: "1", name: "Ada Lovelace", email: "ada@example.com" },
    { user_id: "2", name: null, email: "GRACE@example.com" },
  ];

  assert.deepEqual(filterMemberCandidates(members, " love "), [members[0]]);
  assert.deepEqual(filterMemberCandidates(members, "grace@"), [members[1]]);
  assert.equal(filterMemberCandidates(members, ""), members);
});

test("filterMemberCandidates: safely tolerates null or missing email properties", () => {
  const members = [
    { user_id: "1", name: "Bob Martin", email: null },
    { user_id: "2", name: "Charlie", email: undefined },
    { user_id: "3", name: "Diana Prince", email: "diana@example.com" },
  ];

  assert.deepEqual(filterMemberCandidates(members, "bob"), [members[0]]);
  assert.deepEqual(filterMemberCandidates(members, "diana"), [members[2]]);
  assert.deepEqual(filterMemberCandidates(members, "example"), [members[2]]);
});
