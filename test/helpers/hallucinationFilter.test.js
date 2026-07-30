const test = require("node:test");
const assert = require("node:assert/strict");

// (a) ghost_phrase — isolated segment match
test("detects ghost phrase as an isolated segment", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const text = "This was a great tutorial. Thank you for watching. See you next time.";
  assert.deepEqual(detectHallucination(text), {
    isHallucination: true,
    reason: "ghost_phrase",
  });
});

// (a) note — ghost phrase must NOT match when the segment is longer than the phrase
test("does not flag ghost phrase when segment is longer than the phrase", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const text = "Thank you for watching this video today.";
  assert.deepEqual(detectHallucination(text), {
    isHallucination: false,
    reason: null,
  });
});

// (b) consecutive_repeat — same segment repeated many times
test("detects consecutive_repeat when the same segment repeats many times", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const text = "El día de hoy. ".repeat(18).trim();
  assert.deepEqual(detectHallucination(text), {
    isHallucination: true,
    reason: "consecutive_repeat",
  });
});

// (c) ngram_repeat — long text with > 60% repeated 4-grams
test("detects ngram_repeat for long text with heavily repeated 4-grams", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const text = "lorem ".repeat(25).trim();
  assert.deepEqual(detectHallucination(text), {
    isHallucination: true,
    reason: "ngram_repeat",
  });
});

// (d) short text below minLengthChars
test("does not flag text shorter than minLengthChars", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  assert.deepEqual(detectHallucination("Buy milk."), {
    isHallucination: false,
    reason: null,
  });
});

// (e) below-threshold word repetition inside a single segment
test("does not flag a mild repetition below the consecutive-repeat threshold", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  assert.deepEqual(detectHallucination("meeting meeting meeting"), {
    isHallucination: false,
    reason: null,
  });
});

// (f) clean prose sentence
test("does not flag clean prose", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const text =
    "The quick brown fox jumps over the lazy dog and runs into the shallow river nearby.";
  assert.deepEqual(detectHallucination(text), {
    isHallucination: false,
    reason: null,
  });
});

// (g) options override flips a 3-repeat to true
test("honors options override for maxConsecutiveRepeats", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const text = "Meeting is set. Meeting is set. Meeting is set.";
  assert.deepEqual(detectHallucination(text), {
    isHallucination: false,
    reason: null,
  });
  assert.deepEqual(detectHallucination(text, { maxConsecutiveRepeats: 2 }), {
    isHallucination: true,
    reason: "consecutive_repeat",
  });
});

// (FP1) legitimate Spanish sentence with "el día de hoy" embedded mid-sentence
test("does not flag legitimate Spanish text containing 'el día de hoy' mid-sentence", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const text = "Quiero terminar el informe el día de hoy antes de las cinco de la tarde.";
  assert.deepEqual(detectHallucination(text), {
    isHallucination: false,
    reason: null,
  });
});

// (FP2) legitimate sentence with "¿qué pasa?" embedded
test("does not flag legitimate text containing '¿qué pasa?' embedded", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const text = "Todos se preguntan ¿qué pasa? cuando ven el proyecto retrasado en la reunión.";
  assert.deepEqual(detectHallucination(text), {
    isHallucination: false,
    reason: null,
  });
});

// (FP3) ghost phrase as a substring of a longer legit segment
test("does not flag ghost phrase text when it is a substring of a longer legit segment", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const text = "If you found this useful please subscribe to learn more about our channel.";
  assert.deepEqual(detectHallucination(text), {
    isHallucination: false,
    reason: null,
  });
});

// (FP4) exactly 4 consecutive identical segments triggers, 3 does not
test("flags exactly 4 consecutive identical segments but not 3", async () => {
  const { detectHallucination } = await import("../../src/utils/hallucinationFilter.js");

  const fourRepeats = "Yes indeed. ".repeat(4).trim();
  assert.deepEqual(detectHallucination(fourRepeats), {
    isHallucination: true,
    reason: "consecutive_repeat",
  });

  const threeRepeats = "Yes indeed. ".repeat(3).trim();
  assert.deepEqual(detectHallucination(threeRepeats), {
    isHallucination: false,
    reason: null,
  });
});
