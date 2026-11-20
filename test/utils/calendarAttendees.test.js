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
  assert.equal(hasOtherAttendees(event({ attendees: "[null,null]", attendees_count: 2 })), true);
});

test("parseAttendees returns an empty list for malformed JSON", async () => {
  const { parseAttendees } = await load();
  assert.deepEqual(parseAttendees(event({ attendees: "nope" })), []);
  assert.deepEqual(parseAttendees(event({ attendees: '{"a":1}' })), []);
});

test("attendee policy inspects every human invitee and requires a complete linked roster", async () => {
  const { hasExternalAttendees } = await load();
  const { meetingAttendeeVerdict } = require("../../src/helpers/meetingAttendeePolicy.js");
  const policy = { externalAttendees: "blocked", internalDomains: ["Example.Com"] };
  const check = (row, verdict) => {
    assert.equal(meetingAttendeeVerdict(row, policy), verdict, JSON.stringify(row));
    assert.equal(hasExternalAttendees(row, policy.internalDomains), verdict === "external");
  };
  const roster = (...rows) =>
    event({ attendees: JSON.stringify(rows), attendees_count: rows.length });
  check(event(), "allow");
  check(roster(), "allow");
  check(roster(attendee("ME@EXAMPLE.COM"), attendee("alex@deep.sub.example.com")), "allow");
  check(roster({ resource: true }), "allow");
  check(
    roster(attendee("me@example.com"), { email: "x@notexample.com", responseStatus: "declined" }),
    "external"
  );
  check(roster(null, attendee("known@outside.org")), "external");
  for (const row of [
    roster(null),
    roster({ email: null }),
    roster({ email: "a@b@example.com" }),
    event({ attendees_count: 2 }),
    event({ attendees: "{" }),
    event({ attendees: "{}" }),
    event({ attendees: "[]", attendees_count: 3 }),
    event({ attendees_omitted: 1 }),
  ]) {
    check(row, "unverifiable");
  }
  assert.equal(meetingAttendeeVerdict(null, policy), "confirm");
  assert.equal(meetingAttendeeVerdict(null, {}), "allow");
  assert.equal(
    meetingAttendeeVerdict(roster(attendee("a@example.com")), { externalAttendees: "future" }),
    "external"
  );
  assert.equal(
    meetingAttendeeVerdict(event({ attendees: "{" }), { externalAttendees: "allowed" }),
    "allow"
  );
});

test("displaying an unreadable roster skips entries without a usable email", async () => {
  const { parseAttendees, hasOtherAttendees } = await load();
  const row = event({ attendees: '[null,{"email":null}]', attendees_count: 2 });
  assert.deepEqual(parseAttendees(row), []);
  assert.equal(hasOtherAttendees(row), true);
  assert.equal(
    hasOtherAttendees(
      event({
        attendees: '[{"email":"me@corp.com","self":true},{"email":null}]',
        attendees_count: 2,
      })
    ),
    true
  );
});

test("a hidden guest list still appears in Upcoming meetings", async () => {
  const { hasOtherAttendees } = await load();
  const hidden = event({
    attendees: JSON.stringify([attendee("me@example.com", true)]),
    attendees_count: 1,
    attendees_omitted: 1,
  });
  assert.equal(hasOtherAttendees(hidden), true);
});

test("a human organizer omitted from the roster counts, while a resource organizer is exempt", async () => {
  const { hasExternalAttendees } = await load();
  const organizer = "Host@outside.com";
  const domains = ["corp.com"];
  const invite = (attendees) =>
    event({ organizer_email: organizer, attendees: JSON.stringify(attendees) });
  assert.equal(hasExternalAttendees(invite([attendee("employee@corp.com")]), domains), true);
  assert.equal(
    hasExternalAttendees(invite([{ resource: true, email: organizer.toLowerCase() }]), domains),
    false
  );
});

test("a Google group calendar organizer does not make an internal meeting external", async () => {
  const { hasExternalAttendees } = await load();
  const row = event({
    organizer_email: "engineering@group.calendar.google.com",
    attendees: '[{"email":"lead@corp.com"}]',
  });
  assert.equal(hasExternalAttendees(row, ["corp.com"]), false);
  assert.equal(
    hasExternalAttendees({ ...row, organizer_email: "host@calendar.google.com.outside.net" }, [
      "corp.com",
    ]),
    true
  );
});

test("Upcoming keeps a one-on-one with a separate human organizer", async () => {
  const { hasOtherAttendees } = await load();
  const selfOnly = event({
    attendees: JSON.stringify([attendee("Me@example.com", true)]),
    attendees_count: 1,
  });
  assert.equal(hasOtherAttendees({ ...selfOnly, organizer_email: "guest@outside.com" }), true);
  assert.equal(hasOtherAttendees({ ...selfOnly, organizer_email: " me@EXAMPLE.com " }), false);
  assert.equal(
    hasOtherAttendees({ ...selfOnly, organizer_email: "room@resource.calendar.google.com" }),
    false
  );
  assert.equal(hasOtherAttendees(event({ organizer_email: "me@example.com" })), false);
});

test("Upcoming keeps a one-on-one with a guest whose address is unavailable", async () => {
  const { hasOtherAttendees, parseAttendees } = await load();
  const guest = { email: null, displayName: "Alex", self: false };
  const row = event({
    attendees: JSON.stringify([guest]),
    attendees_count: 1,
    organizer_email: "me@example.com",
    organizer_self: 1,
  });
  assert.deepEqual(parseAttendees(row), []);
  assert.equal(hasOtherAttendees(row), true);
  assert.equal(
    hasOtherAttendees({ ...row, attendees: JSON.stringify([{ ...guest, self: true }]) }),
    false
  );
});

test("policy skips non-person Google calendar entries wherever the provider lists them", async () => {
  const { meetingAttendeeVerdict } = require("../../src/helpers/meetingAttendeePolicy.js");
  const policy = { externalAttendees: "blocked", internalDomains: ["corp.test"] };
  const calendar = "engineering@group.calendar.google.com";
  const row = (guests) =>
    event({
      attendees_count: guests.length,
      attendees: JSON.stringify(guests.map((email) => ({ email }))),
      organizer_email: calendar,
    });
  assert.equal(meetingAttendeeVerdict(row(["employee@corp.test", calendar]), policy), "allow");
  assert.equal(meetingAttendeeVerdict(row([calendar, "visitor@outside.test"]), policy), "external");
  assert.equal(
    meetingAttendeeVerdict(row(["room@calendar.google.com.outside.test"]), policy),
    "external"
  );
});
