const test = require("node:test");
const assert = require("node:assert/strict");

test("detects verbatim echo of dictionary prompt", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr, Parakeet, Alcahest", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("detects echo when Whisper adds trailing period", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr, Parakeet, Alcahest.", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("detects echo with different capitalization", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt("openwhispr, parakeet, alcahest", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("detects echo when Whisper strips commas", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr Parakeet Alcahest", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("detects echo with extra whitespace", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr,  Parakeet,  Alcahest", "OpenWhispr, Parakeet, Alcahest"),
    true
  );
});

test("does not flag legitimate speech containing dictionary words", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt(
      "I just installed OpenWhispr and it works great",
      "OpenWhispr, Parakeet, Alcahest"
    ),
    false
  );
});

test("does not flag speech that partially overlaps with dictionary", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt("OpenWhispr, Parakeet", "OpenWhispr, Parakeet, Alcahest"),
    false
  );
});

test("returns false when dictionary prompt is null", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(matchesDictionaryPrompt("some text", null), false);
});

test("returns false when text is null", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(matchesDictionaryPrompt(null, "OpenWhispr"), false);
});

test("returns false when both inputs are empty strings", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(matchesDictionaryPrompt("", ""), false);
});

test("handles single-word dictionary", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(matchesDictionaryPrompt("OpenWhispr", "OpenWhispr"), true);
  assert.equal(matchesDictionaryPrompt("OpenWhispr is great", "OpenWhispr"), false);
});

test("handles unicode dictionary words with accents", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt("Müller, François, José", "Müller, François, José"),
    true
  );
  assert.equal(
    matchesDictionaryPrompt("muller francois jose", "Müller, François, José"),
    false
  );
});

test("handles CJK dictionary words", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt("東京, 大阪", "東京, 大阪"),
    true
  );
});

test("detects repeated echo where Whisper loops the dictionary", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  const dict = "OpenWhispr, Parakeet, Alcahest";
  const repeated = "OpenWhispr, Parakeet, Alcahest, OpenWhispr, Parakeet, Alcahest";
  assert.equal(matchesDictionaryPrompt(repeated, dict), true);
});

test("detects echo with minor Whisper additions among dictionary words", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  const dict = "Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliet";
  const echoWithFiller = "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet the";
  assert.equal(matchesDictionaryPrompt(echoWithFiller, dict), true);
});

test("does not flag completely unrelated text", async () => {
  const { matchesDictionaryPrompt } = await import(
    "../../src/utils/dictionaryEchoFilter.js"
  );
  assert.equal(
    matchesDictionaryPrompt(
      "The quick brown fox jumps over the lazy dog",
      "OpenWhispr, Parakeet, Alcahest"
    ),
    false
  );
});
