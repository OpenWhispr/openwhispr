/**
 * Unit tests for src/helpers/spokenCommands.js
 *
 * Uses the project's native test runner (node:test + node:assert).
 * Run with: npm test
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectSpokenCommand, getSpokenCommands } = require("../../src/helpers/spokenCommands");

// ---------------------------------------------------------------------------
// Positive matches — all recognized commands
// ---------------------------------------------------------------------------

const POSITIVE_CASES = [
  // Enter / submit group
  ["press enter", "Return"],
  ["press return", "Return"],
  ["submit", "Return"],
  ["send it", "Return"],
  ["send message", "Return"],
  // New line group
  ["new line", "Shift+Return"],
  ["new paragraph", "Shift+Return"],
  ["line break", "Shift+Return"],
  // Escape group
  ["press escape", "Escape"],
  ["escape", "Escape"],
  ["cancel", "Escape"],
  // Tab group
  ["press tab", "Tab"],
  ["next field", "Tab"],
  ["tab", "Tab"],
  // Backspace group
  ["press backspace", "BackSpace"],
  ["delete that", "BackSpace"],
  ["backspace", "BackSpace"],
];

for (const [phrase, expectedKey] of POSITIVE_CASES) {
  test(`detectSpokenCommand("${phrase}") → key "${expectedKey}"`, () => {
    const result = detectSpokenCommand(phrase);
    assert.notStrictEqual(result, null, `Expected a command match for "${phrase}"`);
    assert.strictEqual(result.key, expectedKey);
  });
}

// ---------------------------------------------------------------------------
// Case-insensitivity
// ---------------------------------------------------------------------------

const CASE_VARIANTS = [
  "Press Enter",
  "PRESS ENTER",
  "Submit",
  "SUBMIT",
  "Send It",
  "New Line",
  "NEW LINE",
  "Escape",
  "ESCAPE",
];

for (const phrase of CASE_VARIANTS) {
  test(`detectSpokenCommand("${phrase}") matches case-insensitively`, () => {
    const result = detectSpokenCommand(phrase);
    assert.notStrictEqual(result, null, `Expected case-insensitive match for "${phrase}"`);
  });
}

// ---------------------------------------------------------------------------
// Trailing punctuation stripped
// ---------------------------------------------------------------------------

const PUNCTUATION_VARIANTS = [
  "press enter.",
  "submit.",
  "submit!",
  "submit?",
  "submit,",
  "submit;",
  "Submit.",
  "Escape.",
  "new line.",
];

for (const phrase of PUNCTUATION_VARIANTS) {
  test(`detectSpokenCommand("${phrase}") matches after stripping trailing punctuation`, () => {
    const result = detectSpokenCommand(phrase);
    assert.notStrictEqual(result, null, `Expected match after punctuation strip for "${phrase}"`);
  });
}

// ---------------------------------------------------------------------------
// Negative matches — partial sentences must NOT fire a command
// ---------------------------------------------------------------------------

const NEGATIVE_CASES = [
  "I pressed enter into the competition",
  "please submit the following text",
  "make sure to submit this form later",
  "I need to escape the loop",
  "let me add a new line here",
  "hello world press enter", // command phrase at end of longer text
  "press enter now please", // extra words after the phrase
  "don't escape", // prefix before the phrase
];

for (const phrase of NEGATIVE_CASES) {
  test(`detectSpokenCommand("${phrase}") returns null (partial sentence)`, () => {
    const result = detectSpokenCommand(phrase);
    assert.strictEqual(result, null, `Expected null for partial-sentence phrase "${phrase}"`);
  });
}

// ---------------------------------------------------------------------------
// Edge / boundary cases
// ---------------------------------------------------------------------------

test('detectSpokenCommand("") returns null', () => {
  assert.strictEqual(detectSpokenCommand(""), null);
});

test("detectSpokenCommand(whitespace-only) returns null", () => {
  assert.strictEqual(detectSpokenCommand("   "), null);
});

test("detectSpokenCommand(null) returns null", () => {
  assert.strictEqual(detectSpokenCommand(null), null);
});

test("detectSpokenCommand(undefined) returns null", () => {
  assert.strictEqual(detectSpokenCommand(undefined), null);
});

test("detectSpokenCommand(number) returns null", () => {
  assert.strictEqual(detectSpokenCommand(42), null);
});

test("detectSpokenCommand trims leading/trailing whitespace before matching", () => {
  const result = detectSpokenCommand("  press enter  ");
  assert.notStrictEqual(result, null);
  assert.strictEqual(result.key, "Return");
});

test("matched command has key (string) and label (string) properties", () => {
  const result = detectSpokenCommand("submit");
  assert.ok(result, "Expected a non-null result for 'submit'");
  assert.strictEqual(typeof result.key, "string");
  assert.strictEqual(typeof result.label, "string");
  assert.ok(result.key.length > 0, "key should be non-empty");
  assert.ok(result.label.length > 0, "label should be non-empty");
});

// ---------------------------------------------------------------------------
// getSpokenCommands API contract
// ---------------------------------------------------------------------------

test("getSpokenCommands returns a non-empty array", () => {
  const commands = getSpokenCommands();
  assert.ok(Array.isArray(commands), "Expected an array");
  assert.ok(commands.length > 0, "Expected at least one command");
});

test("each command has phrases (array), key (string), and label (string)", () => {
  for (const cmd of getSpokenCommands()) {
    assert.ok(Array.isArray(cmd.phrases), `phrases should be an array in command "${cmd.key}"`);
    assert.ok(cmd.phrases.length > 0, `phrases should be non-empty in command "${cmd.key}"`);
    assert.strictEqual(typeof cmd.key, "string", `key should be a string in "${cmd.key}"`);
    assert.strictEqual(typeof cmd.label, "string", `label should be a string in "${cmd.key}"`);
  }
});

test("all phrases in getSpokenCommands are lower-case strings", () => {
  for (const cmd of getSpokenCommands()) {
    for (const phrase of cmd.phrases) {
      assert.strictEqual(typeof phrase, "string", "phrase must be a string");
      assert.strictEqual(phrase, phrase.toLowerCase(), `phrase "${phrase}" should be lower-case`);
    }
  }
});

test("every phrase in getSpokenCommands round-trips through detectSpokenCommand", () => {
  for (const cmd of getSpokenCommands()) {
    for (const phrase of cmd.phrases) {
      const result = detectSpokenCommand(phrase);
      assert.notStrictEqual(result, null, `phrase "${phrase}" should be detectable`);
      assert.strictEqual(result.key, cmd.key, `phrase "${phrase}" should map to key "${cmd.key}"`);
    }
  }
});
