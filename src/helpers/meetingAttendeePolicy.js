import { NON_PERSON_CALENDAR_ADDRESS } from "./eventAttendees.js";

// Shared with Vite and Electron main (require(esm)), like eventAttendees.js.
const EMAIL_DOMAIN =
  /^[^\s@]+@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/i;
const normalizeEmail = (email) => (typeof email === "string" ? email.trim().toLowerCase() : "");

// Outlook and EventKit can return a host separately from every invitee.
// A booked room already on the roster keeps its resource exemption.
export function unlistedOrganizerEmail(event, attendees) {
  const organizer = normalizeEmail(event.organizer_email);
  if (!organizer || NON_PERSON_CALENDAR_ADDRESS.test(organizer)) return null;
  return attendees.some((attendee) => normalizeEmail(attendee?.email) === organizer)
    ? null
    : organizer;
}

/** @returns {"allow" | "confirm" | "external" | "unverifiable"} */
export function meetingAttendeeVerdict(event, meetings) {
  if ((meetings?.externalAttendees ?? "allowed") === "allowed") return "allow";
  if (!event) return "confirm";

  let attendees = [];
  let incomplete = Boolean(event.attendees_omitted);
  try {
    const roster = event.attendees == null ? [] : JSON.parse(event.attendees);
    if (Array.isArray(roster)) attendees = roster;
    else incomplete = true;
  } catch {
    incomplete = true;
  }
  incomplete ||= event.attendees_count > attendees.length;
  const organizer = unlistedOrganizerEmail(event, attendees);
  if (organizer) attendees.push({ email: organizer });
  const domains = (meetings.internalDomains ?? []).map((domain) => domain.trim().toLowerCase());
  for (const attendee of attendees) {
    if (attendee?.resource === true) continue;
    const domain = EMAIL_DOMAIN.exec(normalizeEmail(attendee?.email))?.[1];
    if (!domain) {
      incomplete = true;
    } else if (
      !domains.some((internal) => domain === internal || domain.endsWith(`.${internal}`))
    ) {
      return "external";
    }
  }
  return incomplete ? "unverifiable" : "allow";
}

/** @returns {"POLICY_EXTERNAL_ATTENDEES" | "POLICY_ATTENDEES_UNVERIFIABLE" | null} */
export function meetingAttendeeRefusalCode(verdict) {
  if (verdict === "external") return "POLICY_EXTERNAL_ATTENDEES";
  if (verdict === "unverifiable") return "POLICY_ATTENDEES_UNVERIFIABLE";
  return null;
}

export function meetingAttendeeRefusalKey(code) {
  if (code === "POLICY_EXTERNAL_ATTENDEES") return "notes.meeting.externalAttendeesBlocked";
  if (code === "POLICY_ATTENDEES_UNVERIFIABLE")
    return "notes.meeting.externalAttendeesUnverifiable";
  return null;
}
