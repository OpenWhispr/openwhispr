const test = require("node:test");
const assert = require("node:assert/strict");

// Most cases read one Markdown text, given as a body on its own.
const load = async () => {
  const { githubFieldMentions } = await import("../../src/utils/githubMentions.ts");
  return { githubFieldMentions, githubMentions: (text) => githubFieldMentions({ body: text }) };
};

test("finds people and teams, in the order they first appear", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(
    githubMentions("Thanks @alice! Looping in @acme/platform-team and @bob-smith."),
    ["@alice", "@acme/platform-team", "@bob-smith"]
  );
});

test("a name mentioned twice, in any case, is listed once as first written", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("@Alice can you check? cc @bob, @alice, @ALICE"), [
    "@Alice",
    "@bob",
  ]);
});

test("mentions at the start of a line, in brackets and before punctuation count", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("@dana\n(@erin) ping:@finn, @gus.\n- @hal"), [
    "@dana",
    "@erin",
    "@finn",
    "@gus",
    "@hal",
  ]);
});

test("email addresses and @ inside a word are not mentions", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("Mail dana@example.com or ops@acme.io; a@b; x@y.z"), []);
  assert.deepEqual(githubMentions("user@alice"), []);
  // "@@x" and a domain immediately before "@" ("medium.com/@x") still don't
  // count: "@" and "/" stay excluded even though "_", "-", "." and "\\" no
  // longer are.
  assert.deepEqual(githubMentions("a@b.com @@x medium.com/@x"), []);
});

// GitHub renders and notifies through all of these; under-reporting a
// mention it would notify is the mistake to avoid, so any non-word character
// right before "@" now opens one, not only whitespace and a narrower set of
// punctuation.
test("a non-word character right before @ opens a mention, including one that used to be excluded", async () => {
  const { githubMentions } = await load();
  // Markdown italics: GitHub renders `_@gina_` as <em>@gina</em> and notifies
  // gina; the trailing underscore ends the handle rather than blocking it.
  assert.deepEqual(githubMentions("_@gina_"), ["@gina"]);
  // Enterprise Managed User handles carry a "_shortcode" suffix.
  assert.deepEqual(githubMentions("ping @bob_acme"), ["@bob_acme"]);
  assert.deepEqual(githubMentions("hi-@alice"), ["@alice"]);
  // The backslash is dropped when GitHub renders this, and it still notifies.
  assert.deepEqual(githubMentions("see \\@dave"), ["@dave"]);
  // Loosened on purpose: previously excluded as "@ inside a word".
  assert.deepEqual(githubMentions("foo_@bar"), ["@bar"]);
});

test("CRLF line endings are normalised before paragraphs, fences and code spans are found", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("cc @alice\r\n\r\n@bob"), ["@alice", "@bob"]);
  assert.deepEqual(
    githubMentions("Press the ` key to open the console.\r\n\r\ncc @alice, see `main.js`"),
    ["@alice"]
  );
  const body = ["Before @alice", "```js", "// @bob", "```", "After @carol"].join("\r\n");
  assert.deepEqual(githubMentions(body), ["@alice", "@carol"]);
});

test("mentions inside inline code are ignored", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("Run `npm i @types/node` then ask @alice"), ["@alice"]);
  assert.deepEqual(githubMentions("Use ``a ` @inside`` here, @outside"), ["@outside"]);
});

test("a code span never crosses a blank line, so a later paragraph's mention still counts", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(
    githubMentions("Press the ` key to open the console.\n\ncc @alice, the fix is in `main.js`"),
    ["@alice"]
  );
  assert.deepEqual(githubMentions("`@a` then @b"), ["@b"]);
});

test("mentions inside fenced code blocks are ignored, fences of either kind", async () => {
  const { githubMentions } = await load();
  const body = [
    "Before @alice",
    "```js",
    "import x from '@scope/pkg';",
    "// @bob",
    "```",
    "~~~",
    "@carol",
    "~~~",
    "After @dana",
  ].join("\n");
  assert.deepEqual(githubMentions(body), ["@alice", "@dana"]);
});

test("an unclosed fence hides the rest of the text, as GitHub renders it", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("See @alice\n```\n@bob never closed"), ["@alice"]);
});

test("an unclosed backtick is plain text, so its mention counts", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("a stray ` then @alice"), ["@alice"]);
});

test("doubled @ or a bare hyphen right after @ are never mentions; over-long handles aren't either", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("@@bob @-carol"), []);
  assert.deepEqual(githubMentions(`@${"a".repeat(40)}`), []);
  assert.deepEqual(githubMentions(`@${"a".repeat(39)}`), [`@${"a".repeat(39)}`]);
});

test("no text, no mentions", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions(""), []);
  assert.deepEqual(githubMentions("Nothing to see here."), []);
});

test("part of a longer backtick run opens no code span", async () => {
  const { githubMentions } = await load();
  // The ``` mid-line is literal text, so only `x` is code and @alice counts.
  assert.deepEqual(githubMentions("Wrap it in ``` then ping @alice about `x`"), ["@alice"]);
  assert.deepEqual(githubMentions("``@alice`"), ["@alice"]);
});

test("a backtick that opened no code span doesn't hide the mention after it", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("hey `@alice please"), ["@alice"]);
  assert.deepEqual(githubMentions("see `@bob` and @carol"), ["@carol"]);
});

test("a code span never leaves its list item, heading or table row", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("- Run `npm test\n- cc @alice\n- the ` key"), ["@alice"]);
  assert.deepEqual(githubMentions("# Fix `parser\n@alice please look at the ` handling"), [
    "@alice",
  ]);
  assert.deepEqual(githubMentions("| a ` b |\n| --- |\n| @alice ` |"), ["@alice"]);
  // Inside one paragraph a span still runs across a line break.
  assert.deepEqual(githubMentions("a `code\nspan @dan` here"), []);
});

test("a fence closes only on its own character", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("```\n@eve\n~~~\n@frank\n```\n@gina"), ["@gina"]);
  assert.deepEqual(githubMentions("~~~\n@eve\n```\n@frank\n~~~\n@gina"), ["@gina"]);
});

test("a closed HTML comment notifies no one; code or an unclosed one hides nothing", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("<!-- @alice --> @bob"), ["@bob"]);
  assert.deepEqual(githubMentions("a\n<!--\n@eve\n-->\n@fay"), ["@fay"]);
  assert.deepEqual(githubMentions("Use `<!--` to start one. cc @carol"), ["@carol"]);
  assert.deepEqual(githubMentions("<!-- never closed @dan"), ["@dan"]);
});

test("a backslash-escaped backtick opens no code span; an escaped backslash doesn't escape it", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("Use \\` for ticks, cc @alice, and \\` again"), ["@alice"]);
  // The escaped backtick is text, so the next two pair up around @bob.
  assert.deepEqual(githubMentions("\\`a` @bob `b`"), []);
  // "\\\\" is a literal backslash: the backtick after it opens `a`.
  assert.deepEqual(githubMentions("\\\\`a` @carol `b`"), ["@carol"]);
});

test("a backtick line whose info string holds a backtick is a paragraph, not a fence", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("``` not a fence `x`\n@bob\n\n@carol"), ["@bob", "@carol"]);
  // A tilde fence's info string may hold backticks.
  assert.deepEqual(githubMentions("~~~ `x`\n@bob\n~~~\n@carol"), ["@carol"]);
});

test("a setext underline or thematic break ends the block, so a code span can't cross it", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("Heading `a\n---\n@kim `"), ["@kim"]);
  assert.deepEqual(githubMentions("Heading `a\n===\n@kim `"), ["@kim"]);
  assert.deepEqual(githubMentions("a `b\n***\n@lee `"), ["@lee"]);
});

test("only a comment that opens a line runs past a blank line", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("see <!-- draft\n\n@alice\n\n-->"), ["@alice"]);
  assert.deepEqual(githubMentions("  <!--\n@bob\n\n@carol\n--> @dan"), ["@dan"]);
  // Inside one paragraph an inline comment still spans lines.
  assert.deepEqual(githubMentions("see <!-- draft\n@erin --> @fay"), ["@fay"]);
  assert.deepEqual(githubMentions("\\<!-- @gus -->"), ["@gus"]);
});

test("a comment block and a fence each hide the other's markers", async () => {
  const { githubMentions } = await load();
  assert.deepEqual(githubMentions("<!-- a\n```\n-->\n@alice"), ["@alice"]);
  assert.deepEqual(githubMentions("```\n<!--\n```\n-->\n@bob"), ["@bob"]);
});

test("many unclosed comments are scanned in linear time", async () => {
  const { githubMentions } = await load();
  const started = performance.now();
  assert.deepEqual(githubMentions(`${"<!--".repeat(50_000)} @alice`), ["@alice"]);
  assert.deepEqual(githubMentions(`${"<!--\n".repeat(20_000)}@bob`), ["@bob"]);
  // The quadratic scan took about a second here.
  assert.ok(performance.now() - started < 250, "well under a keystroke");
});

test("githubFieldMentions reads title and body apart, each mention once", async () => {
  const { githubFieldMentions } = await load();
  // A title ending in an open code span can't hide the body's mentions.
  assert.deepEqual(githubFieldMentions({ title: "Fix `parser and @Ann", body: "cc @ann ` @bo" }), [
    "@Ann",
    "@bo",
  ]);
  assert.deepEqual(githubFieldMentions({ title: "Crash", body: 7 }), []);
});
