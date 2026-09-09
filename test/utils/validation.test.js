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

// Scoped to handleEmailContinue rather than the whole file: handleSubmit
// legitimately splits on "@" for the signup name default, and the surrounding
// component is free to mention "+" for unrelated reasons.
function emailGateSource() {
  const source = fs.readFileSync(AUTH_STEP, "utf8");
  const start = source.indexOf("const handleEmailContinue");
  assert.notEqual(start, -1, "handleEmailContinue not found - update this pin");
  const end = source.indexOf("\n  const ", start + 1);
  assert.notEqual(end, -1, "could not find the end of handleEmailContinue");
  const body = source.slice(start, end);
  // Guard against a silently empty slice passing the assertions below.
  assert.ok(body.length > 200, "extracted gate body looks truncated");
  return body;
}

// Regression pin for #1700: the sign-in gate rejected any local part containing
// "+", locking out accounts the website had already created with that address.
test("the email gate validates with the shared regex", () => {
  assert.match(emailGateSource(), /EMAIL_REGEX\.test\(/);
});

test("the email gate contains no plus special-casing in any form", () => {
  // Catches includes("+"), split("+"), a "+" regex - not just the original shape.
  assert.doesNotMatch(emailGateSource(), /\+/);
});
