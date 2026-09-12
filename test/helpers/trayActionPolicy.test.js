const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/trayActionPolicy.js");

// The pill's command menu hides Ask assistant instead of refusing; the tray always
// shows it, so every path here must answer rather than swallow the click.
test("the tray's assistant action refuses policy and a busy pill, and runs otherwise", async () => {
  const { resolveTrayAssistantAction, TRAY_REFUSAL_KEYS } = await load();
  const idle = {
    agentAllowed: true,
    policyResolved: true,
    isRecording: false,
    liveTranscriptMounted: false,
  };

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

// Policy outranks busy: an org refusal explains the real reason.
test("a blocked policy is reported even while the pill is busy", async () => {
  const { resolveTrayAssistantAction, TRAY_REFUSAL_KEYS } = await load();

  assert.equal(
    resolveTrayAssistantAction({ agentAllowed: false, policyResolved: true, isRecording: true })
      .messageKey,
    TRAY_REFUSAL_KEYS.agentRestricted
  );
});

// An offline or failed policy fetch fails closed exactly like a restriction, and
// telling the user their org blocked something it never blocked is a lie.
test("an unresolved policy is not reported as an organization restriction", async () => {
  const { resolveTrayAssistantAction, TRAY_REFUSAL_KEYS } = await load();

  assert.equal(
    resolveTrayAssistantAction({
      agentAllowed: false,
      policyResolved: false,
      isRecording: false,
      liveTranscriptMounted: false,
    }).messageKey,
    TRAY_REFUSAL_KEYS.policyUnresolved
  );

  // A caller that forgets the input must not silently keep the org wording.
  assert.equal(
    resolveTrayAssistantAction({ agentAllowed: false, isRecording: false }).messageKey,
    TRAY_REFUSAL_KEYS.policyUnresolved
  );
});
