// ESM like calendarCacheWindow.js: shared with the renderer, where Vite only
// handles ESM source files; main-process CJS callers load it via Node's
// require(esm) with module-syntax detection.

/**
 * Whether an event's attendee belongs on a note made from it: rooms and other
 * resources are booked rather than invited, and a guest who declined isn't
 * coming. The user (`self`) stays whatever they answered, since they are the
 * one recording. Notes created before this rule may still hold rooms, so
 * speaker counts skip `resource` attendees on their own.
 */
export function isEventGuest(attendee) {
  return (
    attendee.resource !== true && (attendee.self === true || attendee.responseStatus !== "declined")
  );
}

/**
 * An event's attendees JSON for the note it creates. Each guest is tagged with
 * the event (`addedByEvent`) so removing the event later takes them off again,
 * except the user (`self`), who recorded the note whichever event it links.
 */
export function tagEventAttendeesJson(attendeesJson, eventId) {
  if (!attendeesJson || !eventId) return attendeesJson || null;
  try {
    const attendees = JSON.parse(attendeesJson);
    if (!Array.isArray(attendees)) return attendeesJson;
    return JSON.stringify(
      attendees
        .filter((attendee) => !attendee || typeof attendee !== "object" || isEventGuest(attendee))
        .map((attendee) =>
          attendee && typeof attendee === "object" && attendee.self !== true
            ? { ...attendee, addedByEvent: eventId }
            : attendee
        )
    );
  } catch {
    return attendeesJson;
  }
}
