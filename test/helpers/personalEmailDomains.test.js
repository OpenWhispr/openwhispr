const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/personalEmailDomains.ts");

test("strips surrounding whitespace before taking the domain", async () => {
  const { emailDomain, isPersonalEmailDomain } = await load();
  assert.equal(emailDomain("  user@Gmail.com  "), "gmail.com");
  assert.equal(isPersonalEmailDomain(emailDomain("  user@Gmail.com  ")), true);
});

test("reads the mailbox inside display-name angle brackets", async () => {
  const { emailDomain, isPersonalEmailDomain } = await load();
  assert.equal(emailDomain("Jane <jane@acme.com>"), "acme.com");
  assert.equal(isPersonalEmailDomain(emailDomain("Jane <jane@acme.com>")), false);
});

test("does not throw on non-string input", async () => {
  const { emailDomain, isPersonalEmailDomain } = await load();
  assert.equal(emailDomain(null), "");
  assert.equal(isPersonalEmailDomain(null), false);
});
