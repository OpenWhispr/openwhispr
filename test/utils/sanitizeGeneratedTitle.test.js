const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/sanitizeGeneratedTitle.ts");

test("strips wrapping ASCII quotes", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('"Weekly standup"'), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle("'Weekly standup'"), "Weekly standup");
});

test("strips wrapping typographic quotes", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle("“Weekly standup”"), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle("‘Weekly standup’"), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle("«Weekly standup»"), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle("„Wochenmeeting“"), "Wochenmeeting");
  assert.equal(sanitizeGeneratedTitle("「週次ミーティング」"), "週次ミーティング");
  assert.equal(sanitizeGeneratedTitle("《周会纪要》"), "周会纪要");
});

test("peels stacked wrappers left by mixed quote styles", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('"“Weekly standup”"'), "Weekly standup");
});

test("keeps inner apostrophes and elisions", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle("Don't stop meeting"), "Don't stop meeting");
  assert.equal(sanitizeGeneratedTitle("'Don't stop meeting'"), "Don't stop meeting");
  assert.equal(sanitizeGeneratedTitle("Workin’"), "Workin’");
  assert.equal(sanitizeGeneratedTitle("’Tis the Season"), "’Tis the Season");
});

test("keeps a quoted phrase at one end intact", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle("Feedback on “Project X”"), "Feedback on “Project X”");
  assert.equal(sanitizeGeneratedTitle("“Q3” Planning Notes"), "“Q3” Planning Notes");
  assert.equal(sanitizeGeneratedTitle("Discussing «Le Projet»"), "Discussing «Le Projet»");
});

test("strips an unterminated wrapper with no counterpart", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('"Weekly standup'), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle('Weekly standup"'), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle("«Réunion"), "Réunion");
});

test("trims whitespace around wrapping quotes", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('  "Weekly standup"  '), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle('" Weekly standup "'), "Weekly standup");
});

test("rejects empty or overlong titles after stripping", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle(""), "");
  assert.equal(sanitizeGeneratedTitle('""'), "");
  assert.equal(sanitizeGeneratedTitle('"'), "");
  assert.equal(sanitizeGeneratedTitle("a".repeat(100)), "");
  assert.equal(sanitizeGeneratedTitle("short"), "short");
});
