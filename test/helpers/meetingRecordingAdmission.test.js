const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMeetingRecordingAdmission } = require("../../src/helpers/meetingRecordingAdmission");

function fixture(overrides = {}) {
  const owner = new EventEmitter();
  const state = {
    meetings: { externalAttendees: "blocked", internalDomains: ["internal.test"] },
    note: { calendar_event_id: "invite" },
    event: { attendees_count: 1, attendees: '[{"email":"person@internal.test"}]' },
    generation: 1,
    revoked: [],
  };
  const gate = createMeetingRecordingAdmission({
    getPolicy: () => state.meetings,
    resolveFeature: async () => null,
    getNote: () => state.note,
    getEvent: () => state.event,
    generation: () => state.generation,
    confirmInternal: async () => {
      throw Error("unexpected confirmation");
    },
    onRevoked: (attempt, code) => state.revoked.push([attempt.sessionId, code]),
    ...overrides,
  });
  return { owner, state, gate, args: { noteId: 3, sessionId: "session" } };
}

test("a linked invite refuses an external guest at either side of admission", async () => {
  const { gate, state, args, owner } = fixture();
  state.event.attendees = '[{"email":"outside@guest.test"}]';
  assert.equal((await gate.prepare(owner, args)).code, "POLICY_EXTERNAL_ATTENDEES");
  assert.equal(gate.start(owner, args).success, false);
  state.event.attendees = "[]";
  state.event.attendees_count = 0;
  assert.equal((await gate.prepare(owner, args)).success, true);
  state.event.attendees = '[{"email":"outside@guest.test"}]';
  assert.equal(gate.start(owner, args).code, "POLICY_EXTERNAL_ATTENDEES");
});

test("a missing linked invite cannot be self-confirmed", async () => {
  const { gate, state, args, owner } = fixture();
  state.event = null;
  assert.equal((await gate.prepare(owner, args)).code, "POLICY_ATTENDEES_UNVERIFIABLE");
});

test("an unlinked confirmation belongs only to its owner, note, session and start", async () => {
  let answer = false;
  const { gate, state, args, owner } = fixture({ confirmInternal: async () => answer });
  state.note.calendar_event_id = null;
  assert.equal((await gate.prepare(owner, args)).code, "AUDIO_OPERATION_CANCELLED");
  answer = true;
  assert.equal((await gate.prepare(owner, args)).success, true);
  assert.equal(gate.start(new EventEmitter(), args).success, false);
  assert.equal(gate.start(owner, { ...args, noteId: 4 }).success, false);
  assert.equal(gate.start(owner, args).success, true);
  gate.end(args.sessionId);
  assert.equal(gate.start(owner, args).success, false);
});

test("a calendar refresh revokes a pinned invite once, even if the note was unlinked", async () => {
  const { gate, state, args, owner } = fixture();
  await gate.prepare(owner, args);
  assert.equal(gate.start(owner, args).success, true);
  state.note.calendar_event_id = null;
  state.event.attendees = '[{"email":"new@guest.test"}]';
  gate.recheck();
  gate.recheck();
  assert.deepEqual(state.revoked, [["session", "POLICY_EXTERNAL_ATTENDEES"]]);
  assert.equal(gate.activeRefusal(), "POLICY_EXTERNAL_ATTENDEES");
  gate.end("some-other-session");
  assert.equal(gate.activeRefusal(), "POLICY_EXTERNAL_ATTENDEES");
  gate.end("session");
  assert.equal(gate.activeRefusal(), null);
});

test("account rotation or cancellation during a confirmation cannot authorize capture", async () => {
  for (const reason of ["cancel", "generation", "destroyed"]) {
    const entered = Promise.withResolvers();
    const answer = Promise.withResolvers();
    const { gate, state, args, owner } = fixture({
      confirmInternal: async () => {
        entered.resolve();
        return answer.promise;
      },
    });
    state.note.calendar_event_id = null;
    const pending = gate.prepare(owner, args);
    await entered.promise;
    if (reason === "cancel") gate.release(owner, args.sessionId);
    if (reason === "generation") state.generation++;
    if (reason === "destroyed") owner.emit("destroyed");
    answer.resolve(true);
    assert.equal((await pending).success, false);
    assert.equal(gate.start(owner, args).success, false);
  }
});

test("a token change revokes an approved start only while external guests are blocked", async () => {
  const { gate, state, args, owner } = fixture();
  state.meetings.externalAttendees = "allowed";
  assert.equal((await gate.prepare(owner, args)).success, true);
  gate.cancelPending();
  assert.deepEqual(state.revoked, []);
  assert.equal(gate.start(owner, args).success, true);
  gate.end(args.sessionId);
  state.meetings.externalAttendees = "blocked";
  assert.equal((await gate.prepare(owner, args)).success, true);
  gate.cancelPending();
  assert.deepEqual(state.revoked, [["session", "AUDIO_OPERATION_CANCELLED"]]);
});

test("allowed direct starts use existing behavior and observe a stricter policy mid-meeting", () => {
  const { gate, state, owner, args } = fixture();
  state.meetings.externalAttendees = "allowed";
  assert.equal(gate.start(owner, args).success, true);
  state.note.calendar_event_id = null;
  state.meetings.externalAttendees = "blocked";
  state.event.attendees = '[{"email":"new@guest.test"}]';
  gate.recheck();
  assert.equal(gate.activeRefusal(), "POLICY_EXTERNAL_ATTENDEES");
});

test("manual announcement is separate from guest confirmation and belongs to one recording start", async () => {
  const prompts = [];
  const { gate, state, args, owner } = fixture({
    confirmInternal: async () => {
      prompts.push("attendees");
      return true;
    },
    confirmNotification: async () => {
      prompts.push("notice");
      return true;
    },
  });
  state.meetings.participantNotification = "required";
  state.note.calendar_event_id = null;
  assert.equal((await gate.prepare(owner, args)).success, true);
  assert.deepEqual(prompts, ["attendees", "notice"]);
  state.meetings.externalAttendees = "allowed";
  assert.equal(gate.checkStart(new EventEmitter(), args).success, false);
  assert.equal(gate.checkStart(owner, { ...args, noteId: 4 }).success, false);
  assert.equal(gate.start(owner, args).notificationMethod, "told-by-member");
  gate.end(args.sessionId);
  assert.equal(gate.start(owner, args).success, false);
});

test("notification-only policy refuses direct starts, cancellation and stale confirmations", async () => {
  for (const reason of [
    "cancel",
    "released",
    "guest-added",
    "account-change",
    "feature-disabled",
  ]) {
    let disabled = false;
    const { gate, state, args, owner } = fixture({
      resolveFeature: async () =>
        disabled ? { success: false, code: "POLICY_MEETING_RECORDING_DISABLED" } : null,
      confirmNotification: async () => {
        if (reason === "released") gate.release(owner, args.sessionId);
        if (reason === "guest-added") {
          state.meetings.externalAttendees = "blocked";
          state.event.attendees = '[{"email":"guest@external.test"}]';
        }
        if (reason === "account-change") state.generation++;
        if (reason === "feature-disabled") disabled = true;
        return reason !== "cancel";
      },
    });
    state.meetings = {
      ...state.meetings,
      externalAttendees: "allowed",
      participantNotification: "future",
    };
    assert.equal(
      gate.start(owner, { ...args, notificationMethod: "told-by-member" }).success,
      false,
      reason
    );
    assert.equal((await gate.prepare(owner, args)).success, false, reason);
    assert.equal(gate.checkStart(owner, args).success, false, reason);
  }
});

test("a blocked guest gets no notice and notification enabled during startup revokes an unconfirmed attempt", async () => {
  const { gate, state, args, owner } = fixture({
    confirmNotification: () => assert.fail("unexpected notice"),
  });
  state.meetings.participantNotification = "required";
  state.event.attendees = '[{"email":"guest@external.test"}]';
  assert.equal((await gate.prepare(owner, args)).code, "POLICY_EXTERNAL_ATTENDEES");
  state.meetings = { participantNotification: "off" };
  assert.equal((await gate.prepare(owner, args)).success, true);
  state.meetings.participantNotification = "required";
  gate.recheck();
  assert.deepEqual(state.revoked, [[args.sessionId, "POLICY_PARTICIPANT_NOTIFICATION_REQUIRED"]]);
});
