const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/guestsView.ts");

const note = (visibility) => ({ id: "n", title: null, permission: "viewer", visibility });
const guest = (overrides) => ({
  email: "a@x.com",
  name: null,
  image: null,
  notes: [],
  ...overrides,
});

test("guestDisplayName falls back to the email", async () => {
  const { guestDisplayName } = await load();
  assert.equal(guestDisplayName(guest({ name: "Jin" })), "Jin");
  assert.equal(guestDisplayName(guest({ name: null })), "a@x.com");
  assert.equal(guestDisplayName(guest({ name: "  " })), "a@x.com");
});

test("hasLinkSharedNote is true for link and domain, false for invited only", async () => {
  const { hasLinkSharedNote } = await load();
  assert.equal(hasLinkSharedNote([guest({ notes: [note("invited"), note("link")] })]), true);
  assert.equal(hasLinkSharedNote([guest({ notes: [note("domain")] })]), true);
  assert.equal(hasLinkSharedNote([guest({ notes: [note("invited")] })]), false);
  assert.equal(hasLinkSharedNote([]), false);
});
