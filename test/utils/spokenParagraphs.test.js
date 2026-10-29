const test = require("node:test");
const assert = require("node:assert/strict");

const cases = [
  [
    "greeting cannot cross a period into a shortcut list",
    "Hi Alex. Available shortcuts include new line, new paragraph, and undo.",
    "Hi Alex. Available shortcuts include new line, new paragraph, and undo.",
  ],
  [
    "greeting cannot cross an exclamation into a shortcut list",
    "Hello everyone! Available shortcuts include new line, new paragraph, and undo.",
    "Hello everyone! Available shortcuts include new line, new paragraph, and undo.",
  ],
  [
    "salutation cannot cross a period into a shortcut list",
    "Dear Alex. Available shortcuts include new line, new paragraph, and undo.",
    "Dear Alex. Available shortcuts include new line, new paragraph, and undo.",
  ],
  [
    "first comma list item",
    "New paragraph, new line, and undo.",
    "New paragraph, new line, and undo.",
  ],
  ["two comma list items", "New paragraph, undo.", "New paragraph, undo."],
  ["ambiguous command-ending comma", "One. New paragraph, Two.", "One. New paragraph, Two."],
  ["paragraph-only ending comma", "New paragraph,", "\n\n"],
  [
    "comma-separated shortcut names",
    "Available shortcuts include new line, new paragraph, and undo.",
    "Available shortcuts include new line, new paragraph, and undo.",
  ],
  [
    "comma-separated names after a colon",
    "Available shortcuts: new line, new paragraph, undo.",
    "Available shortcuts: new line, new paragraph, undo.",
  ],
  ["unlabelled comma list", "New line, new paragraph, undo.", "New line, new paragraph, undo."],
  ["final comma list item", "New line, undo, new paragraph.", "New line, undo, new paragraph."],
  ["capitalised comma list", "New Line, New Paragraph, Undo.", "New Line, New Paragraph, Undo."],
  [
    "ambiguous comma-delimited prose",
    "First clause, new paragraph, second clause.",
    "First clause, new paragraph, second clause.",
  ],
  ["short greeting", "Hi Alex, new paragraph, Ready.", "Hi Alex,\n\nReady."],
  ["repeated comma commands", "New paragraph, new paragraph, Two.", "\n\n\n\nTwo."],
  [
    "plural possessive within quoted passage",
    "He wrote 'The patients' notes follow. New paragraph. Keep it literal.'",
    "He wrote 'The patients' notes follow. New paragraph. Keep it literal.'",
  ],
  [
    "curly plural possessive within quoted passage",
    "He wrote ‘The patients’ notes follow. New paragraph. Keep it literal.’",
    "He wrote ‘The patients’ notes follow. New paragraph. Keep it literal.’",
  ],
  [
    "shortcut enumeration",
    "Available shortcuts: new paragraph, new line, and undo.",
    "Available shortcuts: new paragraph, new line, and undo.",
  ],
  [
    "unlabelled enumeration",
    "We support the following: new paragraph, new line, and undo.",
    "We support the following: new paragraph, new line, and undo.",
  ],
  [
    "apostrophe within quoted passage",
    "He wrote 'Don't change this. New paragraph. Keep it literal.'",
    "He wrote 'Don't change this. New paragraph. Keep it literal.'",
  ],
  [
    "curly apostrophe within quoted passage",
    "He wrote ‘Don’t change this. New paragraph. Keep it literal.’",
    "He wrote ‘Don’t change this. New paragraph. Keep it literal.’",
  ],
  [
    "prose enumeration",
    "The supported commands are: new paragraph, new line, and undo.",
    "The supported commands are: new paragraph, new line, and undo.",
  ],
  [
    "prose examples",
    "The examples include: new paragraph, new line, and undo.",
    "The examples include: new paragraph, new line, and undo.",
  ],
  ["standalone command", "New paragraph.", "\n\n"],
  ["case and punctuation", "First. NEW PARAGRAPH! Second.", "First.\n\nSecond."],
  [
    "greeting",
    "Dear Alex, new paragraph, The report is ready.",
    "Dear Alex,\n\nThe report is ready.",
  ],
  ["repeated commands", "One. New paragraph. New paragraph. Two.", "One.\n\n\n\nTwo."],
  ["repeated bare commands", "new paragraph new paragraph", "\n\n\n\n"],
  ["edge commands", "New paragraph. One. New paragraph.", "\n\nOne.\n\n"],
  ["existing breaks", "One.\n\nNew paragraph. Two.", "One.\n\n\n\nTwo."],
  ["curly quotation", "Keep “new paragraph” exactly.", "Keep “new paragraph” exactly."],
  ["straight quotation", 'The phrase is "new paragraph".', 'The phrase is "new paragraph".'],
  ["single quotation", "The command is 'new paragraph'.", "The command is 'new paragraph'."],
  ["code", "The command is `new paragraph`.", "The command is `new paragraph`."],
  ["ordinary question", "Does this new paragraph work?", "Does this new paragraph work?"],
  ["ordinary instruction", "Please start a new paragraph.", "Please start a new paragraph."],
  ["reported speech", "I said new paragraph.", "I said new paragraph."],
  ["definition", "New paragraph is a command.", "New paragraph is a command."],
  ["label", "The command is: new paragraph.", "The command is: new paragraph."],
  ["possessive", "Today's new paragraph.", "Today's new paragraph."],
  ["ordinary prose", "I like new paragraph.", "I like new paragraph."],
  [
    "ambiguous bare prose",
    "first sentence new paragraph second sentence",
    "first sentence new paragraph second sentence",
  ],
  ["other commands", "One. New line. Two.", "One. New line. Two."],
  [
    "facts",
    "Right eye 6/12, pressure 16. New paragraph. Left eye 6/9, pressure 18.",
    "Right eye 6/12, pressure 16.\n\nLeft eye 6/9, pressure 18.",
  ],
];

for (const [name, input, expected] of cases) {
  test(`paragraph normalization: ${name}`, async () => {
    const { normalizeSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
    assert.equal(normalizeSpokenParagraphs(input, "en-GB"), expected);
  });
}

test("non-English and auto-detected language preserve the original text", async () => {
  const { normalizeSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  for (const language of ["fr", "auto", "", undefined]) {
    const text = "One. New paragraph. Two.";
    assert.equal(normalizeSpokenParagraphs(text, language), text);
  }
});

test("paragraph-only output is accepted only for exact recognized commands", async () => {
  const { isParagraphOnlyResult } = await import("../../src/utils/spokenParagraphs.js");
  assert.equal(isParagraphOnlyResult("\n\n", "New paragraph.", "en"), true);
  assert.equal(isParagraphOnlyResult("\n\n", "  New paragraph. \n", "en"), true);
  assert.equal(isParagraphOnlyResult("\n\n\n\n", "New paragraph. New paragraph.", "en"), true);
  for (const [output, raw, language] of [
    ["\n", "New paragraph.", "en"],
    ["\n\n", "ordinary text", "en"],
    ["\n\n", "New paragraph.", "fr"],
    ["\n\n", '"new paragraph"', "en"],
    ["", "New paragraph.", "en"],
  ])
    assert.equal(isParagraphOnlyResult(output, raw, language), false);
});

test("one whole-transcript cleanup request retains context and explicit breaks", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  const input = "New paragraph. One. New paragraph. New paragraph. Two. New paragraph.";
  const calls = [];
  const output = await cleanupSpokenParagraphs(
    input,
    async (text) => {
      calls.push(text);
      return text.toUpperCase();
    },
    { language: "en" }
  );
  assert.equal(output, "\n\nONE.\n\n\n\nTWO.\n\n");
  assert.deepEqual(calls, [input]);
});

test("deleted command words are restored as breaks without losing cleaned punctuation", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  const output = await cleanupSpokenParagraphs(
    "Dear Alex. New paragraph. The report is ready.",
    async () => "Dear Alex, The report is ready.",
    { language: "en" }
  );
  assert.equal(output, "Dear Alex,\n\nThe report is ready.");
});

test("quoted mention remains while a separate command becomes a break", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  const output = await cleanupSpokenParagraphs(
    'The phrase "new paragraph" stays. New paragraph. Continue here.',
    async () => 'The phrase "new paragraph" stays. Continue here.',
    { language: "en" }
  );
  assert.equal(output, 'The phrase "new paragraph" stays.\n\nContinue here.');
});

test("unsafe or ambiguous alignment preserves raw words and requested breaks", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  for (const cleaned of [
    "An unrelated response.",
    "One. Two. One. Two.",
    "One. Added words. Two.",
    "",
  ]) {
    assert.equal(
      await cleanupSpokenParagraphs("One. New paragraph. Two.", async () => cleaned, {
        language: "en",
      }),
      "One.\n\nTwo."
    );
  }
});

test("a retained command cannot be used as the anchor for its own boundary", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  assert.equal(
    await cleanupSpokenParagraphs(
      "This is a new paragraph. New paragraph. We continue here.",
      async () => "This is a paragraph. New paragraph. We continue here.",
      { language: "en" }
    ),
    "This is a new paragraph.\n\nWe continue here."
  );
});

test("paragraph-only commands bypass the cleanup model", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  const output = await cleanupSpokenParagraphs(
    "New paragraph.",
    async () => assert.fail("no cleanup request expected"),
    { language: "en" }
  );
  assert.equal(output, "\n\n");
});

test("cancelled requests return their original text", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  const input = "One. New paragraph. Two.";
  let cancelled = false;
  let calls = 0;
  const cleanup = async (text) => {
    calls++;
    cancelled = true;
    return text;
  };
  assert.equal(
    await cleanupSpokenParagraphs(input, cleanup, {
      language: "en",
      wasCancelled: () => cancelled,
    }),
    input
  );
  assert.equal(calls, 1);
  assert.equal(
    await cleanupSpokenParagraphs(input, cleanup, {
      language: "en",
      wasCancelled: () => cancelled,
    }),
    input
  );
  assert.equal(calls, 1);
});

test("model-added delimiters cannot leave unmatched punctuation around a break", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  for (const command of ["(New paragraph.)", "[New paragraph.]", "{New paragraph.}"]) {
    assert.equal(
      await cleanupSpokenParagraphs(
        "Alpha beta. New paragraph. Gamma delta.",
        async () => `Alpha beta. ${command} Gamma delta.`,
        { language: "en" }
      ),
      "Alpha beta.\n\nGamma delta."
    );
  }
});

for (const [name, cleaned, expected] of [
  [
    "dash bullet",
    "Shopping list:\n\n- Apples and bananas.",
    "Shopping list:\n\n- Apples and bananas.",
  ],
  [
    "asterisk bullet",
    "Shopping list:\n\n* Apples and bananas.",
    "Shopping list:\n\n* Apples and bananas.",
  ],
  [
    "plus bullet",
    "Shopping list:\n\n+ Apples and bananas.",
    "Shopping list:\n\n+ Apples and bananas.",
  ],
  [
    "Unicode bullet",
    "Shopping list:\n\n• Apples and bananas.",
    "Shopping list:\n\n• Apples and bananas.",
  ],
  [
    "blockquote",
    "Shopping list:\n\n> Apples and bananas.",
    "Shopping list:\n\n> Apples and bananas.",
  ],
  [
    "indented marker",
    "Shopping list:\r\n\r\n  -\tApples and bananas.",
    "Shopping list:\n\n  -\tApples and bananas.",
  ],
  [
    "retained command before a bullet",
    "Shopping list: New paragraph.\n\n- Apples and bananas.",
    "Shopping list:\n\n- Apples and bananas.",
  ],
  [
    "ambiguous inline marker",
    "Shopping list: - Apples and bananas.",
    "Shopping list.\n\nApples and bananas.",
  ],
  [
    "unsupported numbered list",
    "Shopping list:\n\n1. Apples and bananas.",
    "Shopping list.\n\nApples and bananas.",
  ],
  [
    "unsupported checkbox",
    "Shopping list:\n\n- [ ] Apples and bananas.",
    "Shopping list.\n\nApples and bananas.",
  ],
]) {
  test(`cleanup keeps right-side formatting intact: ${name}`, async () => {
    const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
    assert.equal(
      await cleanupSpokenParagraphs(
        "Shopping list. New paragraph. Apples and bananas.",
        async () => cleaned,
        { language: "en" }
      ),
      expected
    );
  });
}

test("leading paragraph command keeps a list marker with its text", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  assert.equal(
    await cleanupSpokenParagraphs(
      "New paragraph. Apples and bananas.",
      async () => "- Apples and bananas.",
      { language: "en" }
    ),
    "\n\n- Apples and bananas."
  );
});

test("repeated paragraph commands keep a list marker with its text", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  assert.equal(
    await cleanupSpokenParagraphs(
      "Shopping list. New paragraph. New paragraph. Apples and bananas.",
      async () => "Shopping list:\n\n- Apples and bananas.",
      { language: "en" }
    ),
    "Shopping list:\n\n\n\n- Apples and bananas."
  );
});

test("a trailing paragraph command cannot acquire an empty model-added bullet", async () => {
  const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
  assert.equal(
    await cleanupSpokenParagraphs(
      "Shopping list. New paragraph.",
      async () => "Shopping list:\n\n- ",
      { language: "en" }
    ),
    "Shopping list.\n\n"
  );
});

for (const marker of ["##", "–", "◦", "☞"]) {
  test(`unsupported formatting falls back without stranding ${marker}`, async () => {
    const { cleanupSpokenParagraphs } = await import("../../src/utils/spokenParagraphs.js");
    assert.equal(
      await cleanupSpokenParagraphs(
        "Shopping list. New paragraph. Apples and bananas.",
        async () => `Shopping list:\n\n${marker} Apples and bananas.`,
        { language: "en" }
      ),
      "Shopping list.\n\nApples and bananas."
    );
  });
}
