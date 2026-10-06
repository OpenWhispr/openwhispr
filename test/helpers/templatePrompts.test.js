const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => ({
  ...(await import("../../src/helpers/builtinActions.js")),
  ...(await import("../../src/helpers/templatePrompts.js")),
});

// The row the database seeds from a built-in, as the note store reads it.
const seededRow = (builtin) => ({
  prompt: builtin.prompt,
  sections: builtin.sections,
  translation_key: builtin.translationKey,
});

test("Detailed Notes compiled from its sections is the prompt it replaced, but for its closing rule", async () => {
  const {
    BUILTIN_ACTIONS,
    DETAILED_NOTES_KEY,
    MEETING_INPUT_PREAMBLE,
    NOTE_INPUT_PREAMBLE,
    compileTemplatePrompt,
  } = await load();
  const detailed = BUILTIN_ACTIONS.find((action) => action.translationKey === DETAILED_NOTES_KEY);
  const flat = detailed.previousPrompts.at(-1);
  // The closing rule is its last paragraph: a note with nothing to summarize now
  // answers with a marker instead of a sentence that was saved as its summary.
  const body = flat.slice(0, flat.lastIndexOf("\n\n"));

  for (const [isMeetingNote, preamble] of [
    [true, MEETING_INPUT_PREAMBLE],
    [false, NOTE_INPUT_PREAMBLE],
  ]) {
    const compiled = compileTemplatePrompt(seededRow(detailed), { isMeetingNote });
    assert.ok(compiled.startsWith(preamble + body), "everything before the rule is unchanged");
    assert.match(
      compiled.slice((preamble + body).length),
      /^\n\nFor material with no substantive discussion[^\n]*reply with exactly NOTHING_TO_SUMMARIZE[^\n]*$/
    );
  }
});

test("a template without sections is sent exactly as before templates had sections", async () => {
  const {
    BUILTIN_ACTIONS,
    DETAILED_NOTES_KEY,
    GENERATE_NOTES_KEY,
    MEETING_INPUT_PREAMBLE,
    MEETING_SYSTEM_PROMPT,
    BASE_SYSTEM_PROMPT,
    compileTemplatePrompt,
  } = await load();
  const generate = BUILTIN_ACTIONS.find((action) => action.translationKey === GENERATE_NOTES_KEY);
  assert.equal(
    compileTemplatePrompt(seededRow(generate), { isMeetingNote: true }),
    MEETING_SYSTEM_PROMPT + generate.prompt
  );

  const editedDetailed = { prompt: "My own notes rules.", translation_key: DETAILED_NOTES_KEY };
  assert.equal(
    compileTemplatePrompt(editedDetailed, { isMeetingNote: true }),
    MEETING_INPUT_PREAMBLE + editedDetailed.prompt
  );

  const custom = { prompt: "Summarize for the board.", sections: null, translation_key: null };
  assert.equal(compileTemplatePrompt(custom), BASE_SYSTEM_PROMPT + custom.prompt);
});

test("a sectioned template puts its context before the format rules and keeps section order", async () => {
  const { SECTIONED_NOTES_FORMAT, compileTemplatePrompt } = await load();
  const prompt = compileTemplatePrompt(
    {
      prompt: "A weekly sales pipeline review.",
      sections: [
        { heading: "## Deals", instruction: "One bullet per deal." },
        { heading: "Risks", instruction: "" },
      ],
    },
    { isMeetingNote: true }
  );

  const context = prompt.indexOf("A weekly sales pipeline review.");
  const format = prompt.indexOf(SECTIONED_NOTES_FORMAT);
  const deals = prompt.indexOf("\n## Deals\nOne bullet per deal.");
  const risks = prompt.indexOf("\n## Risks\n\n");
  assert.ok(context > 0 && context < format && format < deals && deals < risks, prompt);
});

test("sections are trimmed, lose their Markdown heading marks, and need a heading", async () => {
  const { normalizeSections } = await load();
  assert.deepEqual(normalizeSections(null), []);
  assert.deepEqual(normalizeSections("not a list"), []);
  assert.deepEqual(
    normalizeSections([
      { heading: "  ### Next steps ", instruction: " Owners and dates. " },
      { heading: "   ", instruction: "No heading, so dropped." },
      { heading: "# # #", instruction: "Only heading marks, so dropped." },
      { heading: "#1 Priority", instruction: "A '#' in the text itself stays." },
    ]),
    [
      { heading: "Next steps", instruction: "Owners and dates." },
      { heading: "#1 Priority", instruction: "A '#' in the text itself stays." },
    ]
  );
});

const MATERIAL = {
  summary: "- shipped",
  notes: "ask about pricing",
  meetingContext: "## Meeting Context\nInvited participants: Alice.",
  transcript: "Alice: we ship Friday.",
};
const TEMPLATE = { kind: "template", prompt: "", sections: [{ heading: "A", instruction: "" }] };
const ACTION = { kind: "action", output: "summary", prompt: "Translate it to Spanish." };

test("a template always reads the transcript, never the summary it replaces", async () => {
  const { buildNoteRunInput } = await load();
  assert.deepEqual(buildNoteRunInput(TEMPLATE, MATERIAL), {
    input:
      "ask about pricing\n\n## Meeting Context\nInvited participants: Alice.\n\n## Meeting Transcript\nAlice: we ship Friday.",
    fromSummary: false,
    // In pieces too, for splitting a long recording on a local model.
    material: {
      notes: "ask about pricing",
      meetingContext: "## Meeting Context\nInvited participants: Alice.",
      transcript: "Alice: we ship Friday.",
    },
  });
});

test("an action reads the summary when there is one, and the transcript when there isn't", async () => {
  const { buildNoteRunInput } = await load();
  assert.deepEqual(buildNoteRunInput(ACTION, MATERIAL), {
    input:
      "## Current Summary\n- shipped\n\n## My Notes\nask about pricing\n\n## Meeting Context\nInvited participants: Alice.",
    fromSummary: true,
  });
  assert.deepEqual(
    buildNoteRunInput(ACTION, { ...MATERIAL, summary: " " }),
    buildNoteRunInput(TEMPLATE, MATERIAL),
    "without a summary, an action reads, and can split, the material a template does"
  );
  assert.equal(
    buildNoteRunInput(ACTION, {
      summary: "- shipped",
      notes: "  ",
      meetingContext: "",
      transcript: "",
    }).input,
    "## Current Summary\n- shipped"
  );
});

test("a summary action revises the summary, or writes one from the material first", async () => {
  const { compileSummaryActionPrompt, MEETING_INPUT_PREAMBLE } = await load();
  assert.match(
    compileSummaryActionPrompt(ACTION, { fromSummary: true }),
    /^You revise an existing AI summary[\s\S]*Instructions: Translate it to Spanish\.$/
  );
  const fromMaterial = compileSummaryActionPrompt(ACTION, {
    fromSummary: false,
    isMeetingNote: true,
  });
  assert.ok(fromMaterial.startsWith(MEETING_INPUT_PREAMBLE));
  assert.match(fromMaterial, /no AI summary yet[\s\S]*Instructions: Translate it to Spanish\.$/);
  assert.match(
    fromMaterial,
    /reply with exactly NOTHING_TO_SUMMARIZE/,
    "a first summary can decline too"
  );
});

test("a chat action works from the summary when there is one, and the transcript when there isn't", async () => {
  const { compileChatActionPrompt } = await load();
  const action = { prompt: "List the to-dos." };
  assert.match(
    compileChatActionPrompt(action, { fromSummary: true }),
    /^Work from the AI summary[\s\S]*\n\nList the to-dos\.$/
  );
  assert.match(
    compileChatActionPrompt(action, { fromSummary: false }),
    /no AI summary yet, so work from its transcript and notes[\s\S]*\n\nList the to-dos\.$/
  );
  for (const fromSummary of [true, false]) {
    assert.match(
      compileChatActionPrompt(action, { fromSummary }),
      /answer here in the chat as text\. Don't use a tool to draft, send or post it/,
      "one click never sends an email or posts to Slack"
    );
    assert.match(
      compileChatActionPrompt(action, { fromSummary }),
      /in the language the note is written in, not the language of these instructions/,
      "the English action prompt doesn't turn a German note's answer into English"
    );
  }
});
