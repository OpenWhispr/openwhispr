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

test("peels stacked wrappers using the same quote style", async () => {
  const { sanitizeGeneratedTitle } = await load();
  for (const raw of [
    '""Weekly standup""',
    "''Weekly standup''",
    "””Weekly standup””",
    "»»Weekly standup»»",
  ]) {
    assert.equal(sanitizeGeneratedTitle(raw), "Weekly standup", raw);
  }
});

test("peels wrappers around same-style inner quotes", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('"Notes on "Dune""'), 'Notes on "Dune"');
  assert.equal(
    sanitizeGeneratedTitle('"Notes on "Dune" and "Arrival""'),
    'Notes on "Dune" and "Arrival"'
  );
  assert.equal(sanitizeGeneratedTitle("'Notes on 'Dune''"), "Notes on 'Dune'");
  assert.equal(sanitizeGeneratedTitle('""Q3" vs "Q4""'), '"Q3" vs "Q4"');
  assert.equal(sanitizeGeneratedTitle('" "Q3" vs "Q4" "'), '"Q3" vs "Q4"');
});

test("does not treat possessive apostrophes as new phrase openers", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(
    sanitizeGeneratedTitle("'Chris' and Pat's planning meeting'"),
    "Chris' and Pat's planning meeting"
  );
  assert.equal(
    sanitizeGeneratedTitle("'The teams' goals and managers' expectations'"),
    "The teams' goals and managers' expectations"
  );
  assert.equal(
    sanitizeGeneratedTitle("'Cafe\u0301's launch and team's review'"),
    "Cafe\u0301's launch and team's review"
  );
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

test("keeps unspaced quoted phrases intact", async () => {
  const { sanitizeGeneratedTitle } = await load();
  for (const title of ['"設計"と"実装"', "‘计划’与‘预算’", "'設計'と'実装'", '"نعم"و"لا"']) {
    assert.equal(sanitizeGeneratedTitle(title), title);
  }
  assert.equal(sanitizeGeneratedTitle('""設計"と"実装""'), '"設計"と"実装"');
  assert.equal(sanitizeGeneratedTitle("‘‘计划’与‘预算’’"), "‘计划’与‘预算’");
});

test("peels wrappers around padded nested phrases", async () => {
  const { sanitizeGeneratedTitle } = await load();
  for (const [raw, expected] of [
    ['"Notes on " Q3 " and " Q4 ""', 'Notes on " Q3 " and " Q4 "'],
    ["'Notes on ' Q3 ' and ' Q4 ''", "Notes on ' Q3 ' and ' Q4 '"],
    ['"Notes on " C++ " + " Rust ""', 'Notes on " C++ " + " Rust "'],
  ]) {
    assert.equal(sanitizeGeneratedTitle(raw), expected);
  }
});

test("keeps quoted phrases separated by symbols intact", async () => {
  const { sanitizeGeneratedTitle } = await load();
  for (const title of ['"C++"+"Rust"', '"C++"→"Rust"', '"2025"⇒"2026"', '"🚀"+"🌕"']) {
    assert.equal(sanitizeGeneratedTitle(title), title);
  }
  assert.equal(sanitizeGeneratedTitle('""C++"+"Rust""'), '"C++"+"Rust"');
});

test("checks the final quote balance after elisions and possessives", async () => {
  const { sanitizeGeneratedTitle } = await load();
  for (const [raw, expected] of [
    ["‘Workin’ on ‘Dune’’", "Workin’ on ‘Dune’"],
    ["‘Workin’ on ‘ Dune ’’", "Workin’ on ‘ Dune ’"],
    ["'The teams' goals for 'Q4''", "The teams' goals for 'Q4'"],
    ["'The teams' goals for ' Q4 ''", "The teams' goals for ' Q4 '"],
    ["'Cafe\u0301's launch for 'Q4''", "Cafe\u0301's launch for 'Q4'"],
    ["‘Workin’ vs ‘Dune’", "‘Workin’ vs ‘Dune’"],
    ["'The teams' vs 'Q4'", "'The teams' vs 'Q4'"],
  ]) {
    assert.equal(sanitizeGeneratedTitle(raw), expected);
  }
});

test("keeps separate phrases with padding or punctuation between quotes", async () => {
  const { sanitizeGeneratedTitle } = await load();
  for (const title of [
    '" Q3 " vs " Q4 "',
    '"Q3"/"Q4"',
    '"Q3","Q4"',
    '"Dune!"/"Arrival?"',
    '"C++"/"Rust"',
    '"Plan 🚀"/"Launch 🌕"',
    '"Q3"/"$Q4"',
    '"Q3"/"🚀 Launch"',
    '"Q3"/"(Q4)"',
    '"Now"/"…Later"',
  ]) {
    assert.equal(sanitizeGeneratedTitle(title), title);
  }
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

test("rejects quote-only titles after peeling stacked wrappers", async () => {
  const { sanitizeGeneratedTitle } = await load();
  for (const raw of ['""""', "''''", "»»»»", '" " " "']) {
    assert.equal(sanitizeGeneratedTitle(raw), "", raw);
  }
});

test("applies the length limit after peeling same-style wrappers", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('""' + "a".repeat(96) + '""'), "a".repeat(96));
  assert.equal(sanitizeGeneratedTitle('""' + "a".repeat(99) + '""'), "a".repeat(99));
  assert.equal(sanitizeGeneratedTitle('""' + "a".repeat(100) + '""'), "");
  assert.equal(sanitizeGeneratedTitle('"' + "a".repeat(93) + ' "Q3""'), "a".repeat(93) + ' "Q3"');
});

test("rejects runaway replies without stalling", async () => {
  const { sanitizeGeneratedTitle } = await load();
  const wrappers = '"'.repeat(2048);
  const start = Date.now();
  assert.equal(sanitizeGeneratedTitle(wrappers + "Weekly standup" + wrappers), "");
  assert.equal(
    sanitizeGeneratedTitle('" '.repeat(2048) + "Weekly standup" + ' "'.repeat(2048)),
    ""
  );
  assert.ok(Date.now() - start < 1000);
});

test("still peels a deep but plausible stack of wrappers", async () => {
  const { sanitizeGeneratedTitle } = await load();
  const wrappers = '"'.repeat(100);
  assert.equal(sanitizeGeneratedTitle(wrappers + "Weekly standup" + wrappers), "Weekly standup");
  assert.equal(sanitizeGeneratedTitle(wrappers + '"Q3" vs "Q4"' + wrappers), '"Q3" vs "Q4"');
});

test("keeps balanced phrases whose closing marks look like apostrophes", async () => {
  const { sanitizeGeneratedTitle } = await load();
  for (const title of ["‘نعم’و‘لا’", "'Q3 recap' and Q4's 'North Star'", '"Q3 "/"Q4"']) {
    assert.equal(sanitizeGeneratedTitle(title), title, title);
  }
});

test("peels wrappers around inch marks and possessives", async () => {
  const { sanitizeGeneratedTitle } = await load();
  assert.equal(sanitizeGeneratedTitle('"6" and 8" Pipe Planning"'), '6" and 8" Pipe Planning');
  assert.equal(
    sanitizeGeneratedTitle("'Chris', James', and the team's plans'"),
    "Chris', James', and the team's plans"
  );
  assert.equal(
    sanitizeGeneratedTitle('"Comparing "C++"/"Rust" performance"'),
    'Comparing "C++"/"Rust" performance'
  );
});

test("keeps unspaced straight-quoted phrases in scripts without spaces", async () => {
  const { sanitizeGeneratedTitle } = await load();
  for (const title of ['"設計"と"実装"', '"نعم"و"لا"']) {
    assert.equal(sanitizeGeneratedTitle(title), title, title);
  }
});
