/** A meeting start the main process refused under policy, by its refusal code. */
export const meetingStartRefusalKey = (code) =>
  code === "POLICY_UNRESOLVABLE"
    ? "common.policyUnresolved"
    : "notes.meeting.recordingDisabledByOrg";
