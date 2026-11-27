const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/lib/avatarInitials.ts");

test("avatars show the first and last word's initials", async () => {
  const { avatarInitials } = await load();

  assert.equal(avatarInitials("Chad Piha", null), "CP");
  assert.equal(avatarInitials("  ada  lovelace byron ", null), "AB");
  assert.equal(avatarInitials("Acme", null), "A");
  assert.equal(avatarInitials("Émile Zola", null), "ÉZ");
});

test("without a name the email's first character stands in", async () => {
  const { avatarInitials } = await load();

  assert.equal(avatarInitials(null, "chad@example.com"), "C");
  assert.equal(avatarInitials("   ", "chad@example.com"), "C");
  assert.equal(avatarInitials(null, null), "?");
});

test("a character outside the BMP is never split in half", async () => {
  const { avatarInitials } = await load();

  assert.equal(avatarInitials("𝒜da Lovelace", null), "𝒜L");
});
