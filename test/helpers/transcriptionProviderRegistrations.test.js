const test = require("node:test");
const assert = require("node:assert/strict");
const { bundledRegistryData } = require("../../src/models/registryData.js");
const { resolveProviderRequest } = require("../../src/helpers/providerConnectionTest");
const { mountByokStep } = require("../lib/byokStepHarness");

// The catalog alone lists a provider in onboarding. Each place below is a
// hand-kept list, and none of them fails loudly for a provider it does not
// know: onboarding drops the typed key or never unlocks, and the route sends
// the audio to OpenAI with OpenAI's key. The bundled catalog is read so the
// providers the app ships itself count. Two more such lists are held to the
// same catalog elsewhere: Settings' tabs by
// test/components/transcriptionModelPickerCheck.test.js, and the key Audio
// Upload and the chat microphone read by
// test/services/fileTranscriptionApiKeys.test.js.
const providers = bundledRegistryData.transcriptionProviders.map((provider) => provider.id);

test("onboarding checks every provider's typed key and stores it in a slot of its own", async (t) => {
  const step = await mountByokStep(t);
  const storedIn = new Map();
  // Corti signs in with a client ID and secret, which have fields of their own.
  for (const id of providers.filter((provider) => provider !== "corti")) {
    const key = `typed for ${id}`;
    await step.chooseProvider(id);
    await step.type("onboarding.rehaul.provider.apiKeyPlaceholder", key);
    await step.wait(500);
    const request = step.connectionRequests().at(-1);
    assert.deepEqual([request.provider, request.apiKey], [id, key]);
    await step.answerConnection({ success: true });
    await step.proceed();

    const slots = Object.keys(step.state()).filter((slot) => step.state()[slot] === key);
    assert.equal(slots.length, 1, `Proceed stored ${id}'s key in ${slots.length} slots`);
    const owner = storedIn.get(slots[0]) ?? id;
    assert.equal(owner, id, `${id} and ${owner} store their keys in ${slots[0]}`);
    storedIn.set(slots[0], id);
  }
});

// Onboarding unlocks Proceed only on a check's verdict, so a provider the check
// has no request for could never be set up.
test("every provider has a connection check", () => {
  for (const id of providers) {
    assert.doesNotThrow(() => resolveProviderRequest({ provider: id, apiKey: "key" }), id);
  }
});

test("only OpenAI resolves to OpenAI's endpoint and key", async () => {
  const { resolveTranscriptionRoute } = await import("../../src/helpers/transcriptionRoute.ts");

  for (const id of providers) {
    const route = resolveTranscriptionRoute({
      settings: {
        transcriptionMode: "providers",
        cloudTranscriptionMode: "byok",
        cloudTranscriptionProvider: id,
      },
    });
    // A provider with no batch endpoint fails closed, which names no one's.
    if (route.transport === "error") continue;
    assert.equal(route.provider, id);
    if (id === "openai") continue;
    assert.doesNotMatch(String(route.endpoint), /openai\.com/, id);
    assert.notEqual(route.auth?.keyRef, "openai", id);
  }
});
