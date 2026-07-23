// True when a calendar event has at least one attendee other than the user.
// Solo focus blocks / personal reminders (no attendees, or only yourself) return false,
// so they never trigger meeting reminders/detection prompts.
function hasOtherAttendees(event) {
  if (!event || !event.attendees) return false;
  let attendees;
  try {
    attendees = JSON.parse(event.attendees);
  } catch {
    // Unparseable blob: fall back to the stored count (which includes self).
    return (event.attendees_count || 0) > 1;
  }
  if (!Array.isArray(attendees)) return false;
  return attendees.some((a) => a && a.self !== true);
}

module.exports = { hasOtherAttendees };
