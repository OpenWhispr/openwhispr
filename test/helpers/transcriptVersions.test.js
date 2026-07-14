const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptVersions.js");

test("reasoning updates processed text without overwriting the streaming transcript", async () => {
  const { createTranscriptVersions, applyProcessedTranscript } = await load();
  const original = createTranscriptVersions("um send it friday");
  const cleaned = applyProcessedTranscript(original, "Send it Friday.");

  assert.deepEqual(original, {
    text: "um send it friday",
    rawText: "um send it friday",
  });
  assert.deepEqual(cleaned, {
    text: "Send it Friday.",
    rawText: "um send it friday",
  });
});

test("empty reasoning output leaves both versions unchanged", async () => {
  const { createTranscriptVersions, applyProcessedTranscript } = await load();
  const versions = createTranscriptVersions("source");

  assert.equal(applyProcessedTranscript(versions, ""), versions);
  assert.equal(applyProcessedTranscript(versions, null), versions);
});

test("batch fallback adopts the batch raw and processed versions", async () => {
  const { createTranscriptVersions, replaceWithTranscriptionResult } = await load();
  const empty = createTranscriptVersions();

  assert.deepEqual(
    replaceWithTranscriptionResult(empty, {
      text: "Cleaned fallback.",
      rawText: "um cleaned fallback",
    }),
    { text: "Cleaned fallback.", rawText: "um cleaned fallback" }
  );
  assert.deepEqual(replaceWithTranscriptionResult(empty, { text: "Raw fallback" }), {
    text: "Raw fallback",
    rawText: "Raw fallback",
  });
});
