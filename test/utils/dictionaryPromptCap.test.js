const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/dictionaryPromptCap.js");

test("formatDictionaryPrompt personal-only is unchanged", async () => {
  const { formatDictionaryPrompt } = await load();
  assert.equal(formatDictionaryPrompt([["a", "b"], [], []], 900), "a, b");
});

test("formatDictionaryPrompt drops lowest tier first and ends with the personal tier", async () => {
  const { formatDictionaryPrompt } = await load();
  const workspace = Array.from({ length: 300 }, (_, i) => `ws${String(i).padStart(8, "0")}`);
  const prompt = formatDictionaryPrompt([["Piha", "Biscuit"], [], workspace], 900);
  assert.ok(prompt.endsWith("Piha, Biscuit"));
  assert.ok(prompt.length <= 900);
  assert.ok(prompt.length > 800, "fills the budget with workspace words");
  const words = prompt.split(", ");
  assert.ok(words.indexOf("Piha") > words.findIndex((w) => w.startsWith("ws")));
  // Highest-priority workspace words are kept, in their own order.
  assert.equal(words[0], "ws00000000");
});

test("formatDictionaryPrompt keeps the higher tier last and drops whole words only", async () => {
  const { formatDictionaryPrompt } = await load();
  assert.equal(formatDictionaryPrompt([["P1"], ["S1"], ["W1"]], 100), "W1, S1, P1");
  // 9 chars fits "S1, P1" (6) plus nothing more; W1 is dropped, not truncated.
  assert.equal(formatDictionaryPrompt([["P1"], ["S1"], ["W1"]], 9), "S1, P1");
  // A budget below the first personal entry still sends its head (see below).
  assert.equal(formatDictionaryPrompt([["P1"], ["S1"], ["W1"]], 1), "P");
});

test("a first personal entry longer than the budget is cut down, not dropped", async () => {
  const { formatDictionaryPrompt, selectDictionaryPromptTiers, GROQ_PROMPT_CHARS } = await load();
  const long = "x".repeat(1000);
  const prompt = formatDictionaryPrompt([[long, "P2"], ["S1"], ["W1"]], GROQ_PROMPT_CHARS);
  assert.equal(prompt, "x".repeat(GROQ_PROMPT_CHARS), "the head of the entry, to the budget");
  assert.deepEqual(selectDictionaryPromptTiers([[long, "P2"], ["S1"], []], 10), [
    ["x".repeat(10)],
    [],
    [],
  ]);
  // An entry holding commas is cut back to its last comma inside the budget.
  assert.equal(formatDictionaryPrompt([["Smith, John, Doe"], [], []], 13), "Smith, John");
  // A comma at the very start is no cut point, as in trimDictionaryPrompt.
  assert.equal(formatDictionaryPrompt([[",abcdef"], [], []], 4), ",abc");
  // Shared words are never cut: only the first personal entry is.
  assert.equal(formatDictionaryPrompt([[], ["S".repeat(20)], []], 10), "");
  assert.equal(formatDictionaryPrompt([["P".repeat(20)], [], []], 0), "");
});

test("whole entries are kept up to the budget, an exact fit included", async () => {
  const { formatDictionaryPrompt } = await load();
  // "P1, P2" is exactly 6 characters.
  assert.equal(formatDictionaryPrompt([["P1", "P2", "P3"], [], []], 6), "P1, P2");
  // A later entry that doesn't fit is dropped whole, never cut.
  assert.equal(formatDictionaryPrompt([["P1", "P2", "P3"], [], []], 9), "P1, P2");
  assert.equal(formatDictionaryPrompt([["P1", "x".repeat(50)], [], []], 20), "P1");
});

test("formatDictionaryPrompt returns an empty string for empty tiers", async () => {
  const { formatDictionaryPrompt } = await load();
  assert.equal(formatDictionaryPrompt([[], [], []], 900), "");
});

test("shared limits bound only the shared fill, never the personal tier", async () => {
  const { formatDictionaryPrompt } = await load();
  const personal = ["P1", "P2"];
  // sharedChars caps the whole prompt once shared words join it.
  assert.equal(
    formatDictionaryPrompt([personal, ["S1"], ["W1"]], 900, { sharedChars: 10 }),
    "S1, P1, P2"
  );
  assert.equal(
    formatDictionaryPrompt([personal, ["S1", "S2"], []], 900, { sharedWords: 1 }),
    "S1, P1, P2"
  );
  assert.equal(
    formatDictionaryPrompt([personal, ["S1"], ["W1"]], 900, { totalTerms: 3 }),
    "S1, P1, P2"
  );
  // A personal tier past every shared limit is kept whole and takes no shared words.
  assert.equal(
    formatDictionaryPrompt([personal, ["S1"], []], 900, { sharedChars: 1, totalTerms: 1 }),
    "P1, P2"
  );
  // Without shared words the limits change nothing.
  assert.equal(
    formatDictionaryPrompt([personal, [], []], 900, {
      sharedChars: 1,
      sharedWords: 0,
      totalTerms: 0,
    }),
    "P1, P2"
  );
});

test("totalTerms counts a personal entry with commas as the terms a provider splits it into", async () => {
  const { formatDictionaryPrompt } = await load();
  assert.equal(
    formatDictionaryPrompt([["Smith, John"], ["S1"], []], 900, { totalTerms: 2 }),
    "Smith, John"
  );
  assert.equal(
    formatDictionaryPrompt([["Smith, John"], ["S1"], []], 900, { totalTerms: 3 }),
    "S1, Smith, John"
  );
});

test("selectDictionaryPromptTiers returns the kept words highest priority first", async () => {
  const { selectDictionaryPromptTiers } = await load();
  assert.deepEqual(selectDictionaryPromptTiers([["P1"], ["S1"], ["W1", "W2"]], 12), [
    ["P1"],
    ["S1"],
    ["W1"],
  ]);
});

test("sharedDictionaryPromptChars caps Whisper-style budgets at the decoder window", async () => {
  const {
    sharedDictionaryPromptChars,
    GROQ_PROMPT_CHARS,
    WHISPER_PROMPT_CHARS,
    WHISPER_DECODER_PROMPT_CHARS,
    TRANSCRIBE_PROMPT_CHARS,
  } = await load();
  assert.equal(sharedDictionaryPromptChars(GROQ_PROMPT_CHARS), WHISPER_DECODER_PROMPT_CHARS);
  assert.equal(sharedDictionaryPromptChars(WHISPER_PROMPT_CHARS), WHISPER_DECODER_PROMPT_CHARS);
  assert.equal(sharedDictionaryPromptChars(TRANSCRIBE_PROMPT_CHARS), TRANSCRIBE_PROMPT_CHARS);
});
