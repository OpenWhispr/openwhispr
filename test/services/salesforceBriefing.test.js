const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const record = { objectType: "Opportunity", recordId: "006000000000001AAA" };
const recordUrl =
  "https://tenant.my.salesforce.com/lightning/r/Opportunity/006000000000001AAA/view";
const activityUrl = "https://tenant.my.salesforce.com/lightning/r/Task/00T000000000001AAA/view";
const facts = {
  kind: "record",
  ...record,
  Name: "Test 2",
  StageName: "Needs Analysis",
  Amount: null,
  AccountId: null,
  OwnerId: "005000000000001AAA",
  NextStep: null,
  CloseDate: "2026-11-25",
  retrievedAt: "2026-11-17T12:09:35.016Z",
  url: recordUrl,
  unavailableFields: ["CurrencyIsoCode"],
  unavailableNotes: 0,
};
// How the briefing shows a time: in the user's zone, named, on one line.
const when = (value) =>
  new Date(value)
    .toLocaleString("en", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    })
    .replace(/\s+/g, " ");
const source = (noteId) => ({
  kind: "note",
  noteId,
  activityUrl,
});
const context = (messageId = "briefing", controller = new AbortController()) => ({
  messageId,
  toolCallId: "brief",
  signal: controller.signal,
});

// tsx loads the ESM module through CommonJS interop, which can wrap its default export.
async function loadI18n() {
  const { default: imported } = await import("../../src/i18n.ts");
  return imported.default ?? imported;
}

async function setup(
  t,
  { notes = [], items = [facts, source(7)], protectNotes, queries = [] } = {}
) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async (_connectorId, action, args) => {
          queries.push({ action, args });
          return { status: "ok", items, truncated: false };
        },
        getNote: async (id) => notes.find((note) => note.id === id) ?? null,
      },
    },
  });
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");
  // The copy is checked in English, whatever this machine's language is.
  const i18n = await loadI18n();
  if (i18n.language !== "en") await i18n.changeLanguage("en");
  return createToolRegistry({
    isSignedIn: false,
    cloudBackupEnabled: false,
    calendarConnected: false,
    webSearchEnabled: false,
    scopeSpaceIds: [1],
    protectNotes,
    connectors: { emailDraftTarget: "auto", readyConnectorIds: ["salesforce"] },
  });
}

const note = (id, content, space_id = 1) => ({
  id,
  content,
  space_id,
  title: "Acme discovery",
  enhanced_content: null,
  transcript: "",
  created_at: "2026-11-17 11:07:00",
  updated_at: "2026-11-17 11:08:00",
});

test("briefing reads linked notes through workspace protection before returning their content", async (t) => {
  const protectedNotes = [];
  const registry = await setup(t, {
    notes: [note(7, "Proposed pilot:\n8 reps for two weeks; subject to security approval.")],
    protectNotes: async (notes) => {
      protectedNotes.push(...notes.map((item) => item.id));
    },
  });
  const result = await registry.get("salesforce_get_briefing").execute(record, context());
  assert.deepEqual(protectedNotes, [7]);
  assert.equal(result.data.untrusted, true);
  assert.equal(
    result.data.sources[0].passages[0].text,
    "8 reps for two weeks; subject to security approval."
  );
  assert.equal(result.data.sources[0].passages[0].section, "Proposed pilot");
  assert.ok(
    result.renderedAnswer.content.includes(`Retrieved: ${when("2026-11-17T12:09:35.016Z")}`)
  );
  assert.match(result.renderedAnswer.content, /Amount: not recorded/);
  assert.match(result.renderedAnswer.content, /Currency: not returned/);
  assert.match(result.renderedAnswer.content, /identity.*not verified/i);
  assert.doesNotMatch(result.renderedAnswer.content, /005000000000001AAA|budget.*approved/i);
});

test("inaccessible notes are missing context, never empty meeting conclusions or leaked titles", async (t) => {
  const registry = await setup(t, { notes: [note(7, "Private information", 2)] });
  const result = await registry.get("salesforce_get_briefing").execute(record, context());
  assert.deepEqual(result.data.sources, []);
  assert.equal(result.data.unavailableNotes, 1);
  assert.doesNotMatch(JSON.stringify(result), /Discovery|Private information|Acme discovery/);
  assert.match(result.renderedAnswer.content, /No accessible meeting content/);
  assert.doesNotMatch(result.renderedAnswer.content, /no commitments|no contradictions/i);
});

test("structured presentation selects actual passages and retains proposal qualifiers and citations", async (t) => {
  const registry = await setup(t, {
    notes: [
      note(
        7,
        "Proposed pilot:\n8 reps for two weeks; subject to security approval.\n\nDecisions:\nDaniel owns pilot coordination."
      ),
    ],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const [proposal, decision] = fetched.data.sources[0].passages;
  const present = registry.get("salesforce_present_briefing");
  assert.ok(present);
  const result = await present.execute(
    {
      briefingId: fetched.data.briefingId,
      findings: [
        { passageId: proposal.id, status: "proposed", category: "proposal" },
        { passageId: decision.id, status: "confirmed", category: "decision" },
      ],
      conflicts: [],
    },
    context()
  );
  assert.equal(result.success, true);
  assert.match(
    result.renderedAnswer.content,
    /Proposed.*8 reps for two weeks; subject to security approval\./s
  );
  assert.match(result.renderedAnswer.content, /Daniel owns pilot coordination\./);
  assert.match(result.renderedAnswer.content, /\[\^sf-[a-z0-9-]+-1\]/);
  assert.ok(result.renderedAnswer.content.includes(`(${activityUrl})`));
  assert.ok(result.renderedAnswer.content.includes(`(${recordUrl})`));
  // SQLite's UTC time without a zone, never read as local time.
  assert.ok(
    result.renderedAnswer.content.includes(`Note created: ${when("2026-11-17T11:07:00Z")}.`)
  );
  assert.doesNotMatch(result.renderedAnswer.content, /Meeting date: 2026/);
  assert.equal(result.data.untrusted, true);
});

test("presentation rejects invented evidence and downgrades explicitly proposed passages", async (t) => {
  const registry = await setup(t, { notes: [note(7, "Proposed pilot:\n8 reps for two weeks.")] });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const present = registry.get("salesforce_present_briefing");
  assert.ok(present);
  for (const finding of [
    { passageId: "invented", status: "confirmed", category: "decision" },
    {
      passageId: fetched.data.sources[0].passages[0].id,
      status: "confirmed",
      category: "decision",
    },
  ]) {
    const result = await present.execute(
      { briefingId: fetched.data.briefingId, findings: [finding], conflicts: [] },
      context()
    );
    if (finding.passageId === "invented") {
      assert.equal(result.success, false);
      assert.equal(result.renderedAnswer, undefined);
    } else {
      assert.equal(result.success, true);
      assert.match(result.renderedAnswer.content, /Proposed:\*\* 8 reps/);
      assert.doesNotMatch(result.renderedAnswer.content, /Confirmed:/);
    }
  }
});

test("conflicts require distinct real passages and preserve both sources without reconciling them", async (t) => {
  const registry = await setup(t, {
    items: [facts, source(7), source(8)],
    notes: [note(7, "Decision: pilot approved."), note(8, "Decision: pilot declined.")],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const passageIds = fetched.data.sources.map((item) => item.passages[0].id);
  const present = registry.get("salesforce_present_briefing");
  assert.ok(present);
  const args = { briefingId: fetched.data.briefingId, findings: [], conflicts: [{ passageIds }] };
  const result = await present.execute(args, context());
  assert.equal(result.success, true);
  assert.match(result.renderedAnswer.content, /Potential conflict/);
  assert.match(result.renderedAnswer.content, /pilot approved/);
  assert.match(result.renderedAnswer.content, /pilot declined/);
  assert.equal(
    (
      await present.execute(
        { ...args, conflicts: [{ passageIds: [passageIds[0], passageIds[0]] }] },
        context()
      )
    ).success,
    false
  );
});

test("a single conflict object from the provider retains both decisions and all evidence validation", async (t) => {
  const registry = await setup(t, {
    notes: [
      note(
        7,
        "Meeting A:\nThe approved pilot has 8 representatives for two weeks.\n\nMeeting B:\nThe approved pilot has 12 representatives for four weeks."
      ),
    ],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const passageIds = fetched.data.sources[0].passages.map((passage) => passage.id);
  const present = registry.get("salesforce_present_briefing");
  const args = { briefingId: fetched.data.briefingId, findings: [], conflicts: { passageIds } };
  const result = await present.execute(args, context());
  assert.equal(result.success, true);
  assert.match(result.renderedAnswer.content, /Potential conflict — unresolved/);
  assert.match(result.renderedAnswer.content, /8 representatives for two weeks/);
  assert.match(result.renderedAnswer.content, /12 representatives for four weeks/);
  for (const conflicts of [
    { passageIds: [passageIds[0], "invented"] },
    { passageIds: [passageIds[0], passageIds[0]] },
    { passageIds, conclusion: "Meeting B supersedes Meeting A" },
  ]) {
    assert.equal((await present.execute({ ...args, conflicts }, context())).success, false);
  }
});

test("large notes are bounded with explicit limits instead of implying complete coverage", async (t) => {
  const registry = await setup(t, { notes: [note(7, "A long observation.\n".repeat(5000))] });
  const result = await registry.get("salesforce_get_briefing").execute(record, context());
  assert.equal(result.data.truncated, true);
  assert.ok(JSON.stringify(result.data.sources).length < 22000);
  assert.match(result.renderedAnswer.content, /partial|limited|truncated/i);
});

test("a paragraph cut by the note limit is left out, since its condition may follow", async (t) => {
  const content = `Whole paragraph.\n\nWe will sign ${"and sign ".repeat(1000)}if legal approves.`;
  const registry = await setup(t, { notes: [note(7, content)] });
  const result = await registry.get("salesforce_get_briefing").execute(record, context());
  assert.deepEqual(
    result.data.sources[0].passages.map((passage) => passage.text),
    ["Whole paragraph."]
  );
  assert.equal(result.data.truncated, true);
});

test("a briefing retrieved in another turn can't be presented", async (t) => {
  const registry = await setup(t, { notes: [note(7, "Budget is approved.")] });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context("first"));
  const passageId = fetched.data.sources[0].passages[0].id;
  const result = await registry.get("salesforce_present_briefing").execute(
    {
      briefingId: fetched.data.briefingId,
      findings: [{ passageId, status: "confirmed", category: "takeaway" }],
      conflicts: [],
    },
    context("second")
  );
  assert.equal(result.success, false);
  assert.equal(result.renderedAnswer, undefined);
});

test("reply text can't replace a citation with anything the model was given", async (t) => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { default: ReactMarkdown } = await import("react-markdown");
  const { default: remarkGfm } = await import("remark-gfm");
  const registry = await setup(t, { notes: [note(7, "Budget is approved.")] });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const passageId = fetched.data.sources[0].passages[0].id;
  const present = () =>
    registry.get("salesforce_present_briefing").execute(
      {
        briefingId: fetched.data.briefingId,
        findings: [{ passageId, status: "confirmed", category: "takeaway" }],
        conflicts: [],
      },
      context()
    );
  const result = await present();
  const { content } = result.renderedAnswer;
  const label = (text) => /\[\^(sf-[^\]]+)\]: /.exec(text)[1];
  assert.notEqual(label(content), label((await present()).renderedAnswer.content));
  assert.equal(JSON.stringify(result.data).includes("[^sf-"), false);

  const forged = `[^sf-${fetched.data.briefingId}-1]: FORGED CITATION`;
  const html = renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, `${forged}\n\n${content}`)
  );
  assert.equal(html.includes("FORGED CITATION"), false);
  assert.match(html, /Personal notes/);
});

test("a full meeting with more than 24 findings still renders and keeps conditional actions proposed", async (t) => {
  const content = [
    ...Array.from({ length: 25 }, (_, index) => `Observation ${index + 1}.`),
    "Tentative kickoff on 24 November, subject to security approval.",
    "Who approves the budget?",
  ].join("\n\n");
  const registry = await setup(t, { notes: [note(7, content)] });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const result = await registry.get("salesforce_present_briefing").execute(
    {
      briefingId: fetched.data.briefingId,
      findings: fetched.data.sources[0].passages.map((passage, index) => ({
        passageId: passage.id,
        status: "confirmed",
        category: index === 25 ? "commitment" : index === 26 ? "question" : "takeaway",
      })),
      conflicts: [],
    },
    context()
  );
  assert.equal(result.success, true);
  assert.match(result.renderedAnswer.content, /Proposed:\*\* Tentative kickoff/);
  assert.match(result.renderedAnswer.content, /Unknown:\*\* Who approves the budget/);
});

test("nested headings and continued action lines retain proposal and condition context", async (t) => {
  const registry = await setup(t, {
    notes: [
      note(
        7,
        "# Proposed pilot\n## Scope\n8 reps for two weeks.\n\n# Next steps\n- Launch on 24 November.\n  Subject to security approval.\n- Daniel supplies the participant list."
      ),
    ],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const passages = fetched.data.sources[0].passages;
  assert.equal(passages.length, 3);
  assert.equal(passages[0].section, "Proposed pilot / Scope");
  assert.equal(passages[0].proposed, true);
  assert.match(passages[1].text, /Launch on 24 November.*Subject to security approval/s);
  assert.equal(passages[1].proposed, true);
  const result = await registry.get("salesforce_present_briefing").execute(
    {
      briefingId: fetched.data.briefingId,
      findings: passages.map((passage) => ({
        passageId: passage.id,
        status: "confirmed",
        category: "commitment",
      })),
      conflicts: [],
    },
    context()
  );
  assert.equal(result.success, true);
  assert.match(result.renderedAnswer.content, /Proposed:\*\* 8 reps/);
  // Each excerpt is already a list item, so a passage's own bullet goes.
  assert.match(result.renderedAnswer.content, /Proposed:\*\* Launch/);
  assert.match(result.renderedAnswer.content, /Confirmed:\*\* Daniel/);
});

test("two record briefings have independent citation definitions", async (t) => {
  const registry = await setup(t, { notes: [note(7, "Decision: proceed.")] });
  const answers = [];
  for (const recordId of [record.recordId, "006000000000002AAA"]) {
    const fetched = await registry
      .get("salesforce_get_briefing")
      .execute({ ...record, recordId }, context());
    const result = await registry.get("salesforce_present_briefing").execute(
      {
        briefingId: fetched.data.briefingId,
        findings: [
          {
            passageId: fetched.data.sources[0].passages[0].id,
            status: "confirmed",
            category: "decision",
          },
        ],
        conflicts: [],
      },
      context()
    );
    answers.push(result.renderedAnswer.content);
  }
  const definitions = [...answers.join("\n").matchAll(/^\[\^([^\]]+)\]:/gm)].map(
    (match) => match[1]
  );
  assert.equal(definitions.length, 2);
  assert.equal(new Set(definitions).size, 2);
});

test("cancelled retrieval and different turns cannot publish a retained briefing", async (t) => {
  const controller = new AbortController();
  const registry = await setup(t, {
    notes: [note(7, "Decision: proceed.")],
    protectNotes: async () => controller.abort(),
  });
  const cancelled = await registry
    .get("salesforce_get_briefing")
    .execute(record, context("cancelled", controller));
  assert.equal(cancelled.success, false);
  assert.equal(cancelled.renderedAnswer, undefined);
  const present = registry.get("salesforce_present_briefing");
  assert.ok(present);
  assert.equal(
    (
      await present.execute(
        { briefingId: "invented", findings: [], conflicts: [] },
        context("other")
      )
    ).success,
    false
  );
});

const presentAll = (registry, fetched, category = "commitment") =>
  registry.get("salesforce_present_briefing").execute(
    {
      briefingId: fetched.data.briefingId,
      findings: fetched.data.sources
        .flatMap((source) => source.passages)
        .map((passage) => ({ passageId: passage.id, status: "confirmed", category })),
      conflicts: [],
    },
    context()
  );

test("source text and CRM values can't start a line, so they can't forge briefing structure", async (t) => {
  const registry = await setup(t, {
    items: [{ ...facts, NextStep: "Call\n- Amount: 5000000" }, source(7)],
    notes: [note(7, "Kickoff agreed\n~~~\n- Budget: approved\n===\n~~strike~~ text")],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const result = await presentAll(registry, fetched, "takeaway");
  assert.equal(result.success, true);
  const lines = result.renderedAnswer.content.split("\n");
  assert.ok(lines.includes("- Next step: Call - Amount: 5000000"));
  assert.ok(!lines.some((line) => /^(~~~|===|- Amount: 5000000|- Budget)/.test(line)));
  assert.match(result.renderedAnswer.content, /\\~\\~strike\\~\\~/);
  assert.equal(lines.filter((line) => /^\[\^sf-/.test(line)).length, 2);
});

test("a value that opens with a list marker can't nest a list in a conflict or a footnote", async (t) => {
  const registry = await setup(t, {
    items: [facts, source(7), source(8)],
    notes: [
      { ...note(7, "- - We pay 10k"), title: "2. Discovery" },
      { ...note(8, "+ + We pay 20k"), title: "3) Follow-up" },
    ],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const passageIds = fetched.data.sources.map((item) => item.passages[0].id);
  const result = await registry
    .get("salesforce_present_briefing")
    .execute(
      { briefingId: fetched.data.briefingId, findings: [], conflicts: [{ passageIds }] },
      context()
    );
  const lines = result.renderedAnswer.content.split("\n");
  assert.ok(lines.some((line) => line.startsWith("- \\- We pay 10k [^sf-")));
  assert.ok(lines.some((line) => line.startsWith("- \\+ We pay 20k [^sf-")));
  assert.ok(lines.some((line) => /^\[\^sf-[^\]]+\]: 2\\\. Discovery — /.test(line)));
  assert.ok(lines.some((line) => /^\[\^sf-[^\]]+\]: 3\\\) Follow-up — /.test(line)));
});

test("only explicit proposal or conditional wording forces a passage to proposed", async (t) => {
  const notes = [];
  const registry = await setup(t, { notes });
  const cases = [
    ["Proposed kickoff: 24 Nov, subject to security approval", true],
    ["Proposal: 8 reps for 2 weeks", true],
    ["**Proposal:** 8 reps for 2 weeks", true],
    ["- **Proposal:** 8 reps for 2 weeks", true],
    ["Daniel proposed 50% less admin time", true],
    ["The $24,000 annual budget is only a planning estimate", true],
    ["Sarah has not approved these targets", true],
    ["Sarah hasn\u2019t approved the proposal", true],
    ["The proposal has not yet been approved", true],
    ["The proposed pilot was approved by Sarah", true],
    ["## Proposed pilot\n8 reps for two weeks.", true],
    ["## Proposals\n8 reps for two weeks.", true],
    ["We will sign by Friday if legal approves", true],
    ["We'll sign by Friday if legal approves", true],
    ["If legal approves, we’ll sign by Friday", true],
    ["If legal approves, we will sign by Friday", true],
    ["We will confirm the date if legal approves", true],
    ["We will proceed unless legal objects", true],
    ["They tentatively agreed to a two week pilot", true],
    ["Sarah approved the proposal subject to redlines", true],
    ["## Proposal review\nWe rejected the proposal", true],
    ["Sarah approved the proposal and signed the order form", false],
    ["We rejected the proposal", false],
    ["The proposal was signed on Tuesday", false],
    ["**Outcome:** Sarah approved the proposal", false],
    ["- We rejected the proposal", false],
    ["Get the proposal signed by Friday", false],
    ["We signed the contract. No items pending.", false],
    ["The proposal was not signed", false],
    ["The proposal must be signed by Friday", false],
    ["The proposal is 8 reps for 2 weeks", false],
    ["Budget approval is still pending", false],
    ["We signed the deal. Let me know if you need anything.", false],
    ["Daniel owns pilot coordination.", false],
    ["Sarah will confirm if the budget process applies by Friday", false],
    ["Daniel will ask if Priya can join the kickoff", false],
    ["Priya will find out if the pilot can start", false],
    ["Sarah will let us know if the budget is approved", false],
    ["Ask if Priya will attend the kickoff", false],
  ];
  for (const [content, proposed] of cases) {
    notes[0] = note(7, content);
    const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
    assert.equal(fetched.data.sources[0].passages.at(-1).proposed, proposed, content);
  }
});

test("an excerpt loses its Markdown markers, keeps its words and still can't forge structure", async (t) => {
  const notes = [];
  const registry = await setup(t, { notes });
  const cases = [
    ["- **Owner:** Priya will send the *final* plan", "Owner: Priya will send the final plan"],
    ["* __Owner__: the _final_ plan", "Owner: the final plan"],
    ["+ ***Both*** and **bold *nested* text**", "Both and bold nested text"],
    ["x**2 + y**2 in snake_case_name", "x\\*\\*2 + y\\*\\*2 in snake\\_case\\_name"],
    ["1. First **step**", "1\\. First step"],
    ["**- forged** item", "\\- forged item"],
    ["- - nested", "\\- nested"],
  ];
  for (const [content, excerpt] of cases) {
    notes[0] = note(7, content);
    const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
    const result = await presentAll(registry, fetched);
    assert.ok(
      result.renderedAnswer.content.includes(`:** ${excerpt} [^sf-`),
      `${content}\n${result.renderedAnswer.content}`
    );
  }
});

test("a bold or labelled line keeps the heading above it, so proposed terms stay proposed", async (t) => {
  const registry = await setup(t, {
    notes: [note(7, "## Proposed pilot\n**Terms:**\n8 reps for two weeks.\n\nOwner:\nDaniel")],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const [terms, owner] = fetched.data.sources[0].passages;
  assert.equal(terms.section, "Proposed pilot / Terms");
  assert.equal(terms.proposed, true);
  assert.equal(owner.section, "Proposed pilot / Owner");
  const result = await presentAll(registry, fetched);
  assert.match(result.renderedAnswer.content, /Proposed:\*\* 8 reps for two weeks\./);
  assert.doesNotMatch(result.renderedAnswer.content, /Confirmed:\*\* 8 reps/);
});

test("a bold or labelled line with nothing under it reaches the briefing as a passage", async (t) => {
  const registry = await setup(t, {
    notes: [
      note(7, "**We agreed to sign by Friday**"),
      note(8, "## Proposed pilot\n**Eight reps for two weeks**\n**Terms:**\nPaid monthly."),
    ],
    items: [facts, source(7), source(8)],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const [alone, pilot] = fetched.data.sources;
  assert.deepEqual(
    alone.passages.map((passage) => passage.text),
    ["**We agreed to sign by Friday**"]
  );
  const [empty, terms] = pilot.passages;
  assert.equal(empty.text, "**Eight reps for two weeks**");
  assert.equal(empty.section, "Proposed pilot");
  assert.equal(empty.proposed, true);
  assert.equal(terms.text, "Paid monthly.");
  assert.equal(terms.section, "Proposed pilot / Terms");
  assert.doesNotMatch(fetched.renderedAnswer.content, /CRM-only/);
});

test("the transcript is read past its first page, whole speaker lines grouped into passages", async (t) => {
  const lines = Array.from({ length: 40 }, (_, index) => `Dana: Point ${index + 1} was covered.`);
  lines.push("Lee: We sign by Friday if legal approves.");
  const transcriptNote = { ...note(7, ""), transcript: lines.join("\n") };
  const registry = await setup(t, { notes: [transcriptNote] });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const passages = fetched.data.sources[0].passages;
  assert.ok(lines.join("\n").length > 1000);
  // Fewer passages than lines, each about 400 characters of whole lines.
  assert.ok(passages.length > 1 && passages.length < lines.length);
  assert.ok(passages.every((passage) => passage.text.length <= 400));
  assert.deepEqual(
    passages.flatMap((passage) => passage.text.split("\n")),
    lines
  );
  assert.equal(fetched.data.truncated, false);
  assert.match(passages.at(-1).section, /^Transcript characters \d+–\d+$/);
});

test("a one-line transcript longer than the budget publishes whole sentences", async (t) => {
  const sentences = Array.from(
    { length: 400 },
    (_, index) => `Point ${index + 1} was covered, if legal approves.`
  );
  const registry = await setup(t, {
    notes: [{ ...note(7, ""), transcript: sentences.join(" ") }],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const passages = fetched.data.sources[0].passages;
  assert.ok(passages.length > 1);
  assert.ok(passages.every((passage) => passage.text.endsWith("if legal approves.")));
  assert.ok(passages.every((passage) => passage.text.length < 500));
  assert.equal(fetched.data.truncated, true);
});

test("a one-line Japanese transcript splits at sentence marks, never inside a quote or number", async (t) => {
  const sentence = "田中さんは「承認します。」と言い、予算は3.5万ドルになりました。";
  const registry = await setup(t, {
    notes: [{ ...note(7, ""), transcript: sentence.repeat(400) }],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const passages = fetched.data.sources[0].passages;
  assert.ok(passages.length > 1);
  assert.ok(passages.every((passage) => passage.text.length < 500));
  assert.ok(
    passages.every((passage) => passage.text.replaceAll(sentence, "") === ""),
    "every passage holds whole sentences"
  );
  assert.equal(fetched.data.truncated, true);
});

test("transcript text the briefing doesn't publish leaves its budget to the next notes", async (t) => {
  const transcript = (length) =>
    Array.from({ length }, (_, index) => `Dana: Line ${index + 1} is here.`).join("\n");
  const bullets = Array.from({ length: 60 }, (_, index) => `- Item ${index + 1}`).join("\n");
  const registry = await setup(t, {
    items: [facts, source(7), source(8), source(9)],
    notes: [
      // Its bullets fill the passages, so none of its transcript is published.
      { ...note(7, bullets), transcript: transcript(200) },
      { ...note(8, ""), transcript: transcript(250) },
      { ...note(9, ""), transcript: transcript(200) },
    ],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const [first, , third] = fetched.data.sources;
  assert.equal(first.passages.length, 60);
  assert.match(third.passages.at(-1).text, /Dana: Line 200 is here\.$/);
});

test("a transcript longer than the budget publishes only whole lines and says coverage is partial", async (t) => {
  const lines = Array.from(
    { length: 400 },
    (_, index) => `Dana: Line ${index + 1} ends here, if legal approves.`
  );
  const registry = await setup(t, { notes: [{ ...note(7, ""), transcript: lines.join("\n") }] });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const passages = fetched.data.sources[0].passages;
  assert.ok(passages.length > 0);
  assert.ok(
    passages.every((passage) => passage.text.split("\n").every((line) => lines.includes(line)))
  );
  assert.equal(fetched.data.truncated, true);
  assert.match(fetched.renderedAnswer.content, /partial/i);
});

test("a conflict can set a meeting passage against a CRM value, never two CRM values or an ID", async (t) => {
  const registry = await setup(t, {
    notes: [note(7, "Decision: we are in contract negotiation.")],
  });
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  assert.deepEqual(fetched.data.crmFactIds, ["CRM:Name", "CRM:StageName", "CRM:CloseDate"]);
  const passageId = fetched.data.sources[0].passages[0].id;
  const present = registry.get("salesforce_present_briefing");
  const args = (passageIds) => ({
    briefingId: fetched.data.briefingId,
    findings: [],
    conflicts: [{ passageIds }],
  });
  const result = await present.execute(args([passageId, "CRM:StageName"]), context());
  assert.equal(result.success, true);
  assert.match(
    result.renderedAnswer.content,
    /Potential conflict — unresolved\n\n- Decision: we are in contract negotiation\. \[\^sf-[^\]]+\]\n- Salesforce Stage: Needs Analysis/
  );
  for (const passageIds of [
    ["CRM:StageName", "CRM:CloseDate"],
    [passageId, "CRM:OwnerId"],
    [passageId, "CRM:Amount"],
  ])
    assert.equal((await present.execute(args(passageIds), context())).success, false);
});

test("notes the user chose for a briefing are passed on, read first and marked as added", async (t) => {
  const queries = [];
  const registry = await setup(t, {
    queries,
    items: [facts, source(7), { kind: "note", noteId: 8 }],
    notes: [note(7, "Linked decision."), note(8, "Chosen decision.")],
  });
  const fetched = await registry
    .get("salesforce_get_briefing")
    .execute({ ...record, noteIds: [8, 8] }, context());
  assert.deepEqual(queries[0].args.noteIds, [8]);
  assert.deepEqual(
    fetched.data.sources.map((item) => [item.passages[0].text, item.explicit]),
    [
      ["Chosen decision.", true],
      ["Linked decision.", false],
    ]
  );
  assert.match(fetched.renderedAnswer.content, /Added for this briefing\./);
  // An ID sent as a digit string is the same note.
  const asString = await registry
    .get("salesforce_get_briefing")
    .execute({ ...record, noteIds: ["8"] }, context());
  assert.deepEqual(queries[1].args.noteIds, [8]);
  assert.equal(asString.data.sources[0].explicit, true);
  for (const noteIds of [[0], ["8a"], Array.from({ length: 11 }, (_, index) => index + 1)]) {
    const refused = await registry
      .get("salesforce_get_briefing")
      .execute({ ...record, noteIds }, context());
    assert.equal(refused.data.status, "failed");
  }
  assert.equal(queries.length, 2);
  // A chosen note that an export also links still comes first.
  const linked = await setup(t, {
    items: [facts, source(7), source(8)],
    notes: [note(7, "Linked decision."), note(8, "Chosen decision.")],
  });
  const chosenFirst = await linked
    .get("salesforce_get_briefing")
    .execute({ ...record, noteIds: [8] }, context());
  assert.deepEqual(
    chosenFirst.data.sources.map((item) => [item.passages[0].text, item.explicit]),
    [
      ["Chosen decision.", true],
      ["Linked decision.", false],
    ]
  );
});

test("a person's Name is labelled as a person's name, in languages that word it differently", async (t) => {
  const registry = await setup(t, {
    items: [
      { ...facts, objectType: "Contact", recordId: "003000000000001AAA", Name: "Dana Lee" },
      source(7),
    ],
    notes: [note(7, "Decision: proceed.")],
  });
  const i18n = await loadI18n();
  const previous = i18n.language;
  await i18n.changeLanguage("ru");
  t.after(() => i18n.changeLanguage(previous));
  const contact = await registry
    .get("salesforce_get_briefing")
    .execute({ objectType: "Contact", recordId: "003000000000001AAA" }, context());
  assert.match(contact.renderedAnswer.content, /^- Имя: Dana Lee$/m);
  assert.doesNotMatch(contact.renderedAnswer.content, /Название: Dana Lee/);
});

test("the briefing is written in the app's language", async (t) => {
  const registry = await setup(t, { notes: [note(7, "Decision: proceed.")] });
  const i18n = await loadI18n();
  const previous = i18n.language;
  await i18n.changeLanguage("de");
  t.after(() => i18n.changeLanguage(previous));
  const fetched = await registry.get("salesforce_get_briefing").execute(record, context());
  const result = await presentAll(registry, fetched, "decision");
  assert.match(result.renderedAnswer.content, /### Aktuelle CRM-Daten/);
  assert.match(result.renderedAnswer.content, /- Phase: Needs Analysis/);
  assert.match(result.renderedAnswer.content, /\*\*Bestätigt:\*\* Decision: proceed\./);
  assert.doesNotMatch(result.renderedAnswer.content, /Current CRM facts|Confirmed:/);
});
