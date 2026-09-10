const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => import("../../src/utils/validation.ts");

// The #1700 regression itself — a plus-addressed alias reaching account
// discovery untouched — is pinned behaviourally in
// test/components/authenticationStep.test.js. These cover the shared regex the
// sign-in gate, the referral dashboard and the share-note dialog all validate
// with.

test("accepts plus-addressed emails", async () => {
  const { EMAIL_REGEX } = await load();
  for (const email of [
    "user+alias@domain.com",
    "user+tag+more@example.co.uk",
    "+leading@example.com",
  ]) {
    assert.ok(EMAIL_REGEX.test(email), `${email} should be accepted`);
  }
});

test("accepts the other RFC-legal shapes users actually type", async () => {
  const { EMAIL_REGEX } = await load();
  for (const email of [
    "first.last@example.com",
    "user_name@example.com",
    "user-name@sub.example.co.uk",
    "USER@EXAMPLE.COM",
  ]) {
    assert.ok(EMAIL_REGEX.test(email), `${email} should be accepted`);
  }
});

test("rejects obviously malformed input", async () => {
  const { EMAIL_REGEX } = await load();
  for (const email of [
    "",
    "user",
    "user@",
    "@example.com",
    "a b@example.com",
    "user@@example.com",
    "user@one@two.com",
    "user@example.",
    // A single-label domain is rejected on purpose. The hosted auth server
    // rejects it too, so sparing the round trip is the deliberate tradeoff; the
    // server stays the authority on anything this shape check lets through.
    "user@example",
  ]) {
    assert.ok(!EMAIL_REGEX.test(email), `${email} should be rejected`);
  }
});

// Callers test the trimmed address (AuthenticationStep, ReferralDashboard,
// ShareNoteDialog all pass `.trim()`), so the regex itself must stay strict
// about surrounding whitespace rather than absorbing it.
test("rejects surrounding whitespace so callers must trim", async () => {
  const { EMAIL_REGEX } = await load();
  for (const email of [" user@example.com", "user@example.com ", "user@example.com\n"]) {
    assert.ok(!EMAIL_REGEX.test(email), `${JSON.stringify(email)} should be rejected`);
  }
  assert.ok(EMAIL_REGEX.test(" user@example.com ".trim()));
});
