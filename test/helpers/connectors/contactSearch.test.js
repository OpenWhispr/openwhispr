const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/contactSearch.js");

const NOW = Date.parse("2026-09-24T12:00:00Z");

function meeting(startTime, attendees, organizer = null, selfIsUser = 1) {
  return {
    start_time: startTime,
    organizer_email: organizer,
    attendees: JSON.stringify(attendees),
    self_is_user: selfIsUser,
  };
}

const ME = { email: "chad@example.com", displayName: "Chad", self: true };

const SOURCES = {
  meetings: [
    meeting("2026-09-20T10:00:00Z", [
      ME,
      { email: "gabe.torres@example.com", displayName: "Gabe Torres" },
    ]),
    meeting("2026-10-20T10:00:00-07:00", [
      ME,
      { email: "gabe.torres@example.com", displayName: "Gabe Torres" },
    ]),
    meeting("2026-09-10T10:00:00Z", [
      ME,
      { email: "gabriel@acme.test", displayName: "Gabriel Stone" },
    ]),
    meeting(
      "2026-09-01T10:00:00Z",
      [ME, { email: "gabe.torres@example.com", displayName: null }],
      "boss@example.com"
    ),
    meeting("2026-10-01T09:00:00Z", [ME, { email: "nora@example.com", displayName: "Nora New" }]),
    meeting("2026-09-23T15:00:00Z", [ME, { email: "sam.lee@example.com", displayName: null }]),
    meeting("2026-08-01T10:00:00Z", [
      ME,
      { email: "room-4@resource.calendar.google.com", displayName: "Room 4" },
      { email: "boardroom@corp.test", displayName: "Boardroom", resource: true },
    ]),
    meeting("2026-07-01T10:00:00Z", [
      ME,
      { email: "zoë.müller@example.de", displayName: "Zoë Müller" },
    ]),
    // The user's own solo event: they are only the organizer, never flagged self.
    meeting("2026-09-22T10:00:00Z", [], "chad.work@corp.test"),
    meeting("2026-12-25T00:00:00Z", [
      {
        email: "en.usa#holiday@group.v.calendar.google.com",
        displayName: "Holidays in United States",
      },
    ]),
    // A colleague's shared Google calendar: Google flags its owner as self.
    meeting(
      "2026-09-25T09:00:00Z",
      [
        { email: "dana@example.com", displayName: "Dana Wu", self: true },
        { email: "chad@example.com", displayName: "Chad" },
      ],
      null,
      0
    ),
    // Addresses outside the account table: an Apple account, a Google alias.
    meeting("2026-09-24T08:00:00Z", [
      { email: "chad@icloud.com", displayName: "Chad", self: true },
    ]),
    meeting("2026-09-24T09:00:00Z", [
      { email: "chad@alias.test", displayName: "Chad", self: true },
    ]),
    { start_time: "2026-06-01T10:00:00Z", organizer_email: null, attendees: "not json" },
  ],
  contacts: [
    // Met months ago: the meeting has aged out of the calendar cache.
    { email: "priya.shah@example.com", display_name: "Priya Shah" },
    { email: "gabe.torres@example.com", display_name: "Gabe Torres" },
    { email: "jean-luc@example.fr", display_name: "Jean-Luc Picard" },
    { email: "miles@example.com", display_name: "Miles O'Brien" },
    { email: "boardroom@corp.test", display_name: "Boardroom" },
  ],
  accountEmails: ["chad@example.com", "Chad.Work@corp.test"],
};

const search = async (query, options = {}) => {
  const { searchContacts } = await load();
  return searchContacts(SOURCES, query, { now: NOW, ...options }).contacts;
};

test("a first name finds every matching person, the nearest meeting first", async () => {
  const results = await search("gab");
  assert.deepEqual(
    results.map((person) => person.email),
    ["gabe.torres@example.com", "gabriel@acme.test"]
  );
  assert.equal(results[0].name, "Gabe Torres");
});

test("lastMet is the most recent past meeting, never an upcoming one", async () => {
  assert.equal((await search("gabe"))[0].lastMet, "2026-09-20T10:00:00Z");
  assert.equal((await search("nora"))[0].lastMet, null);
});

test("people whose meetings aged out of the calendar are still found", async () => {
  const [priya] = await search("priya");
  assert.deepEqual(priya, { name: "Priya Shah", email: "priya.shah@example.com", lastMet: null });
});

test("a full name ranks the exact person first", async () => {
  assert.equal((await search("Gabriel Stone"))[0].email, "gabriel@acme.test");
});

test("the owner of a colleague's shared calendar is still a contact", async () => {
  assert.equal((await search("dana"))[0]?.email, "dana@example.com");
});

test("the user, rooms, resources and holiday calendars never appear", async () => {
  assert.deepEqual(await search("chad"), []);
  assert.deepEqual(await search("room"), []);
  assert.deepEqual(await search("holidays"), []);
});

test("accents, email local parts and spoken name forms match", async () => {
  assert.equal((await search("zoe"))[0].name, "Zoë Müller");
  assert.equal((await search("boss"))[0].email, "boss@example.com");
  assert.equal((await search("sam lee"))[0].email, "sam.lee@example.com");
  assert.equal((await search("jean luc"))[0].name, "Jean-Luc Picard");
  assert.equal((await search("miles o brien"))[0].name, "Miles O'Brien");
  assert.equal((await search("obrien"))[0].name, "Miles O'Brien");
});

test("an empty query and the limit are respected, and a cut-off list says so", async () => {
  const { searchContacts } = await load();
  assert.deepEqual(searchContacts(SOURCES, "   ", { now: NOW }), { contacts: [], hasMore: false });
  const limited = searchContacts(SOURCES, "gab", { now: NOW, limit: 1 });
  assert.equal(limited.contacts.length, 1);
  assert.equal(limited.hasMore, true);
  assert.equal(searchContacts(SOURCES, "priya", { now: NOW }).hasMore, false);
});

test("people seen only in contacts keep the most recently synced first", async () => {
  const { searchContacts } = await load();
  // getContactLookupSources returns contacts newest first.
  const sources = {
    contacts: [
      { email: "josh.recent@example.com", display_name: "Josh Recent" },
      { email: "josh.old@example.com", display_name: "Josh Old" },
    ],
  };
  assert.deepEqual(
    searchContacts(sources, "josh", { now: NOW }).contacts.map((person) => person.email),
    ["josh.recent@example.com", "josh.old@example.com"]
  );
});

test("an all-day meeting starts at local midnight, not UTC midnight", async () => {
  const { searchContacts } = await load();
  const tomorrow = new Date(2026, 8, 25);
  const tomorrowDate = "2026-09-25";
  const sources = {
    meetings: [
      {
        provider: "google",
        start_time: tomorrowDate,
        is_all_day: 1,
        attendees: JSON.stringify([{ email: "offsite@example.com", displayName: "Offsite Host" }]),
      },
    ],
  };
  // An hour before it starts locally it hasn't happened yet, whatever the zone.
  const [host] = searchContacts(sources, "offsite", {
    now: tomorrow.getTime() - 60 * 60 * 1000,
  }).contacts;
  assert.equal(host.lastMet, null);
  const [later] = searchContacts(sources, "offsite", {
    now: tomorrow.getTime() + 60 * 60 * 1000,
  }).contacts;
  assert.equal(later.lastMet, tomorrowDate);
});

test("a typed address ranks its owner first", async () => {
  const { searchContacts } = await load();
  const sources = {
    meetings: [meeting("2026-09-24T11:00:00Z", [{ email: "sal@x.test", displayName: "Sal Z" }])],
    contacts: [{ email: "al@x.test", display_name: "Al Gore" }],
  };
  const { contacts } = searchContacts(sources, "AL@x.test", { now: NOW });
  assert.equal(contacts[0].email, "al@x.test");
});

test("the domain only matches once the query has an @", async () => {
  const sources = { contacts: [{ email: "chad@alias.test", display_name: "Chad" }] };
  const { searchContacts } = await load();
  assert.deepEqual(searchContacts(sources, "al", { now: NOW }).contacts, []);
  assert.equal(searchContacts(sources, "chad@alias", { now: NOW }).contacts.length, 1);
});

test("equal matches rank the nearest meeting first, whatever order they were seen in", async () => {
  const { searchContacts } = await load();
  const sources = {
    meetings: [
      meeting("2026-08-01T10:00:00Z", [{ email: "josh.far@example.com", displayName: "Josh Far" }]),
      meeting("2026-09-25T10:00:00Z", [
        { email: "josh.near@example.com", displayName: "Josh Near" },
      ]),
    ],
  };
  assert.deepEqual(
    searchContacts(sources, "josh", { now: NOW }).contacts.map((person) => person.email),
    ["josh.near@example.com", "josh.far@example.com"]
  );
});
