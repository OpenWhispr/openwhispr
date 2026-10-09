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

// #2581: a prompt-conditioned model recited the hint list after the speech.
// The real speech dilutes matchesDictionaryPrompt's ratios, so only the
// trailing list is removed and everything spoken is kept. The prompt is the
// hint list as sent; the third argument is the user's own dictionary.
const entries = (prompt) => prompt.split(", ");

test("stripTrailingDictionaryEcho removes a two-term echo appended to speech", async () => {
  const { matchesDictionaryPrompt, stripTrailingDictionaryEcho } =
    await import("../../src/utils/dictionaryEchoFilter.js");
  const text = "Appreciate the time. Thanks, all. Thanks, you. OpenWhispr, n8n.";
  const prompt = "OpenWhispr, n8n";

  assert.equal(matchesDictionaryPrompt(text, prompt), false);
  assert.equal(
    stripTrailingDictionaryEcho(text, prompt, entries(prompt)),
    "Appreciate the time. Thanks, all. Thanks, you."
  );
});

test("stripTrailingDictionaryEcho removes a whole recited list, case and punctuation aside", async () => {
  const { stripTrailingDictionaryEcho } = await import("../../src/utils/dictionaryEchoFilter.js");
  const prompt = "OpenWhispr, n8n, Traefik, Tailscale, Claude Code, kubectl";
  const dictionary = entries(prompt);

  assert.equal(
    stripTrailingDictionaryEcho(
      "All right. Appreciate the time. Thanks, you. OpenWhispr, n8n, Traefik, Tailscale, Claude Code, kubectl",
      prompt,
      dictionary
    ),
    "All right. Appreciate the time. Thanks, you."
  );
  assert.equal(
    stripTrailingDictionaryEcho(
      "Ship it today! traefik, tailscale, claude code,",
      prompt,
      dictionary
    ),
    "Ship it today!"
  );
  assert.equal(
    stripTrailingDictionaryEcho(
      "下周发布。OpenWhispr、n8n。",
      `以下是简体中文。语言、学习、软件、网络。 ${prompt}`,
      dictionary
    ),
    "下周发布。"
  );
});

test("stripTrailingDictionaryEcho counts two entries only when they open the list", async () => {
  const { stripTrailingDictionaryEcho } = await import("../../src/utils/dictionaryEchoFilter.js");
  const prompt = "OpenWhispr, n8n, Traefik, Tailscale, Claude Code, kubectl";
  const dictionary = entries(prompt);

  // Three or more consecutive entries are a recital from anywhere in the list.
  assert.equal(
    stripTrailingDictionaryEcho(
      "We shipped it. Tailscale, Claude Code, kubectl.",
      prompt,
      dictionary
    ),
    "We shipped it."
  );
  // Two consecutive entries from mid-list are a short list the user said.
  const said = "Here are the tools I use. Traefik, Tailscale.";
  assert.equal(stripTrailingDictionaryEcho(said, prompt, dictionary), said);
});

test("stripTrailingDictionaryEcho keeps a sentence that ends on one dictionary word", async () => {
  const { stripTrailingDictionaryEcho } = await import("../../src/utils/dictionaryEchoFilter.js");
  const prompt = "OpenWhispr, n8n, Traefik, Tailscale";

  for (const text of [
    "The VPN was flaky, so we moved it to Tailscale.",
    "That was flaky. Tailscale.",
    "That was flaky. Tailscale, Tailscale.",
  ]) {
    assert.equal(stripTrailingDictionaryEcho(text, prompt, entries(prompt)), text);
  }
});

test("stripTrailingDictionaryEcho keeps dictionary terms used inside speech", async () => {
  const { stripTrailingDictionaryEcho } = await import("../../src/utils/dictionaryEchoFilter.js");
  const prompt = "OpenWhispr, n8n, Traefik, Tailscale, Claude Code";

  for (const text of [
    // Leading list, then real speech: only a tail can be an appended echo.
    "OpenWhispr, n8n. Those are the two tools I set up today.",
    // Terms mid-sentence, even consecutive ones in prompt order.
    "Today I wired OpenWhispr, n8n and Traefik together.",
    "We route it through Traefik, Tailscale.",
    // Its own sentence, but out of the prompt's order: dictation, not recital.
    "Which ones did you pick? Tailscale, Traefik.",
    // One term is a prefix of a spoken word, not the term itself.
    "It is ready. Open, n8n.",
    // A spoken word between the terms.
    "It is ready. OpenWhispr, then n8n.",
  ]) {
    assert.equal(stripTrailingDictionaryEcho(text, prompt, entries(prompt)), text);
  }
});

test("stripTrailingDictionaryEcho does not treat an abbreviation as a sentence break", async () => {
  const { stripTrailingDictionaryEcho } = await import("../../src/utils/dictionaryEchoFilter.js");
  const prompt = "OpenWhispr, n8n, Traefik";

  for (const text of [
    "Use the tools e.g. OpenWhispr, n8n",
    "Use the tools, i.e. OpenWhispr, n8n.",
    "Ask Mr. OpenWhispr, n8n",
    "Step 1. OpenWhispr, n8n",
    "So... OpenWhispr, n8n",
  ]) {
    assert.equal(stripTrailingDictionaryEcho(text, prompt, entries(prompt)), text);
  }
  // A year is not a list marker: the sentence before it still ends there.
  assert.equal(
    stripTrailingDictionaryEcho("We shipped in 2026. OpenWhispr, n8n.", prompt, entries(prompt)),
    "We shipped in 2026."
  );
});

test("stripTrailingDictionaryEcho keeps an entry containing a period whole", async () => {
  const { stripTrailingDictionaryEcho } = await import("../../src/utils/dictionaryEchoFilter.js");
  const prompt = "St. Louis, Chicago, J. R. R. Tolkien";

  assert.equal(
    stripTrailingDictionaryEcho("Done. St. Louis, Chicago", prompt, entries(prompt)),
    "Done."
  );
  assert.equal(
    stripTrailingDictionaryEcho("I read it. Louis, Chicago", prompt, entries(prompt)),
    "I read it. Louis, Chicago"
  );
});

test("stripTrailingDictionaryEcho never strips a snippet trigger or the script bias", async () => {
  const { stripTrailingDictionaryEcho } = await import("../../src/utils/dictionaryEchoFilter.js");
  const dictionary = ["OpenWhispr", "n8n"];

  // getDictionaryHintWords appends snippet triggers after the dictionary.
  const withTrigger = "OpenWhispr, n8n, on my way, see you";
  for (const text of ["Text him. On my way, see you.", "Text him. n8n, on my way, see you."]) {
    assert.equal(stripTrailingDictionaryEcho(text, withTrigger, dictionary), text);
  }

  // The Chinese script bias's generic words are not dictionary entries.
  const biased = "以下是简体中文。语言、学习、软件、网络。 OpenWhispr, n8n";
  assert.equal(
    stripTrailingDictionaryEcho("我们看看。语言、学习。", biased, dictionary),
    "我们看看。语言、学习。"
  );
  assert.equal(
    stripTrailingDictionaryEcho("我们看看。软件、网络、OpenWhispr。", biased, dictionary),
    "我们看看。软件、网络、OpenWhispr。"
  );
});

test("stripTrailingDictionaryEcho leaves a whole-response echo to matchesDictionaryPrompt", async () => {
  const { matchesDictionaryPrompt, stripTrailingDictionaryEcho } =
    await import("../../src/utils/dictionaryEchoFilter.js");

  assert.equal(
    stripTrailingDictionaryEcho("OpenWhispr, n8n.", "OpenWhispr, n8n", ["OpenWhispr", "n8n"]),
    "OpenWhispr, n8n."
  );
  assert.equal(matchesDictionaryPrompt("OpenWhispr, n8n.", "OpenWhispr, n8n"), true);
});

test("stripTrailingDictionaryEcho only compares against the prompt it was given", async () => {
  const { stripTrailingDictionaryEcho } = await import("../../src/utils/dictionaryEchoFilter.js");
  const text = "Thanks, you. OpenWhispr, n8n.";
  const dictionary = ["OpenWhispr", "n8n", "Traefik", "Tailscale"];

  assert.equal(stripTrailingDictionaryEcho(text, null, dictionary), text);
  assert.equal(stripTrailingDictionaryEcho(text, "", dictionary), text);
  // Terms the capped prompt never carried cannot have been recited from it.
  assert.equal(stripTrailingDictionaryEcho(text, "Traefik, Tailscale", dictionary), text);
});

test("stripTrailingDictionaryEcho returns non-string input untouched", async () => {
  const { stripTrailingDictionaryEcho } = await import("../../src/utils/dictionaryEchoFilter.js");
  const prompt = "OpenWhispr, n8n";

  assert.equal(stripTrailingDictionaryEcho(null, prompt, entries(prompt)), null);
  assert.equal(stripTrailingDictionaryEcho(undefined, prompt, entries(prompt)), undefined);
  assert.deepEqual(stripTrailingDictionaryEcho({ text: "x" }, prompt, entries(prompt)), {
    text: "x",
  });
  const text = "Thanks, you. OpenWhispr, n8n.";
  assert.equal(stripTrailingDictionaryEcho(text, ["OpenWhispr", "n8n"], entries(prompt)), text);
  assert.equal(stripTrailingDictionaryEcho(text, prompt, undefined), text);
});
