const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/calendarAttendees.ts");

const event = (overrides) => ({
  id: "evt",
  attendees: null,
  attendees_count: 0,
  ...overrides,
});

const attendee = (email, self = false) => ({
  email,
  displayName: null,
  responseStatus: "accepted",
  self,
});

test("hasOtherAttendees hides events with nobody invited", async () => {
  const { hasOtherAttendees } = await load();
  assert.equal(hasOtherAttendees(event()), false);
  assert.equal(hasOtherAttendees(event({ attendees: "[]", attendees_count: 0 })), false);
});

test("hasOtherAttendees hides events where the user is the only attendee", async () => {
  const { hasOtherAttendees } = await load();
  const solo = event({
    attendees: JSON.stringify([attendee("me@example.com", true)]),
    attendees_count: 1,
  });
  assert.equal(hasOtherAttendees(solo), false);
});

test("hasOtherAttendees keeps events with at least one other person", async () => {
  const { hasOtherAttendees } = await load();
  const meeting = event({
    attendees: JSON.stringify([attendee("me@example.com", true), attendee("them@example.com")]),
    attendees_count: 2,
  });
  assert.equal(hasOtherAttendees(meeting), true);
});

test("hasOtherAttendees falls back to attendees_count when the list is missing or malformed", async () => {
  const { hasOtherAttendees } = await load();
  assert.equal(hasOtherAttendees(event({ attendees: null, attendees_count: 3 })), true);
  assert.equal(hasOtherAttendees(event({ attendees: "{not json", attendees_count: 3 })), true);
  assert.equal(hasOtherAttendees(event({ attendees: null, attendees_count: 1 })), false);
});

test("parseAttendees returns an empty list for malformed JSON", async () => {
  const { parseAttendees } = await load();
  assert.deepEqual(parseAttendees(event({ attendees: "nope" })), []);
  assert.deepEqual(parseAttendees(event({ attendees: '{"a":1}' })), []);
});
