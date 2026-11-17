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
const source = (noteId) => ({
  kind: "note",
  noteId,
  title: "Discovery",
  context: "linked",
  activityUrl,
});
const context = (messageId = "briefing", controller = new AbortController()) => ({
  messageId,
  toolCallId: "brief",
  signal: controller.signal,
});

async function setup(t, { notes = [], items = [facts, source(7)], protectNotes } = {}) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async () => ({ status: "ok", items, truncated: false }),
        getNote: async (id) => notes.find((note) => note.id === id) ?? null,
      },
    },
  });
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");
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
  assert.match(result.renderedAnswer.content, /2026-11-17T12:09:35\.016Z/);
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
  assert.match(result.renderedAnswer.content, /Note created: 2026-11-17 11:07:00/);
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
  assert.match(result.renderedAnswer.content, /Proposed:\*\* - Launch/);
  assert.match(result.renderedAnswer.content, /Confirmed:\*\* - Daniel/);
});

test("two record briefings have independent citation definitions and disclose their exclusive reply scope", async (t) => {
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
    assert.match(result.renderedAnswer.content, /other questions.*separate message/i);
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
