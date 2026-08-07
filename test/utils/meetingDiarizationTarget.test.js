const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/meetingDiarizationTarget.ts");

test("a delayed A result cannot update B's visible state", async () => {
  const { matchesMeetingDiarizationTarget } = await load();
  const result = { sessionId: "session-a", noteId: 1, clientNoteId: "client-a" };

  assert.equal(
    matchesMeetingDiarizationTarget(result, {
      sessionId: "session-b",
      noteId: 2,
      clientNoteId: "client-b",
    }),
    false
  );
});

test("all three identity fields must match before applying UI state", async () => {
  const { matchesMeetingDiarizationTarget } = await load();
  const target = { sessionId: "session-a", noteId: 1, clientNoteId: "client-a" };

  assert.equal(matchesMeetingDiarizationTarget({ ...target }, target), true);
  assert.equal(matchesMeetingDiarizationTarget({ ...target, sessionId: "old" }, target), false);
  assert.equal(matchesMeetingDiarizationTarget({ ...target, noteId: 2 }, target), false);
  assert.equal(
    matchesMeetingDiarizationTarget({ ...target, clientNoteId: "replaced" }, target),
    false
  );
  assert.equal(matchesMeetingDiarizationTarget(null, target), false);
});
