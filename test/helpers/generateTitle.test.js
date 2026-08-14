const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/sanitizeGeneratedTitle.ts");

test("strips wrapping ASCII quotes", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('"Weekly standup"'), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle("'Weekly standup'"), "Weekly standup");
});

test("strips wrapping curly quotes and guillemets", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle("“Weekly standup”"), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle("‘Weekly standup’"), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle("«Weekly standup»"), "Weekly standup");
});

test("peels stacked wrappers left by mixed quote styles", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('"“Weekly standup”"'), "Weekly standup");
});

test("keeps inner apostrophes", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle("Don't stop meeting"), "Don't stop meeting");
  assert.equal(sanitizeGeneratedTitle("'Don't stop meeting'"), "Don't stop meeting");
});

test("trims whitespace around wrapping quotes", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('  "Weekly standup"  '), "Weekly standup");
});

test("rejects empty or overlong titles after stripping", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('""'), "");
  assert.equal(sanitizeGeneratedTitle('"'), "");
  assert.equal(sanitizeGeneratedTitle("a".repeat(100)), "");
  assert.equal(sanitizeGeneratedTitle("short"), "short");
});

test("non-string input is empty", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle(undefined), "");
  assert.equal(sanitizeGeneratedTitle(null), "");
});
