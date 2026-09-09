const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = async () => import("../../src/utils/validation.ts");

const AUTH_STEP = path.join(__dirname, "../../src/components/AuthenticationStep.tsx");

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
  for (const email of ["", "user", "user@", "@example.com", "user@example", "a b@example.com"]) {
    assert.ok(!EMAIL_REGEX.test(email), `${email} should be rejected`);
  }
});

// Regression pin for #1700: the sign-in gate rejected any local part containing
// "+", locking out accounts the website had already created with that address.
test("the auth email gate does not special-case plus addressing", () => {
  const source = fs.readFileSync(AUTH_STEP, "utf8");
  assert.match(source, /EMAIL_REGEX\.test\(/);
  assert.doesNotMatch(source, /localPart/);
  assert.doesNotMatch(source, /plusAlias/);
});
