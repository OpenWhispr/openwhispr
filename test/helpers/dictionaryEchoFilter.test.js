const test = require("node:test");
const assert = require("node:assert/strict");

const LARGE_DICTIONARY_PROMPT = [
  "OpenWhispr",
  "Parakeet",
  "Alcahest",
  "Chromium",
  "TypeScript",
  "Electron",
  "testing",
  "data",
  "benchmark",
  "inference",
  "transcription",
  "dictionary",
  "microphone",
  "renderer",
  "latency",
  "pipeline",
].join(", ");

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

test("detects short repeated fragments from a large dictionary prompt", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  assert.equal(
    isLikelyDictionaryPromptFragment("data, data, data, data,", LARGE_DICTIONARY_PROMPT),
    true
  );
  assert.equal(isLikelyDictionaryPromptFragment("testing,", LARGE_DICTIONARY_PROMPT), true);
});

test("does not classify normal or unrelated short speech as a dictionary fragment", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  assert.equal(
    isLikelyDictionaryPromptFragment("OpenWhispr is working", LARGE_DICTIONARY_PROMPT),
    false
  );
  assert.equal(isLikelyDictionaryPromptFragment("hello there", LARGE_DICTIONARY_PROMPT), false);
});

test("requires non-empty text and a non-empty dictionary prompt", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  assert.equal(isLikelyDictionaryPromptFragment("", LARGE_DICTIONARY_PROMPT), false);
  assert.equal(isLikelyDictionaryPromptFragment("...", LARGE_DICTIONARY_PROMPT), false);
  assert.equal(isLikelyDictionaryPromptFragment("testing", null), false);
  assert.equal(isLikelyDictionaryPromptFragment("testing", ""), false);
});

test("detects repeated long dictionary terms without a character cutoff", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  assert.equal(
    isLikelyDictionaryPromptFragment("OpenWhispr, OpenWhispr, OpenWhispr", LARGE_DICTIONARY_PROMPT),
    true
  );
});

test("does not classify long non-repeated dictionary speech as a prompt fragment", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  assert.equal(
    isLikelyDictionaryPromptFragment(
      "OpenWhispr Parakeet Alcahest Chromium",
      LARGE_DICTIONARY_PROMPT
    ),
    false
  );
});

test("requires the prompt's own separator or a repeat, not just dictionary words", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  // A bare dictionary term is short-form dictation, not a prompt continuation.
  assert.equal(isLikelyDictionaryPromptFragment("testing", LARGE_DICTIONARY_PROMPT), false);
  assert.equal(
    isLikelyDictionaryPromptFragment("Electron renderer latency", LARGE_DICTIONARY_PROMPT),
    false
  );
  // Whisper continuing the prompt carries the ", " the hint list was joined with.
  assert.equal(isLikelyDictionaryPromptFragment("testing, ", LARGE_DICTIONARY_PROMPT), true);
});

test("does not treat snippet-trigger words as an echo of ordinary speech", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  // getDictionaryHintWords appends whole triggers, so a multi-word trigger puts
  // "on", "my" and "way" into the prompt's word set.
  const promptWithTriggers = `${LARGE_DICTIONARY_PROMPT}, on my way, let me know`;
  assert.equal(isLikelyDictionaryPromptFragment("On my way.", promptWithTriggers), false);
  assert.equal(isLikelyDictionaryPromptFragment("Let me know", promptWithTriggers), false);
});

test("does not classify comma-separated dictionary-term dictation as a fragment", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  // Real short-form dictation of curated terms; replacing it with a prompt-free
  // retry would misspell exactly the vocabulary the dictionary protects.
  assert.equal(
    isLikelyDictionaryPromptFragment("Electron, renderer", LARGE_DICTIONARY_PROMPT),
    false
  );
  // Without a dangling separator, two echoed terms are indistinguishable from
  // that dictation, so they are deliberately left alone as well.
  assert.equal(isLikelyDictionaryPromptFragment("testing, data", LARGE_DICTIONARY_PROMPT), false);
});

test("does not classify a genuinely doubled term as a looped echo", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  // Whisper's echo pathology loops a term many times; saying it twice is speech.
  assert.equal(
    isLikelyDictionaryPromptFragment("OpenWhispr, OpenWhispr", LARGE_DICTIONARY_PROMPT),
    false
  );
});

test("detects a run of consecutive prompt terms past the character cutoff", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  // A comma-separated continuation of 3+ entries in the prompt's own order is
  // the echo shape that outgrows the short-fragment cap.
  assert.equal(
    isLikelyDictionaryPromptFragment(
      "TypeScript, Electron, testing, data, benchmark",
      LARGE_DICTIONARY_PROMPT
    ),
    true
  );
  // The same words out of prompt order are dictation, not a continuation.
  assert.equal(
    isLikelyDictionaryPromptFragment(
      "benchmark, TypeScript, data, Electron, testing",
      LARGE_DICTIONARY_PROMPT
    ),
    false
  );
});

test("a dangling separator does not outweigh non-dictionary words", async () => {
  const { isLikelyDictionaryPromptFragment } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  assert.equal(
    isLikelyDictionaryPromptFragment("yes, no, maybe, dunno,", LARGE_DICTIONARY_PROMPT),
    false
  );
});

// #1759: the echo check must only run when the outgoing payload actually
// carried dictionary bias. Payload shapes below mirror what each provider's
// buildPayload in audioManager.js really produces.

test("payloadSendsDictionaryBias: Corti payload carries no bias field at all", async () => {
  const { payloadSendsDictionaryBias } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    payloadSendsDictionaryBias({
      audioBuffer: new ArrayBuffer(4),
      language: "en",
      environment: "us",
      tenant: "clinic",
    }),
    false
  );
});

test("payloadSendsDictionaryBias: Tinfoil-style prompt string counts as bias", async () => {
  const { payloadSendsDictionaryBias } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    payloadSendsDictionaryBias({ audioBuffer: new ArrayBuffer(4), prompt: "Ozempic, Parakeet" }),
    true
  );
  assert.equal(
    payloadSendsDictionaryBias({ audioBuffer: new ArrayBuffer(4), prompt: "   " }),
    false
  );
  assert.equal(
    payloadSendsDictionaryBias({ audioBuffer: new ArrayBuffer(4), prompt: undefined }),
    false
  );
});

test("payloadSendsDictionaryBias: Mistral contextBias tokens count as bias", async () => {
  const { payloadSendsDictionaryBias } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    payloadSendsDictionaryBias({
      audioBuffer: new ArrayBuffer(4),
      model: "voxtral",
      contextBias: ["Machine", "Learning"],
    }),
    true
  );
  // empty dictionary: buildPayload omits the field entirely
  assert.equal(
    payloadSendsDictionaryBias({ audioBuffer: new ArrayBuffer(4), model: "voxtral" }),
    false
  );
});

test("payloadSendsDictionaryBias: xAI/Gemini keyterms count as bias", async () => {
  const { payloadSendsDictionaryBias } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(
    payloadSendsDictionaryBias({ audioBuffer: new ArrayBuffer(4), keyterms: ["Ozempic"] }),
    true
  );
  assert.equal(payloadSendsDictionaryBias({ audioBuffer: new ArrayBuffer(4) }), false);
  assert.equal(
    payloadSendsDictionaryBias({ audioBuffer: new ArrayBuffer(4), keyterms: [] }),
    false
  );
});

test("payloadSendsDictionaryBias: nullish or malformed payloads never enable the check", async () => {
  const { payloadSendsDictionaryBias } = await import("../../src/utils/dictionaryEchoFilter.js");
  assert.equal(payloadSendsDictionaryBias(null), false);
  assert.equal(payloadSendsDictionaryBias(undefined), false);
  assert.equal(payloadSendsDictionaryBias("prompt"), false);
});
