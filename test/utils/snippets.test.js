const test = require("node:test");
const assert = require("node:assert/strict");

const { expandSnippets, getDictionaryHintWords } = require("../../src/utils/snippets.ts");

test("expands a trigger containing Turkish capital İ", () => {
  const snippets = [{ trigger: "İmza", replacement: "Best regards,\nUmut" }];
  assert.equal(expandSnippets("İmza", snippets), "Best regards,\nUmut");
});

test("İ trigger matches every casing the transcript may use", () => {
  const snippets = [{ trigger: "İmza", replacement: "Best regards,\nUmut" }];
  for (const spoken of ["imza", "İmza", "İMZA", "Imza"]) {
    assert.equal(
      expandSnippets(`Meeting is over. ${spoken} please.`, snippets),
      "Meeting is over. Best regards,\nUmut please.",
      `expected "${spoken}" to expand`
    );
  }
});

test("lowercase trigger matches capital İ in the transcript", () => {
  const snippets = [{ trigger: "imza", replacement: "Best regards,\nUmut" }];
  assert.equal(expandSnippets("İmza goes here", snippets), "Best regards,\nUmut goes here");
  assert.equal(expandSnippets("İMZA goes here", snippets), "Best regards,\nUmut goes here");
});

test("dotless ı trigger matches capital I in the transcript", () => {
  const snippets = [{ trigger: "ışık", replacement: "LIGHT" }];
  for (const spoken of ["ışık", "Işık", "IŞIK"]) {
    assert.equal(
      expandSnippets(`${spoken} on`, snippets),
      "LIGHT on",
      `expected "${spoken}" to expand`
    );
  }
});

test("trigger saved with capital I matches both Turkish and English readings", () => {
  const snippets = [{ trigger: "Işık", replacement: "LIGHT" }];
  for (const spoken of ["ışık", "Işık", "IŞIK", "işık"]) {
    assert.equal(
      expandSnippets(`${spoken} on`, snippets),
      "LIGHT on",
      `expected "${spoken}" to expand`
    );
  }
});

test("all-caps English trigger with capital I still matches", () => {
  const snippets = [{ trigger: "IBAN", replacement: "TR00 0000 0000" }];
  assert.equal(expandSnippets("iban please", snippets), "TR00 0000 0000 please");
  assert.equal(expandSnippets("IBAN please", snippets), "TR00 0000 0000 please");
  assert.equal(expandSnippets("İBAN please", snippets), "TR00 0000 0000 please");
});

test("decomposed İ (capital I + combining dot above) still matches", () => {
  const snippets = [{ trigger: "İmza", replacement: "Best regards,\nUmut" }];
  assert.equal(expandSnippets("İmza done".normalize("NFD"), snippets), "Best regards,\nUmut done");
});

test("İ still respects word boundaries", () => {
  const snippets = [{ trigger: "İmza", replacement: "SIGNATURE" }];
  assert.equal(expandSnippets("imzalar are ready", snippets), "imzalar are ready");
  assert.equal(expandSnippets("(İmza) is required", snippets), "(SIGNATURE) is required");
});

test("plain ASCII triggers still fold case both ways", () => {
  const snippets = [{ trigger: "Signoff", replacement: "Regards" }];
  assert.equal(expandSnippets("SIGNOFF now", snippets), "Regards now");
  assert.equal(expandSnippets("signoff now", snippets), "Regards now");
});

test("multiple occurrences and unmatched text are preserved", () => {
  const snippets = [{ trigger: "İmza", replacement: "X" }];
  assert.equal(expandSnippets("İmza and imza, done", snippets), "X and X, done");
});

test("expandSnippets leaves the transcript unchanged when snippets is nullish", () => {
  assert.equal(expandSnippets("hello there", null), "hello there");
  assert.equal(expandSnippets("hello there", undefined), "hello there");
});

test("getDictionaryHintWords returns empty list on nullish, empty, or partial settings", () => {
  assert.deepEqual(getDictionaryHintWords(null), []);
  assert.deepEqual(getDictionaryHintWords(undefined), []);
  assert.deepEqual(getDictionaryHintWords({}), []);
  assert.deepEqual(getDictionaryHintWords({ customDictionary: null }), []);
  assert.deepEqual(getDictionaryHintWords({ snippets: null }), []);
  assert.deepEqual(getDictionaryHintWords({ customDictionary: null, snippets: null }), []);
});

test("getDictionaryHintWords preserves customDictionary when snippets are absent or empty", () => {
  const customDictionary = ["OpenWhispr", "Supabase"];
  const result = getDictionaryHintWords({ customDictionary });
  assert.deepEqual(result, ["OpenWhispr", "Supabase"]);
  // Must return a fresh array, not the input reference
  assert.notEqual(result, customDictionary);

  const emptySnippetsResult = getDictionaryHintWords({ customDictionary, snippets: [] });
  assert.deepEqual(emptySnippetsResult, ["OpenWhispr", "Supabase"]);
  assert.notEqual(emptySnippetsResult, customDictionary);
});

test("getDictionaryHintWords extracts triggers when customDictionary is absent or empty", () => {
  const snippets = [
    { trigger: "my cal", replacement: "cal.com/me" },
    { trigger: "zoom link", replacement: "zoom.us/j/123" },
  ];
  assert.deepEqual(getDictionaryHintWords({ snippets }), ["my cal", "zoom link"]);
  assert.deepEqual(getDictionaryHintWords({ customDictionary: [], snippets }), [
    "my cal",
    "zoom link",
  ]);
});

test("getDictionaryHintWords combines dictionary words and snippet triggers safely", () => {
  const settings = {
    customDictionary: ["OpenWhispr", "Supabase"],
    snippets: [
      { trigger: "my cal", replacement: "cal.com/me" },
      { trigger: "zoom link", replacement: "zoom.us/j/123" },
    ],
  };
  assert.deepEqual(getDictionaryHintWords(settings), [
    "OpenWhispr",
    "Supabase",
    "my cal",
    "zoom link",
  ]);
});
