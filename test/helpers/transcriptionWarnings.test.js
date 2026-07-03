const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptionWarnings.js");

test("creates cleanup failed warnings with a normalized stage and provider", async () => {
  const { CLEANUP_FAILED_WARNING, createCleanupFailedWarning } = await load();

  assert.deepEqual(createCleanupFailedWarning({ stage: "agent", provider: " openai " }), {
    type: CLEANUP_FAILED_WARNING,
    stage: "agent",
    provider: "openai",
  });

  assert.deepEqual(createCleanupFailedWarning({ stage: "unexpected" }), {
    type: CLEANUP_FAILED_WARNING,
    stage: "cleanup",
  });
});

test("normalizes and dedupes cleanup warnings only", async () => {
  const { normalizeTranscriptionWarnings } = await load();

  assert.deepEqual(
    normalizeTranscriptionWarnings([
      { type: "cleanup_failed", stage: "cleanup", provider: "openwhispr" },
      { type: "cleanup_failed", stage: "cleanup", provider: "openwhispr" },
      { type: "cleanup_failed", stage: "agent" },
      { type: "ignored", stage: "cleanup" },
      null,
    ]),
    [
      { type: "cleanup_failed", stage: "cleanup", provider: "openwhispr" },
      { type: "cleanup_failed", stage: "agent" },
    ]
  );
});

test("attaches normalized warnings to successful transcription results", async () => {
  const { withTranscriptionWarnings } = await load();

  assert.deepEqual(
    withTranscriptionWarnings(
      { success: true, text: "raw transcript", source: "openai" },
      [{ type: "cleanup_failed", stage: "cleanup", provider: "openai" }],
      [{ type: "cleanup_failed", stage: "cleanup", provider: "openai" }]
    ),
    {
      success: true,
      text: "raw transcript",
      source: "openai",
      warnings: [{ type: "cleanup_failed", stage: "cleanup", provider: "openai" }],
    }
  );

  assert.deepEqual(withTranscriptionWarnings({ success: true, text: "cleaned" }, []), {
    success: true,
    text: "cleaned",
  });
});

test("derives cleanup warning stage and provider from reasoning route", async () => {
  const { createReasoningFallbackWarning, mergeReasoningFallbackWarning } = await load();

  assert.deepEqual(
    createReasoningFallbackWarning({ kind: "agent", config: { provider: "openwhispr" } }, "openai"),
    {
      type: "cleanup_failed",
      stage: "agent",
      provider: "openwhispr",
    }
  );

  assert.deepEqual(createReasoningFallbackWarning({ kind: "cleanup", config: {} }, "custom"), {
    type: "cleanup_failed",
    stage: "cleanup",
    provider: "custom",
  });

  assert.deepEqual(
    mergeReasoningFallbackWarning(
      [{ type: "cleanup_failed", stage: "cleanup", provider: "custom" }],
      { kind: "cleanup", config: {} },
      "custom"
    ),
    [{ type: "cleanup_failed", stage: "cleanup", provider: "custom" }]
  );
});

test("models shared processTranscription fallback warnings without changing raw text", async () => {
  const {
    mergeReasoningFallbackWarning,
    normalizeProcessedTranscriptionResult,
    withTranscriptionWarnings,
  } = await load();

  const rawText = "raw transcript";
  const processed = normalizeProcessedTranscriptionResult(
    {
      text: rawText,
      warnings: mergeReasoningFallbackWarning([], { kind: "cleanup", config: {} }, "custom"),
    },
    rawText
  );

  assert.deepEqual(
    withTranscriptionWarnings(
      { success: true, text: processed.text, rawText, source: "openai" },
      processed.warnings
    ),
    {
      success: true,
      text: rawText,
      rawText,
      source: "openai",
      warnings: [{ type: "cleanup_failed", stage: "cleanup", provider: "custom" }],
    }
  );
});

test("models OpenWhispr Cloud cleanup failure without dropping usage fields", async () => {
  const { mergeReasoningFallbackWarning, withTranscriptionWarnings } = await load();
  const warnings = mergeReasoningFallbackWarning([], { kind: "cleanup", config: {} }, "openwhispr");

  assert.deepEqual(
    withTranscriptionWarnings(
      {
        success: true,
        text: "raw cloud transcript",
        rawText: "raw cloud transcript",
        source: "openwhispr",
        limitReached: true,
        wordsUsed: 995,
        wordsRemaining: 5,
        clientTranscriptionId: "client-1",
      },
      warnings
    ),
    {
      success: true,
      text: "raw cloud transcript",
      rawText: "raw cloud transcript",
      source: "openwhispr",
      limitReached: true,
      wordsUsed: 995,
      wordsRemaining: 5,
      clientTranscriptionId: "client-1",
      warnings: [{ type: "cleanup_failed", stage: "cleanup", provider: "openwhispr" }],
    }
  );
});

test("models streaming reasoning failure and batch fallback warning dedupe", async () => {
  const { mergeReasoningFallbackWarning, mergeTranscriptionWarnings, withTranscriptionWarnings } =
    await load();
  const route = { kind: "agent", config: { provider: "openwhispr" } };
  let warnings = mergeReasoningFallbackWarning([], route, "openai");
  warnings = mergeTranscriptionWarnings(warnings, [
    { type: "cleanup_failed", stage: "agent", provider: "openwhispr" },
  ]);

  assert.deepEqual(
    withTranscriptionWarnings(
      {
        success: true,
        text: "raw streaming transcript",
        rawText: "raw streaming transcript",
        source: "deepgram-streaming",
      },
      warnings
    ),
    {
      success: true,
      text: "raw streaming transcript",
      rawText: "raw streaming transcript",
      source: "deepgram-streaming",
      warnings: [{ type: "cleanup_failed", stage: "agent", provider: "openwhispr" }],
    }
  );
});

test("normalizes richer processTranscription results to text plus warnings", async () => {
  const { normalizeProcessedTranscriptionResult } = await load();

  assert.deepEqual(
    normalizeProcessedTranscriptionResult({
      text: "raw transcript",
      warnings: [{ type: "cleanup_failed", stage: "cleanup" }],
    }),
    {
      text: "raw transcript",
      warnings: [{ type: "cleanup_failed", stage: "cleanup" }],
    }
  );

  assert.deepEqual(normalizeProcessedTranscriptionResult("cleaned text", "fallback"), {
    text: "cleaned text",
    warnings: [],
  });

  assert.deepEqual(normalizeProcessedTranscriptionResult({ warnings: [] }, "fallback"), {
    text: "fallback",
    warnings: [],
  });
});

test("returns one localized toast decision for cleanup warnings", async () => {
  const { getCleanupFailedWarningToast } = await load();
  const t = (key) => `translated:${key}`;

  assert.deepEqual(
    getCleanupFailedWarningToast(
      {
        warnings: [
          { type: "cleanup_failed", stage: "cleanup" },
          { type: "cleanup_failed", stage: "cleanup" },
        ],
      },
      t
    ),
    {
      title: "translated:hooks.audioRecording.cleanupWarning.title",
      description: "translated:hooks.audioRecording.cleanupWarning.description",
      variant: "default",
    }
  );

  assert.equal(getCleanupFailedWarningToast({ warnings: [] }, t), null);
  assert.equal(
    getCleanupFailedWarningToast({ warnings: [{ type: "cleanup_failed", stage: "cleanup" }] }, t, {
      transcriptionSaved: false,
    }),
    null
  );
});
