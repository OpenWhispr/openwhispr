const assert = require("node:assert/strict");
const test = require("node:test");
const { mountByokStep } = require("../lib/byokStepHarness");

// The onboarding session is plain-text localStorage, while every one of these is a
// safeStorage secret. Named literally so a leak shows up as the value, not just as
// an unexpected key.
const SECRETS = {
  openaiApiKey: "sk-leaked-openai-key",
  cortiClientId: "leaked-corti-client-id",
  cortiClientSecret: "leaked-corti-client-secret",
  customTranscriptionApiKey: "leaked-custom-transcription-key",
  chatAgentCustomApiKey: "leaked-chat-agent-key",
};

const ALLOWED_DRAFT_KEYS = ["baseUrl", "customModel", "selectedModel", "selectedProvider"];

// Each case has to actually load a credential or the value assertions guard
// nothing: the step only seeds the one its step and mode select. A hosted step
// with no resumed provider opens on none, leaving every credential state empty.
for (const [name, options] of [
  [
    "a hosted provider",
    {
      stepId: "byok-dictation",
      selfHostedRequested: false,
      resumeState: { selectedProvider: "openai", selectedModel: "", baseUrl: "", customModel: "" },
    },
  ],
  ["a self-hosted transcription endpoint", { stepId: "byok-dictation", selfHostedRequested: true }],
  ["a self-hosted assistant endpoint", { stepId: "byok-assistant", selfHostedRequested: true }],
]) {
  test(`the resume draft for ${name} carries no credential`, async (t) => {
    const step = await mountByokStep(t, { ...options, secrets: SECRETS });
    const drafts = await step.unmountForDrafts();

    assert.ok(drafts.length > 0, "the step persists a draft so the session can restore it");
    for (const draft of drafts) {
      assert.deepEqual(
        Object.keys(draft).sort(),
        ALLOWED_DRAFT_KEYS,
        "a draft may only carry the four fields the session schema declares"
      );
      const serialized = JSON.stringify(draft);
      for (const [field, secret] of Object.entries(SECRETS)) {
        assert.doesNotMatch(serialized, new RegExp(secret), `${field} reached the draft`);
      }
    }
  });
}
