const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveDisplayMode,
  isCloudModeOffered,
  isSubscriptionModeOffered,
  subscriptionSelectPatch,
} = require("../../src/helpers/llmCli/subscriptionMode.js");
const { LLM_CLI_PROVIDERS } = require("../../src/helpers/llmCliProviders.js");

const cliId = LLM_CLI_PROVIDERS[0].id;

test("subscription card only for allowlisted scopes", () => {
  assert.equal(isSubscriptionModeOffered("chatIntelligence"), true);
  assert.equal(isSubscriptionModeOffered("dictationAgent"), true);
  assert.equal(isSubscriptionModeOffered("dictationCleanup"), false);
  assert.equal(isSubscriptionModeOffered("noteFormatting"), false);
});

test("cloud card follows cloud config", () => {
  assert.equal(isCloudModeOffered(true), true);
  assert.equal(isCloudModeOffered(false), false);
});

test("CLI provider under providers displays as subscription, not BYOK", () => {
  assert.equal(deriveDisplayMode("providers", cliId), "subscription");
  assert.equal(deriveDisplayMode("providers", "openai"), "providers");
  assert.equal(deriveDisplayMode("providers", ""), "providers");
  assert.equal(deriveDisplayMode("providers", "", true), "subscription");
  assert.equal(deriveDisplayMode("local", cliId), "local");
});

test("select patch keeps stored shape", () => {
  assert.deepEqual(subscriptionSelectPatch({ id: cliId }), {
    mode: "providers",
    cloudMode: "byok",
    provider: cliId,
    model: "default",
  });
  assert.equal(subscriptionSelectPatch(null).provider, "");
});
