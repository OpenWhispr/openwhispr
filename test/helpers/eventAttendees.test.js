const test = require("node:test");
const assert = require("node:assert/strict");

const { tagEventAttendeesJson } = require("../../src/helpers/eventAttendees.js");

test("tagEventAttendeesJson tags every guest with the event that added them, but not the user", () => {
  const attendees = [
    { email: "dana@x.com", displayName: "Dana", responseStatus: "accepted", self: false },
    { email: "me@x.com", displayName: "Me", responseStatus: "accepted", self: true },
  ];

  assert.deepEqual(
    JSON.parse(tagEventAttendeesJson(JSON.stringify(attendees), "evt-1")),
    [{ ...attendees[0], addedByEvent: "evt-1" }, attendees[1]],
    "the user recorded the note, so removing the event keeps their own row"
  );
});

test("tagEventAttendeesJson leaves rooms and declined guests off the note, never the user", () => {
  const dana = { email: "dana@x.com", displayName: "Dana", responseStatus: null, self: false };
  const attendees = [
    dana,
    {
      email: "room@resource.calendar.google.com",
      displayName: "Room 4",
      self: false,
      resource: true,
    },
    { email: "kim@x.com", displayName: "Kim", responseStatus: "declined", self: false },
    // The user records the note even when their RSVP says no.
    { email: "me@x.com", displayName: "Me", responseStatus: "declined", self: true },
  ];

  assert.deepEqual(JSON.parse(tagEventAttendeesJson(JSON.stringify(attendees), "evt-1")), [
    { ...dana, addedByEvent: "evt-1" },
    attendees[3],
  ]);
});

test("tagEventAttendeesJson leaves missing or unreadable attendees as they are", () => {
  assert.equal(tagEventAttendeesJson(null, "evt-1"), null);
  assert.equal(tagEventAttendeesJson("[]", null), "[]");
  assert.equal(tagEventAttendeesJson("not json", "evt-1"), "not json");
  assert.equal(tagEventAttendeesJson('{"email":"a@x.com"}', "evt-1"), '{"email":"a@x.com"}');
});
