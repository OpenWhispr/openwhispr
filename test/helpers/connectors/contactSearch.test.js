const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/contactSearch.js");

function row(startTime, attendees, organizer = null) {
  return { start_time: startTime, organizer_email: organizer, attendees: JSON.stringify(attendees) };
}

const ME = { email: "chad@example.com", displayName: "Chad", self: true };

const ROWS = [
  row("2026-09-20T10:00:00Z", [ME, { email: "gabe.torres@example.com", displayName: "Gabe Torres" }]),
  row("2026-09-10T10:00:00Z", [ME, { email: "gabriel@acme.test", displayName: "Gabriel Stone" }]),
  row("2026-09-01T10:00:00Z", [ME, { email: "gabe.torres@example.com", displayName: null }], "boss@example.com"),
  row("2026-08-01T10:00:00Z", [ME, { email: "room-4@resource.calendar.google.com", displayName: "Room 4" }]),
  row("2026-07-01T10:00:00Z", [ME, { email: "zoë.müller@example.de", displayName: "Zoë Müller" }]),
  { start_time: "2026-06-01T10:00:00Z", organizer_email: null, attendees: "not json" },
];

test("a first name finds every matching person, most recent first", async () => {
  const { searchContacts } = await load();
  const results = searchContacts(ROWS, "gab");
  assert.deepEqual(
    results.map((person) => person.email),
    ["gabe.torres@example.com", "gabriel@acme.test"]
  );
  assert.equal(results[0].name, "Gabe Torres");
  assert.equal(results[0].lastMet, "2026-09-20T10:00:00Z");
});

test("a full name ranks the exact person first", async () => {
  const { searchContacts } = await load();
  assert.equal(searchContacts(ROWS, "Gabriel Stone")[0].email, "gabriel@acme.test");
});

test("the user, meeting rooms and malformed rows never appear", async () => {
  const { searchContacts } = await load();
  assert.deepEqual(searchContacts(ROWS, "chad"), []);
  assert.deepEqual(searchContacts(ROWS, "room"), []);
});

test("accents and email local parts match", async () => {
  const { searchContacts } = await load();
  assert.equal(searchContacts(ROWS, "zoe")[0].name, "Zoë Müller");
  assert.equal(searchContacts(ROWS, "boss")[0].email, "boss@example.com");
});

test("an empty query and the limit are respected", async () => {
  const { searchContacts } = await load();
  assert.deepEqual(searchContacts(ROWS, "   "), []);
  assert.equal(searchContacts(ROWS, "example", { limit: 1 }).length, 1);
});
