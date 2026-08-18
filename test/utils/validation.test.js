const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = async () => {
  const m = await import("../../src/utils/validation.ts");
  return m.default || m;
};

// EMAIL_REGEX is the shared client-side email gate (login, referral, note
// sharing). It must accept anything the account backend accepts, notably
// plus-addressed emails, and reject only obviously malformed input.

test("accepts the plus-addressed email from the login bug report", async () => {
  const { EMAIL_REGEX } = await load();
  assert.equal(EMAIL_REGEX.test("user+alias@domain.com"), true);
});

test("accepts plus-addressing variants in the local part", async () => {
  const { EMAIL_REGEX } = await load();
  for (const email of [
    "user+tag@example.com",
    "user+tag+nested@example.com",
    "user+123@example.com",
    "first.last+work@example.com",
    "+lead@example.com",
  ]) {
    assert.equal(EMAIL_REGEX.test(email), true, email);
  }
});

test("accepts dots, hyphens, underscores, and subdomains", async () => {
  const { EMAIL_REGEX } = await load();
  for (const email of [
    "first.last@example.com",
    "user@mail.example.com",
    "user@deep.mail.example.co.uk",
    "user@my-domain.com",
    "user-name@example.com",
    "user_name@example.com",
    "o'brien@example.com",
    "user123@example123.com",
  ]) {
    assert.equal(EMAIL_REGEX.test(email), true, email);
  }
});

test("rejects input without an @ or without a dotted domain", async () => {
  const { EMAIL_REGEX } = await load();
  for (const email of ["", "plainaddress", "user@domain", "user@example.", "@example.com", "user@"]) {
    assert.equal(EMAIL_REGEX.test(email), false, JSON.stringify(email));
  }
});

test("rejects whitespace and extra @ signs anywhere in the address", async () => {
  const { EMAIL_REGEX } = await load();
  for (const email of [
    "user name@example.com",
    "user@exa mple.com",
    "user@example.com extra",
    " user@example.com",
    "user@@example.com",
    "user@one@two.com",
    "user@example.com\n",
  ]) {
    assert.equal(EMAIL_REGEX.test(email), false, JSON.stringify(email));
  }
});

// The login flow used to special-case "+" in the local part and reject it
// before reaching the server, locking out accounts the website registers.
// Pin the auth email gate to the shared regex with no plus-address carve-out.
test("authentication email gate uses the shared regex and has no plus-address rejection", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/components/AuthenticationStep.tsx"),
    "utf8"
  );
  assert.equal(source.includes("EMAIL_REGEX.test"), true);
  assert.equal(source.includes("plusAliasUnsupported"), false);
  assert.equal(source.includes('includes("+")'), false);
});
