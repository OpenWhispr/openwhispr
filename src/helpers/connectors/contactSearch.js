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

  const remember = (email, name, startTime) => {
    if (typeof email !== "string" || !email.includes("@") || NON_PERSON_ADDRESS.test(email)) return;
    const key = email.toLowerCase();
    let person = people.get(key);
    if (!person) {
      person = { email, name: null, lastMet: null, lastMetTime: null, distance: Infinity };
      people.set(key, person);
    }
    if (!person.name && name) person.name = name;
    const time = Date.parse(startTime);
    if (Number.isNaN(time)) return;
    person.distance = Math.min(person.distance, Math.abs(time - now));
    if (time <= now && (person.lastMetTime === null || time > person.lastMetTime)) {
      person.lastMet = startTime;
      person.lastMetTime = time;
    }
  };

  for (const row of meetings) {
    const attendees = parseAttendees(row.attendees);
    for (const attendee of attendees) {
      // Only Apple's self flag means the user (EventKit's current user); on a
      // colleague's shared Google calendar it marks that colleague. The
      // account emails already cover the Google and Microsoft user.
      const isUser = attendee?.self && row.provider === "apple";
      if ((isUser || attendee?.resource) && typeof attendee.email === "string") {
        excluded.add(attendee.email.toLowerCase());
      }
    }
    for (const attendee of attendees) {
      remember(attendee?.email, attendee?.displayName, row.start_time);
    }
    remember(row.organizer_email, null, row.start_time);
  }
  // Every sync adds its attendees here and nothing prunes them, so people
  // whose meetings aged out of the calendar cache are still found.
  for (const contact of contacts) remember(contact.email, contact.display_name, null);
  for (const email of excluded) people.delete(email);
  return [...people.values()];
}

function score(person, query, queryTokens) {
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
  if (compactName.includes(compactQuery) || normalize(person.email).includes(query)) return 1;
  return 0;
}

/**
 * People matching a name or address in the user's calendar meetings and
 * synced contacts. Ties go to whoever the user meets closest to now; lastMet
 * is the most recent past meeting still on record, or null.
 */
function searchContacts(sources, query, { limit = 5, now = Date.now() } = {}) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const queryTokens = normalizedQuery.split(" ");
  return collectPeople(sources, now)
    .map((person) => ({ person, score: score(person, normalizedQuery, queryTokens) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.person.distance - b.person.distance)
    .slice(0, limit)
    .map(({ person }) => ({ name: person.name, email: person.email, lastMet: person.lastMet }));
}

module.exports = { searchContacts };
