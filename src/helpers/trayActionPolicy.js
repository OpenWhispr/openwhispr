// The pill's command menu hides quick actions that cannot run; the tray always
// shows them, so a tray click needs an answer instead of silence. These decide
// what the dictation renderer does with one, and the message it explains a
// refusal with. Keys resolve through i18n in the renderer.
export const TRAY_REFUSAL_KEYS = Object.freeze({
  agentRestricted: "common.policyAgentRestricted",
  meetingRestricted: "notes.meeting.restrictedByOrg",
  policyUnresolved: "common.policyUnresolved",
  busy: "app.commandMenu.busyRecording",
});

const run = Object.freeze({ action: "run" });
const refuse = (messageKey) => Object.freeze({ action: "refuse", messageKey });

// A policy that never arrived — offline, or a failed fetch — fails closed exactly
// like a real restriction, so the refusal must not blame an org that restricted
// nothing. `policyResolved` is required: defaulting it would hide a miswiring.
const policyRefusal = (policyResolved, restrictedKey) =>
  refuse(policyResolved ? restrictedKey : TRAY_REFUSAL_KEYS.policyUnresolved);

/** The pill menu hides Ask Assistant without the agent, and while a panel owns the pill. */
export function resolveTrayAssistantAction({
  agentAllowed,
  policyResolved,
  isRecording,
  liveTranscriptMounted,
}) {
  if (!agentAllowed) return policyRefusal(policyResolved, TRAY_REFUSAL_KEYS.agentRestricted);
  if (isRecording || liveTranscriptMounted) return refuse(TRAY_REFUSAL_KEYS.busy);
  return run;
}

/** A meeting would capture the microphone a live dictation already holds. */
export function resolveTrayMeetingAction({ meetingAllowed, policyResolved, isRecording }) {
  if (!meetingAllowed) return policyRefusal(policyResolved, TRAY_REFUSAL_KEYS.meetingRestricted);
  if (isRecording) return refuse(TRAY_REFUSAL_KEYS.busy);
  return run;
}
