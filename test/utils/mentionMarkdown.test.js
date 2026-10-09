const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/mentionMarkdown.ts");

const PEOPLE = [
  { name: "Gabriel Stein", email: "gabe@openwhispr.com" },
  { name: "Michael Chen", email: "michael@acme.com" },
  { name: "Sean", email: null },
];

test("buildMentionMarkdown links the email when present", async () => {
  const { buildMentionMarkdown } = await load();
  assert.equal(
    buildMentionMarkdown({ name: "Michael Chen", email: "michael@acme.com" }),
    "[@Michael Chen](mention:michael%40acme.com)"
  );
});

test("buildMentionMarkdown falls back to the name and escapes link-breaking chars", async () => {
  const { buildMentionMarkdown } = await load();
  assert.equal(buildMentionMarkdown({ name: "Sean", email: null }), "[@Sean](mention:Sean)");
  // Parens would end the markdown link destination early; brackets break the label.
  assert.equal(
    buildMentionMarkdown({ name: "Ana (PM)", email: null }),
    "[@Ana (PM)](mention:Ana%20%28PM%29)"
  );
  assert.equal(
    buildMentionMarkdown({ name: "Bob [ops]", email: null }),
    "[@Bob ops](mention:Bob%20ops)"
  );
});

test("parseMentionEmail extracts emails and rejects everything else", async () => {
  const { parseMentionEmail } = await load();
  assert.equal(parseMentionEmail("mention:michael%40acme.com"), "michael@acme.com");
  assert.equal(parseMentionEmail("mention:Sean"), null);
  assert.equal(parseMentionEmail("https://example.com"), null);
  assert.equal(parseMentionEmail(null), null);
  assert.equal(parseMentionEmail("mention:%E0%A4%A"), null);
});

test("tags a full-name owner on a checkbox line", async () => {
  const { tagActionItemOwners } = await load();
  assert.equal(
    tagActionItemOwners("- [ ] Send the deck — Michael Chen", PEOPLE),
    "- [ ] Send the deck — [@Michael Chen](mention:michael%40acme.com)"
  );
});

test("tags by unique first name, case-insensitively", async () => {
  const { tagActionItemOwners } = await load();
  assert.equal(
    tagActionItemOwners("- [x] Review PR - michael", PEOPLE),
    "- [x] Review PR - [@Michael Chen](mention:michael%40acme.com)"
  );
});

test("leaves ambiguous first names untouched", async () => {
  const { tagActionItemOwners } = await load();
  const people = [
    { name: "Michael Chen", email: "michael@acme.com" },
    { name: "Michael Ross", email: "mross@acme.com" },
  ];
  const line = "- [ ] Review PR — Michael";
  assert.equal(tagActionItemOwners(line, people), line);
});

test("does not choose between attendees with the same full name", async () => {
  const { tagActionItemOwners } = await load();
  const people = [
    { name: "Alex Morgan", email: "alex.design@example.test" },
    { name: "Alex Morgan", email: "alex.engineering@example.test" },
  ];
  for (const roster of [people, [...people].reverse()]) {
    for (const owner of ["Alex Morgan", "Alex", "Sean and Alex Morgan"]) {
      const line = `- [ ] Send the proposal — ${owner}`;
      assert.equal(tagActionItemOwners(line, [...roster, PEOPLE[2]]), line);
    }
  }
});

test("normalizing a display name must not hide conflicting attendee emails", async () => {
  const { tagActionItemOwners } = await load();
  const line = "- [ ] Send the proposal — Alex Morgan";
  assert.equal(
    tagActionItemOwners(line, [
      { name: "Alex  Morgan", email: "alex.design@example.test" },
      { name: "ALEX MORGAN", email: "alex.engineering@example.test" },
    ]),
    line
  );
});

test("duplicate records and name-only speaker labels retain the known attendee email", async () => {
  const { tagActionItemOwners } = await load();
  const attendee = { name: "Alex Morgan", email: "alex@example.test" };
  for (const people of [
    [attendee, { ...attendee }],
    [attendee, { ...attendee, email: "ALEX@example.test" }],
    [{ ...attendee, email: null }, attendee],
    [attendee, { ...attendee, email: null }],
  ]) {
    assert.equal(
      tagActionItemOwners("- [ ] Send the proposal — Alex", people),
      "- [ ] Send the proposal — [@Alex Morgan](mention:alex%40example.test)"
    );
  }
});

test("tags multiple owners only when every owner is known", async () => {
  const { tagActionItemOwners } = await load();
  assert.equal(
    tagActionItemOwners("- [ ] Draft the plan — Sean and Michael", PEOPLE),
    "- [ ] Draft the plan — [@Sean](mention:Sean), [@Michael Chen](mention:michael%40acme.com)"
  );
  const partiallyUnknown = "- [ ] Draft the plan — Sean and Priya";
  assert.equal(tagActionItemOwners(partiallyUnknown, PEOPLE), partiallyUnknown);
});

test("ignores unknown owners, non-task lines, and already-tagged lines", async () => {
  const { tagActionItemOwners } = await load();
  const unknown = "- [ ] Follow up — Priya";
  assert.equal(tagActionItemOwners(unknown, PEOPLE), unknown);

  const prose = "We agreed — Michael will follow up.";
  assert.equal(tagActionItemOwners(prose, PEOPLE), prose);

  const tagged = "- [ ] Send the deck — [@Michael Chen](mention:michael%40acme.com)";
  assert.equal(tagActionItemOwners(tagged, PEOPLE), tagged);
});

test("handles multi-line markdown and empty people", async () => {
  const { tagActionItemOwners } = await load();
  const markdown = ["## Action Items", "- [ ] Ship it — Sean", "- [ ] Untouched text"].join("\n");
  assert.equal(
    tagActionItemOwners(markdown, PEOPLE),
    ["## Action Items", "- [ ] Ship it — [@Sean](mention:Sean)", "- [ ] Untouched text"].join("\n")
  );
  assert.equal(tagActionItemOwners(markdown, []), markdown);
});
