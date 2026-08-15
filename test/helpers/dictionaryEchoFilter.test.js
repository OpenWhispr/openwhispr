const test = require("node:test");
const assert = require("node:assert/strict");

test("detects verbatim echo of dictionary prompt", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr, Parakeet, Alcahest", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("detects echo when Whisper adds trailing period", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr, Parakeet, Alcahest.", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("detects echo with different capitalization", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    matchesDictionaryPrompt("openwhispr, parakeet, alcahest", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("detects echo when Whisper strips commas", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr Parakeet Alcahest", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("detects echo with extra whitespace", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr,  Parakeet,  Alcahest", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("does not flag legitimate speech containing dictionary words", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    matchesDictionaryPrompt(
      "I just installed OpenWhispr and it works great",
      "OpenWhispr, Parakeet, Alcahest"
    ),
    false
  );
});

test("does not flag speech that partially overlaps with dictionary", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr, Parakeet", "OpenWhispr, Parakeet, Alcahest"),
    false
  );
});

test("returns false when dictionary prompt is null", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(matchesDictionaryPrompt("some text", null), false);
});

test("returns false when text is null", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(matchesDictionaryPrompt(null, "OpenWhispr"), false);
});

test("returns false when both inputs are empty strings", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(matchesDictionaryPrompt("", ""), false);
});

test("handles single-word dictionary", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(matchesDictionaryPrompt("OpenWhispr", "OpenWhispr"), true);
  assert.equal(matchesDictionaryPrompt("OpenWhispr is great", "OpenWhispr"), false);
});

test("handles unicode dictionary words with accents", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(matchesDictionaryPrompt("Müller, François, José", "Müller, François, José"), true);
  assert.equal(matchesDictionaryPrompt("muller francois jose", "Müller, François, José"), false);
});

test("handles CJK dictionary words", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(matchesDictionaryPrompt("東京, 大阪", "東京, 大阪"), true);
});

test("detects repeated echo where Whisper loops the dictionary", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  const dict = "OpenWhispr, Parakeet, Alcahest";
  const repeated = "OpenWhispr, Parakeet, Alcahest, OpenWhispr, Parakeet, Alcahest";
  assert.equal(matchesDictionaryPrompt(repeated, dict), true);
});

test("detects echo with minor Whisper additions among dictionary words", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  const dict = "Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliet";
  const echoWithFiller = "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet the";
  assert.equal(matchesDictionaryPrompt(echoWithFiller, dict), true);
});

test("does not flag completely unrelated text", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    matchesDictionaryPrompt(
      "The quick brown fox jumps over the lazy dog",
      "OpenWhispr, Parakeet, Alcahest"
    ),
    false
  );
});

test("returns false when text or prompt normalizes to empty string (punctuation only)", async () => {
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(matchesDictionaryPrompt("...", "..."), false);
  assert.equal(matchesDictionaryPrompt("!!!", ",,,"), false);
  assert.equal(matchesDictionaryPrompt("???", "OpenWhispr, Parakeet"), false);
  assert.equal(matchesDictionaryPrompt("OpenWhispr, Parakeet", "!!!"), false);
});

// #1636: the request path caps the sent prompt at ~900 chars (890 for Groq),
// but the echo check compared against the full dictionary join. An exact echo
// of the sent prefix has dictionaryUsage ≈ sentChars / joinChars against the
// full join, so a large dictionary made the echo mathematically undetectable.

function buildLargeDictionary(termCount = 390) {
  const terms = [];
  for (let i = 0; i < termCount; i++) terms.push(`term${i}alpha`);
  return terms.join(", ");
}

test("truncateDictionaryPrompt trims to the last comma within the cap", async () => {
  const { truncateDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(truncateDictionaryPrompt("Alpha, Bravo, Charlie", 999), "Alpha, Bravo, Charlie");
  assert.equal(truncateDictionaryPrompt("Alpha, Bravo, Charlie", 14), "Alpha, Bravo");
  assert.equal(truncateDictionaryPrompt("NoCommaHere", 5), "NoCom");
  assert.equal(truncateDictionaryPrompt(null, 900), null);
});

test("detects an exact echo of the sent (900-char capped) prompt against a large dictionary", async () => {
  const { matchesSentDictionaryPrompt, matchesDictionaryPrompt, truncateDictionaryPrompt } =
    await import("../../src/utils/dictionaryEchoFilter.js");
  const fullPrompt = buildLargeDictionary();
  assert.ok(fullPrompt.length > 3000);
  const sentPrompt = truncateDictionaryPrompt(fullPrompt, 900);

  // the old full-list-only comparison misses the echo of what was actually sent
  assert.equal(matchesDictionaryPrompt(sentPrompt, fullPrompt), false);
  // the sent-prefix-aware check catches it
  assert.equal(matchesSentDictionaryPrompt(sentPrompt, fullPrompt), true);
});

test("detects an echo of the Groq-capped (890-char) prompt", async () => {
  const { matchesSentDictionaryPrompt, truncateDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  const fullPrompt = buildLargeDictionary();
  const sentPrompt = truncateDictionaryPrompt(fullPrompt, 890);
  assert.equal(matchesSentDictionaryPrompt(sentPrompt, fullPrompt), true);
});

test("sent-prefix check still detects a verbatim full echo and stays quiet on real speech", async () => {
  const { matchesSentDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  const smallDict = "OpenWhispr, Parakeet, Alcahest";
  assert.equal(matchesSentDictionaryPrompt("OpenWhispr, Parakeet, Alcahest", smallDict), true);

  const fullPrompt = buildLargeDictionary();
  // dictation that merely uses a few dictionary terms is not an echo
  assert.equal(
    matchesSentDictionaryPrompt(
      "remember to file the term1alpha report before the term2alpha meeting tomorrow",
      fullPrompt
    ),
    false
  );
  assert.equal(matchesSentDictionaryPrompt("The quick brown fox jumps over it", fullPrompt), false);
  assert.equal(matchesSentDictionaryPrompt("anything", null), false);
});
