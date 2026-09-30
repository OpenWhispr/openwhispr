const { parseEventTime } = require("../calendarAvailability");
const { isValidEmailAddress } = require("./emailCompose");

// Rooms, resources, groups and holiday calendars Google lists as attendees.
const NON_PERSON_ADDRESS = /@(?:[^@]+\.)?calendar\.google\.com$/i;

// Spoken names arrive without punctuation: "jean luc" for Jean-Luc, "obrien"
// or "o brien" for O'Brien, "gabe torres" for gabe.torres@.
function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[-_.\s]+/g, " ")
    .trim();
}

function parseAttendees(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The user's own addresses and the rooms stored events flag, lowercased: the
 * calendar accounts, Microsoft aliases and resources (excludedEmails), plus
 * every address a meeting marks as the user (self). find_contact and a note's
 * attendee list both leave these out.
 */
function excludedAddresses({ meetings = [], excludedEmails = [] }) {
  const excluded = new Set(excludedEmails.map((email) => String(email).toLowerCase()));
  for (const row of meetings) {
    for (const attendee of parseAttendees(row.attendees)) {
      if (attendee?.self && typeof attendee.email === "string") {
        excluded.add(attendee.email.toLowerCase());
      }
    }
  }
  return excluded;
}

function isPersonAddress(email) {
  return typeof email === "string" && email.includes("@") && !NON_PERSON_ADDRESS.test(email);
}

// A display name is one line of plain text for the model's attendee list.
// Invisible format characters (bidi overrides, zero-width joiners) go, and
// so do angle brackets, their look-alikes and anything shaped like an
// address, so a name can't pass itself off as another "Name <address>".
const NAME_BREAKERS = /[\p{Cc}\s<>＜＞﹤﹥˂˃‹›«»〈〉《》⟨⟩]+/gu;
function attendeeName(value) {
  if (typeof value !== "string") return null;
  const name = value
    .replace(/\p{Cf}/gu, "")
    .replace(/\S*[@＠﹫]\S*/g, " ")
    .replace(NAME_BREAKERS, " ")
    .trim();
  return name || null;
}

/**
 * A note's attendees who are other people: never the user (flagged self, or
 * one of their addresses), a room or resource, a non-person calendar address
 * or anything that isn't a valid address. The meeting's organizer, when
 * known, comes last: Outlook and Apple calendars leave them out of the
 * attendees. De-duplicated case-insensitively, in the note's order.
 */
function personAttendees(sources, attendees, { organizerEmail = null } = {}) {
  const list = Array.isArray(attendees) ? attendees : [];
  const excluded = excludedAddresses(sources);
  // A participant flagged as the user excludes that address everywhere, so
  // it can't come back as an identified speaker or as the organizer.
  for (const attendee of list) {
    if (attendee?.self === true && typeof attendee.email === "string") {
      excluded.add(attendee.email.trim().toLowerCase());
    }
  }
  const seen = new Set();
  const people = [];
  const all = [...list, ...(organizerEmail ? [{ email: organizerEmail, displayName: null }] : [])];
  for (const attendee of all) {
    if (!attendee || attendee.self === true || attendee.resource === true) continue;
    const email = typeof attendee.email === "string" ? attendee.email.trim() : "";
    if (!isPersonAddress(email) || !isValidEmailAddress(email)) continue;
    const key = email.toLowerCase();
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    people.push({ name: attendeeName(attendee.displayName), email });
  }
  return people;
}

// The people speaker identification named in a note, with the address their
// speaker profile carries: they were in the meeting even when the invite
// didn't list them.
function identifiedSpeakers(mappings, profiles) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return mappings
    .map((mapping) => byId.get(mapping.profile_id))
    .filter((profile) => typeof profile?.email === "string" && profile.email !== "")
    .map((profile) => ({ email: profile.email, displayName: profile.display_name ?? null }));
}

/**
 * The note chat's attendee lookup (connector-note-attendees): the note's
 * participants, then the speakers identified in it, then its calendar
 * event's organizer. Besides the stored exclusions, the user's OpenWhispr
 * address and their Gmail login's address are theirs too, even when neither
 * is one of their calendar accounts.
 */
function createNoteAttendeesLookup({
  getContactLookupSources,
  getCalendarEventById,
  getSpeakerMappings,
  getSpeakerProfiles,
  getGmailAddress,
}) {
  return async ({ noteId, participants, calendarEventId, selfEmail }) => {
    const sources = getContactLookupSources();
    const gmailAddress = await getGmailAddress();
    const speakers = noteId
      ? identifiedSpeakers(getSpeakerMappings(noteId), getSpeakerProfiles())
      : [];
    const calendarEvent = calendarEventId ? getCalendarEventById(calendarEventId) : null;
    return personAttendees(
      {
        ...sources,
        excludedEmails: [
          ...(sources.excludedEmails ?? []),
          ...[selfEmail, gmailAddress].filter(Boolean),
        ],
      },
      [...participants, ...speakers],
      { organizerEmail: calendarEvent?.organizer_email ?? null }
    );
  };
}

function collectPeople({ meetings = [], contacts = [], excludedEmails = [] }, now) {
  const excluded = excludedAddresses({ meetings, excludedEmails });
  const people = new Map();

  const remember = (email, name, startTime, isAllDay) => {
    if (!isPersonAddress(email)) return;
    const key = email.toLowerCase();
    let person = people.get(key);
    if (!person) {
      person = { email, name: null, lastMet: null, lastMetTime: null, distance: Infinity };
      people.set(key, person);
    }
    if (!person.name && name) person.name = name;
    // All-day starts are local dates, not UTC midnight.
    const time = parseEventTime(startTime, isAllDay);
    if (time === null) return;
    person.distance = Math.min(person.distance, Math.abs(time - now));
    if (time <= now && (person.lastMetTime === null || time > person.lastMetTime)) {
      person.lastMet = startTime;
      person.lastMetTime = time;
    }
  };

  for (const row of meetings) {
    for (const attendee of parseAttendees(row.attendees)) {
      remember(attendee?.email, attendee?.displayName, row.start_time, row.is_all_day);
    }
    remember(row.organizer_email, null, row.start_time, row.is_all_day);
  }
  // Every sync adds its attendees here and only disconnecting their last
  // source prunes them, so people whose meetings aged out of the calendar
  // cache are still found. They come most recently synced first, which is how
  // ties between them are broken.
  for (const contact of contacts) remember(contact.email, contact.display_name, null);
  for (const email of excluded) people.delete(email);
  return [...people.values()];
}

function score(person, query, queryTokens, typedEmail) {
  if (person.email.toLowerCase() === typedEmail) return 5;
  const name = normalize(person.name);
  const localPart = normalize(person.email.split("@")[0]);
  if (name && name === query) return 4;
  const words = `${name} ${localPart}`.split(" ").filter(Boolean);
  if (queryTokens.every((token) => words.some((word) => word.startsWith(token)))) return 3;
  const compactQuery = query.replace(/ /g, "");
  const compactName = name.replace(/ /g, "");
  if (
    localPart.replace(/ /g, "").startsWith(compactQuery) ||
    compactName.startsWith(compactQuery)
  ) {
    return 2;
  }
  // The domain only counts once the query has an @, or "al" would match
  // everyone at alias.com.
  const address = query.includes("@") ? normalize(person.email) : localPart;
  if (compactName.includes(compactQuery) || address.includes(query)) return 1;
  return 0;
}

/**
 * People matching a name or address in the user's calendar meetings and
 * synced contacts. A typed address ranks its owner first. Ties go to whoever
 * the user meets closest to now, then to whoever was synced most recently;
 * lastMet is the most recent past meeting still on record, or null. hasMore
 * says the limit left matches out, so the model asks for a last name instead
 * of offering the wrong few.
 */
function searchContacts(sources, query, { limit = 5, now = Date.now() } = {}) {
  const normalizedQuery = normalize(query);
  // A query without a letter or digit ("@", "-") would match everyone.
  if (!/[\p{L}\p{N}]/u.test(normalizedQuery)) return { contacts: [], hasMore: false };
  const queryTokens = normalizedQuery.split(" ");
  const typedEmail = String(query).trim().toLowerCase();
  const matches = collectPeople(sources, now)
    .map((person) => ({
      person,
      score: score(person, normalizedQuery, queryTokens, typedEmail),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.person.distance - b.person.distance);
  return {
    contacts: matches
      .slice(0, limit)
      .map(({ person }) => ({ name: person.name, email: person.email, lastMet: person.lastMet })),
    hasMore: matches.length > limit,
  };
}

module.exports = { searchContacts, excludedAddresses, personAttendees, createNoteAttendeesLookup };
