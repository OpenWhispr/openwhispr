const test = require("node:test");
const assert = require("node:assert/strict");

const loadPrompt = () => import("../../src/helpers/dictionaryPrompt.js");
const loadScript = () => import("../../src/utils/chineseScript.js");

test("default order keeps dictionary first and triggers last", async () => {
  const { buildDictionaryPrompt } = await loadPrompt();
  assert.equal(buildDictionaryPrompt(["most", "least"], ["trig"]), "most, least, trig");
});

test("mostUsedLast reverses the dictionary but keeps triggers at the tail", async () => {
  const { buildDictionaryPrompt } = await loadPrompt();
  assert.equal(
    buildDictionaryPrompt(["most", "mid", "least"], ["trig1", "trig2"], { mostUsedLast: true }),
    "least, mid, most, trig1, trig2"
  );
});

test("mostUsedLast does not mutate the caller's dictionary array", async () => {
  const { buildDictionaryPrompt } = await loadPrompt();
  const dictionary = ["most", "least"];
  buildDictionaryPrompt(dictionary, [], { mostUsedLast: true });
  assert.deepEqual(dictionary, ["most", "least"]);
});

test("returns null when there are no words at all", async () => {
  const { buildDictionaryPrompt } = await loadPrompt();
  assert.equal(buildDictionaryPrompt([], []), null);
  assert.equal(buildDictionaryPrompt(null, undefined), null);
});

test("triggers alone still produce a prompt", async () => {
  const { buildDictionaryPrompt } = await loadPrompt();
  assert.equal(buildDictionaryPrompt([], ["trig"], { mostUsedLast: true }), "trig");
});

test("truncation keeps the tail aligned to a word start", async () => {
  const { truncateDictionaryPromptTail } = await loadPrompt();
  const prompt = "aaaa, bbbb, cccc, dddd";
  const result = truncateDictionaryPromptTail(prompt, 14);
  assert.equal(result, "cccc, dddd");
});

test("truncation keeps the most-used tail of a long list", async () => {
  const { buildDictionaryPrompt, truncateDictionaryPromptTail } = await loadPrompt();
  const dictionary = Array.from({ length: 200 }, (_, i) => `word${i}`);
  const prompt = buildDictionaryPrompt(dictionary, ["trig"], { mostUsedLast: true });
  const truncated = truncateDictionaryPromptTail(prompt, 100);
  assert.ok(truncated.length <= 100);
  assert.ok(truncated.endsWith("word1, word0, trig"));
});

test("a tail without a comma is returned as-is", async () => {
  const { truncateDictionaryPromptTail } = await loadPrompt();
  const result = truncateDictionaryPromptTail("x".repeat(50), 10);
  assert.equal(result, "x".repeat(10));
});

test("the Chinese script bias survives the cap and the most-used tail is kept", async () => {
  const { buildDictionaryPrompt, budgetDictionaryPrompt } = await loadPrompt();
  const { getChineseScriptPromptBias, mergeWhisperPrompt } = await loadScript();
  const bias = getChineseScriptPromptBias("simplified");
  const dictionary = Array.from({ length: 400 }, (_, i) => `term${i}`);
  const MAX_PROMPT_CHARS = 890;

  const prompt = mergeWhisperPrompt(
    budgetDictionaryPrompt(
      buildDictionaryPrompt(dictionary, [], { mostUsedLast: true }),
      bias,
      MAX_PROMPT_CHARS
    ),
    "simplified"
  );

  assert.ok(prompt.length <= MAX_PROMPT_CHARS);
  assert.ok(prompt.startsWith(bias));
  assert.ok(prompt.endsWith("term1, term0"));
});

test("budgetDictionaryPrompt drops the dictionary when the prefix fills the cap", async () => {
  const { budgetDictionaryPrompt } = await loadPrompt();
  assert.equal(budgetDictionaryPrompt("aaaa, bbbb", "x".repeat(10), 10), null);
  assert.equal(budgetDictionaryPrompt("aaaa, bbbb", null, 6), "bbbb");
  assert.equal(budgetDictionaryPrompt("aaaa, bbbb", "bias", NaN), "aaaa, bbbb");
  assert.equal(budgetDictionaryPrompt(null, "bias", 100), null);
});

test("prompts within the cap and invalid caps are returned unchanged", async () => {
  const { truncateDictionaryPromptTail } = await loadPrompt();
  assert.equal(truncateDictionaryPromptTail("short, list", 900), "short, list");
  assert.equal(truncateDictionaryPromptTail("short, list", 0), "short, list");
  assert.equal(truncateDictionaryPromptTail("short, list", NaN), "short, list");
  assert.equal(truncateDictionaryPromptTail(null, 10), null);
});
