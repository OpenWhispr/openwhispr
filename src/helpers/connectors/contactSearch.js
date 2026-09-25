const { parseEventTime } = require("../calendarAvailability");

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

function collectPeople({ meetings = [], contacts = [], accountEmails = [] }, now) {
  const excluded = new Set(accountEmails.map((email) => String(email).toLowerCase()));
  const people = new Map();

  const remember = (email, name, startTime, isAllDay) => {
    if (typeof email !== "string" || !email.includes("@") || NON_PERSON_ADDRESS.test(email)) return;
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
    const attendees = parseAttendees(row.attendees);
    for (const attendee of attendees) {
      // On a colleague's shared Google calendar self marks that colleague;
      // self_is_user is set wherever it means the user.
      const isUser = attendee?.self && row.self_is_user;
      if ((isUser || attendee?.resource) && typeof attendee.email === "string") {
        excluded.add(attendee.email.toLowerCase());
      }
    }
    for (const attendee of attendees) {
      remember(attendee?.email, attendee?.displayName, row.start_time, row.is_all_day);
    }
    remember(row.organizer_email, null, row.start_time, row.is_all_day);
  }
  // Every sync adds its attendees here and only a disconnect prunes them, so
  // people whose meetings aged out of the calendar cache are still found. They
  // come most recently synced first, which is how ties between them are broken.
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
  if (!normalizedQuery) return { contacts: [], hasMore: false };
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

module.exports = { searchContacts };
