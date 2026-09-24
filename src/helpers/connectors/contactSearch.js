const NON_PERSON_DOMAIN = /(resource|group)\.calendar\.google\.com$/i;

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
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

function collectPeople(rows) {
  const selfEmails = new Set();
  const people = new Map();

  const remember = (email, name, startTime) => {
    if (typeof email !== "string" || !email.includes("@") || NON_PERSON_DOMAIN.test(email)) return;
    const key = email.toLowerCase();
    const existing = people.get(key);
    if (!existing) {
      people.set(key, { email, name: name || null, lastMet: startTime || null });
      return;
    }
    if (!existing.name && name) existing.name = name;
    if (startTime && (!existing.lastMet || startTime > existing.lastMet)) existing.lastMet = startTime;
  };

  for (const row of rows) {
    const attendees = parseAttendees(row.attendees);
    for (const attendee of attendees) {
      if (attendee?.self && typeof attendee.email === "string") {
        selfEmails.add(attendee.email.toLowerCase());
      }
    }
    for (const attendee of attendees) {
      if (attendee && !attendee.self) remember(attendee.email, attendee.displayName, row.start_time);
    }
    remember(row.organizer_email, null, row.start_time);
  }
  for (const email of selfEmails) people.delete(email);
  return [...people.values()];
}

function score(person, query, queryTokens) {
  const name = normalize(person.name);
  const email = normalize(person.email);
  const localPart = email.split("@")[0];
  if (name && name === query) return 4;
  const nameTokens = name.split(/\s+/).filter(Boolean);
  if (nameTokens.length > 0 && queryTokens.every((token) => nameTokens.some((part) => part.startsWith(token)))) {
    return 3;
  }
  if (localPart.startsWith(query.replace(/\s+/g, ""))) return 2;
  if (name.includes(query) || email.includes(query)) return 1;
  return 0;
}

function searchContacts(rows, query, { limit = 5 } = {}) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const queryTokens = normalizedQuery.split(/\s+/);
  return collectPeople(rows)
    .map((person) => ({ person, score: score(person, normalizedQuery, queryTokens) }))
    .filter((match) => match.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || String(b.person.lastMet || "").localeCompare(String(a.person.lastMet || ""))
    )
    .slice(0, limit)
    .map(({ person }) => ({ name: person.name, email: person.email, lastMet: person.lastMet }));
}

module.exports = { searchContacts };
