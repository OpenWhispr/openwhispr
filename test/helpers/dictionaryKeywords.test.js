const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/dictionaryKeywords.js");

test("only gpt-transcribe takes the dictionary as keywords", async () => {
  const { usesTranscriptionKeywords } = await load();
  assert.equal(usesTranscriptionKeywords("gpt-transcribe"), true);
  assert.equal(usesTranscriptionKeywords(" gpt-transcribe "), true);
  for (const model of ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1", "", undefined]) {
    assert.equal(usesTranscriptionKeywords(model), false, String(model));
  }
});

test("keywords split the joined dictionary on commas and line breaks", async () => {
  const { dictionaryKeywords } = await load();
  assert.deepEqual(dictionaryKeywords("OpenWhispr, Gizmo Labs,Corti\nVoxtral\r\nParakeet"), [
    "OpenWhispr",
    "Gizmo Labs",
    "Corti",
    "Voxtral",
    "Parakeet",
  ]);
});

test("keywords drop the characters OpenAI rejects and any entry left empty", async () => {
  const { dictionaryKeywords } = await load();
  assert.deepEqual(dictionaryKeywords("<OpenWhispr>, < >, ,, a<b>c\n\n"), ["OpenWhispr", "abc"]);
  assert.deepEqual(dictionaryKeywords(null), []);
  assert.deepEqual(dictionaryKeywords(""), []);
});

test("keywords stop at 900, counted after empty entries are dropped (#2224)", async () => {
  const { dictionaryKeywords } = await load();
  const terms = Array.from({ length: 1481 }, (_, i) => `Term${i}`);
  assert.deepEqual(dictionaryKeywords(", , <>, " + terms.join(", ")), terms.slice(0, 900));
  assert.deepEqual(dictionaryKeywords(terms.slice(0, 900).join(", ")), terms.slice(0, 900));
});

test("terms past the keyword cap are comma-joined for the prompt, never dropped (#2224)", async () => {
  const { dictionaryKeywordOverflow } = await load();
  const terms = Array.from({ length: 1481 }, (_, i) => `Term${i}`);
  assert.equal(
    dictionaryKeywordOverflow(", , <>, " + terms.join(", ")),
    terms.slice(900).join(", ")
  );
  assert.equal(dictionaryKeywordOverflow(terms.slice(0, 900).join(", ")), null);
  assert.equal(dictionaryKeywordOverflow(null), null);
});
