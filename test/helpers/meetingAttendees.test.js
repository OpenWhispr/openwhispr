const test = require("node:test");
const assert = require("node:assert/strict");

const { hasOtherAttendees } = require("../../src/helpers/meetingAttendees");

test("returns false for missing event or absent attendees", () => {
  assert.equal(hasOtherAttendees(null), false);
  assert.equal(hasOtherAttendees({}), false);
  assert.equal(hasOtherAttendees({ attendees: null }), false);
});

test("returns false for an empty attendee list", () => {
  assert.equal(hasOtherAttendees({ attendees: "[]" }), false);
});

test("returns false when you are the only attendee", () => {
  assert.equal(
    hasOtherAttendees({ attendees: JSON.stringify([{ email: "me@x.com", self: true }]) }),
    false
  );
});

test("returns true when an attendee other than you is present", () => {
  assert.equal(
    hasOtherAttendees({
      attendees: JSON.stringify([
        { email: "me@x.com", self: true },
        { email: "them@x.com", self: false },
      ]),
    }),
    true
  );
});

test("treats attendees without a self flag as others", () => {
  assert.equal(
    hasOtherAttendees({ attendees: JSON.stringify([{ email: "them@x.com" }]) }),
    true
  );
});

test("falls back to attendees_count when the blob is unparseable", () => {
  assert.equal(hasOtherAttendees({ attendees: "not json", attendees_count: 2 }), true);
  assert.equal(hasOtherAttendees({ attendees: "not json", attendees_count: 1 }), false);
  assert.equal(hasOtherAttendees({ attendees: "not json" }), false);
});

test("returns false when the parsed blob is not an array", () => {
  assert.equal(hasOtherAttendees({ attendees: JSON.stringify({ email: "them@x.com" }) }), false);
});
