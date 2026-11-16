const test = require("node:test");
const assert = require("node:assert/strict");

const {
  expandSnippets,
  findSnippetTriggerRanges,
  getDictionaryHintWords,
  getDictionaryHintTiers,
  getEffectiveDictionaryWords,
  getKeytermDictionaryWords,
  getLlmDictionaryWords,
  MAX_SHARED_KEYTERMS,
  MAX_SHARED_WORDS_IN_LLM_PROMPTS,
  MAX_SHARED_CHARS_IN_LLM_PROMPTS,
  getKeywordDictionaryWords,
  splitSharedDictionaryWords,
  toCloudDictionaryFields,
  getCloudLlmDictionaryFields,
} = require("../../src/utils/snippets.ts");

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

test("findSnippetTriggerRanges reports where each trigger occurs", () => {
  const snippets = [{ trigger: "openwhispr review", replacement: "Review the PR" }];

  assert.deepEqual(findSnippetTriggerRanges("openwhispr review this PR", snippets), [
    { start: 0, end: 17 },
  ]);
  assert.deepEqual(findSnippetTriggerRanges("please openwhispr review it", snippets), [
    { start: 7, end: 24 },
  ]);
  assert.deepEqual(findSnippetTriggerRanges("nothing to expand here", snippets), []);
  assert.deepEqual(findSnippetTriggerRanges("openwhispr review", null), []);
});

// Wake-word suppression keys off these ranges, so a range that expandSnippets
// will not actually replace costs the user both the wake word and the snippet.
// The matcher folds case the Unicode way (/iu) while the replacement lookup
// uses toLowerCase(); Turkish dotless ı is where the two part company, since
// the pattern's [ıI] matches a plain "i" that is not a Map key.
test("findSnippetTriggerRanges reports only ranges expandSnippets will replace", () => {
  const snippets = [{ trigger: "ımza", replacement: "Saygılarımla" }];

  assert.equal(expandSnippets("imza raporu hazırla", snippets), "imza raporu hazırla");
  assert.deepEqual(findSnippetTriggerRanges("imza raporu hazırla", snippets), []);
});

test("tiers dedupe case-insensitively with personal spelling", () => {
  const tiers = getDictionaryHintTiers({
    customDictionary: ["OpenWhispr"],
    sharedDictionaryHints: { space: [], workspace: ["openwhispr", "ARR"] },
  });
  assert.deepEqual(tiers, [["OpenWhispr"], [], ["ARR"]]);
});

test("snippet triggers rank in the personal tier", () => {
  const tiers = getDictionaryHintTiers({
    customDictionary: ["Piha"],
    snippets: [{ trigger: "sig", replacement: "Regards" }],
    sharedDictionaryHints: { space: ["Kube", "SIG"], workspace: ["Acme"] },
  });
  assert.deepEqual(tiers, [["Piha", "sig"], ["Kube"], ["Acme"]]);
});

test("getDictionaryHintWords without shared hints is unchanged", () => {
  assert.deepEqual(
    getDictionaryHintWords({
      customDictionary: ["a", "b"],
      snippets: [{ trigger: "t", replacement: "x" }],
    }),
    ["a", "b", "t"]
  );
  assert.deepEqual(getDictionaryHintWords(null), []);
});

test("getEffectiveDictionaryWords omits triggers", () => {
  assert.deepEqual(
    getEffectiveDictionaryWords({
      customDictionary: ["Piha"],
      snippets: [{ trigger: "sig", replacement: "Regards" }],
      sharedDictionaryHints: { space: ["Kube"], workspace: ["piha", "Acme"] },
    }),
    ["Piha", "Kube", "Acme"]
  );
});

const teamWords = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

test("keyterms keep every personal word and fill shared ones up to 100 in total", () => {
  assert.equal(MAX_SHARED_KEYTERMS, 100);
  const keyterms = getKeytermDictionaryWords({
    customDictionary: ["Piha", ...teamWords("Mine", 20)],
    snippets: [{ trigger: "sig", replacement: "Regards" }],
    sharedDictionaryHints: { space: teamWords("Space", 30), workspace: teamWords("Team", 500) },
  });

  assert.deepEqual(keyterms.slice(0, 21), ["Piha", ...teamWords("Mine", 20)], "personal first");
  assert.equal(keyterms.length, 100, "shared words stop at the providers' 100-keyterm limit");
  assert.deepEqual(keyterms.slice(21, 51), teamWords("Space", 30), "space words before workspace");
  assert.ok(!keyterms.includes("sig"), "snippet triggers are not keyterms");
});

test("a personal list past the keyterm limit is sent whole, with no shared words", () => {
  const personal = teamWords("Mine", 150);
  const keyterms = getKeytermDictionaryWords({
    customDictionary: personal,
    sharedDictionaryHints: { space: ["Kube"], workspace: ["Acme"] },
  });
  assert.deepEqual(keyterms, personal);
});

test("shared keyterms stay inside the character budget and drop terms over 50 chars", () => {
  const long = "x".repeat(51);
  const words = Array.from(
    { length: 60 },
    (_, i) => `${"w".repeat(28)}${String(i).padStart(2, "0")}`
  );
  const keyterms = getKeytermDictionaryWords({
    customDictionary: ["Piha"],
    sharedDictionaryHints: { space: [long, "Kube"], workspace: words },
  });
  assert.ok(!keyterms.includes(long), "AssemblyAI rejects keyterms over 50 characters");
  assert.deepEqual(keyterms.slice(0, 2), ["Piha", "Kube"]);
  const chars = keyterms.reduce((total, term) => total + term.length, 0);
  assert.ok(chars <= 1000, `keyterms must stay inside Deepgram's budget, got ${chars}`);
  assert.equal(keyterms.length, 2 + Math.floor((1000 - 8) / 30));
  // A long personal word is the user's to keep.
  assert.deepEqual(getKeytermDictionaryWords({ customDictionary: [long] }), [long]);
});

test("gpt-transcribe keywords keep personal words and triggers, at most 100 shared", () => {
  const settings = {
    customDictionary: ["Piha"],
    snippets: [{ trigger: "sig", replacement: "Regards" }],
    sharedDictionaryHints: { space: ["Kube"], workspace: teamWords("Team", 500) },
  };
  const keywords = getKeywordDictionaryWords(settings);
  assert.deepEqual(keywords.slice(0, 3), ["Piha", "sig", "Kube"]);
  assert.equal(keywords.length, 2 + 100);
  assert.deepEqual(
    getKeywordDictionaryWords({ customDictionary: ["a", "b"], snippets: [{ trigger: "t" }] }),
    getDictionaryHintWords({ customDictionary: ["a", "b"], snippets: [{ trigger: "t" }] })
  );
});

test("tiers dedupe on NFC-normalised, trimmed, lowercased keys with personal spelling", () => {
  const tiers = getDictionaryHintTiers({
    customDictionary: ["Cafe\u0301 Noir"],
    sharedDictionaryHints: {
      space: ["CAF\u00C9 NOIR", " café noir "],
      workspace: ["Acme", "acme"],
    },
  });
  assert.deepEqual(tiers, [["Cafe\u0301 Noir"], [], ["Acme"]]);
});

test("splitSharedDictionaryWords tells applied shared words from personal ones", () => {
  const settings = {
    customDictionary: ["OpenWhispr"],
    snippets: [{ trigger: "sig", replacement: "Regards" }],
    sharedDictionaryHints: { space: ["openwhispr", "Kube"], workspace: ["Acme", "SIG"] },
  };
  const words = getLlmDictionaryWords(settings, { includeTriggers: true });
  assert.deepEqual(splitSharedDictionaryWords(words, settings), {
    personal: ["OpenWhispr", "sig"],
    shared: ["Kube", "Acme"],
  });
  assert.deepEqual(splitSharedDictionaryWords(["a", "b"], { customDictionary: ["a", "b"] }), {
    personal: ["a", "b"],
    shared: [],
  });
});

test("keyterms without shared words are the personal dictionary", () => {
  assert.deepEqual(getKeytermDictionaryWords({ customDictionary: ["Piha", "Biscuit"] }), [
    "Piha",
    "Biscuit",
  ]);
});

test("LLM prompts get every personal word and at most 200 shared ones", () => {
  assert.equal(MAX_SHARED_WORDS_IN_LLM_PROMPTS, 200);
  const settings = {
    customDictionary: ["Piha", "Biscuit"],
    snippets: [{ trigger: "sig", replacement: "Regards" }],
    sharedDictionaryHints: { space: ["Kube"], workspace: teamWords("Team", 500) },
  };

  const withTriggers = getLlmDictionaryWords(settings, { includeTriggers: true });
  assert.deepEqual(withTriggers.slice(0, 4), ["Piha", "Biscuit", "sig", "Kube"]);
  assert.equal(withTriggers.length, 3 + 200);

  const withoutTriggers = getLlmDictionaryWords(settings, { includeTriggers: false });
  assert.deepEqual(withoutTriggers.slice(0, 3), ["Piha", "Biscuit", "Kube"]);
  assert.equal(withoutTriggers.length, 2 + 200);
});

test("LLM prompts carry at most 2,000 characters of shared words, personal words whole", () => {
  assert.equal(MAX_SHARED_CHARS_IN_LLM_PROMPTS, 2000);
  const personal = [`${"p".repeat(3000)}`];
  const words = Array.from(
    { length: 150 },
    (_, i) => `${"w".repeat(37)}${String(i).padStart(3, "0")}`
  );
  const kept = getLlmDictionaryWords(
    { customDictionary: personal, sharedDictionaryHints: { space: [], workspace: words } },
    { includeTriggers: false }
  );
  assert.equal(kept[0], personal[0]);
  const shared = kept.slice(1);
  assert.equal(shared.length, 50, "2,000 characters hold 50 of these 40-character words");
  assert.deepEqual(shared, words.slice(0, 50));
});

test("without shared words every list is the personal one it always was", () => {
  const long = Array.from({ length: 300 }, (_, i) => `Term ${i}, with comma.`);
  for (const customDictionary of [[], ["Piha"], long, ["x".repeat(5000), "Café", "café"]]) {
    for (const sharedDictionaryHints of [undefined, { space: [], workspace: [] }]) {
      const settings = {
        customDictionary,
        snippets: [{ trigger: "my sig", replacement: "Chad" }],
        sharedDictionaryHints,
      };
      const hintWords = [...customDictionary, "my sig"];
      assert.deepEqual(getKeytermDictionaryWords(settings), customDictionary);
      assert.deepEqual(getKeywordDictionaryWords(settings), hintWords);
      assert.deepEqual(getLlmDictionaryWords(settings, { includeTriggers: true }), hintWords);
      assert.deepEqual(
        getLlmDictionaryWords(settings, { includeTriggers: false }),
        customDictionary
      );
      assert.deepEqual(splitSharedDictionaryWords(hintWords, settings).shared, []);
    }
  }
});

test("Cloud LLM requests carry shared words in their own field", () => {
  const settings = {
    customDictionary: ["Piha"],
    snippets: [{ trigger: "my sig", replacement: "Chad" }],
    sharedDictionaryHints: { space: ["Kube"], workspace: ["piha", ...teamWords("Team", 300)] },
  };
  const fields = getCloudLlmDictionaryFields(settings);
  assert.deepEqual(fields.customDictionary, ["Piha", "my sig"]);
  assert.deepEqual(fields.sharedDictionary.slice(0, 2), ["Kube", "Team0"]);
  assert.equal(fields.sharedDictionary.length, MAX_SHARED_WORDS_IN_LLM_PROMPTS);
  assert.deepEqual(Object.keys(fields), ["customDictionary", "sharedDictionary"]);
});

test("a personal-only Cloud request has no sharedDictionary field", () => {
  for (const settings of [
    { customDictionary: ["Piha"], snippets: [{ trigger: "my sig", replacement: "Chad" }] },
    {
      customDictionary: ["Piha"],
      snippets: [{ trigger: "my sig", replacement: "Chad" }],
      sharedDictionaryHints: { space: [], workspace: [] },
    },
  ]) {
    const fields = getCloudLlmDictionaryFields(settings);
    assert.deepEqual(fields, { customDictionary: ["Piha", "my sig"] });
    assert.equal(
      JSON.stringify({ text: "x", ...fields, customPrompt: undefined }),
      JSON.stringify({
        text: "x",
        customDictionary: getLlmDictionaryWords(settings, { includeTriggers: true }),
        customPrompt: undefined,
      })
    );
  }
  assert.deepEqual(toCloudDictionaryFields([], null), { customDictionary: [] });
});

test("suppressed moved words leave every personal tier, other personal words stay", () => {
  const settings = {
    customDictionary: ["Acme", "Piha"],
    snippets: [{ trigger: "acme", replacement: "Acme Corp" }],
    sharedDictionaryHints: { space: [], workspace: ["Kube"], suppressedPersonal: ["ACME"] },
  };
  assert.deepEqual(getDictionaryHintTiers(settings), [["Piha", "acme"], [], ["Kube"]]);
  assert.deepEqual(getKeytermDictionaryWords(settings), ["Piha", "Kube"]);
  assert.deepEqual(getEffectiveDictionaryWords(settings), ["Piha", "Kube"]);
  assert.deepEqual(getLlmDictionaryWords(settings, { includeTriggers: false }), ["Piha", "Kube"]);
});
