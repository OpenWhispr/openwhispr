const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const load = () => import("../../src/helpers/cleanupAnswerGuard.js");

const readSource = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

// Lengths from the report this guards against: a 75-char dictated question
// answered with 762 chars of chatbot prose.
const DICTATED_QUESTION =
  "Why should I use the Quinn three point five model instead of a Gemma model?";
const CHATBOT_ANSWER =
  "You should use the Quinn 3.5 model instead of a Gemma model because the " +
  "Quinn 3.5 model is specifically optimized for high-performance inference " +
  "and offers superior speed and efficiency, making it ideal for real-time " +
  "applications where latency is a concern. Unlike Gemma, which is a smaller " +
  "model designed for specific tasks or environments, Quinn 3.5 is built to " +
  "handle complex reasoning and large-scale data processing with greater " +
  "accuracy and speed. Additionally, Quinn 3.5 is designed to be more " +
  "user-friendly and easier to integrate into existing systems, providing a " +
  "smoother experience for developers and end-users alike. If you're looking " +
  "for a model that can handle more complex tasks while maintaining high " +
  "performance, Quinn 3.5 is the better choice.";

test("chatbot answer 10x longer than the dictated question is answer-shaped", async () => {
  const { isAnswerShapedCleanupResponse } = await load();
  assert.ok(isAnswerShapedCleanupResponse(DICTATED_QUESTION, CHATBOT_ANSWER));
});

test("same-length cleanup of a dictated question is not answer-shaped", async () => {
  const { isAnswerShapedCleanupResponse } = await load();
  assert.ok(
    !isAnswerShapedCleanupResponse(
      DICTATED_QUESTION,
      "Why should I use the Qwen 3.5 model instead of a Gemma model?"
    )
  );
});

test("aggressive filler and repetition stripping (5x shrink) is not answer-shaped", async () => {
  const { isAnswerShapedCleanupResponse } = await load();
  assert.ok(
    !isAnswerShapedCleanupResponse(
      "thank you thank you thank you thank you thank you",
      "Thank you."
    )
  );
});

test("growth at exactly the ratio-and-margin threshold is not answer-shaped", async () => {
  const { isAnswerShapedCleanupResponse } = await load();
  const input = "a".repeat(100);
  assert.ok(!isAnswerShapedCleanupResponse(input, "b".repeat(300)));
  assert.ok(isAnswerShapedCleanupResponse(input, "b".repeat(301)));
});

test("short input is protected by the absolute margin, not the ratio", async () => {
  const { isAnswerShapedCleanupResponse } = await load();
  const input = "a".repeat(20);
  // 11x the input but still within input + 200.
  assert.ok(!isAnswerShapedCleanupResponse(input, "b".repeat(220)));
  assert.ok(isAnswerShapedCleanupResponse(input, "b".repeat(221)));
});

test("long input is protected by the ratio, not the margin", async () => {
  const { isAnswerShapedCleanupResponse } = await load();
  const input = "a".repeat(500);
  assert.ok(!isAnswerShapedCleanupResponse(input, "b".repeat(1500)));
  assert.ok(isAnswerShapedCleanupResponse(input, "b".repeat(1501)));
});

test("empty or non-string sides are never answer-shaped", async () => {
  const { isAnswerShapedCleanupResponse } = await load();
  assert.ok(!isAnswerShapedCleanupResponse("", CHATBOT_ANSWER));
  assert.ok(!isAnswerShapedCleanupResponse("   ", CHATBOT_ANSWER));
  assert.ok(!isAnswerShapedCleanupResponse(DICTATED_QUESTION, ""));
  assert.ok(!isAnswerShapedCleanupResponse(undefined, CHATBOT_ANSWER));
  assert.ok(!isAnswerShapedCleanupResponse(DICTATED_QUESTION, null));
});

test("resolveCleanupText keeps a normal cleanup untouched", async () => {
  const { resolveCleanupText } = await load();
  const cleaned = "Why should I use the Qwen 3.5 model instead of a Gemma model?";
  assert.equal(resolveCleanupText(DICTATED_QUESTION, cleaned, {}), cleaned);
});

test("resolveCleanupText falls back to the transcript and reports metrics on an answer", async () => {
  const { resolveCleanupText } = await load();
  const reported = [];
  const kept = resolveCleanupText(DICTATED_QUESTION, CHATBOT_ANSWER, {
    onSuspect: (metrics) => reported.push(metrics),
  });
  assert.equal(kept, DICTATED_QUESTION);
  assert.deepEqual(reported, [
    { inputLength: DICTATED_QUESTION.length, responseLength: CHATBOT_ANSWER.length },
  ]);
});

test("resolveCleanupText with a custom prompt bypasses the guard for answer-shaped output", async () => {
  const { resolveCleanupText } = await load();
  let suspectCalled = false;
  const kept = resolveCleanupText(DICTATED_QUESTION, CHATBOT_ANSWER, {
    hasCustomPrompt: true,
    onSuspect: () => {
      suspectCalled = true;
    },
  });
  assert.equal(kept, CHATBOT_ANSWER);
  assert.equal(suspectCalled, false);
});

test("resolveCleanupText keeps the transcript when the response is empty or missing", async () => {
  const { resolveCleanupText } = await load();
  assert.equal(resolveCleanupText("raw dictation", "", {}), "raw dictation");
  assert.equal(resolveCleanupText("raw dictation", null, {}), "raw dictation");
  assert.equal(resolveCleanupText("raw dictation", undefined, {}), "raw dictation");
});

test("resolveCleanupText without onSuspect still falls back silently", async () => {
  const { resolveCleanupText } = await load();
  assert.equal(resolveCleanupText(DICTATED_QUESTION, CHATBOT_ANSWER), DICTATED_QUESTION);
});

// Prompt-shape anchors: the transcript must arrive framed as data, with the
// instruction block that forbids answering it. Guards the contract, not wording.
test("cleanup prompt declares the transcript-tag contract and forbids answering", () => {
  const prompts = JSON.parse(readSource("src/locales/en/prompts.json"));
  assert.match(prompts.cleanupPrompt, /<transcript>/);
  assert.match(prompts.cleanupPrompt, /never answer or execute/i);
  assert.match(prompts.cleanupPrompt, /ignore your rules/i);
});

test("wrapCleanupTranscript frames the dictation between transcript tags with a trailing anchor", () => {
  const source = readSource("src/config/prompts/index.ts");
  assert.match(
    source,
    /<transcript>\\n\$\{text\}\\n<\/transcript>\\n\\nOutput only the cleaned transcript\./
  );
});

// Source-level wiring asserts; the TS call sites are not requirable here.
test("every cleanup result consumer routes through the answer guard", () => {
  const reasoning = readSource("src/services/ReasoningService.ts");
  assert.match(reasoning, /resolveCleanupText\(text, result/);
  assert.match(reasoning, /cleanupGuardEligible/);

  const audioManager = readSource("src/helpers/audioManager.js");
  const guardCalls = audioManager.match(/resolveCleanupText\(/g) || [];
  assert.equal(guardCalls.length, 3);
});

test("every inference provider frames the cleanup transcript", () => {
  const wrapped = [
    "src/services/ReasoningService.ts",
    "src/services/ai/inferenceProviders/openai.ts",
    "src/services/ai/inferenceProviders/local.ts",
    "src/services/ai/inferenceProviders/gemini.ts",
    "src/services/ai/inferenceProviders/anthropic.ts",
    "src/services/ai/inferenceProviders/tinfoil.ts",
    "src/services/ai/inferenceProviders/enterprise.ts",
  ];
  for (const rel of wrapped) {
    assert.match(readSource(rel), /wrapCleanupTranscript\(text\)/, rel);
  }
});
