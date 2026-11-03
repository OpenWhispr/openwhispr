const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_INVITE_RECIPIENTS,
  createInviteFlow,
  inviteReducer,
  inviteSummary,
  inviteSuggestions,
} = require("../../src/lib/inviteFlow.ts");

const run = (state, ...events) => events.reduce(inviteReducer, state);
const emails = (state) => state.recipients.map((recipient) => recipient.email);
const statuses = (state) => state.recipients.map((recipient) => recipient.state.status);
const fresh = () => createInviteFlow({});
const commitText = (state, text) => run(state, { type: "draft", text }, { type: "commit" });

test("typing a comma, semicolon or space turns the text before it into a chip", () => {
  for (const separator of [",", ";", " "]) {
    const state = run(fresh(), { type: "draft", text: `a@x.com${separator}` });
    assert.deepEqual(emails(state), ["a@x.com"]);
    assert.equal(state.draft, "");
  }
});

test("a paste with several separators commits all but the trailing fragment", () => {
  const state = run(fresh(), { type: "draft", text: "a@x.com, b@y.io, c" });
  assert.deepEqual(emails(state), ["a@x.com", "b@y.io"]);
  assert.equal(state.draft, "c");
});

test("adding text splits on commas, spaces and semicolons and drops duplicates", () => {
  const state = commitText(fresh(), "A@x.com; a@X.com  b@y.io,");
  assert.deepEqual(emails(state), ["a@x.com", "b@y.io"]);
  assert.equal(state.draft, "");
});

test("committed text is trimmed, lowercased and stripped of empty parts", () => {
  const state = commitText(fresh(), "  A@x.com,, ;B@Y.io \n");
  assert.deepEqual(emails(state), ["a@x.com", "b@y.io"]);
  assert.deepEqual(statuses(state), ["draft", "draft"]);
});

test("a pasted Name <address> becomes its address", () => {
  const gmail = run(fresh(), { type: "draft", text: "Jane Doe <Jane@x.com>, bob@x.com" });
  assert.deepEqual(emails(gmail), ["jane@x.com"]);
  assert.equal(gmail.draft, "bob@x.com");

  // Outlook copies "Last, First <address>", whose comma isn't a separator.
  const outlook = run(fresh(), {
    type: "draft",
    text: "Doe, Jane <jane@x.com>; Roe, Bob <bob@x.com>",
  });
  assert.deepEqual(emails(outlook), ["jane@x.com", "bob@x.com"]);
  assert.equal(outlook.draft, "");
});

test("Arabic and CJK commas separate addresses", () => {
  for (const comma of ["،", "，", "、"]) {
    const state = run(fresh(), { type: "draft", text: `a@x.com${comma} b@y.io` });
    assert.deepEqual(emails(state), ["a@x.com"]);
    assert.deepEqual(statuses(state), ["draft"]);
    assert.equal(state.draft, "b@y.io");
  }
});

test("a space only ends an address, so a name can be typed to search contacts", () => {
  const typing = run(fresh(), { type: "draft", text: "Jane Smith" });
  assert.deepEqual(emails(typing), []);
  assert.equal(typing.draft, "Jane Smith");

  const half = run(fresh(), { type: "draft", text: "Jane <jane@x" });
  assert.deepEqual(emails(half), []);

  // Committed, a stray name is one chip to remove rather than one per word.
  assert.deepEqual(statuses(commitText(fresh(), "Jane Smith")), ["invalid"]);
  assert.deepEqual(emails(commitText(fresh(), "a@x.com b@y.io")), ["a@x.com", "b@y.io"]);
});

test("a malformed address becomes an invalid chip and blocks sending", () => {
  const state = commitText(fresh(), "sam@acme");
  assert.deepEqual(statuses(state), ["invalid"]);
  const summary = inviteSummary(state);
  assert.equal(summary.canSend, false);
  assert.equal(summary.invalid.length, 1);
});

test("a current member is flagged before sending", () => {
  const state = commitText(
    run(fresh(), { type: "roster", memberEmails: ["sam@acme.test"], invitedEmails: [] }),
    "Sam@acme.test"
  );
  assert.deepEqual(state.recipients[0].state, { status: "blocked", reason: "alreadyMember" });
  assert.equal(inviteSummary(state).canSend, false);
});

test("a pending invitation is flagged before sending", () => {
  const state = commitText(
    run(fresh(), { type: "roster", memberEmails: [], invitedEmails: ["pat@acme.test"] }),
    "pat@acme.test"
  );
  assert.deepEqual(state.recipients[0].state, { status: "blocked", reason: "alreadyInvited" });
  assert.equal(inviteSummary(state).blocked.length, 1);
});

test("the roster arriving later flags chips already added", () => {
  const added = commitText(fresh(), "sam@acme.test pat@acme.test new@acme.test");
  assert.deepEqual(statuses(added), ["draft", "draft", "draft"]);
  const state = run(added, {
    type: "roster",
    memberEmails: ["SAM@acme.test"],
    invitedEmails: ["pat@acme.test"],
  });
  assert.deepEqual(statuses(state), ["blocked", "blocked", "draft"]);
  assert.deepEqual(state.memberEmails, ["sam@acme.test"]);
});

test("more than 20 recipients blocks sending", () => {
  const many = Array.from({ length: MAX_INVITE_RECIPIENTS + 1 }, (_, index) => `p${index}@x.com`);
  const state = commitText(fresh(), many.join(" "));
  const summary = inviteSummary(state);
  assert.equal(summary.tooMany, true);
  assert.equal(summary.canSend, false);
  assert.equal(run(state, { type: "send" }).phase, "editing");
});

test("a valid address typed after 20 chips counts toward the cap", () => {
  const twenty = Array.from({ length: MAX_INVITE_RECIPIENTS }, (_, index) => `p${index}@x.com`);
  const state = run(commitText(fresh(), twenty.join(" ")), { type: "draft", text: "extra@x.com" });
  const summary = inviteSummary(state);
  assert.equal(summary.tooMany, true);
  assert.equal(summary.canSend, false);
});

test("only failures that sending again could fix are sent again", () => {
  const kinds = ["seatLimit", "notAllowed", "directoryRequired", "sessionExpired", "requestFailed"];
  const addresses = kinds.map((kind) => `${kind.toLowerCase()}@x.com`);
  let state = run(commitText(fresh(), addresses.join(" ")), { type: "send" });
  state = run(
    state,
    ...kinds.map((kind, index) => ({
      type: "result",
      email: addresses[index],
      outcome: { ok: false, kind },
    })),
    { type: "finished" }
  );
  assert.deepEqual(inviteSummary(state).sendable, ["sessionexpired@x.com", "requestfailed@x.com"]);
});

test("removing a chip clears tooMany when back under the cap", () => {
  const many = Array.from({ length: MAX_INVITE_RECIPIENTS + 1 }, (_, index) => `p${index}@x.com`);
  const state = run(commitText(fresh(), many.join(" ")), { type: "remove", email: "P0@x.com" });
  const summary = inviteSummary(state);
  assert.equal(summary.tooMany, false);
  assert.equal(summary.canSend, true);
});

test("removing an address that is not a chip changes nothing", () => {
  const state = commitText(fresh(), "a@x.com");
  assert.deepEqual(run(state, { type: "remove", email: "z@x.com" }), state);
});

test("a typed draft that is not yet an address blocks sending until committed", () => {
  const state = run(fresh(), { type: "draft", text: "sam@ac" });
  assert.equal(inviteSummary(state).canSend, false);
  const valid = run(fresh(), { type: "draft", text: "sam@acme.test" });
  assert.equal(inviteSummary(valid).canSend, true);
  assert.deepEqual(inviteSummary(valid).sendable, ["sam@acme.test"]);
});

test("send commits the text still in the field", () => {
  const state = run(fresh(), { type: "draft", text: "a@x.com" }, { type: "send" });
  assert.equal(state.phase, "sending");
  assert.equal(state.draft, "");
  assert.deepEqual(state.recipients, [{ email: "a@x.com", state: { status: "sending" } }]);
});

test("send with an invalid field text turns it into an invalid chip and stays editing", () => {
  const state = run(fresh(), { type: "draft", text: "sam@ac" }, { type: "send" });
  assert.equal(state.phase, "editing");
  assert.deepEqual(statuses(state), ["invalid"]);
});

test("add puts a picked suggestion in as a chip once", () => {
  const state = run(
    fresh(),
    { type: "add", email: "Sam@acme.test" },
    { type: "add", email: "sam@acme.test" }
  );
  assert.deepEqual(emails(state), ["sam@acme.test"]);
});

test("a half-typed initial email stays in the field to finish", () => {
  const state = createInviteFlow({ initialEmail: "john@acme" });
  assert.deepEqual(emails(state), []);
  assert.equal(state.draft, "john@acme");
});

test("the initial email starts as a chip", () => {
  const state = createInviteFlow({ initialEmail: "Sam@Acme.test" });
  assert.deepEqual(emails(state), ["sam@acme.test"]);
  assert.equal(state.draft, "");
  assert.equal(state.role, "member");
  assert.equal(state.phase, "editing");
});

test("retry sends only the failed recipients", () => {
  let state = run(commitText(fresh(), "a@x.com b@y.io"), { type: "send" });
  state = run(
    state,
    { type: "result", email: "a@x.com", outcome: { ok: true, emailSent: true } },
    { type: "result", email: "b@y.io", outcome: { ok: false, kind: "requestFailed" } },
    { type: "finished" }
  );
  assert.equal(state.phase, "editing");
  assert.deepEqual(state.recipients, [
    { email: "b@y.io", state: { status: "failed", kind: "requestFailed" } },
  ]);
  assert.deepEqual(state.sent, [{ email: "a@x.com", emailSent: true }]);
  assert.deepEqual(inviteSummary(state).sendable, ["b@y.io"]);

  state = run(state, { type: "send" });
  assert.equal(state.phase, "sending");
  assert.deepEqual(statuses(state), ["sending"]);
  assert.deepEqual(state.sent, [{ email: "a@x.com", emailSent: true }]);
});

test("an already-invited answer from the server blocks that chip instead of offering retry", () => {
  let state = run(commitText(fresh(), "a@x.com b@y.io c@z.org"), { type: "send" });
  state = run(
    state,
    { type: "result", email: "a@x.com", outcome: { ok: false, kind: "alreadyInvited" } },
    { type: "result", email: "b@y.io", outcome: { ok: false, kind: "alreadyMember" } },
    { type: "result", email: "c@z.org", outcome: { ok: false, kind: "invalid" } },
    { type: "finished" }
  );
  assert.deepEqual(
    state.recipients.map((recipient) => recipient.state),
    [
      { status: "blocked", reason: "alreadyInvited" },
      { status: "blocked", reason: "alreadyMember" },
      { status: "invalid" },
    ]
  );
  const summary = inviteSummary(state);
  assert.deepEqual(summary.failed, []);
  assert.equal(summary.canSend, false);
});

test("all sent moves to done", () => {
  let state = run(commitText(fresh(), "a@x.com b@y.io"), { type: "send" });
  state = run(
    state,
    { type: "result", email: "a@x.com", outcome: { ok: true, emailSent: true } },
    { type: "result", email: "b@y.io", outcome: { ok: true, emailSent: false } },
    { type: "finished" }
  );
  assert.equal(state.phase, "done");
  assert.deepEqual(state.recipients, []);
  assert.equal(inviteSummary(state).noEmailCount, 1);
});

test("role change is ignored while sending", () => {
  const sending = run(commitText(fresh(), "a@x.com"), { type: "send" });
  assert.equal(run(sending, { type: "role", role: "admin" }).role, "member");
  assert.deepEqual(run(sending, { type: "remove", email: "a@x.com" }), sending);
  assert.deepEqual(run(sending, { type: "draft", text: "b@y.io," }), sending);
  assert.equal(run(fresh(), { type: "role", role: "admin" }).role, "admin");
});

test("a chip still sending when the run finishes becomes a failed chip", () => {
  const sending = run(commitText(fresh(), "a@x.com"), { type: "send" });
  const state = run(sending, { type: "finished" });
  assert.equal(state.phase, "editing");
  assert.deepEqual(state.recipients[0].state, { status: "failed", kind: "requestFailed" });
});

test("suggestions leave out members, pending invites and chips", () => {
  const contacts = [
    { email: "member@acme.test", name: "Member" },
    { email: "Invited@acme.test", name: "Invited" },
    { email: "chip@acme.test" },
    { email: "ana@acme.test", name: "Ana" },
    { email: "bo@acme.test", name: null },
    { email: "cy@acme.test", name: "Cy" },
  ];
  const exclude = ["member@acme.test", "invited@acme.test", "chip@acme.test"];
  assert.deepEqual(inviteSuggestions(contacts, exclude), [
    { email: "ana@acme.test", name: "Ana" },
    { email: "bo@acme.test", name: null },
    { email: "cy@acme.test", name: "Cy" },
  ]);
  assert.equal(inviteSuggestions(contacts, exclude, 2).length, 2);
  assert.equal(inviteSuggestions(contacts, [], 99).length, 6);
});

test("removing the last failed chip after a partial send shows the outcome", () => {
  const sending = run(commitText(fresh(), "a@x.com b@x.com c@x.com"), { type: "send" });
  const finished = run(
    sending,
    { type: "result", email: "a@x.com", outcome: { ok: true, emailSent: false } },
    { type: "result", email: "b@x.com", outcome: { ok: true, emailSent: true } },
    { type: "result", email: "c@x.com", outcome: { ok: false, kind: "requestFailed" } },
    { type: "finished" }
  );
  assert.equal(finished.phase, "editing");

  const state = run(finished, { type: "remove", email: "c@x.com" });

  assert.equal(state.phase, "done");
  assert.deepEqual(
    state.sent.map((entry) => entry.email),
    ["a@x.com", "b@x.com"]
  );
  assert.equal(inviteSummary(state).noEmailCount, 1);
});

test("removing a chip with nothing sent stays editing", () => {
  const state = run(commitText(fresh(), "a@x.com"), { type: "remove", email: "a@x.com" });

  assert.equal(state.phase, "editing");
  assert.deepEqual(state.recipients, []);
});

test("a refused or SSO-blocked chip stays failed but isn't sent again unchanged", () => {
  let state = run(commitText(fresh(), "a@x.com b@y.io c@z.org"), { type: "send" });
  state = run(
    state,
    {
      type: "result",
      email: "a@x.com",
      outcome: { ok: false, kind: "refused", message: "Only admins can be invited without a seat" },
    },
    { type: "result", email: "b@y.io", outcome: { ok: false, kind: "ssoRequired" } },
    { type: "result", email: "c@z.org", outcome: { ok: false, kind: "requestFailed" } },
    { type: "finished" }
  );
  assert.deepEqual(
    state.recipients.map((recipient) => recipient.state),
    [
      {
        status: "failed",
        kind: "refused",
        message: "Only admins can be invited without a seat",
      },
      { status: "failed", kind: "ssoRequired" },
      { status: "failed", kind: "requestFailed" },
    ]
  );
  const summary = inviteSummary(state);
  assert.equal(summary.failed.length, 3);
  assert.deepEqual(summary.sendable, ["c@z.org"]);

  // Retrying takes only the request that may go through this time.
  state = run(state, { type: "send" });
  assert.deepEqual(statuses(state), ["failed", "failed", "sending"]);
});

test("only refused chips left means there is nothing to send", () => {
  let state = run(commitText(fresh(), "a@x.com"), { type: "send" });
  state = run(
    state,
    { type: "result", email: "a@x.com", outcome: { ok: false, kind: "refused", message: "No" } },
    { type: "finished" }
  );
  assert.equal(state.phase, "editing");
  assert.equal(inviteSummary(state).canSend, false);
});

test("re-typing an address already sent in this dialog blocks it as already invited", () => {
  let state = run(commitText(fresh(), "a@x.com b@y.io"), { type: "send" });
  state = run(
    state,
    { type: "result", email: "a@x.com", outcome: { ok: true, emailSent: true } },
    { type: "result", email: "b@y.io", outcome: { ok: false, kind: "requestFailed" } },
    { type: "finished" }
  );

  state = commitText(state, "A@x.com");
  assert.deepEqual(state.recipients, [
    { email: "b@y.io", state: { status: "failed", kind: "requestFailed" } },
    { email: "a@x.com", state: { status: "blocked", reason: "alreadyInvited" } },
  ]);
  assert.equal(inviteSummary(state).canSend, false);
  // The same address typed twice still makes one chip.
  assert.equal(commitText(state, "a@x.com").recipients.length, 2);
  assert.deepEqual(state.sent, [{ email: "a@x.com", emailSent: true }]);
});
