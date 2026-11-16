const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/emailApprovalFields.ts");

// A right-to-left override, which can make one domain read as another.
const RLO = String.fromCodePoint(0x202e);

const FIELDS = {
  to: ["josh@acme.test", "dana@acme.test"],
  cc: [],
  subject: "Q3 numbers",
  body: "Line one\nLine two",
};
const NO_PROBLEMS = {
  invalid: [],
  missingTo: false,
  tooManyRecipients: false,
  subjectTooLong: false,
  bodyTooLong: false,
};

test("To and Cc are read as the addresses the user typed, empty entries dropped", async () => {
  const { parseAddressList } = await load();
  assert.deepEqual(parseAddressList(" josh@acme.test, ,dana@acme.test ,"), [
    "josh@acme.test",
    "dana@acme.test",
  ]);
  assert.deepEqual(parseAddressList("   "), []);
  // A bad entry is kept as typed, so the card can name it.
  assert.deepEqual(parseAddressList("josh@acme.test, sam"), ["josh@acme.test", "sam"]);
});

test("a list pasted from a mail app becomes the bare addresses Send uses", async () => {
  const { parseAddressList } = await load();
  assert.deepEqual(parseAddressList("Bob Smith <bob@acme.test>; Ann <ann@acme.test>"), [
    "bob@acme.test",
    "ann@acme.test",
  ]);
  // Outlook's "Last, First <address>": the comma belongs to the name.
  assert.deepEqual(parseAddressList("Smith, Bob <bob@acme.test>, dana@acme.test"), [
    "bob@acme.test",
    "dana@acme.test",
  ]);
  assert.deepEqual(parseAddressList('"Smith, Bob" <bob@acme.test>'), ["bob@acme.test"]);
  // A name without an address of its own is never folded into a bare one.
  assert.deepEqual(parseAddressList("Smith, bob@acme.test"), ["Smith", "bob@acme.test"]);
});

test("the commas of every locale, and semicolons, separate addresses", async () => {
  const { parseAddressList } = await load();
  for (const separator of [",", ";", "،", "，", "、"]) {
    assert.deepEqual(
      parseAddressList(`josh@acme.test${separator} dana@acme.test`),
      ["josh@acme.test", "dana@acme.test"],
      separator
    );
  }
});

test("Send is blocked by an empty To and by any address that isn't bare and valid", async () => {
  const { emailFieldProblems } = await load();
  assert.deepEqual(emailFieldProblems(FIELDS), NO_PROBLEMS);
  assert.deepEqual(emailFieldProblems({ ...FIELDS, to: [] }), { ...NO_PROBLEMS, missingTo: true });
  assert.deepEqual(
    emailFieldProblems({
      ...FIELDS,
      to: ["Josh <josh@acme.test>", "josh@acme.test"],
      cc: ["sam", `evil@acme.test${RLO}`, "dana@acme"],
    }),
    {
      ...NO_PROBLEMS,
      invalid: ["Josh <josh@acme.test>", "sam", `evil@acme.test${RLO}`, "dana@acme"],
    }
  );
});

test("Send is blocked past Gmail's limits: 50 recipients, a 250-character subject", async () => {
  const { emailFieldProblems } = await load();
  const addresses = (count, prefix) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}@acme.test`);

  assert.equal(
    emailFieldProblems({ ...FIELDS, to: addresses(30, "a"), cc: addresses(20, "b") })
      .tooManyRecipients,
    false,
    "50 exactly is allowed"
  );
  assert.equal(
    emailFieldProblems({ ...FIELDS, to: addresses(30, "a"), cc: addresses(21, "b") })
      .tooManyRecipients,
    true
  );
  // Main sends each address once, so a repeat doesn't count twice.
  assert.equal(
    emailFieldProblems({
      ...FIELDS,
      to: addresses(50, "a"),
      cc: ["A0@acme.test"],
    }).tooManyRecipients,
    false
  );

  assert.equal(emailFieldProblems({ ...FIELDS, subject: "x".repeat(250) }).subjectTooLong, false);
  assert.equal(emailFieldProblems({ ...FIELDS, subject: "x".repeat(251) }).subjectTooLong, true);
  // Characters, not UTF-16 units, as main counts them.
  assert.equal(emailFieldProblems({ ...FIELDS, subject: "😀".repeat(250) }).subjectTooLong, false);
});

test("Send is blocked past the body size main allows, counting UTF-8 bytes and CRLF", async () => {
  const { emailFieldProblems } = await load();
  const { MAX_EMAIL_BODY_BYTES } = await import("../../src/helpers/connectors/emailCompose.js");
  const tooLong = (body) => emailFieldProblems({ ...FIELDS, body }).bodyTooLong;

  assert.equal(tooLong("a".repeat(MAX_EMAIL_BODY_BYTES)), false);
  assert.equal(tooLong("a".repeat(MAX_EMAIL_BODY_BYTES + 1)), true);
  assert.equal(tooLong("é".repeat(MAX_EMAIL_BODY_BYTES / 2 + 1)), true, "two bytes each");
  assert.equal(tooLong("\n".repeat(MAX_EMAIL_BODY_BYTES / 2 + 1)), true, "sent as CRLF");
});

test("a draft's fields map is read as an email, with anything missing left empty", async () => {
  const { toEmailFields } = await load();
  assert.deepEqual(toEmailFields(FIELDS), FIELDS);
  assert.deepEqual(toEmailFields({ to: "josh@acme.test", subject: ["x"] }), {
    to: [],
    cc: [],
    subject: "",
    body: "",
  });
});
