const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/textReplacements.js");

// ─── Word boundaries ───

test("replaces a whole word anywhere in the transcript", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "wheels", to: "views" }];
  assert.equal(applyTextReplacements("the wheels look great", rules), "the views look great");
  assert.equal(applyTextReplacements("wheels", rules), "views");
  assert.equal(applyTextReplacements("love my wheels", rules), "love my views");
});

test("replaces every occurrence, not just the first", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "wheels", to: "views" }];
  assert.equal(
    applyTextReplacements("wheels here, wheels there", rules),
    "views here, views there"
  );
});

test("never replaces inside a longer word", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "cat", to: "dog" }];
  assert.equal(applyTextReplacements("the caterpillar crawled", rules), "the caterpillar crawled");
  assert.equal(applyTextReplacements("a bobcat ran", rules), "a bobcat ran");
});

test("matches next to punctuation and symbols", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "wheels", to: "views" }];
  assert.equal(applyTextReplacements("wheels, wheels. (wheels)", rules), "views, views. (views)");
});

test("adjacent digits block the match (still inside a word)", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "wheels", to: "views" }];
  assert.equal(applyTextReplacements("wheels2 and 2wheels", rules), "wheels2 and 2wheels");
});

// ─── Case handling ───

test("lowercase rule adapts to the matched casing", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "wheels", to: "views" }];
  assert.equal(applyTextReplacements("wheels ahead", rules), "views ahead");
  assert.equal(applyTextReplacements("Wheels ahead", rules), "Views ahead");
  assert.equal(applyTextReplacements("WHEELS AHEAD", rules), "VIEWS AHEAD");
});

test("an uppercase target is kept verbatim in every casing", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "github", to: "GitHub" }];
  assert.equal(applyTextReplacements("github is down", rules), "GitHub is down");
  assert.equal(applyTextReplacements("Github is down", rules), "GitHub is down");
  assert.equal(applyTextReplacements("GITHUB is down", rules), "GitHub is down");
});

test("a single capital letter counts as title case, not all-caps", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "i", to: "we" }];
  assert.equal(applyTextReplacements("I agree", rules), "We agree");
});

// ─── Multi-word phrases and ordering ───

test("multi-word phrases replace as a unit", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "git hub", to: "GitHub" }];
  assert.equal(applyTextReplacements("I use git hub daily", rules), "I use GitHub daily");
});

test("longest match wins over a shorter overlapping rule", async () => {
  const { applyTextReplacements } = await load();
  const rules = [
    { from: "york", to: "Y" },
    { from: "new york", to: "NY" },
  ];
  assert.equal(applyTextReplacements("flew to new york today", rules), "flew to NY today");
  assert.equal(applyTextReplacements("old york lane", rules), "old Y lane");
});

test("whitespace runs in a rule collapse before matching", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "git   hub", to: "GitHub" }];
  assert.equal(applyTextReplacements("on git hub now", rules), "on GitHub now");
});

// ─── Escaping and injection safety ───

test("regex metacharacters in the source are matched literally", async () => {
  const { applyTextReplacements } = await load();
  assert.equal(
    applyTextReplacements("we write c++ here", [{ from: "c++", to: "cpp" }]),
    "we write cpp here"
  );
  assert.equal(
    applyTextReplacements("version 1.5 shipped", [{ from: "1.5", to: "one-point-five" }]),
    "version one-point-five shipped"
  );
  assert.equal(
    applyTextReplacements("value 125 stays", [{ from: "1.5", to: "x" }]),
    "value 125 stays"
  );
  assert.equal(
    applyTextReplacements("(a|b) chosen", [{ from: "(a|b)", to: "both" }]),
    "both chosen"
  );
});

test("dollar patterns in the target are inserted literally", async () => {
  const { applyTextReplacements } = await load();
  assert.equal(
    applyTextReplacements("say foo now", [{ from: "foo", to: "$&bar" }]),
    "say $&bar now"
  );
  assert.equal(applyTextReplacements("say foo now", [{ from: "foo", to: "$1" }]), "say $1 now");
});

// ─── Unicode ───

test("accented words match and keep case adaptation", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "café", to: "caffè" }];
  assert.equal(applyTextReplacements("meet at the café", rules), "meet at the caffè");
  assert.equal(applyTextReplacements("Café closed", rules), "Caffè closed");
});

test("decomposed input matches an NFC rule", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "café", to: "bar" }];
  assert.equal(applyTextReplacements("at the café now", rules), "at the bar now");
});

test("a decomposed rule source matches composed text", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "cafe\u0301", to: "bar" }];
  assert.equal(applyTextReplacements("at the caf\u00e9 now", rules), "at the bar now");
});

test("cyrillic words replace with case adaptation", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "привет", to: "здравствуйте" }];
  assert.equal(applyTextReplacements("Привет!", rules), "Здравствуйте!");
});

test("emoji count as separators around a match", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "wheels", to: "views" }];
  assert.equal(applyTextReplacements("🚀wheels🚀", rules), "🚀views🚀");
});

test("CJK inside running text is not replaced (no separators around it)", async () => {
  const { applyTextReplacements } = await load();
  const rules = [{ from: "视图", to: "views" }];
  assert.equal(applyTextReplacements("包含视图组件", rules), "包含视图组件");
  assert.equal(applyTextReplacements("这个 视图 组件", rules), "这个 views 组件");
});

// ─── Chains, cycles, idempotence ───

test("one rule's output is never re-scanned by another in the same pass", async () => {
  const { applyTextReplacements } = await load();
  const rules = [
    { from: "alpha", to: "beta" },
    { from: "beta", to: "gamma" },
  ];
  assert.equal(applyTextReplacements("alpha beta", rules), "beta gamma");
});

test("cyclic pairs swap once instead of looping", async () => {
  const { applyTextReplacements } = await load();
  const rules = [
    { from: "wheels", to: "views" },
    { from: "views", to: "wheels" },
  ];
  assert.equal(applyTextReplacements("wheels and views", rules), "views and wheels");
});

test("applying twice equals applying once for non-chaining rules", async () => {
  const { applyTextReplacements } = await load();
  const rules = [
    { from: "wheels", to: "views" },
    { from: "github", to: "GitHub" },
  ];
  const once = applyTextReplacements("Wheels on github", rules);
  assert.equal(once, "Views on GitHub");
  assert.equal(applyTextReplacements(once, rules), once);
});

// ─── Degenerate input ───

test("empty rule list returns the exact same string reference", async () => {
  const { applyTextReplacements } = await load();
  const text = "café untouched";
  assert.ok(Object.is(applyTextReplacements(text, []), text));
});

test("self-mapping rules are dropped and leave the text reference intact", async () => {
  const { applyTextReplacements } = await load();
  const text = "views everywhere";
  assert.ok(Object.is(applyTextReplacements(text, [{ from: "views", to: "views" }]), text));
});

test("invalid rule entries are ignored", async () => {
  const { applyTextReplacements } = await load();
  const rules = [
    null,
    42,
    { from: "", to: "x" },
    { from: "   ", to: "x" },
    { from: "x", to: "" },
    { from: 3, to: "x" },
    { from: "wheels", to: "views" },
  ];
  assert.equal(applyTextReplacements("wheels x", rules), "views x");
});

test("empty and non-string text pass through", async () => {
  const { applyTextReplacements } = await load();
  assert.equal(applyTextReplacements("", [{ from: "a", to: "b" }]), "");
  assert.equal(applyTextReplacements(null, [{ from: "a", to: "b" }]), null);
});

test("duplicate sources keep the first rule", async () => {
  const { applyTextReplacements } = await load();
  const rules = [
    { from: "wheels", to: "views" },
    { from: "Wheels", to: "tyres" },
  ];
  assert.equal(applyTextReplacements("wheels", rules), "views");
});

// ─── normalizeReplacementRules ───

test("normalize trims, collapses, dedupes and drops degenerate rules", async () => {
  const { normalizeReplacementRules } = await load();
  const rules = normalizeReplacementRules([
    { from: "  wheels  ", to: "  views " },
    { from: "WHEELS", to: "tyres" },
    { from: "same", to: "same" },
    { from: "a".repeat(121), to: "x" },
    { from: "ok", to: "y".repeat(241) },
    "not-an-object",
  ]);
  assert.deepEqual(rules, [{ from: "wheels", to: "views" }]);
});

test("normalize keeps case-only pairs", async () => {
  const { normalizeReplacementRules } = await load();
  assert.deepEqual(normalizeReplacementRules([{ from: "github", to: "GitHub" }]), [
    { from: "github", to: "GitHub" },
  ]);
});

test("normalize returns empty for non-array input", async () => {
  const { normalizeReplacementRules } = await load();
  assert.deepEqual(normalizeReplacementRules(undefined), []);
  assert.deepEqual(normalizeReplacementRules("wheels"), []);
});

test("normalize caps the rule list at 1000, keeping the first entries", async () => {
  const { normalizeReplacementRules } = await load();
  const rules = Array.from({ length: 1001 }, (_, i) => ({ from: `word${i}`, to: `fixed${i}` }));
  const normalized = normalizeReplacementRules(rules);
  assert.equal(normalized.length, 1000);
  assert.equal(normalized[0].from, "word0");
  assert.equal(normalized[999].from, "word999");
});

// ─── applyTranscriptReplacements (the audioManager seam) ───

test("settings without rules are a zero-cost passthrough", async () => {
  const { applyTranscriptReplacements } = await load();
  const text = "raw transcript";
  assert.ok(Object.is(applyTranscriptReplacements(text, undefined), text));
  assert.ok(Object.is(applyTranscriptReplacements(text, {}), text));
  assert.ok(Object.is(applyTranscriptReplacements(text, { dictionaryReplacements: [] }), text));
});

test("settings rules apply to the transcript", async () => {
  const { applyTranscriptReplacements } = await load();
  const settings = { dictionaryReplacements: [{ from: "wheels", to: "views" }] };
  assert.equal(
    applyTranscriptReplacements("The wheels layout is done", settings),
    "The views layout is done"
  );
});
