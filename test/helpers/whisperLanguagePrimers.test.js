import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getWhisperLanguagePrimer,
  withLanguagePrimer,
} from "../../src/config/whisperLanguagePrimers.js";
import { matchesDictionaryPrompt } from "../../src/utils/dictionaryEchoFilter.js";

test("greek gets a code-switching primer with latin english terms", () => {
  const primer = getWhisperLanguagePrimer("el");
  assert.match(primer, /[α-ω]/);
  assert.match(primer, /\bemail\b/);
});

test("other languages keep the dictionary prompt unchanged", () => {
  assert.equal(withLanguagePrimer("en", "Foo, Bar"), "Foo, Bar");
  assert.equal(withLanguagePrimer(null, null), null);
});

test("primer goes before dictionary words", () => {
  const p = withLanguagePrimer("el", "OpenWhispr, Softweb");
  assert.ok(p.endsWith("OpenWhispr, Softweb"));
});

test("an echoed primer is caught, normal greek speech is not", () => {
  const primer = getWhisperLanguagePrimer("el");
  assert.ok(matchesDictionaryPrompt(primer, primer));
  assert.ok(!matchesDictionaryPrompt("Στείλε μου το email αύριο", primer));
});
