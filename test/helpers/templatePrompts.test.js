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

test("Detailed Notes compiled from its sections is the prompt it replaced, byte for byte", async () => {
  const {
    BUILTIN_ACTIONS,
    DETAILED_NOTES_KEY,
    MEETING_INPUT_PREAMBLE,
    NOTE_INPUT_PREAMBLE,
    compileTemplatePrompt,
  } = await load();
  const detailed = BUILTIN_ACTIONS.find((action) => action.translationKey === DETAILED_NOTES_KEY);
  // Delete this test if the sectioned default is meant to diverge from the flat one.
  const flat = detailed.previousPrompts.at(-1);

  assert.equal(
    compileTemplatePrompt(seededRow(detailed), { isMeetingNote: true }),
    MEETING_INPUT_PREAMBLE + flat
  );
  assert.equal(
    compileTemplatePrompt(seededRow(detailed), { isMeetingNote: false }),
    NOTE_INPUT_PREAMBLE + flat
  );
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
    ]),
    [{ heading: "Next steps", instruction: "Owners and dates." }]
  );
});

test("a summary action edits the current summary with the notes as reference only", async () => {
  const { compileSummaryActionPrompt, buildSummaryActionInput } = await load();
  assert.match(
    compileSummaryActionPrompt({ prompt: "Translate it to Spanish." }),
    /revise an existing AI summary[\s\S]*Instructions: Translate it to Spanish\.$/
  );
  assert.equal(
    buildSummaryActionInput({
      summary: "- shipped",
      notes: "ask about pricing",
      meetingContext: "## Meeting Context\nInvited participants: Alice.",
    }),
    "## Current Summary\n- shipped\n\n## My Notes\nask about pricing\n\n## Meeting Context\nInvited participants: Alice."
  );
  assert.equal(
    buildSummaryActionInput({ summary: "- shipped", notes: "  ", meetingContext: "" }),
    "## Current Summary\n- shipped"
  );
});

test("a chat action asks about the note the chat already has in context", async () => {
  const { compileChatActionPrompt } = await load();
  assert.match(
    compileChatActionPrompt({ prompt: "List the to-dos." }),
    /note I'm viewing[\s\S]*\n\nList the to-dos\.$/
  );
});
