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

test("keeps quoted phrases at both ends intact", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle("“Dune” vs “Arrival”"), "“Dune” vs “Arrival”");
  assert.equal(sanitizeGeneratedTitle('"Q3" vs "Q4"'), '"Q3" vs "Q4"');
  assert.equal(sanitizeGeneratedTitle("'Q3' vs 'Q4'"), "'Q3' vs 'Q4'");
  assert.equal(sanitizeGeneratedTitle("«Le Projet» et «La Suite»"), "«Le Projet» et «La Suite»");
  assert.equal(sanitizeGeneratedTitle("„Plan A“ und „Plan B“"), "„Plan A“ und „Plan B“");
  assert.equal(sanitizeGeneratedTitle("「設計」と「実装」"), "「設計」と「実装」");
});

test("peels a wrapper around a title with quoted phrases inside", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('"“Dune” vs “Arrival”"'), "“Dune” vs “Arrival”");
  assert.equal(sanitizeGeneratedTitle("“Notes on ‘Dune’”"), "Notes on ‘Dune’");
  assert.equal(sanitizeGeneratedTitle("‘Workin’ late’"), "Workin’ late");
  assert.equal(sanitizeGeneratedTitle("『「設計」と「実装」』"), "「設計」と「実装」");
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
