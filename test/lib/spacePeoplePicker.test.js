const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addRecipients,
  pickedSummary,
  pickerResults,
  recipientKey,
  recipientsFromText,
} = require("../../src/lib/spacePeoplePicker.ts");

const member = (userId, name, email = `${userId}@openronnie.com`) => ({
  user_id: userId,
  role: "member",
  joined_at: "2026-01-01T00:00:00Z",
  email,
  name,
  image: null,
});

const group = (id, name, memberCount = 2) => ({
  id,
  workspace_id: "w1",
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  member_count: memberCount,
});

const ROSTER = [
  member("ethan", "Ethan"),
  member("saket", "Saket"),
  member("bob", "Bob", "bov@openronnie.com"),
  member("nameless", null, "ghost@openronnie.com"),
];
const GROUPS = [group("sales", "Sales", 5), group("design", "Design Team", 2)];

const NO_ACCESS = { accessUserIds: new Set(), accessGroupIds: new Set() };

const search = (query, overrides = {}) =>
  pickerResults({
    query,
    roster: ROSTER,
    groups: GROUPS,
    picked: [],
    canInvite: true,
    ...NO_ACCESS,
    ...overrides,
  });

const names = (results) => ({
  members: results.members.map(({ member: person }) => person.name ?? person.email),
  groups: results.groups.map(({ group: found }) => found.name),
});

test("a query finds members and groups, members first", () => {
  assert.deepEqual(names(search("sa")), { members: ["Saket"], groups: ["Sales"] });
  // Case does not matter, and members also match by email.
  assert.deepEqual(names(search("ETHAN")), { members: ["Ethan"], groups: [] });
  assert.deepEqual(names(search("bov@")), { members: ["Bob"], groups: [] });
  // A group is found by its name only, not by its slug or description.
  assert.deepEqual(names(search("design")), { members: [], groups: ["Design Team"] });
  const support = { ...group("cs", "CS"), slug: "customer-success", description: "Customer care" };
  assert.deepEqual(names(search("customer", { groups: [...GROUPS, support] })), {
    members: [],
    groups: [],
  });
  assert.deepEqual(names(search("openronnie")), {
    members: ["Ethan", "Saket", "Bob", "ghost@openronnie.com"],
    groups: [],
  });
  assert.equal(search("sa").noResults, false);
});

test("an empty query lists the first of each, at most eight", () => {
  const crowd = Array.from({ length: 12 }, (_, index) => member(`m${index}`, `Person ${index}`));
  const teams = Array.from({ length: 10 }, (_, index) => group(`g${index}`, `Group ${index}`));
  for (const query of ["", "  ", "r"]) {
    const results = pickerResults({
      query,
      roster: crowd,
      groups: teams,
      picked: [],
      canInvite: true,
      ...NO_ACCESS,
    });
    assert.equal(results.members.length, 8);
    assert.equal(results.groups.length, 8);
    assert.equal(results.members[0].member.user_id, "m0");
    assert.equal(results.groups[0].group.id, "g0");
  }
});

test("picked and hidden people don't show again", () => {
  const picked = [
    { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" },
    { kind: "group", teamId: "sales", label: "Sales", memberCount: 5 },
  ];
  assert.deepEqual(names(search("", { picked })), {
    members: ["Saket", "Bob", "ghost@openronnie.com"],
    groups: ["Design Team"],
  });
  assert.deepEqual(names(search("", { hiddenUserIds: new Set(["saket"]) })).members, [
    "Ethan",
    "Bob",
    "ghost@openronnie.com",
  ]);

  // The ones left out don't use up a place in the eight.
  const crowd = Array.from({ length: 9 }, (_, index) => member(`m${index}`, `Person ${index}`));
  const results = pickerResults({
    query: "",
    roster: crowd,
    groups: [],
    picked: [],
    hiddenUserIds: new Set(["m0"]),
    canInvite: false,
    ...NO_ACCESS,
  });
  assert.equal(results.members.length, 8);
  assert.equal(results.members[0].member.user_id, "m1");
});

test("someone with access shows disabled, a group with its count", () => {
  const results = search("", {
    accessUserIds: new Set(["ethan"]),
    accessGroupIds: new Set(["sales"]),
  });
  const flags = (rows, pick) => Object.fromEntries(rows.map((row) => [pick(row), row.hasAccess]));
  assert.deepEqual(
    flags(results.members, (row) => row.member.user_id),
    { ethan: true, saket: false, bob: false, nameless: false }
  );
  assert.deepEqual(
    flags(results.groups, (row) => row.group.id),
    { sales: true, design: false }
  );
  // The row carries the group itself, so the list can say how many people it holds.
  assert.equal(results.groups[0].group.member_count, 5);
});

test("an address with no match offers an invite only to those who can", () => {
  assert.equal(search("alex@example.com").inviteEmail, "alex@example.com");
  assert.equal(search("  alex@example.com  ").inviteEmail, "alex@example.com");
  assert.equal(search("alex@example.com", { canInvite: false }).inviteEmail, null);
  // A roster address is that member, in any capitalisation, not someone to invite.
  assert.equal(search("Ethan@OpenRonnie.com").inviteEmail, null);
  assert.deepEqual(names(search("Ethan@OpenRonnie.com")).members, ["Ethan"]);
  // Half an address isn't one.
  assert.equal(search("alex@").inviteEmail, null);
  assert.equal(search("alex").inviteEmail, null);
});

test("no results tell the inviter they can enter an address, and others they can't", () => {
  for (const canInvite of [true, false]) {
    const results = search("Research", { canInvite });
    assert.equal(results.noResults, true);
    assert.equal(results.inviteEmail, null);
    assert.deepEqual(names(results), { members: [], groups: [] });
  }
  // An invite row, or any match, is something to show instead.
  assert.equal(search("alex@example.com").noResults, false);
  assert.equal(search("alex@example.com", { canInvite: false }).noResults, true);
  assert.equal(search("sa").noResults, false);
});

test("a member's address resolves to the member, in any capitalisation", () => {
  assert.deepEqual(recipientsFromText("ETHAN@OpenRonnie.com", ROSTER), [
    { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" },
  ]);
  // A member with no name is labelled by address.
  assert.deepEqual(recipientsFromText("Ghost@openronnie.com", ROSTER), [
    {
      kind: "member",
      userId: "nameless",
      label: "ghost@openronnie.com",
      email: "ghost@openronnie.com",
    },
  ]);
  assert.deepEqual(recipientsFromText("Ethan <ETHAN@openronnie.com>", ROSTER)[0].userId, "ethan");
});

test("pasting a list makes one recipient each", () => {
  const expected = [
    { kind: "email", email: "a@x.io", role: "member", valid: true },
    { kind: "email", email: "b@y.io", role: "member", valid: true },
    { kind: "email", email: "bad", role: "member", valid: false },
  ];
  assert.deepEqual(recipientsFromText("Name <a@x.io>, b@y.io; bad", []), expected);
  // The commas people type in Arabic and in Chinese or Japanese split like the Latin one.
  assert.deepEqual(recipientsFromText("a@x.io، b@y.io، bad", []), expected);
  assert.deepEqual(recipientsFromText("Name <a@x.io>， b@y.io、bad", []), expected);
  // A pasted column, and the same address twice.
  assert.deepEqual(recipientsFromText("a@x.io\nb@y.io\r\nbad\n\nA@X.io", []), expected);
  assert.deepEqual(recipientsFromText("  ", []), []);

  // Members in the list are resolved, the rest are addresses.
  assert.deepEqual(
    recipientsFromText("ethan@openronnie.com, a@x.io", ROSTER).map((recipient) => recipient.kind),
    ["member", "email"]
  );
});

test("an address the server would refuse reads as invalid", () => {
  const tooLong = `${"a".repeat(320)}@x.io`;
  assert.equal(recipientsFromText(tooLong, [])[0].valid, false);
});

test("pickedSummary splits the three kinds, keeps roles and flags invalid ones", () => {
  const picked = [
    { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" },
    { kind: "group", teamId: "sales", label: "Sales", memberCount: 5 },
    { kind: "email", email: "a@x.io", role: "admin", valid: true },
    { kind: "email", email: "b@y.io", role: "member", valid: true },
    { kind: "member", userId: "saket", label: "Saket", email: "saket@openronnie.com" },
    { kind: "group", teamId: "design", label: "Design Team", memberCount: 2 },
  ];
  assert.deepEqual(pickedSummary(picked), {
    memberIds: ["ethan", "saket"],
    teamIds: ["sales", "design"],
    emails: [
      { email: "a@x.io", role: "admin" },
      { email: "b@y.io", role: "member" },
    ],
    hasInvalid: false,
  });

  const withInvalid = pickedSummary([
    ...picked,
    { kind: "email", email: "bad", role: "member", valid: false },
  ]);
  assert.equal(withInvalid.hasInvalid, true);
  // An invalid one is never offered to the server as an address to invite.
  assert.deepEqual(
    withInvalid.emails.map((entry) => entry.email),
    ["a@x.io", "b@y.io"]
  );

  assert.deepEqual(pickedSummary([]), {
    memberIds: [],
    teamIds: [],
    emails: [],
    hasInvalid: false,
  });
});

test("adding recipients keeps each one once and skips those who can't be staged", () => {
  const ethan = { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" };
  const sales = { kind: "group", teamId: "sales", label: "Sales", memberCount: 5 };
  const alex = { kind: "email", email: "alex@x.io", role: "member", valid: true };

  assert.deepEqual(addRecipients([ethan], [ethan, sales, sales]), [ethan, sales]);
  // Staging an address again with another role is a change of mind, not a second chip.
  assert.deepEqual(addRecipients([alex], [{ ...alex, role: "admin" }]), [
    { ...alex, role: "admin" },
  ]);
  // Someone who already has access, or is hidden, can't be added by typing their address.
  assert.deepEqual(addRecipients([], [ethan, sales], { accessUserIds: new Set(["ethan"]) }), [
    sales,
  ]);
  assert.deepEqual(addRecipients([], [ethan], { hiddenUserIds: new Set(["ethan"]) }), []);
  const same = [ethan];
  assert.equal(addRecipients(same, [ethan]), same, "nothing new keeps the list as it was");
});

test("each kind of recipient has a key of its own", () => {
  assert.equal(
    new Set([
      recipientKey({ kind: "member", userId: "a", label: "A", email: "a@x.io" }),
      recipientKey({ kind: "group", teamId: "a", label: "A", memberCount: 1 }),
      recipientKey({ kind: "email", email: "a", role: "member", valid: false }),
    ]).size,
    3
  );
});
