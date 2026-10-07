const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateRecord, evaluate } = require("../../scripts/help-eval");

test("evaluator catches native-observed inventions and separates transport success", () => {
  const result = evaluateRecord({
    caseId: "offline-models",
    provider: "local",
    model: "Qwen3.5-4B-Q4_K_M",
    provenance: "synthetic",
    transport: "success",
    content:
      "Speech-to-text is separate from language models. Download local GPT-4-Turbo and local Claude-3; select Offline-only. Click Save.",
  });
  assert.deepEqual(result.failures, [
    "invented local proprietary model",
    "invented offline toggle",
    "invented Save/Apply step",
  ]);
  assert.equal(result.transport, "success");
  assert.equal(result.factualCorrectness, "unassessed beyond explicit regression assertions");
});

test("stale shortcut, wrong Hold label, and unsupported coverage are separate failures", () => {
  const stale = evaluateRecord({
    caseId: "fresh-settings",
    expectedShortcut: "Control+Alt+K",
    content: "RightCommand",
    observations: { freshContextRead: true },
  });
  assert.deepEqual(stale.failures, ["currentShortcut"]);
  assert.ok(
    evaluateRecord({
      caseId: "hold-label",
      content: "Your mode is Tap. Hold is available.",
    }).failures.includes("hold")
  );
  const abstention = evaluateRecord({
    caseId: "offline-models",
    content: "I cannot verify this.",
    metadata: { answerStatus: "abstained" },
  });
  assert.ok(abstention.failures.includes("supported answer abstained"));
});

test("source metadata alone does not establish rendered citation or factual support", () => {
  const result = evaluateRecord({
    caseId: "citation-support",
    content: "Hold",
    metadata: { sources: [{ url: "https://evil.invalid/help", path: "/help" }] },
  });
  assert.deepEqual(result.failures, ["invalid source URL", "missing clickable citation"]);
});

test("missing side-effect and freshness observations cannot silently pass", () => {
  const result = evaluateRecord({
    caseId: "no-side-effects",
    content: "Settings → App → Hotkeys; Settings → App → Preferences.",
  });
  assert.equal(result.failures.length, 3);
  assert.ok(
    evaluateRecord({
      caseId: "fresh-settings",
      content: "RightCommand",
      expectedShortcut: "RightCommand",
    }).failures.includes("missing proof: freshContextRead")
  );
});

test("live requirement rejects synthetic captures and missing cases stay visible", () => {
  const report = evaluate(
    [
      {
        caseId: "unknown-feature",
        provenance: "synthetic",
        provider: "fixture",
        model: "none",
        prompt: "Quantum Dictation?",
        content: "I cannot verify that feature.",
        metadata: { answerStatus: "abstained" },
      },
    ],
    { requireLive: true }
  );
  assert.equal(report.passed, 1);
  assert.equal(report.provenanceFailures, 1);
  assert.equal(report.missingCases.length, 11);
  assert.equal(report.abstentions, 1);
  assert.deepEqual(report.repetitions["fixture/none/unknown-feature"], {
    runs: 1,
    distinctPrompts: 1,
  });
});

test("empty or unknown captures are not acceptance evidence", () => {
  assert.equal(evaluate([]).missingCases.length, 12);
  assert.deepEqual(evaluateRecord({ caseId: "not-a-case" }).failures, ["unknown case id"]);
});

test("an official but unrelated article cannot satisfy source relevance", () => {
  const url = "https://docs.openwhispr.com/help/meetings/record-a-meeting";
  const result = evaluateRecord({
    caseId: "citation-support",
    content: `Hold. [Meeting](${url})`,
    metadata: { sources: [{ url, path: "/help/meetings/record-a-meeting" }] },
  });
  assert.deepEqual(result.failures, ["invalid source URL"]);
});
