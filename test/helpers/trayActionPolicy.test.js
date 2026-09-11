const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/trayActionPolicy.js");

// The pill's command menu hides these items instead of refusing; the tray always
// shows them, so every path here must answer rather than swallow the click.
test("the tray's assistant action refuses policy and a busy pill, and runs otherwise", async () => {
  const { resolveTrayAssistantAction, TRAY_REFUSAL_KEYS } = await load();
  const idle = { agentAllowed: true, isRecording: false, liveTranscriptMounted: false };

  assert.deepEqual(resolveTrayAssistantAction(idle), { action: "run" });
  assert.deepEqual(resolveTrayAssistantAction({ ...idle, agentAllowed: false }), {
    action: "refuse",
    messageKey: TRAY_REFUSAL_KEYS.agentRestricted,
  });
  assert.deepEqual(resolveTrayAssistantAction({ ...idle, isRecording: true }), {
    action: "refuse",
    messageKey: TRAY_REFUSAL_KEYS.busy,
  });
  // The transcript panel owns the pill just as a live recording does.
  assert.deepEqual(resolveTrayAssistantAction({ ...idle, liveTranscriptMounted: true }), {
    action: "refuse",
    messageKey: TRAY_REFUSAL_KEYS.busy,
  });
});

test("the tray's meeting action refuses policy and a live dictation, and runs otherwise", async () => {
  const { resolveTrayMeetingAction, TRAY_REFUSAL_KEYS } = await load();
  const idle = { meetingAllowed: true, isRecording: false };

  assert.deepEqual(resolveTrayMeetingAction(idle), { action: "run" });
  assert.deepEqual(resolveTrayMeetingAction({ ...idle, meetingAllowed: false }), {
    action: "refuse",
    messageKey: TRAY_REFUSAL_KEYS.meetingRestricted,
  });
  assert.deepEqual(resolveTrayMeetingAction({ ...idle, isRecording: true }), {
    action: "refuse",
    messageKey: TRAY_REFUSAL_KEYS.busy,
  });
});

// Policy outranks busy: an org refusal explains the real reason.
test("a blocked policy is reported even while the pill is busy", async () => {
  const { resolveTrayAssistantAction, resolveTrayMeetingAction, TRAY_REFUSAL_KEYS } = await load();

  assert.equal(
    resolveTrayAssistantAction({ agentAllowed: false, isRecording: true }).messageKey,
    TRAY_REFUSAL_KEYS.agentRestricted
  );
  assert.equal(
    resolveTrayMeetingAction({ meetingAllowed: false, isRecording: true }).messageKey,
    TRAY_REFUSAL_KEYS.meetingRestricted
  );
});
