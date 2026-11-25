/** Unknown policy strings use the restrictive behavior until the client understands them. */
export function requiresParticipantNotification(meetings) {
  return (meetings?.participantNotification ?? "off") !== "off";
}

export function requiresMeetingAdmission(meetings) {
  return (
    (meetings?.externalAttendees ?? "allowed") !== "allowed" ||
    requiresParticipantNotification(meetings)
  );
}
