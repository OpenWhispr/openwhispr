const test = require("node:test");
const assert = require("node:assert/strict");
const { stripVoiceStopCommand } = require("../../src/helpers/voiceStopCommand");

test("stripVoiceStopCommand removes exact match at end", () => {
  const result = stripVoiceStopCommand("Testing one two three stop dictation", "stop dictation");
  assert.strictEqual(result, "Testing one two three");
});

test("stripVoiceStopCommand ignores case", () => {
  const result = stripVoiceStopCommand("Testing one two three Stop Dictation", "stop dictation");
  assert.strictEqual(result, "Testing one two three");

  const result2 = stripVoiceStopCommand("hello JARVIS DONE", "jarvis done");
  assert.strictEqual(result2, "hello");
});

test("stripVoiceStopCommand removes trailing punctuation", () => {
  const cases = [
    "Testing one two three stop dictation.",
    "Testing one two three stop dictation!",
    "Testing one two three stop dictation?",
    "Testing one two three stop dictation,",
    "Testing one two three stop dictation...",
  ];

  for (const text of cases) {
    const result = stripVoiceStopCommand(text, "stop dictation");
    assert.strictEqual(result, "Testing one two three", `Failed on: ${text}`);
  }
});

test("stripVoiceStopCommand only removes if at the very end", () => {
  // Should not strip
  const result = stripVoiceStopCommand("I told you to stop dictation yesterday", "stop dictation");
  assert.strictEqual(result, "I told you to stop dictation yesterday");
});

test("stripVoiceStopCommand handles phrase matching the entire string", () => {
  const result = stripVoiceStopCommand("stop dictation", "stop dictation");
  assert.strictEqual(result, "");

  const result2 = stripVoiceStopCommand("stop dictation.", "stop dictation");
  assert.strictEqual(result2, "");
});

test("stripVoiceStopCommand requires word boundaries", () => {
  // Should not strip because it's part of a larger word
  const result = stripVoiceStopCommand("Testing nonestop dictation", "stop dictation");
  assert.strictEqual(result, "Testing nonestop dictation");
});

test("stripVoiceStopCommand handles empty or invalid inputs gracefully", () => {
  assert.strictEqual(stripVoiceStopCommand(null, "stop"), "");
  assert.strictEqual(stripVoiceStopCommand(undefined, "stop"), "");
  assert.strictEqual(stripVoiceStopCommand("hello", ""), "hello");
  assert.strictEqual(stripVoiceStopCommand("hello", null), "hello");
  assert.strictEqual(stripVoiceStopCommand("hello", "  "), "hello");
});
