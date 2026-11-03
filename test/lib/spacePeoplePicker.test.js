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

test("picked people stay listed with a check, and hidden people don't show", () => {
  const picked = [
    { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" },
    { kind: "group", teamId: "sales", label: "Sales", memberCount: 5 },
  ];
  const results = search("", { picked });
  // Nobody leaves the list for being picked; the row says so, so choosing it again can take it back.
  assert.deepEqual(names(results), {
    members: ["Ethan", "Saket", "Bob", "ghost@openronnie.com"],
    groups: ["Sales", "Design Team"],
  });
  assert.deepEqual(
    results.members.map((row) => row.picked),
    [true, false, false, false]
  );
  assert.deepEqual(
    results.groups.map((row) => row.picked),
    [true, false]
  );
  // A query keeps them too, and nothing is picked without a chip.
  assert.deepEqual(
    search("sa", { picked }).groups.map((row) => [row.group.name, row.picked]),
    [["Sales", true]]
  );
  assert.ok(search("").members.every((row) => row.picked === false));
  // Only an address staged as a chip is picked; the same person typed by email is a member row.
  assert.equal(search("ethan", { picked }).members[0].picked, true);

  assert.deepEqual(names(search("", { hiddenUserIds: new Set(["saket"]) })).members, [
    "Ethan",
    "Bob",
    "ghost@openronnie.com",
  ]);
  // A hidden person is gone even when picked.
  assert.deepEqual(names(search("", { picked, hiddenUserIds: new Set(["ethan"]) })).members, [
    "Saket",
    "Bob",
    "ghost@openronnie.com",
  ]);

  // The ones left out don't use up a place in the eight.
  const crowd = Array.from({ length: 9 }, (_, index) => member(`m${index}`, `Person ${index}`));
  const crowded = pickerResults({
    query: "",
    roster: crowd,
    groups: [],
    picked: [],
    hiddenUserIds: new Set(["m0"]),
    canInvite: false,
    ...NO_ACCESS,
  });
  assert.equal(crowded.members.length, 8);
  assert.equal(crowded.members[0].member.user_id, "m1");
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

test("an address with a pending invitation is shown as pending, not offered again", () => {
  const pendingEmails = new Set(["clark@gmail.com"]);
  const pending = search("clark@gmail.com", { pendingEmails });
  assert.equal(pending.inviteEmail, null);
  assert.equal(pending.pendingInvite, "clark@gmail.com");
  assert.equal(pending.noResults, false, "there is a row to show");
  assert.deepEqual(names(pending), { members: [], groups: [] });

  // As typed, in any capitalisation and with spaces around it.
  assert.equal(search("  Clark@Gmail.com ", { pendingEmails }).pendingInvite, "Clark@Gmail.com");
  // Whoever can't invite still sees that the invitation is there.
  const cannotInvite = search("clark@gmail.com", { pendingEmails, canInvite: false });
  assert.equal(cannotInvite.pendingInvite, "clark@gmail.com");
  // Other addresses are unaffected, and so is a list that has no pending set.
  assert.equal(search("alex@example.com", { pendingEmails }).pendingInvite, null);
  assert.equal(search("alex@example.com", { pendingEmails }).inviteEmail, "alex@example.com");
  assert.equal(search("clark@gmail.com").pendingInvite, null);
  assert.equal(search("clark@gmail.com").inviteEmail, "clark@gmail.com");
  // A roster member is that member, whatever else is pending for the address.
  const member = search("ethan@openronnie.com", {
    pendingEmails: new Set(["ethan@openronnie.com"]),
  });
  assert.equal(member.pendingInvite, null);
  assert.deepEqual(names(member).members, ["Ethan"]);
  // Half an address is nobody's invitation.
  assert.equal(search("clark@gmail", { pendingEmails }).pendingInvite, null);
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
  const alex = { kind: "email", email: "alex@x.io", role: "admin", valid: true };

  assert.deepEqual(addRecipients([ethan], [ethan, sales, sales]), [ethan, sales]);
  // Someone who already has access, or is hidden, can't be added by typing their address.
  assert.deepEqual(addRecipients([], [ethan, sales], { accessUserIds: new Set(["ethan"]) }), [
    sales,
  ]);
  assert.deepEqual(addRecipients([], [ethan], { hiddenUserIds: new Set(["ethan"]) }), []);
  const same = [ethan];
  assert.equal(addRecipients(same, [ethan]), same, "nothing new keeps the list as it was");
});

test("an address already staged keeps its role unless the role is chosen again on purpose", () => {
  const admin = { kind: "email", email: "alex@x.io", role: "admin", valid: true };
  const member = { ...admin, role: "member" };

  // Typing it again, or pasting it, is not a change of mind: it never downgrades an admin.
  const same = [admin];
  assert.equal(addRecipients(same, [member]), same);
  // Choosing a role for it on its row is.
  assert.deepEqual(addRecipients(same, [member], { replaceRole: true }), [member]);
  assert.deepEqual(addRecipients([member], [admin], { replaceRole: true }), [admin]);
  // The same role changes nothing, even when asked to replace.
  assert.equal(addRecipients(same, [admin], { replaceRole: true }), same);
});

test("an address with a pending invitation is never staged again", () => {
  const pending = new Set(["clark@gmail.com"]);
  const clark = { kind: "email", email: "clark@gmail.com", role: "member", valid: true };
  const alex = { kind: "email", email: "alex@x.io", role: "member", valid: true };
  assert.deepEqual(addRecipients([], [clark, alex], { pendingEmails: pending }), [alex]);
  // A member is not held back by an unrelated pending address.
  const ethan = { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" };
  assert.deepEqual(addRecipients([], [ethan], { pendingEmails: pending }), [ethan]);
});

test("recipientsFromText gives every new address the role shown, never a member's", () => {
  assert.deepEqual(recipientsFromText("a@x.io; ethan@openronnie.com", ROSTER, "admin"), [
    { kind: "email", email: "a@x.io", role: "admin", valid: true },
    { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" },
  ]);
  assert.equal(recipientsFromText("a@x.io", ROSTER)[0].role, "member", "Member by default");
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
