const test = require("node:test");
const assert = require("node:assert/strict");
const { orderMemberCandidates } = require("../../src/lib/memberCandidates.ts");

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
